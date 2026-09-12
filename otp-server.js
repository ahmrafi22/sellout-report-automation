import express from 'express';
import { recordOtp, getLastOtp } from './otp-store.js';

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

const PORT = Number(process.env.OTP_SERVER_PORT || 80);
app.listen(PORT, () => {
  console.log(`OTP backup API listening on http://0.0.0.0:${PORT}`);
});