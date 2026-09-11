import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import { getTelegramToken } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BOT_TOKEN = getTelegramToken();

// Webhook-only Telegram — direct fetch to Bot API for file-upload notifications.
// OTP state is now in otp-store.js (recordOtp/getLastOtp/consumeOtp) — kept separate.

function getConfigRecipientIds() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(__dirname, 'keys.json'), 'utf8'));
    const v = parsed.telegram?.recipientChatIds;
    if (Array.isArray(v)) {
      return v
        .map((e) => (typeof e === 'object' && e !== null ? e.id : e))
        .filter(Boolean);
    }
    if (typeof v === 'string' && v) return [v];
    return [];
  } catch {
    return [];
  }
}

export function getConfigRecipients() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(__dirname, 'keys.json'), 'utf8'));
    const v = parsed.telegram?.recipientChatIds;
    if (Array.isArray(v)) return v.filter(Boolean);
    return [];
  } catch {
    return [];
  }
}

export function unregisterRecipient(chatId) {
  const keyPath = path.join(__dirname, 'keys.json');
  const parsed = JSON.parse(readFileSync(keyPath, 'utf8'));
  const list = Array.isArray(parsed.telegram?.recipientChatIds) ? parsed.telegram.recipientChatIds : [];
  const id = typeof chatId === 'number' ? chatId : Number(chatId);
  const index = list.findIndex((e) => {
    const eid = typeof e === 'object' && e !== null ? e.id : e;
    return Number(eid) === id;
  });
  if (index === -1) return false;
  list.splice(index, 1);
  parsed.telegram = parsed.telegram || {};
  parsed.telegram.recipientChatIds = list;
  writeFileSync(keyPath, JSON.stringify(parsed, null, 2));
  return true;
}

export function registerRecipient(chatId, username) {
  const keyPath = path.join(__dirname, 'keys.json');
  const parsed = JSON.parse(readFileSync(keyPath, 'utf8'));
  const list = Array.isArray(parsed.telegram?.recipientChatIds) ? parsed.telegram.recipientChatIds.filter(Boolean) : [];
  const id = typeof chatId === 'number' ? chatId : Number(chatId);
  const exists = list.some((e) => {
    const eid = typeof e === 'object' && e !== null ? e.id : e;
    return Number(eid) === id;
  });
  if (exists) return false;
  list.push({ id, username: username || null });
  parsed.telegram = parsed.telegram || {};
  parsed.telegram.recipientChatIds = list;
  writeFileSync(keyPath, JSON.stringify(parsed, null, 2));
  return true;
}

async function sendToChat(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram send failed to ' + chatId + ':', JSON.stringify(data));
    return false;
  }
  return true;
}

export async function sendTelegramMessage(text) {
  const ids = getConfigRecipientIds();
  if (ids.length === 0) {
    console.error('No Telegram recipient ids. Add "telegram": { "recipientChatIds": ["<your-id>"] } to keys.json.');
    return false;
  }
  let ok = true;
  for (const id of ids) {
    try {
      ok = (await sendToChat(id, text)) && ok;
    } catch (e) {
      ok = false;
      console.error('Telegram send error to ' + id + ':', e.message);
    }
  }
  if (ok) console.log('Telegram message sent.');
  return ok;
}