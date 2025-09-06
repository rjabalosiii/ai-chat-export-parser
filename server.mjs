import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { Buffer } from "node:buffer";

/* ---------------- config ---------------- */
const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);
const MAX_BODY = process.env.MAX_BODY || "2mb";
const FORCE_PLAYWRIGHT = process.env.FORCE_PLAYWRIGHT === "1";
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_CONCURRENCY = Number(process.env.CONCURRENCY || 1);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ---------------- app ---------------- */
const app = express();
app.use(cors({ origin: ORIGINS }));
app.use(express.json({ limit: MAX_BODY }));

// Log every request path (view in Railway logs)
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
  next();
});

// Force JSON on all /api/* routes except /api/pdf (which returns PDF)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") && req.path !== "/api/pdf") {
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("X-Content-Type-Options", "nosniff");
  }
  next();
});

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
    ["turns"]
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

/** Try to parse embedded <script> JSON from HTML */
function extractFromEmbeddedJSON(html) {
  // __NEXT_DATA__ fast path
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
          turns
        };
      }
    } catch {}
  }
  // Generic JSON blobs
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
          turns
        };
      }
    } catch {}
  }
  return null;
}

/** Parse hydrated DOM without executing JS */
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
    turns
  };
}

/* ---- Playwright: single browser instance + safer flags ---- */
let PW_BROWSER = null;
async function getBrowser() {
  if (PW_BROWSER) return PW_BROWSER;
  PW_BROWSER = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // avoid small /dev/shm crashes
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  });
  // clean shutdown
  for (const sig of ["SIGINT", "SIGTERM", "SIGQUIT"]) {
    process.once(sig, async () => {
      try { await PW_BROWSER?.close(); } catch {}
      process.exit(0);
    });
  }
  return PW_BROWSER;
}

let INFLIGHT = 0;
async function extractWithPlaywright(url) {
  // simple queue to limit memory usage
  while (INFLIGHT >= MAX_CONCURRENCY) {
    await new Promise(r => setTimeout(r, 50));
  }
  INFLIGHT++;
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({ userAgent: UA, locale: "en-US" });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1"
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: Math.max(60000, TIMEOUT_MS) });

    // Try __NEXT_DATA__ first
    try {
      await page.waitForSelector('script#__NEXT_DATA__', { timeout: 8000 });
      const nextText = await page.$eval('script#__NEXT_DATA__', el => el.textContent || "");
      if (nextText?.trim()?.startsWith("{")) {
        const json = JSON.parse(nextText);
        const turns = extractTurnsFromPossibleJSON(json);
        if (turns.length) {
          const title = (await page.title()) || "Conversation";
          await context.close();
          return { title, model: null, turns };
        }
      }
    } catch {}

    // Fallback: hydrated DOM
    try { await page.waitForSelector("[data-message-author-role]", { timeout: 8000 }); } catch {}
    const html = await page.content();
    await context.close();
    const dom = extractFromDomHTML(html);
    if (dom) return dom;

    return null;
  } catch (e) {
    console.error("Playwright error:", e);
    throw e;
  } finally {
    INFLIGHT--;
  }
}

