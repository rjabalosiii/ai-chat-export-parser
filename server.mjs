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

/* ---------------- app ---------------- */
const app = express();
app.use(cors({ origin: ORIGINS }));
app.use(express.json({ limit: MAX_BODY }));

/* tiny in-memory rate limit (60 req/min/IP) */
const hits = new Map();
app.use((req, res, next) => {
  const ip =
    (req.headers["x-forwarded-for"]?.toString().split(",")[0] ||
      req.socket.remoteAddress ||
      "").trim();
  const now = Date.now();
  const arr = hits.get(ip) || [];
  const recent = arr.filter(t => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (recent.length > 60) return res.status(429).json({ error: "rate_limited" });
  next();
});

/* ---------------- helpers ---------------- */
const nowIso = () => new Date().toISOString();
const isChatGPTShare = url => /^https?:\/\/(chatgpt\.com|chat\.openai\.com)\/share\//i.test(url);
const clean = s => (s || "").replace(/\u00A0/g, " ").trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Try to extract turns from common JSON shapes embedded in the HTML */
function extractTurnsFromPossibleJSON(json) {
  const out = [];
  const paths = [
    ["props", "pageProps", "serverResponse", "messages"],
    ["props", "pageProps", "sharedConversation", "mapping"],
    ["state", "conversation", "messages"],
    ["messages"],
    ["turns"]
  ];
  for (const p of paths) {
    let node = json;
    for (const k of p) node = node?.[k];
    if (!node) continue;

    if (Array.isArray(node)) {
      for (const m of node) {
        const role = m?.author?.role || m?.role;
        const parts = m?.content?.parts;
        const text =
          Array.isArray(parts) ? parts.join("\n\n") : m?.content?.text ?? m?.content ?? m?.text ?? "";
        if (role && text) out.push({ role, content: clean(String(text)) });
      }
      if (out.length) return out;
    } else if (typeof node === "object") {
      for (const v of Object.values(node)) {
        const msg = v?.message || v;
        const role = msg?.author?.role || msg?.role;
        const parts = msg?.content?.parts;
        const text =
          Array.isArray(parts) ? parts.join("\n\n") : msg?.content?.text ?? msg?.content ?? msg?.text ?? "";
        if (role && text) out.push({ role, content: clean(String(text)) });
      }
      if (out.length) return out;
    }
  }
  return out;
}

/** Parse from embedded <script> JSON inside the HTML */
function extractFromEmbeddedJSON(html) {
  const $ = cheerio.load(html);
  const candidates = [
    'script[id="__NEXT_DATA__"]',
    'script[type="application/json"]',
    "script[data-state]"
  ];
  for (const sel of candidates) {
    const el = $(sel).first();
    if (!el.length) continue;
    const text = el.text().trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) continue;
    try {
      const json = JSON.parse(text);
      const turns = extractTurnsFromPossibleJSON(json);
      if (turns.length) {
        return {
          title: clean($('meta[property="og:title"]').attr("content") || $("title").text() || "Conversation"),
          model: $('meta[name="model"]').attr("content") || null,
          turns
        };
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

/** Parse hydrated DOM without JS execution */
function extractFromDomHTML(html) {
  const $ = cheerio.load(html);
  const nodes = $("[data-message-author-role]");
  if (!nodes.length) return null;

  const turns = [];
  nodes.each((_, el) => {
    const role = $(el).attr("data-message-author-role") || "assistant";
    // preserve code blocks
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
    turns
  };
}

/** Full-headless fallback using Playwright */
async function extractWithPlaywright(url) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
    await page.waitForTimeout(800);

    // try DOM after hydration
    const html = await page.content();
    const dom = extractFromDomHTML(html);
    if (dom) return dom;

    // do a quick in-page scrape as a last resort
    const data = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("[data-message-author-role]"));
      if (!items.length) return null;
      items.forEach(el => {
        el.querySelectorAll("pre").forEach(pre => {
          const txt = pre.textContent || "";
          const div = document.createElement("div");
          div.textContent = "```" + "\n" + txt + "\n" + "```";
          pre.replaceWith(div);
        });
      });
      const turns = items
        .map(el => ({
          role: el.getAttribute("data-message-author-role") || "assistant",
          content: (el.textContent || "").trim()
        }))
        .filter(t => t.content);
      const title =
        document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
        document.title ||
        "Conversation";
      const model = document.querySelector('meta[name="model"]')?.getAttribute("content") || null;
      return { title, model, turns };
    });
    if (data?.turns?.length) return data;
    return null;
  } finally {
    await browser.close();
  }
}

/* ---------------- routes ---------------- */
app.get("/", (_req, res) => {
  res.type("text/plain").send("AI Chat Export Parser is running. Try /healthz or /api/ingest?url=...");
});

app.get("/healthz", (_req, res) => res.json({ ok: true, ts: nowIso() }));

/**
 * GET /api/ingest?url=<chatgpt_share_link>
 * Returns { title, model, source, canonical_url, fetched_at, turns:[{role,content,ord}] }
 */
app.get("/api/ingest", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    if (!url) return res.status(400).json({ error: "url required" });
    if (!isChatGPTShare(url)) return res.status(400).json({ error: "only chatgpt share links supported" });

    let parsed = null;

    // 1) Static fetch with browser-like headers
    if (!FORCE_PLAYWRIGHT) {
      try {
        const r = await fetch(url, {
          headers: {
            "User-Agent": UA,
            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Upgrade-Insecure-Requests": "1"
          }
        });
        if (r.ok) {
          const html = await r.text();
          parsed = extractFromEmbeddedJSON(html) || extractFromDomHTML(html);
        } else if (![403, 401, 503].includes(r.status)) {
          return res.status(422).json({ error: `fetch ${r.status}` });
        }
      } catch {
        /* ignore; try Playwright */
      }
    }

    // 2) Playwright fallback
    if (!parsed) parsed = await extractWithPlaywright(url);

    if (!parsed?.turns?.length) {
      return res.status(422).json({ error: "parse_failed", hint: "try manual paste" });
    }

    return res.json({
      title: parsed.title || "Conversation",
      model: parsed.model || null,
      source: "chatgpt",
      canonical_url: url,
      fetched_at: nowIso(),
      turns: parsed.turns.map((t, i) => ({ role: t.role, content: t.content, ord: i }))
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* --------- PDF endpoint (HTML -> PDF via Playwright) --------- */
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
@page { margin: 22mm; }
body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; color:#0f172a; line-height:1.5; }
h1 { font-size: 20pt; margin: 0 0 8mm; }
.meta { color:#475569; font-size:10pt; margin-bottom: 8mm; }
.turn { margin: 5mm 0; }
.role { font-weight:600; font-size:10pt; margin-bottom: 2mm; }
.bubble { border:1px solid #e2e8f0; border-radius:8px; padding:5mm; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size:9pt; white-space:pre-wrap; word-break:break-word; }
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">Exported ${nowIso()}</div>
${turns
  .map(
    t => `<div class="turn">
  <div class="role">${escapeHtml(String(t.role).toUpperCase())}</div>
  <div class="bubble">${formatRich(String(t.content || ""))}</div>
</div>`
  )
  .join("")}
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
