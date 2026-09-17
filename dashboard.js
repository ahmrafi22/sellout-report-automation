import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8787);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const KEYS_PATH = path.join(__dirname, 'keys.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CRON_LOG_PATH = path.join(__dirname, 'cron.log');
const SUBMITTED_PATH = path.join(__dirname, 'submitted_jobs.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { console.log(`${new Date().toISOString()} ${req.method} ${req.url} from ${req.ip}`); next(); });
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-password, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function requireAuth(req, res, next) {
  const supplied = req.headers['x-dashboard-password'] || req.headers['x-dashboard-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query.password || req.body?.password || '';
  if (req.path === '/api/login' || req.path === '/' || req.path === '/dashboard' || req.path === '/health') {
    if (req.path === '/' || req.path === '/dashboard' || req.path === '/health' || req.path === '/api/login') return next();
  }
  if (supplied === DASHBOARD_PASSWORD) return next();
  if (req.headers['x-dashboard-password'] === DASHBOARD_PASSWORD) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized. Invalid dashboard password.' });
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'config-dashboard', time: new Date().toISOString() }));
app.post('/api/login', (req, res) => {
  const pw = String(req.body?.password ?? req.query.password ?? '').trim();
  if (pw === DASHBOARD_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'Invalid password' });
});
app.get('/api/login', (req, res) => {
  const pw = String(req.query.password ?? '').trim();
  if (pw === DASHBOARD_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'Invalid password' });
});

function loadKeysRaw() {
  try { return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); } catch (e) { console.error('load keys', e.message); return null; }
}
function loadTokenRaw() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch (e) { console.error('load token', e.message); return null; }
}

function getCensoredKeys() {
  const raw = loadKeysRaw();
  if (!raw) return null;
  const stores = ['fbusinesscenter','ripley','mercadolibre','walmart'];
  const out = {};
  for (const s of stores) {
    if (raw[s]) out[s] = { email: raw[s].email || '', hasPassword: !!raw[s].password };
    else out[s] = { email: '', hasPassword: false };
  }
  out.capsolver = { hasApiKey: !!(raw.capsolver && raw.capsolver.apiKey) };
  return out;
}

app.get('/api/keys', requireAuth, (req, res) => {
  const censored = getCensoredKeys();
  if (!censored) return res.status(500).json({ ok: false, error: 'Failed to read keys.json' });
  res.json({ ok: true, keys: censored });
});
app.get('/api/config', requireAuth, (req, res) => {
  const censored = getCensoredKeys();
  if (!censored) return res.status(500).json({ ok: false, error: 'Failed to read keys.json' });
  res.json({ ok: true, keys: censored });
});

app.get('/api/token', requireAuth, (req, res) => {
  const token = loadTokenRaw();
  if (!token) return res.status(500).json({ ok: false, error: 'Failed to read token.json' });
  const stat = fs.existsSync(TOKEN_PATH) ? fs.statSync(TOKEN_PATH) : null;
  res.json({ ok: true, token: {
    exists: true,
    hasAccessToken: !!token.access_token,
    hasRefreshToken: !!token.refresh_token,
    expiry_date: token.expiry_date || null,
    scope: token.scope || null,
    token_type: token.token_type || null,
    lastModified: stat ? stat.mtime.toISOString() : null,
    maskedAccess: token.access_token ? token.access_token.slice(0,6)+'...'+token.access_token.slice(-4) : null
  }});
});

