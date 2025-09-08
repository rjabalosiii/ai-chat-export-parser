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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ---------------- app ---------------- */
const app = express();
app.use(cors({ origin: ORIGINS }));
app.use(express.json({ limit: MAX_BODY }));

// Log every request path
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
  next();
});

// Force JSON on /api/* except /api/pdf
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

function withTimeout(promise, ms, label = "op") {
  let to;
  const timeout = new Promise((_r, reject) => {
    to = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(to)), timeout]);
}

/** Heuristic extractor */
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
  return null;
}

/** Parse hydrated DOM */
function extractFromDomHTML(html) {
  const $ = cheerio.load(html);
  const nodes = $("[data-message-author-role]");
  if (!nodes.length) return null;
  const turns = [];
  nodes.each((_, el) => {
    const role = $(el).attr("data-message-author-role") || "assistant";
    const text = clean($(el).text());
    if (text) turns.push({ role, content: text });
  });
  if (!turns.length) return null;
  return {
    title: clean($("title").text() || "Conversation"),
    model: null,
    turns
  };
}

/* ---- Playwright: single browser instance ---- */
let PW_BROWSER = null;
let READY = false;
let WARMING = null;
let INFLIGHT = 0;

async function getBrowser() {
  if (PW_BROWSER) return PW_BROWSER;
  PW_BROWSER = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  });
  return PW_BROWSER;
}

async function warmup() {
  try {
    const b = await getBrowser();
    const ctx = await b.newContext({ userAgent: UA, locale: "en-US" });
    const page = await ctx.newPage();
    await page.setContent("<html><body>warmup</body></html>");
    await ctx.close();
    READY = true;
    console.log("✅ Playwright warm-up complete");
  } catch (e) {
    console.error("❌ Playwright warm-up failed:", e);
  }
}

async function ensureWarm() {
  if (READY) return;
  if (WARMING) return WARMING;
  WARMING = (async () => {
    await warmup();
    WARMING = null;
  })();
  return WARMING;
}

async function extractWithPlaywright(url) {
  while (INFLIGHT >= MAX_CONCURRENCY) {
    await new Promise(r => setTimeout(r, 50));
  }
  INFLIGHT++;
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({ userAgent: UA, locale: "en-US" });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: Math.max(60000, TIMEOUT_MS) });
    const html = await page.content();
    await context.close();
    return extractFromDomHTML(html);
  } finally {
    INFLIGHT--;
  }
}

/* ---------------- core ingest ---------------- */
async function ingestCore(targetUrl, debugFlag) {
  if (DRY_RUN) return { status: 200, body: { dryRun: true } };
  if (!targetUrl) return { status: 400, body: { error: "url required" } };
  if (!isChatGPTShare(targetUrl)) return { status: 400, body: { error: "only chatgpt share links supported" } };

  let parsed = null;
  if (!FORCE_PLAYWRIGHT) {
    try {
      const r = await fetch(targetUrl, { headers: { "User-Agent": UA } });
      if (r.ok) {
        const html = await r.text();
        parsed = extractFromEmbeddedJSON(html) || extractFromDomHTML(html);
      }
    } catch {}
  }
  if (!parsed) {
    try {
      parsed = await extractWithPlaywright(targetUrl);
    } catch (e) {
      return { status: 504, body: { error: "playwright_failed", detail: String(e.message || e) } };
    }
  }
  if (!parsed?.turns?.length) {
    return { status: 422, body: { error: "parse_failed" } };
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
app.get("/", (_req, res) => res.type("text/plain").send("AI Chat Export Parser running."));

app.get("/healthz", (_req, res) => res.json({ ok: true, ts: nowIso(), dryRun: DRY_RUN, ready: READY }));

app.get("/diag/playwright", async (_req, res) => {
  try {
    const b = await getBrowser();
    const ctx = await b.newContext();
    const page = await ctx.newPage();
    await page.setContent("<html><body>diag</body></html>");
    await ctx.close();
    res.json({ ok: true, version: (await b.version?.()) || "unknown" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/echo", (req, res) => {
  res.json({ ok: true, urlParam: req.query.url ?? null, srcParam: req.query.src ?? null, debug: req.query.debug ?? null, dryRun: DRY_RUN });
});
app.post("/api/echo", (req, res) => {
  res.json({ ok: true, method: "POST", body: req.body });
});

app.get("/api/ingest", async (req, res) => {
  const targetUrl = String(req.query.url || "");
  const debugFlag = String(req.query.debug || "") === "1";
  if (!READY && FORCE_PLAYWRIGHT) await ensureWarm();
  const result = await ingestCore(targetUrl, debugFlag);
  return res.status(result.status).json(result.body);
});

app.get("/api/ingest2", async (req, res) => {
  const targetUrl = String(req.query.src || "");
  if (!READY && FORCE_PLAYWRIGHT) await ensureWarm();
  const result = await ingestCore(targetUrl, false);
  return res.status(result.status).json(result.body);
});

app.get("/api/ingest_b64", async (req, res) => {
  const b64 = String(req.query.src_b64 || "");
  if (!b64) return res.status(400).json({ error: "src_b64 required" });
  const targetUrl = Buffer.from(b64, "base64").toString("utf8");
  if (!READY && FORCE_PLAYWRIGHT) await ensureWarm();
  const result = await ingestCore(targetUrl, false);
  return res.status(result.status).json(result.body);
});

app.post("/api/ingest", async (req, res) => {
  const targetUrl = String((req.body && (req.body.url || req.body.src)) || "");
  if (!READY && FORCE_PLAYWRIGHT) await ensureWarm();
  const result = await ingestCore(targetUrl, false);
  return res.status(result.status).json(result.body);
});

/* ---------------- start ---------------- */
app.listen(PORT, () => console.log(`🚀 Parser listening on :${PORT} (DRY_RUN=${DRY_RUN ? "1" : "0"})`));
warmup();

/* ---------------- error guards ---------------- */
process.on("unhandledRejection", err => console.error("unhandledRejection:", err));
process.on("uncaughtException", err => console.error("uncaughtException:", err));
