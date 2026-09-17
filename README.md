# Retail Reports Automation

An end-to-end system that automatically collects daily sell-out and stock reports from four
retail portals (Falabella, Ripley, MercadoLibre, Walmart), analyzes the data with optional
AI, uploads the results to Google Drive, and notifies a Telegram channel - all on a cron
schedule with no manual intervention.

It is built for unattended operation: browser automation handles logins and 2FA/OTP, a
config dashboard lets you edit credentials without touching files, and every secret is
resolved from environment variables or a git-ignored config file. When an AI endpoint is
configured each report also gets a narrative summary plus automatic anomaly detection, so
unusual numbers are flagged the moment they appear.

---

## What it does

Every day (via cron) `run-all.js` runs four browser-automation workflows in sequence:

| # | Workflow | File | Site |
|---|----------|------|------|
| 1 | Falabella Business Center | `falabella.js` | Playwright |
| 2 | Ripley | `ripley.js` | Camoufox (Firefox) |
| 3 | MercadoLibre | `mercadolibre.js` | Playwright |
| 4 | Walmart Retail Link | `wall-mart.js` | Camoufox (Firefox) |

Each workflow:

1. Logs in with credentials from config (solving captchas via CapSolver where needed).
2. Waits for 2FA / OTP codes posted to the local OTP server.
3. Downloads the day-range report (CSV/XLSX).
4. Runs **AI analysis** on the file (`ai-analysis.js`).
5. Uploads the file to `Google Drive/fbusinesscenter/<Tenant>/<folder>`.
6. Sends a Telegram notification.

After all four, `run-all.js` compiles an upload log and pushes it to `Drive/logs/`.

---

## Architecture

```
run-all.js
   |-- falabella.js   --+--> ai-analysis.js --> LLM (optional)
   |-- ripley.js      --+         |
   |-- mercadolibre.js-+         +--> local stats + anomaly detection
   |-- wall-mart.js   --+
   |                     +--> drive.js  --> Google Drive
   |                     +--> telegram.js --> Telegram Bot API
   |
   +--> dashboard.js      (config editor UI + status, port 8787)
   +--> otp-server.js     (receives OTP webhooks, port 80)
   +--> otp-server-local.js (local relay for testing)
```

Supporting modules:

- `config.js` - central configuration resolver (env -> .env -> keys.json).
- `drive.js` - Google Drive auth + folder/upload helpers.
- `telegram.js` - webhook-only Telegram sender + recipient registry.
- `otp-store.js` - file-backed OTP state shared between server and workflows.
- `ai-analysis.js` - dependency-free spreadsheet parser + LLM summariser.

---

## Requirements

- Node.js 20 or newer.
- Google Chrome (MercadoLibre workflow) and a Camoufox-compatible Firefox (Ripley/Walmart).
- On headless Linux, `Xvfb` (Ripley starts its own throwaway X server automatically).

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Copy the examples and fill them in. **Never commit the real files.**

```bash
cp .env.example .env
cp keys.example.json keys.json
```

Resolution order for every secret is:

1. Real environment variable (highest priority - use this on a VPS/CI).
2. `.env` file next to the scripts.
3. `keys.json` (local development convenience).

Recognised settings (see `.env.example` for the full annotated list):

| Group | Variables |
|-------|-----------|
| AI analysis | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_ANALYSIS_ENABLED`, `AI_MAX_ROWS`, `AI_TIMEOUT_MS`, `AI_ANOMALY_THRESHOLD` |
| Dashboard | `DASHBOARD_PASSWORD`, `DASHBOARD_PORT` |
| OTP | `OTP_SERVER_PORT`, `OTP_SERVER_URL`, `OTP_RELAY_URL` |
| Drive | `DRIVE_ROOT_FOLDER` |
| Telegram | `TELEGRAM_BOT_TOKEN` |
| Stores | `FBUSINESSCENTER_*`, `RIPLEY_*`, `MERCADOLIBRE_*`, `WALMART_*`, `CAPSOLVER_API_KEY` |

### 3. Google Drive authorization

Place your OAuth desktop client in `client_secret.json`, then run the helper in
`gdrive-token/` to produce `token.json`:

```powershell
pwsh ./gdrive-token/gdrive_token.ps1
```

`token.json` is refreshed automatically by the upload helper.

---

## Running

```bash
node run-all.js          # all four workflows, then upload the daily log
```

Useful environment flags:

- `HEADLESS=0` - run browsers headed (debugging).

### Services

```bash
node dashboard.js        # config editor + status UI on :8787
node otp-server.js       # OTP webhook receiver on :80
node otp-server-local.js # local relay for development
```

The dashboard is the supported way to edit store credentials, the CapSolver key and
the Drive token without touching files by hand. Set `DASHBOARD_PASSWORD` before
exposing the port.

### Scheduling

A typical crontab entry (runs at 12:00 UTC = 08:00 Chile):

```cron
0 12 * * * cd /path/to/project && /usr/bin/node run-all.js >> cron.log 2>&1
```

---

## AI analysis

`ai-analysis.js` is intentionally dependency-free so it works on a bare VPS:

1. **Parse** - XLSX is read as a ZIP of XML using Node's built-in `zlib`; CSV uses a
   small RFC-4180-style parser. Excel serial numbers, `es-CL` (`1.234,56`) and
   `en-US` (`1,234.56`) number formats are all handled.
2. **Statistics** - per-column totals, min, max and average for numeric columns.
3. **Anomaly detection** - compares each numeric total against the previous run for
   the same `store::report` key (cached in `.ai-cache/history.json`) and flags any
   change beyond `AI_ANOMALY_THRESHOLD` percent.
4. **Narrative** - if an OpenAI-compatible endpoint is configured, the statistics and
   a row sample are sent for a short Markdown summary. On any error it falls back to
   the deterministic local summary, so uploads are never blocked.

Works with OpenAI, OpenRouter, Groq, Azure, vLLM, Ollama, LM Studio and anything
else exposing a `/chat/completions` endpoint.

To disable the network call entirely set `AI_ANALYSIS_ENABLED=0`; the local
statistics and anomaly table are still produced.

---

## Security notes

Before deploying:

- Fill in every placeholder (`REPLACE_WITH_`, `YOUR-`, `Change_This`) with real values, and
  keep them out of version control.
- `keys.json`, `.env`, `token.json`, `client_secret.json`, browser profiles and
  runtime state are git-ignored. Keep it that way.
- Set a strong `DASHBOARD_PASSWORD`; the dashboard serves on `0.0.0.0` by default.
- Prefer real environment variables over files on a shared host, and restrict the
  OTP and dashboard ports with a firewall.

---

## License

Provided as-is for internal use. Review and adapt before production deployment.