app.get('/api/cron-status', requireAuth, (req, res) => {
  try {
    let crontabLine = '0 12 * * * cd /path/to/project && /usr/bin/node run-all.js >> cron.log 2>&1';
    try {
      const out = execSync('crontab -l 2>&1', { encoding: 'utf8' });
      const lines = out.split('\n').filter(l=>l.includes('run-all.js'));
      if (lines.length) crontabLine = lines[0].trim();
    } catch {}
    let lastRun = null, lastRunMs = null, logTail = '', submittedJobs = null, allDownloaded = false, total = 0, downloaded = 0;
    let driveUploads = 0, driveUploadsList = [];
    if (fs.existsSync(CRON_LOG_PATH)) {
      const stat = fs.statSync(CRON_LOG_PATH);
      lastRun = stat.mtime.toISOString();
      lastRunMs = stat.mtime.getTime();
      try {
        const content = fs.readFileSync(CRON_LOG_PATH, 'utf8');
        const lines = content.split('\n');
        logTail = lines.slice(-60).join('\n');
        const markerStart = '===== [1/4] FALABELLA WORKFLOW =====';
        const markerEnd = '===== ALL WORKFLOWS COMPLETED =====';
        const lastStart = content.lastIndexOf(markerStart);
        let section = '';
        if (lastStart >= 0) {
          const lastEnd = content.indexOf(markerEnd, lastStart);
          section = lastEnd >= 0 ? content.slice(lastStart, lastEnd + markerEnd.length) : content.slice(lastStart);
        } else {
          section = content;
        }
        const driveMatches = section.match(/Drive (file updated|upload OK):.*->/g) || [];
        const logReportMatches = section.match(/Log report uploaded:/g) || [];
        driveUploadsList = driveMatches;
        driveUploads = driveMatches.length + logReportMatches.length;
      } catch {}
    }
    if (fs.existsSync(SUBMITTED_PATH)) {
      try {
        submittedJobs = JSON.parse(fs.readFileSync(SUBMITTED_PATH, 'utf8'));
        const vals = Object.values(submittedJobs);
        total = vals.length;
        downloaded = vals.filter(v=>v.downloaded).length;
        allDownloaded = total>0 && downloaded===total;
      } catch {}
    }
    let displayTotal = driveUploads > 0 ? driveUploads : total;
    let displayDownloaded = driveUploads > 0 ? driveUploads : downloaded;
    let displayAll = driveUploads > 0 ? true : allDownloaded;
    const now = new Date();
    let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12,0,0,0));
    if (next <= now) next.setUTCDate(next.getUTCDate()+1);
    const nextUtc = next.toISOString();
    const nextChile = next.toLocaleString('en-GB', { timeZone: 'America/Santiago', dateStyle: 'medium', timeStyle: 'short' });
    const diffMs = next - now;
    const diffH = Math.floor(diffMs/3600000);
    const diffM = Math.floor((diffMs%3600000)/60000);
    const countdown = `${diffH}h ${diffM}m`;
    let lastAge = null;
    if (lastRunMs) {
      const ageMs = now - lastRunMs;
      const ageH = Math.floor(ageMs/3600000);
      const ageM = Math.floor((ageMs%3600000)/60000);
      if (ageH<24) lastAge = `${ageH}h ${ageM}m ago`;
      else lastAge = `${Math.floor(ageH/24)}d ${ageH%24}h ago`;
    }
    res.json({ ok: true, crontab: crontabLine, lastRun, lastAge, logTail, submittedJobs, total: displayTotal, downloaded: displayDownloaded, allDownloaded: displayAll, driveUploads, driveUploadsList, wallmartTotal: total, wallmartDownloaded: downloaded, nextRun: { utc: nextUtc, chile: nextChile, countdown } });
  } catch (e) {
    console.error('cron-status', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/keys', requireAuth, (req, res) => {
  try {
    const incoming = req.body?.keys || req.body;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ ok: false, error: 'Invalid payload' });
    const allowedStores = ['fbusinesscenter','ripley','mercadolibre','walmart'];
    const raw = loadKeysRaw();
    if (!raw) return res.status(500).json({ ok: false, error: 'Cannot read keys.json' });
    try { fs.copyFileSync(KEYS_PATH, KEYS_PATH + '.bak.' + Date.now()); fs.copyFileSync(KEYS_PATH, KEYS_PATH + '.bak'); } catch {}
    const updated = { ...raw };
    if ('wall-mart' in updated) delete updated['wall-mart'];
    for (const store of allowedStores) {
      if (incoming[store] !== undefined) {
        const entry = incoming[store];
        if (typeof entry !== 'object' || entry === null) return res.status(400).json({ ok: false, error: `Invalid entry for ${store}` });
        const email = String(entry.email ?? '').trim();
        let password = String(entry.password ?? '').trim();
        const masked = ['••••••••','********','....','***'];
        if (masked.includes(password) || password === '') {
          if (updated[store] && updated[store].password) password = updated[store].password;
          else if (!password) return res.status(400).json({ ok: false, error: `Password required for ${store}` });
        }
        if (!email) return res.status(400).json({ ok: false, error: `Email required for ${store}` });
        if (!password) return res.status(400).json({ ok: false, error: `Password required for ${store}` });
        updated[store] = { email, password };
      }
    }
    if (incoming.capsolver !== undefined) {
      const cs = incoming.capsolver;
      if (typeof cs !== 'object' || cs === null) return res.status(400).json({ ok: false, error: 'Invalid capsolver' });
      let apiKey = String(cs.apiKey ?? '').trim();
      const masked = ['••••••••','********','CAP-****',''];
      if (masked.includes(apiKey) || apiKey === '' || apiKey === '••••••••') {
        if (raw.capsolver && raw.capsolver.apiKey) apiKey = raw.capsolver.apiKey;
        else return res.status(400).json({ ok: false, error: 'capsolver.apiKey required' });
      }
      if (apiKey && !apiKey.startsWith('CAP-')) console.warn('capsolver key not CAP-');
      updated.capsolver = { apiKey };
    }
    updated.telegram = raw.telegram;
    fs.writeFileSync(KEYS_PATH, JSON.stringify(updated, null, 2), 'utf8');
    console.log(`Keys updated by ${req.ip}`);
    const censored = getCensoredKeys();
    res.json({ ok: true, keys: censored });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/token', requireAuth, (req, res) => {
  try {
    let incoming = req.body?.token || req.body;
    if (incoming && typeof incoming.raw === 'string') {
      try { incoming = JSON.parse(incoming.raw); } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid JSON pasted: '+e.message }); }
    } else if (incoming && typeof incoming.rawJson === 'string') {
      try { incoming = JSON.parse(incoming.rawJson); } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid JSON pasted: '+e.message }); }
    } else if (typeof incoming === 'string') {
      try { incoming = JSON.parse(incoming); } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid JSON: '+e.message }); }
    }
    if (incoming && typeof incoming.jsonText === 'string') {
      try { incoming = JSON.parse(incoming.jsonText); } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid JSON pasted: '+e.message }); }
    }
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ ok: false, error: 'Invalid payload. Paste full token.json' });
    if (!incoming.access_token) {
      if (incoming.token && typeof incoming.token === 'object') incoming = incoming.token;
      else return res.status(400).json({ ok: false, error: 'access_token missing in pasted JSON' });
    }
    try { fs.copyFileSync(TOKEN_PATH, TOKEN_PATH + '.bak.' + Date.now()); fs.copyFileSync(TOKEN_PATH, TOKEN_PATH + '.bak'); } catch {}
    if (incoming.expiry_date && typeof incoming.expiry_date === 'string') {
      const n = Number(incoming.expiry_date);
      if (!isNaN(n)) incoming.expiry_date = n;
    }
    if (!incoming.access_token || incoming.access_token.length < 10) return res.status(400).json({ ok: false, error: 'access_token looks invalid' });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(incoming, null, 2), 'utf8');
    console.log(`Token updated by ${req.ip}`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/api/keys', requireAuth, (req,res)=>{ req.method='POST'; app._router.handle(req,res,()=>{}); });
app.put('/api/token', requireAuth, (req,res)=>{ req.method='POST'; app._router.handle(req,res,()=>{}); });

const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Config Editor — Automation</title>
<meta name="color-scheme" content="dark"/>
<link href="https://fonts.googleapis.com/css2?family=Fira+Sans:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#070a14;
    --surface:#11172e;
    --surface-2:#171f3d;
    --surface-3:#0c1226;
    --border:#232e5a;
    --border-2:#2d3660;
    --text:#eef2ff;
    --muted:#8e98ba;
    --muted-2:#6b7aa0;
    --primary:#4f6ef7;
    --primary-hover:#3b5bdb;
    --accent:#10b981;
    --accent-hover:#059669;
    --warning:#f59e0b;
    --danger:#ef4444;
    --radius:16px;
    --radius-sm:10px;
    --radius-xs:8px;
    --shadow:0 10px 30px rgba(0,0,0,.35);
    --focus:0 0 0 3px rgba(59,130,246,.35);
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  body{margin:0;font-family:'Fira Sans',Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;-webkit-font-smoothing:antialiased}
  a{color:var(--primary);text-decoration:none}
  a:hover{text-decoration:underline}
  a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--primary);outline-offset:2px;box-shadow:var(--focus)}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .container{max-width:980px;margin:0 auto;padding:28px 18px 60px}
  /* header */
  header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
  .brand{display:flex;align-items:center;gap:12px;min-width:0}
  .logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--primary),#7C3AED);display:grid;place-items:center;flex-shrink:0;box-shadow:0 8px 24px rgba(59,130,246,.35)}
  .logo svg{width:20px;height:20px;color:#fff}
  .brand h1{margin:0;font-size:18px;font-weight:700;letter-spacing:-.025em;line-height:1.1}
  .brand .sub{color:var(--muted);font-size:12px;margin-top:2px;font-weight:400}
  .header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
  .badge{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.22);color:#86EFAC;font-size:12px;font-weight:600;white-space:nowrap}
  .dot{width:8px;height:8px;border-radius:999px;background:var(--accent);box-shadow:0 0 10px rgba(34,197,94,.6);animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
  /* buttons */
  .btn{appearance:none;border:0;cursor:pointer;min-height:44px;padding:0 16px;border-radius:10px;font-weight:600;font-size:13px;transition:transform 180ms ease,box-shadow 180ms ease,background 180ms ease,border-color 180ms ease,opacity 180ms ease;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;user-select:none;-webkit-tap-highlight-color:transparent}
  .btn:active{transform:scale(.98)}
  .btn-primary{background:var(--primary);color:#fff;box-shadow:0 6px 18px rgba(59,130,246,.30)}
  .btn-primary:hover{background:var(--primary-hover);box-shadow:0 10px 24px rgba(59,130,246,.35);transform:translateY(-1px)}
  .btn-ghost{background:rgba(255,255,255,.04);color:var(--text);border:1px solid var(--border);backdrop-filter:blur(6px)}
  .btn-ghost:hover{background:rgba(255,255,255,.07);border-color:var(--border-2)}
  .btn-small{min-height:36px;padding:0 12px;font-size:12px;border-radius:8px}
  .btn:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}
  .btn svg{width:16px;height:16px;flex-shrink:0}
  .btn-small svg{width:14px;height:14px}
  /* cards */
  .card{background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.01)),var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow);backdrop-filter:blur(8px)}
  .login-wrap{max-width:440px;margin:56px auto}
  .login-card{padding:28px}
  .login-icon{width:48px;height:48px;border-radius:14px;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.22);display:grid;place-items:center;margin-bottom:14px;color:var(--primary)}
  .login-icon svg{width:22px;height:22px}
  .login-card h2{margin:0 0 6px;font-size:20px;font-weight:700;letter-spacing:-.02em}
  .muted{color:var(--muted);font-size:13px;line-height:1.6}
  .help{color:var(--muted-2);font-size:11px;line-height:1.4;margin-top:6px;display:block}
  .field{margin-bottom:14px}
  .field label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:7px;display:block}
  .input{width:100%;min-height:44px;padding:11px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-3);color:var(--text);font-size:14px;outline:none;transition:border-color 180ms ease,box-shadow 180ms ease,background 180ms ease}
  .input::placeholder{color:var(--muted-2)}
  .input:hover{border-color:var(--border-2)}
  .input:focus{border-color:var(--primary);box-shadow:var(--focus);background:#0F1B33}
  .input.mono{font-family:'Fira Code',monospace;font-size:13px}
  .input[aria-invalid="true"]{border-color:var(--danger);box-shadow:0 0 0 3px rgba(239,68,68,.18)}
  textarea.input{resize:vertical;min-height:120px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin:16px 0}
  .store-card{position:relative;overflow:hidden;padding:18px;transition:border-color 180ms ease,transform 180ms ease,box-shadow 180ms ease}
  .store-card:hover{border-color:var(--border-2);transform:translateY(-1px);box-shadow:0 14px 36px rgba(0,0,0,.38)}
  .store-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(59,130,246,.5),transparent);opacity:.6}
  .store-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
  .store-name{font-weight:600;font-size:13px;display:flex;align-items:center;gap:10px;letter-spacing:-.01em;min-width:0}
  .store-icon{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;flex-shrink:0;color:#fff;box-shadow:var(--shadow-sm)}
  .store-icon svg{width:18px;height:18px}
  .s-fb,.s-ri,.s-ml,.s-wm,.s-cs,.s-tk{background:var(--surface-2);border:1px solid var(--border);color:var(--muted)}
  .chip{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:5px 8px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--muted);display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .chip.ok{background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.24);color:#86EFAC}
  .chip.warn{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.24);color:#FDE68A}
  .chip svg{width:12px;height:12px}
  .value-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 12px;background:var(--surface-3);border:1px solid var(--border);border-radius:10px;min-height:44px}
  .value{font-size:13px;word-break:break-all;min-width:0}
  .value.mono{font-family:'Fira Code',monospace;font-size:12.5px}
  .tick{color:var(--success);font-weight:600;display:inline-flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap}
  .tick svg{width:16px;height:16px}
  .edit-panel{margin-top:12px;padding:14px;background:var(--surface-3);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;gap:12px;animation:slideIn 220ms ease}
  @keyframes slideIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
  @media(prefers-reduced-motion:reduce){.edit-panel{animation:none}}
  .edit-panel.hidden{display:none}
  .row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
  .alert{padding:12px 14px;border-radius:10px;font-size:13px;font-weight:500;margin:14px 0;display:none;align-items:center;gap:8px}
  .alert.show{display:flex}
  .alert.success{background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.24);color:#86EFAC}
  .alert.error{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.24);color:#FECACA}
  .alert.info{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.24);color:#BFDBFE}
  .alert svg{width:18px;height:18px;flex-shrink:0}
  .section-title{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:22px 0 12px;display:flex;align-items:center;gap:10px}
  .section-title::after{content:'';flex:1;height:1px;background:var(--border);opacity:.7}
  .section-count{font-size:11px;font-weight:600;letter-spacing:.04em;background:var(--surface-2);border:1px solid var(--border);padding:2px 7px;border-radius:999px;color:var(--muted)}
  .divider{height:1px;background:var(--border);margin:16px 0;opacity:.7}
  .hidden{display:none !important}
  .flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .cron-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:14px}
  @media(max-width:760px){.cron-grid{grid-template-columns:1fr} .grid{grid-template-columns:1fr} .container{padding:20px 14px 50px} header{flex-wrap:wrap}}
  .stat{padding:14px;background:var(--surface-3);border:1px solid var(--border);border-radius:12px;transition:border-color 180ms ease}
  .stat:hover{border-color:var(--border-2)}
  .stat label{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:6px;margin-bottom:8px}
  .stat label svg{width:14px;height:14px;color:var(--muted-2)}
  .stat .big{font-size:14px;font-weight:600;letter-spacing:-.01em}
  .stat .small{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.4}
  .mono{font-family:'Fira Code',monospace}
  pre{margin:0;white-space:pre-wrap;word-break:break-all;background:var(--surface-3);border:1px solid var(--border);border-radius:10px;padding:12px;font-family:'Fira Code',monospace;font-size:11px;color:var(--muted);max-height:220px;overflow:auto}
  details{margin-top:12px}
  details summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--muted);user-select:none;min-height:44px;display:flex;align-items:center;gap:6px}
  details summary:hover{color:var(--text)}
  .footer{margin-top:24px;text-align:center;color:var(--muted-2);font-size:11px;line-height:1.6}
  .footer a{color:var(--muted)}