/* ---------------- core ingest ---------------- */
async function ingestCore(targetUrl, debugFlag) {
  if (DRY_RUN) {
    return {
      status: 200,
      body: {
        dryRun: true,
        targetUrl,
        debugFlag,
        hint: "Set DRY_RUN=0 in Railway env to enable real parsing."
      }
    };
  }

  if (!targetUrl) return { status: 400, body: { error: "url required" } };
  if (!isChatGPTShare(targetUrl)) return { status: 400, body: { error: "only chatgpt share links supported" } };

  // 1) Static fetch → embedded JSON → DOM
  let parsed = null;
  if (!FORCE_PLAYWRIGHT) {
    try {
      const r = await fetch(targetUrl, {
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Upgrade-Insecure-Requests": "1"
        }
      });
      if (r.ok) {
        const html = await r.text();
        parsed = extractFromEmbeddedJSON(html) || extractFromDomHTML(html);
      }
    } catch { /* fall through */ }
  }

  // 2) Playwright fallback (hydrated)
  if (!parsed) parsed = await extractWithPlaywright(targetUrl);

  // 3) Failure diagnostics
  if (!parsed?.turns?.length) {
    if (debugFlag) {
      try {
        const r2 = await fetch(targetUrl, { headers: { "User-Agent": UA } });
        const ct = r2.headers.get("content-type") || "";
        const body = await r2.text();
        return {
          status: 422,
          body: { error: "parse_failed", debug: { contentType: ct, bytes: body.length, headSample: body.slice(0, 800) } }
        };
      } catch (e) {
        return { status: 422, body: { error: "parse_failed", note: "debug fetch failed", detail: String(e) } };
      }
    }
    return { status: 422, body: { error: "parse_failed", hint: "append &debug=1 to inspect" } };
  }

  return {
    status: 200,
    body: {
      title: parsed.title || "Conversation",
      model: parsed.model || null,
      source: "chatgpt",
      canonical_url: targetUrl,
      fetched_at: nowIso(),
      turns: parsed.turns.map((t, i) => ({ role: t.role, content: t.content, ord: i }))
    }
  };
}

/* ---------------- routes ---------------- */
app.get("/", (_req, res) => {
  res.type("text/plain").send("AI Chat Export Parser running. Try /healthz or /api/ingest?url=...");
});

app.get("/healthz", (_req, res) => res.json({ ok: true, ts: nowIso(), dryRun: DRY_RUN }));

// sanity: verify query parsing & JSON-only behavior
app.get("/api/echo", (req, res) => {
  res.json({
    ok: true,
    urlParam: req.query.url ?? null,
    srcParam: req.query.src ?? null,
    debug: req.query.debug ?? null,
    dryRun: DRY_RUN
  });
});

/** GET /api/ingest?url=... */
app.get("/api/ingest", async (req, res) => {
  const targetUrl = String(req.query.url || "");
  const debugFlag = String(req.query.debug || "") === "1";
  const result = await ingestCore(targetUrl, debugFlag);
  return res.status(result.status).json(result.body);
});

/** GET /api/ingest2?src=...  (alias avoiding `url=` param) */
app.get("/api/ingest2", async (req, res) => {
  const targetUrl = String(req.query.src || req.query.u || req.query.link || req.query.target || "");
  const debugFlag = String(req.query.debug || "") === "1";
  const result = await ingestCore(targetUrl, debugFlag);
  return res.status(result.status).json(result.body);
});

/** GET /api/ingest_b64?src_b64=<base64(url)>  (browser-safe GET) */
app.get("/api/ingest_b64", async (req, res) => {
  try {
    const b64 = String(req.query.src_b64 || "");
    if (!b64) return res.status(400).json({ error: "src_b64 required" });
    const targetUrl = Buffer.from(b64, "base64").toString("utf8");
    const debugFlag = String(req.query.debug || "") === "1";
    const result = await ingestCore(targetUrl, debugFlag);
    return res.status(result.status).json(result.body);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/** POST /api/ingest  { "url": "..." }  (best for clients; no query follow issues) */
app.post("/api/ingest", async (req, res) => {
  const targetUrl = String((req.body && (req.body.url || req.body.src)) || "");
  const debugFlag = Boolean(req.body && (req.body.debug === 1 || req.body.debug === true));
  const result = await ingestCore(targetUrl, debugFlag);
  return res.status(result.status).json(result.body);
});

/* --------- PDF endpoint (keeps PDF content-type) --------- */
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

    const browser = await getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    await context.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${slug(title)}.pdf"`);
    return res.send(Buffer.from(pdf));
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------------- start ---------------- */
app.listen(PORT, () => console.log(`🚀 AI Chat Export Parser listening on :${PORT} (DRY_RUN=${DRY_RUN ? "1" : "0"}, CONCURRENCY=${MAX_CONCURRENCY})`));
