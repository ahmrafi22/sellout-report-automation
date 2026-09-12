import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OTP_STATE_FILE = path.join(__dirname, 'otp-state.json');

export function recordOtp(code, store) {
  try {
    writeFileSync(OTP_STATE_FILE, JSON.stringify({ code, store: store || null, receivedAt: Date.now() }));
  } catch (e) {
    console.error('Could not save OTP state:', e.message);
  }
}

export function getLastOtp() {
  try {
    return JSON.parse(readFileSync(OTP_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function consumeOtp() {
  try {
    unlinkSync(OTP_STATE_FILE);
  } catch {}
}
