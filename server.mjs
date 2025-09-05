import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());

const app = express();
app.use(cors({ origin: ORIGINS }));
app.use(express.json({ limit: "2mb" }));

// Log every request path + method
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
  next();
});

// Force JSON on all /api/* routes
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("X-Content-Type-Options", "nosniff");
  }
  next();
});

const nowIso = () => new Date().toISOString();

app.get("/", (_req, res) => {
  res.type("text/plain").send("Parser DEBUG build. Try /healthz, /api/echo, /api/ingest (GET/POST).");
});

app.get("/healthz", (_req, res) => res.json({ ok: true, ts: nowIso() }));

app.get("/api/echo", (req, res) => {
  res.json({
    ok: true,
    method: req.method,
    path: req.path,
    query: req.query,
    headers: { "content-type": req.headers["content-type"] || null },
    ts: nowIso()
  });
});

// GET /api/ingest?url=... (echo-only)
app.get("/api/ingest", (req, res) => {
  res.json({
    ok: true,
    method: req.method,
    path: req.path,
    query: req.query,
    gotUrl: req.query.url || null,
    note: "DEBUG build: no parsing attempted.",
    ts: nowIso()
  });
});

// GET /api/ingest2?src=... (alias; echo-only)
app.get("/api/ingest2", (req, res) => {
  res.json({
    ok: true,
    method: req.method,
    path: req.path,
    query: req.query,
    gotUrl: req.query.src || req.query.u || req.query.link || req.query.target || null,
    note: "DEBUG build: no parsing attempted.",
    ts: nowIso()
  });
});

// POST /api/ingest  { "url": "..." } (echo-only)
app.post("/api/ingest", (req, res) => {
  res.json({
    ok: true,
    method: req.method,
    path: req.path,
    headers: { "content-type": req.headers["content-type"] || null },
    bodyType: typeof req.body,
    bodyKeys: req.body ? Object.keys(req.body) : [],
    gotUrl: req.body?.url || req.body?.src || null,
    bodySample: req.body ? JSON.stringify(req.body).slice(0, 200) : null,
    note: "DEBUG build: no parsing attempted.",
    ts: nowIso()
  });
});

app.listen(PORT, () => console.log(`🔎 DEBUG parser listening on :${PORT}`));
