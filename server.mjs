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
const isChatGPT = url => /^https?:\/\/(chatgpt\.com|chat\.openai\.com)\/share\//i.test(url);
const clean = s => (s || "").replace(/\u00A0/g, " ").trim();
const ua =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function metaTitle($) {
  return clean($('meta[property="og:title"]').attr("content") || $("title").text() || "Conversation");
}
function metaModel($) {
  return $('meta[name="model"]').attr("content") || null;
}

/* 1) Embedded JSON parse */
function extractFromEmbeddedJSON(html) {
  const $ = cheerio.load(html);
  const sels = ['script[id="__NEXT_DATA__"]', 'script[type="application/json"]', 'script[data-state]'];
  for (const sel of sels) {
    const el = $(sel).first();
    if (!el.length) continue;
    try {
      const json = JSON.par
