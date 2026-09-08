import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Central configuration.
//
// Resolution order for every secret:
//   1. Real environment variable (highest priority, safe for CI/VPS)
//   2. .env file next to this script
//   3. keys.json (local development convenience)
//
// No secret is ever hard-coded in the source. Ship keys.example.json and
// .env.example to new environments and fill in real values there.
// ---------------------------------------------------------------------------

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

export function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

let cachedKeys = null;

export function loadKeys() {
  if (cachedKeys) return cachedKeys;
  const keyPath = path.join(__dirname, env('KEYS_FILE', 'keys.json'));
  try {
    cachedKeys = JSON.parse(readFileSync(keyPath, 'utf8'));
  } catch {
    cachedKeys = {};
  }
  return cachedKeys;
}

// Store credentials by logical name (fbusinesscenter, ripley, mercadolibre, walmart).
export function getStore(name) {
  const stored = loadKeys()[name] || {};
  const upper = name.toUpperCase();
  return {
    email: env(`${upper}_EMAIL`, stored.email || ''),
    password: env(`${upper}_PASSWORD`, stored.password || ''),
  };
}

export function getCapsolverKey() {
  return env('CAPSOLVER_API_KEY', loadKeys().capsolver?.apiKey || '');
}

export function getTelegramToken() {
  return env('TELEGRAM_BOT_TOKEN', loadKeys().telegram?.token || '');
}

export function getOtpServerBase() {
  return env('OTP_SERVER_URL', 'http://127.0.0.1');
}

export function getDriveRootFolder() {
  return env('DRIVE_ROOT_FOLDER', 'retail-reports');
}

export function getDashboardPassword() {
  return env('DASHBOARD_PASSWORD', '');
}

export function getAiConfig() {
  const stored = loadKeys().ai || {};
  return {
    baseUrl: env('OPENAI_BASE_URL', stored.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env('OPENAI_API_KEY', stored.apiKey || ''),
    model: env('OPENAI_MODEL', stored.model || 'gpt-4o-mini'),
    enabled: env('AI_ANALYSIS_ENABLED', '1') !== '0',
    maxRows: Number(env('AI_MAX_ROWS', '40')),
    timeoutMs: Number(env('AI_TIMEOUT_MS', '60000')),
    anomalyThreshold: Number(env('AI_ANOMALY_THRESHOLD', '30')),
  };
}