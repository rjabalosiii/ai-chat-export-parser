import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

/* ---------------- config ---------------- */
const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);
const MAX_BODY = process.env.MAX_BODY || "2mb";
const FORCE_PLAYWRIGHT = process.env.FORCE_PLAYWRIGHT === "1";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ---------------- app ---------------- */
const app = express();
app.use(cors({ origin: ORIGINS }));
app.use(express.json({ limit: MAX_BODY }));

/* ---------------- helpers ---------------- */
const nowIso = () => new Date().toISOString();
const isChatGPTShare = url => /^https?:\/\/(chatgpt\.com|chat\.openai\.com)\/share\//i.test(url);
const clean = s => (s || "").replace(/\u00A0/g, " ").trim();

/** Heuristic extractor for various JSON shapes from ChatGPT */
function extractTurnsFromPossibleJSON(json) {
  const out = [];
  const paths = [
    ["props", "pageProps", "serverResponse", "messages"],
    ["props", "pageProps", "sharedConversation", "mapping"],
    ["state", "conversation", "messages"],
    ["messages"],
    ["turns"],
  ];
  for (const p of paths) {
    let node = json;
    for (const k of p) node = node?.[k];
    if (!node) continue;

    const push = (role, text) => {
      const t = String(text ?? "").trim();
      if (role && t) out.push({ role, content: t });
    };

    if (Array.isArray(node)) {
      for (const m of node) {
        const role = m?.author?.role || m?.role;
        const parts = m?.content?.parts;
        const text = Array.isArray(parts) ? parts.join("\n\n") : m?.content?.text ?? m?.content ?? m?.text;
        push(role, text);
      }
      if (out.length) return out;
    } else if (typeof node === "object") {
      for (const v of Object.values(node)) {
        const msg = v?.message || v;
        const role = msg?.author?.role || msg?.role;
        const parts = msg?.content?.parts;
        const text = Array.isArray(parts) ? parts.join("\n\n") : msg?.content?.text ?? msg?.content ?? msg?.text;
        push(role, text);
      }
      if (out.length) return out;
    }
  }
  return out;
}

function extractFromEmbeddedJSON(html) {
  // Regex fast path for __NEXT_DATA__
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m?.[1]) {
    try {
      const json = JSON.parse(m[1]);
      const turns = extractTurnsFromPossibleJSON(json);
      if (turns.length) {
        const $ = cheerio.load(html);
        return {
          title: clean($('meta[property="og:title"]').attr("content") || $("title").text() || "Conversation"),
          model: $('meta[name="model"]').attr("content") || null,
          turns,
        };
      }
    } catch {}
  }
  // Fallback: any <script type="application/json">
  const $ = cheerio.load(html);
  for (const sel of ['script[type="application/json"]', "script[data-state]"]) {
    const el = $(sel).first();
    if (!el.length) continue;
    const text = (el.text() || "").trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) continue;
    try {
      const json = JSON.parse(text);
      const turns = extractTurnsFromPossibleJSON(json);
      if (turns.length) {
        return {
          title: clean($('meta[property="og:title"]').attr("content") || $("title").text() || "Conversation"),
          model: $('meta[name="model"]').attr("content") || null,
          turns,
        };
      }
    } catch {}
  }
  return null;
}

function extractFromDomHTML(html) {
  const $ = cheerio.load(html);
  const nodes = $("[data-message-author-role]");
  if (!nodes.length) return null;
  const turns = [];
  nodes.each((_, el) => {
    const role = $(el).attr("data-message-author-role") || "assistant";
    $(el).find("pre").each((__, pre) => {
      const code = $(pre).text();
      $(pre).replaceWith("```" + "\n" + code + "\n" + "```");
    });
    const text = clean($(el).text());
    if (text) turns.push({ role, content: text });
  });
  if (!turns.length) return null;
  return {
    title: clean($('meta[property="og:title"]').attr("content") || $("title").text() || "Conversation"),
    model: $('meta[name="model"]').attr("content") || null,
    turns,
  };
}