</style>
</head>
<body>
<div class="container">
  <header role="banner">
    <div class="brand">
      <div class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 4v6l-7 4-7-4V7z"/><path d="M12 11v8"/><path d="M5 7l7 4 7-4"/></svg></div>
      <div>
        <h1>Config Editor</h1>
        <div class="sub">Automation credentials</div>
      </div>
    </div>
    <div class="header-actions">
      <span class="badge" aria-live="polite"><span class="dot" aria-hidden="true"></span> Online</span>
      <button id="logoutBtn" class="btn btn-ghost btn-small hidden" aria-label="Logout">Logout</button>
    </div>
  </header>

  <section id="loginView" class="login-wrap" aria-labelledby="login-title">
    <div class="card login-card">
      <div class="login-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1"/></svg></div>
      <h2 id="login-title">Welcome back</h2>
      <p class="muted" style="margin:6px 0 18px">Enter dashboard password to manage store credentials, capsolver and Drive token.</p>
      <div id="loginAlert" class="alert" role="alert" aria-live="assertive"></div>
      <form id="loginForm" novalidate>
        <div class="field">
          <label for="loginPassword">Dashboard password</label>
          <input id="loginPassword" class="input" type="password" placeholder="Enter password" autocomplete="current-password" required aria-describedby="loginHelp" />
          <span id="loginHelp" class="help">Protected by <code class="mono">DASHBOARD_PASSWORD</code></span>
        </div>
        <button id="loginBtn" type="submit" class="btn btn-primary" style="width:100%;min-height:44px">Unlock <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg></button>
      </form>
      <div class="muted" style="text-align:center;margin-top:16px;font-size:11px"><a href="/health" target="_blank" rel="noopener">Health check</a></div>
    </div>
  </section>

  <main id="dashboardView" class="hidden" aria-labelledby="dash-heading">
    <h2 id="dash-heading" class="sr-only">Dashboard</h2>
    <div id="globalAlert" class="alert" role="alert" aria-live="polite"></div>

    <section class="card" id="cronCard" aria-labelledby="cron-title">
      <div class="flex" style="justify-content:space-between;gap:12px">
        <h3 id="cron-title" style="font-weight:700;font-size:13px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;color:var(--muted)"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Cron Status <span class="chip mono" id="cronExpr">0 12 * * *</span></h3>
        <button class="btn btn-ghost btn-small" onclick="loadCron()" aria-label="Refresh cron status"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg> Refresh</button>
      </div>
      <div class="cron-grid">
        <div class="stat">
          <label><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Last run</label>
          <div class="big" id="cronLast">—</div>
          <div class="small" id="cronLastAge">—</div>
          <div class="small" id="cronLastStatus" style="margin-top:8px"></div>
        </div>
        <div class="stat">
          <label><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Uploads</label>
          <div class="big" id="cronUploads">—</div>
          <div class="small" id="cronUploadsDetail">—</div>
        </div>
        <div class="stat">
          <label><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Next run</label>
          <div class="big mono" id="cronNextUtc">—</div>
          <div class="small" id="cronNextChile">—</div>
          <div class="small" id="cronNextCount" style="font-weight:700;color:var(--accent)"></div>
        </div>
      </div>
    </section>

    <section aria-labelledby="stores-title">
      <div class="section-title" id="stores-title">Stores <span class="section-count" id="storesCount">4</span></div>
      <div class="grid" id="storesGrid"></div>
    </section>

    <section aria-labelledby="capsolver-title">
      <div class="section-title" id="capsolver-title">Capsolver</div>
      <div class="card store-card" id="capCard">
        <div class="store-head">
          <div class="store-name"><span class="store-icon s-cs" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><path d="M12 2v2"/></svg></span> capsolver</div>
          <span class="chip ok" id="capTick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Set</span>
        </div>
        <div class="value-row">
          <span class="value mono" style="color:var(--muted)">API Key</span>
          <span class="tick" aria-label="Set"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> ••••••••</span>
        </div>
        <div class="flex" style="justify-content:flex-end;margin-top:12px">
          <button class="btn btn-ghost btn-small" onclick="toggleEdit('capsolver')" aria-expanded="false" aria-controls="edit-capsolver">Edit</button>
        </div>
        <div id="edit-capsolver" class="edit-panel hidden" role="region" aria-label="Edit capsolver">
          <div class="field" style="margin:0">
            <label for="capKeyInput">New API Key</label>
            <input id="capKeyInput" class="input mono" placeholder="CAP-..." autocomplete="off" aria-describedby="capHelp" />
            <span id="capHelp" class="help">Leave blank to keep current. Must start with <code class="mono">CAP-</code></span>
          </div>
          <div class="row">
            <button class="btn btn-ghost btn-small" onclick="toggleEdit('capsolver')">Cancel</button>
            <button class="btn btn-primary btn-small" onclick="saveCapsolver()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save</button>
          </div>
        </div>
      </div>
    </section>

    <section aria-labelledby="token-title">
      <div class="section-title" id="token-title">Google Drive Token</div>
      <div class="card store-card">
        <div class="store-head">
          <div class="store-name"><span class="store-icon s-tk" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span> token.json</div>
          <span class="chip ok" id="tokTick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Configured</span>
        </div>
        <div class="value-row">
          <span class="value mono" id="tokInfo" style="color:var(--muted)">Token • paste full JSON to update</span>
          <span class="tick" id="tokMask">••••••••</span>
        </div>
        <div class="flex" style="justify-content:flex-end;margin-top:12px">
          <button class="btn btn-ghost btn-small" onclick="toggleEdit('token')" aria-expanded="false" aria-controls="edit-token">Edit JSON</button>
        </div>
        <div id="edit-token" class="edit-panel hidden" role="region" aria-label="Edit token">
          <div class="field" style="margin:0">
            <label for="tokRaw">Paste full token.json</label>
            <textarea id="tokRaw" class="input mono" rows="8" placeholder='{"access_token":"ya29...","refresh_token":"1//...","scope":"https://www.googleapis.com/auth/drive.file","token_type":"Bearer","expiry_date":178558...}' aria-describedby="tokHelp"></textarea>
            <span id="tokHelp" class="help">Paste the entire JSON file content. It will replace <code class="mono">token.json</code> atomically with backup.</span>
          </div>
          <div class="row">
            <button class="btn btn-ghost btn-small" onclick="toggleEdit('token')">Cancel</button>
            <button class="btn btn-primary btn-small" onclick="saveToken()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save token</button>
          </div>
        </div>
      </div>
    </section>

    <div class="footer">Config Editor • Cron 12:00 UTC (08:00 CL) • <span id="footerTime"></span></div>
  </main>
