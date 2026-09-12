import express from 'express';
import { recordOtp, getLastOtp } from './otp-store.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'OTP backup API. POST /otp/mercadolibre?code=123456, POST /otp/wallmart?code=123456, GET /otp/latest' });
});

app.get('/otp/latest', (req, res) => {
  const lastOtp = getLastOtp();
  res.json(lastOtp ? { ok: true, ...lastOtp } : { ok: false, code: null });
});

app.post('/otp/mercadolibre', (req, res) => {
  const code = String(req.query.code ?? req.query.otp ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'Invalid OTP. Expected a 6-digit code.' });
  }
  recordOtp(code, 'mercadolibre');
  console.log('OTP received via API from store: mercadolibre', code);
  res.json({ ok: true, received: code });
});

app.post('/otp/wallmart', (req, res) => {
  const code = String(req.query.code ?? req.query.otp ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'Invalid OTP. Expected a 6-digit code.' });
  }
  recordOtp(code, 'wallmart');
  console.log('OTP received via API from store: wallmart', code);
  res.json({ ok: true, received: code });
});

// --- OTP relay for local testing ---
// No hard-coded remote. Configure OTP_RELAY_URL (or OTP_SERVER_URL) in .env
// to mirror OTPs from another host; leave empty to disable relaying.
const RELAY_URL = process.env.OTP_RELAY_URL !== undefined ? process.env.OTP_RELAY_URL : (process.env.OTP_SERVER_URL || '');
const RELAY_POLL_MS = 2000;
let lastRelayAt = 0;
// persisted relay watermark to avoid re-processing after restart (optional)
const __relayDir = path.dirname(fileURLToPath(import.meta.url));
const RELAY_STATE_FILE = path.join(__relayDir, 'otp-relay-state.json');
try {
  if (existsSync(RELAY_STATE_FILE)) {
    const j = JSON.parse(readFileSync(RELAY_STATE_FILE, 'utf8'));
    if (j && typeof j.lastRelayAt === 'number') lastRelayAt = j.lastRelayAt;
  }
} catch {}
function saveRelayState(ts) {
  try { writeFileSync(RELAY_STATE_FILE, JSON.stringify({ lastRelayAt: ts })); } catch {}
}
const isLocalHost = (u) => /127\.0\.0\.1|localhost/i.test(u || '');
if (RELAY_URL && !isLocalHost(RELAY_URL)) {
  console.log(`OTP relay enabled -> ${RELAY_URL} (poll ${RELAY_POLL_MS}ms)`);
  setInterval(async () => {
    try {
      const res = await fetch(RELAY_URL.replace(/\/$/, '') + '/otp/latest', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.ok || !data.code || !data.receivedAt) return;
      if (data.receivedAt <= lastRelayAt) return;
      // also check local is not newer
      const local = getLastOtp();
      if (local && local.receivedAt >= data.receivedAt) {
        lastRelayAt = local.receivedAt;
        saveRelayState(lastRelayAt);
        return;
      }
      recordOtp(String(data.code).trim(), data.store || null);
      lastRelayAt = data.receivedAt;
      saveRelayState(lastRelayAt);
      console.log(`OTP relayed from ${RELAY_URL}: ${data.code} [${data.store || '?'}]`);
    } catch (e) {
      // silent - remote may be down
    }
  }, RELAY_POLL_MS);
}

const PORT = Number(process.env.OTP_SERVER_PORT || 80);
app.listen(PORT, () => {
  console.log(`OTP backup API listening on http://0.0.0.0:${PORT}`);
  if (RELAY_URL && !isLocalHost(RELAY_URL)) console.log(`Relaying OTPs from ${RELAY_URL}`);
});