/** Playwright: wait for app to hydrate, then read JSON or DOM */
async function extractWithPlaywright(url) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "en-US",
    });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: Math.max(20000, TIMEOUT_MS) });

    // Try: wait for __NEXT_DATA__ and parse it
    try {
      await page.waitForSelector('script#__NEXT_DATA__', { timeout: 6000 });
      const nextText = await page.$eval('script#__NEXT_DATA__', el => el.textContent || "");
      if (nextText?.trim()?.startsWith("{")) {
        const json = JSON.parse(nextText);
        const turns = extractTurnsFromPossibleJSON(json);
        if (turns.length) {
          const title =
            (await page.title()) || "Conversation";
          return { title, model: null, turns };
        }
      }
    } catch {
      // ignore and try DOM
    }

    // Try: wait for hydrated DOM and scrape
    try {
      await page.waitForSelector("[data-message-author-role]", { timeout: 6000 });
    } catch {}
    const html = await page.content();
    const dom = extractFromDomHTML(html);
    if (dom) return dom;

    return null;
  } finally {
    await browser.close();
  }
}

/* ---------------- routes ---------------- */
app.get("/", (_req, res) => {
  res.type("text/plain").send("AI Chat Export Parser running. Try /healthz or /api/ingest?url=...");
});

app.get("/healthz", (_req, res) => res.json({ ok: true, ts: nowIso() }));

app.get("/api/ingest", async (req, res) => {
  res.set("Content-Type", "application/json; charset=utf-8");

  try {
    const url = String(req.query.url || "");
    if (!url) return res.status(400).json({ error: "url required" });
    if (!isChatGPTShare(url)) return res.status(400).json({ error: "only chatgpt share links supported" });

    let parsed = null;

    // 1) Static fetch → parse
    if (!FORCE_PLAYWRIGHT) {
      try {
        const r = await fetch(url, {
          headers: {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Upgrade-Insecure-Requests": "1",
          },
        });
        if (r.ok) {
          const html = await r.text();
          parsed = extractFromEmbeddedJSON(html) || extractFromDomHTML(html);
        }
      } catch {}
    }

    // 2) Playwright fallback (robust)
    if (!parsed) parsed = await extractWithPlaywright(url);

    // 3) Failure → diagnostics
    if (!parsed?.turns?.length) {
      if (String(req.query.debug) === "1") {
        try {
          const r2 = await fetch(url, { headers: { "User-Agent": UA } });
          const ct = r2.headers.get("content-type") || "";
          const body = await r2.text();
          return res.status(422).json({
            error: "parse_failed",
            debug: { contentType: ct, bytes: body.length, headSample: body.slice(0, 800) },
          });
        } catch (e) {
          return res.status(422).json({ error: "parse_failed", note: "debug fetch failed", detail: String(e) });
        }
      }
      return res.status(422).json({ error: "parse_failed", hint: "append &debug=1 to inspect" });
    }

    return res.json({
      title: parsed.title || "Conversation",
      model: parsed.model || null,
      source: "chatgpt",
      canonical_url: url,
      fetched_at: nowIso(),
      turns: parsed.turns.map((t, i) => ({ role: t.role, content: t.content, ord: i })),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* --------- PDF endpoint --------- */
app.post("/api/pdf", async (req, res) => {
  try {
    const { title, turns } = req.body || {};
    if (!title || !Array.isArray(turns)) {
      return res.status(400).json({ error: "title and turns required" });
    }

    const escapeHtml = s =>
      String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
    const formatRich = text =>
      String(text)
        .replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${escapeHtml(code)}</code></pre>`)
        .replace(/\n/g, "<br/>");
    const slug = s => (s || "conversation").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
.role { font-weight: 600; margin-top: 12px; }
.bubble { border: 1px solid #ddd; border-radius: 8px; padding: 10px; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 10pt; }
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div>Exported ${nowIso()}</div>
${turns.map(t => `<div class="turn"><div class="role">${escapeHtml(t.role)}</div><div class="bubble">${formatRich(String(t.content||""))}</div></div>`).join("")}
</body></html>`;

    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${slug(title)}.pdf"`);
    return res.send(Buffer.from(pdf));
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------------- start ---------------- */
app.listen(PORT, () => console.log(`🚀 AI Chat Export Parser listening on :${PORT}`));