</div>

<script>
const $ = s => document.querySelector(s);
let DASH_PASS = localStorage.getItem('dash_pass') || '';
const STORES = [
  {key:'fbusinesscenter',label:'fbusinesscenter',icon:'FB',cls:'s-fb', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>'},
  {key:'ripley',label:'ripley',icon:'RP',cls:'s-ri', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'},
  {key:'mercadolibre',label:'mercadolibre',icon:'ML',cls:'s-ml', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>'},
  {key:'walmart',label:'walmart',icon:'WM',cls:'s-wm', svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z"/><path d="M9 9h6v6H9z"/><path d="M9 3v6"/><path d="M15 3v6"/><path d="M9 15v6"/><path d="M15 15v6"/><path d="M3 9h6"/><path d="M15 9h6"/><path d="M3 15h6"/><path d="M15 15h6"/></svg>'},
];
function showAlert(el,msg,type='info'){
  if(!el) return;
  const icons = {success:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>', error:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>', info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'};
  el.innerHTML = (icons[type]||icons.info) + '<span>'+msg+'</span>';
  el.className='alert show '+type;
  if(type!=='error') setTimeout(()=>{ el.className='alert'; el.innerHTML=''; },4000);
}
async function apiFetch(url,opts={}){
  opts.headers={...(opts.headers||{}),'x-dashboard-password':DASH_PASS,'Content-Type':'application/json'};
  const r=await fetch(url,opts);
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||'Request failed '+r.status);
  return j;
}
function buildStores(){
  const grid=$('#storesGrid');
  if(!grid) return;
  grid.innerHTML='';
  STORES.forEach(s=>{
    const card=document.createElement('div');
    card.className='card store-card';
    card.id='card-'+s.key;
    card.innerHTML = '<div class="store-head"><div class="store-name"><span class="store-icon '+s.cls+'" aria-hidden="true">'+s.svg+'</span> '+s.key+'</div><span class="chip ok" id="tick-'+s.key+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Set</span></div>' +
      '<div class="value-row"><span class="value" id="email-display-'+s.key+'" style="color:var(--muted)">—</span><span class="tick" aria-label="password set"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> ••••••••</span></div>' +
      '<div class="flex" style="justify-content:flex-end;margin-top:12px"><button class="btn btn-ghost btn-small" onclick="toggleEdit(\\''+s.key+'\\')" aria-expanded="false" aria-controls="edit-'+s.key+'">Edit</button></div>' +
      '<div id="edit-'+s.key+'" class="edit-panel hidden" role="region" aria-label="Edit '+s.key+'">' +
        '<div class="field" style="margin:0"><label for="email-'+s.key+'">Email</label><input id="email-'+s.key+'" class="input" placeholder="email@example.com" autocomplete="email" aria-describedby="email-help-'+s.key+'"/><span id="email-help-'+s.key+'" class="help" style="display:none"></span></div>' +
        '<div class="field" style="margin:0"><label for="pass-'+s.key+'">New password</label><input id="pass-'+s.key+'" class="input" type="password" placeholder="Leave blank to keep current" autocomplete="new-password" aria-describedby="pass-help-'+s.key+'"/><span id="pass-help-'+s.key+'" class="help">Only filled password will be updated.</span></div>' +
        '<div class="row"><button class="btn btn-ghost btn-small" onclick="toggleEdit(\\''+s.key+'\\')">Cancel</button><button class="btn btn-primary btn-small" onclick="saveStore(\\''+s.key+'\\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save</button></div>' +
      '</div>';
    grid.appendChild(card);
  });
  const c = $('#storesCount'); if(c) c.textContent = String(STORES.length);
}
buildStores();
function toggleEdit(id){
  const el=document.getElementById('edit-'+id);
  if(!el) return;
  const btn=document.querySelector('[aria-controls="edit-'+id+'"]');
  const isHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden');
  if(btn) btn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
  if(isHidden){
    const firstInput = el.querySelector('input,textarea');
    if(firstInput) setTimeout(()=>firstInput.focus(), 80);
  }
}
function setLoggedIn(on){
  const loginView = $('#loginView');
  const dashView = $('#dashboardView');
  const logoutBtn = $('#logoutBtn');
  if(loginView) loginView.classList.toggle('hidden',on);
  if(dashView) dashView.classList.toggle('hidden',!on);
  if(logoutBtn) logoutBtn.classList.toggle('hidden',!on);
}
async function tryLogin(pw){
  DASH_PASS=pw;
  const j=await apiFetch('/api/login',{method:'POST',body:JSON.stringify({password:pw})}).catch(async e=>{
    const r=await fetch('/api/login?password='+encodeURIComponent(pw));
    const jj=await r.json();
    if(!r.ok) throw new Error(jj.error||e.message);
    return jj;
  });
  if(j.ok){
    localStorage.setItem('dash_pass',pw);
    setLoggedIn(true);
    await Promise.all([loadKeys(),loadCron(),loadTokenInfo()]);
    showAlert($('#globalAlert'),'Unlocked successfully','success');
    return true;
  }
  throw new Error('Invalid');
}
const loginForm = $('#loginForm');
if(loginForm){
  loginForm.addEventListener('submit', async(e)=>{
    e.preventDefault();
    const pw=$('#loginPassword').value.trim();
    const alertEl=$('#loginAlert');
    const btn=$('#loginBtn');
    if(!pw){ showAlert(alertEl,'Enter password','error'); const inp=$('#loginPassword'); if(inp) inp.setAttribute('aria-invalid','true'); return; }
    const inp=$('#loginPassword'); if(inp) inp.removeAttribute('aria-invalid');
    const orig = btn.innerHTML;
    btn.disabled=true; btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg> Checking...';
    try{ await tryLogin(pw); }catch(e){ showAlert(alertEl, e.message||'Invalid','error'); if(inp) inp.setAttribute('aria-invalid','true'); }finally{ btn.disabled=false; btn.innerHTML=orig; }
  });
}
const logoutBtn = $('#logoutBtn');
if(logoutBtn) logoutBtn.addEventListener('click',()=>{ localStorage.removeItem('dash_pass'); DASH_PASS=''; setLoggedIn(false); const inp=$('#loginPassword'); if(inp) inp.value=''; const a=$('#loginAlert'); if(a){a.className='alert'; a.innerHTML='';} });
async function loadKeys(){
  try{
    const j=await apiFetch('/api/keys');
    const keys=j.keys||{};
    STORES.forEach(s=>{
      const e=keys[s.key];
      const emDisp=document.getElementById('email-display-'+s.key);
      const emInput=document.getElementById('email-'+s.key);
      const tick=document.getElementById('tick-'+s.key);
      if(e){
        if(emDisp) emDisp.textContent=e.email||'—';
        if(emInput) emInput.value=e.email||'';
        if(tick){
          const ok = !!e.hasPassword;
          tick.innerHTML = ok ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Set' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Not set';
          tick.className='chip '+(ok?'ok':'warn');
          tick.setAttribute('aria-label', ok ? 'Password set' : 'Password not set');
        }
      }
    });
    const cap=keys.capsolver||{};
    const capTick=$('#capTick');
    if(capTick){
      const ok = !!cap.hasApiKey;
      capTick.innerHTML = ok ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Set' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Not set';
      capTick.className='chip '+(ok?'ok':'warn');
    }
  }catch(e){
    showAlert($('#globalAlert'),'Failed keys: '+e.message,'error');
    if(e.message.includes('Unauthorized')){ setLoggedIn(false); showAlert($('#loginAlert'),'Session expired','error'); }
  }
}
async function loadTokenInfo(){
  try{
    const j=await apiFetch('/api/token');
    const t=j.token||{};
    const tick=$('#tokTick');
    const mask=$('#tokMask');
    if(t.exists){
      if(tick){
        const ok = !!t.hasAccessToken;
        tick.innerHTML = ok ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Configured' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Missing';
        tick.className='chip '+(ok?'ok':'warn');
      }
      if(mask) mask.textContent = t.maskedAccess ? t.maskedAccess : '••••••••';
    }
  }catch(e){ showAlert($('#globalAlert'),'Token load failed: '+e.message,'error'); }
}
async function loadCron(){
  try{
    const j=await apiFetch('/api/cron-status');
    const exprEl=$('#cronExpr'); if(exprEl) exprEl.textContent = j.crontab ? j.crontab.split(' ').slice(0,5).join(' ') : '0 12 * * *';
    const lastEl=$('#cronLast'); if(lastEl) lastEl.textContent = j.lastRun ? new Date(j.lastRun).toLocaleString() : 'never';
    const ageEl=$('#cronLastAge'); if(ageEl) ageEl.textContent = j.lastAge ? j.lastAge : '';
    const statusEl=$('#cronLastStatus');
    if(statusEl){
      if(j.allDownloaded) { statusEl.innerHTML='<span class="chip ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> All files uploaded</span>'; }
      else if(j.total>0) { statusEl.innerHTML='<span class="chip warn">'+j.downloaded+'/'+j.total+' uploaded</span>'; }
      else { statusEl.innerHTML='<span class="chip">no jobs</span>'; }
    }
    const upEl=$('#cronUploads'); if(upEl) upEl.textContent = j.total ? j.downloaded+' / '+j.total : '0';
    const detEl=$('#cronUploadsDetail'); if(detEl) detEl.textContent = j.allDownloaded ? 'All reports downloaded & pushed to Drive' : (j.total? 'Pending: '+(j.total-j.downloaded): 'No jobs');
    const utcEl=$('#cronNextUtc'); if(utcEl) utcEl.textContent = j.nextRun? j.nextRun.utc.replace('T',' ').slice(0,16)+' UTC' : '—';
    const chileEl=$('#cronNextChile'); if(chileEl) chileEl.textContent = j.nextRun? j.nextRun.chile : '—';
    const countEl=$('#cronNextCount'); if(countEl) countEl.textContent = j.nextRun? 'in '+j.nextRun.countdown : '';
  }catch(e){
    console.error('cron load failed',e);
  }
}
async function saveStore(key){
  const emailEl=document.getElementById('email-'+key);
  const passEl=document.getElementById('pass-'+key);
  const email=emailEl?emailEl.value.trim():'';
  const password=passEl?passEl.value.trim():'';
  if(!email){ showAlert($('#globalAlert'),'Email required for '+key,'error'); if(emailEl) emailEl.setAttribute('aria-invalid','true'); return; }
  if(emailEl) emailEl.removeAttribute('aria-invalid');
  const payload={};
  payload[key]={email,password};
  const btn = document.querySelector('#card-'+key+' .btn-primary');
  const orig = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled=true; btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg> Saving...'; }
  try{
    await apiFetch('/api/keys',{method:'POST',body:JSON.stringify(payload)});
    showAlert($('#globalAlert'), key+' saved','success');
    if(passEl) passEl.value='';
    toggleEdit(key);
    await loadKeys();
  }catch(e){ showAlert($('#globalAlert'),'Save failed: '+e.message,'error'); } finally { if(btn){ btn.disabled=false; btn.innerHTML=orig || 'Save'; } }
}
async function saveCapsolver(){
  const input=$('#capKeyInput');
  const apiKey=input?input.value.trim():'';
  const btn = document.querySelector('#capCard .btn-primary');
  const orig = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled=true; btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg> Saving...'; }
  try{
    await apiFetch('/api/keys',{method:'POST',body:JSON.stringify({capsolver:{apiKey: apiKey}})});
    showAlert($('#globalAlert'),'capsolver saved','success');
    if(input) input.value='';
    toggleEdit('capsolver');
    await loadKeys();
  }catch(e){ showAlert($('#globalAlert'),'Save failed: '+e.message,'error'); } finally { if(btn){ btn.disabled=false; btn.innerHTML=orig || 'Save'; } }
}
async function saveToken(){
  const rawEl=$('#tokRaw');
  const raw=rawEl?rawEl.value.trim():'';
  if(!raw) return showAlert($('#globalAlert'),'Paste JSON first','error');
  let parsed;
  try{ parsed=JSON.parse(raw); }catch(e){ return showAlert($('#globalAlert'),'Invalid JSON: '+e.message,'error'); }
  const btn = document.querySelector('#edit-token .btn-primary');
  const orig = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled=true; btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg> Saving...'; }
  try{
    await apiFetch('/api/token',{method:'POST',body:JSON.stringify(parsed)});
    showAlert($('#globalAlert'),'token.json saved','success');
    if(rawEl) rawEl.value='';
    toggleEdit('token');
    await loadTokenInfo();
  }catch(e){ showAlert($('#globalAlert'),'Save failed: '+e.message,'error'); } finally { if(btn){ btn.disabled=false; btn.innerHTML=orig || 'Save token'; } }
}
if(DASH_PASS){
  const inp=$('#loginPassword'); if(inp) inp.value=DASH_PASS;
  tryLogin(DASH_PASS).catch(()=>setLoggedIn(false));
} else {
  setLoggedIn(false);
}
setInterval(()=>{ const el=$('#footerTime'); if(el) el.textContent=new Date().toLocaleString(); },1000);
const ft=$('#footerTime'); if(ft) ft.textContent=new Date().toLocaleString();
window.toggleEdit=toggleEdit;
window.saveStore=saveStore;
window.saveCapsolver=saveCapsolver;
window.saveToken=saveToken;
window.loadCron=loadCron;
</script>
<style>@keyframes spin{to{transform:rotate(360deg)}}</style>
</body>
</html>`;

app.get('/', (req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(dashboardHTML); });
app.get('/dashboard', (req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(dashboardHTML); });
app.use((req,res)=> res.status(404).json({ok:false,error:'Not found'}));
app.listen(DASHBOARD_PORT,'0.0.0.0',()=>{
  console.log(`Config Editor listening on http://0.0.0.0:${DASHBOARD_PORT}`);
  if (!DASHBOARD_PASSWORD) console.warn('   DASHBOARD_PASSWORD is not set - set it in .env before exposing this port.');
});
