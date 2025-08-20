# AI Chat Export Parser

Tiny service that ingests ChatGPT share links and returns real turns as JSON.
Includes a simple PDF endpoint for clean exports.

## Endpoints

### Health
GET /healthz

### Ingest
GET /api/ingest?url=<chatgpt_share_url>

### PDF
POST /api/pdf with JSON body { title, turns } -> returns PDF

## Deploy on Railway

Push repo to GitHub, connect to Railway, set env vars, deploy.
