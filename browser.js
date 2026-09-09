import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Camoufox } = require('camoufox');

const HEADLESS = process.env.HEADLESS !== '0';
const USE_CHROME = process.argv.includes('--chrome');
const START_URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6) || 'https://www.google.com';

(async () => {
  let context;
  let page;

  if (USE_CHROME) {
    const userDataDir = path.join(__dirname, 'chrome-profile');
    console.log('Launching Chrome with profile:', userDataDir);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--no-first-run',
        '--no-default-browser-check',
        ...(HEADLESS ? [] : ['--window-size=1920,1080']),
        '--start-maximized',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: HEADLESS ? { width: 1920, height: 1080 } : null,
      locale: 'es-CL',
      timezoneId: 'America/Santiago',
      permissions: ['geolocation'],
      geolocation: { longitude: -73.935242, latitude: 40.730610 },
      colorScheme: 'light',
      ...(HEADLESS ? { deviceScaleFactor: 1 } : {}),
      isMobile: false,
      hasTouch: false,
      ignoreHTTPSErrors: true,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
    });

    page = context.pages()[0] || await context.newPage();
  } else {
    const userDataDir = path.join(__dirname, 'camoufox-profile');
    console.log('Launching Camoufox (Firefox, Windows fingerprint) with profile:', userDataDir);
    context = await Camoufox({
      os: 'windows',
      headless: HEADLESS,
      locale: 'en-US',
      humanize: false,
      data_dir: userDataDir,
      viewport: null,
      noViewport: true,
    });
    try { await context.acceptDownloads(true); } catch {}

    page = typeof context.pages === 'function'
      ? (context.pages()[0] || await context.newPage())
      : await context.newPage();
  }

  console.log(`Navigating to: ${START_URL}`);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('Browser is open. Press Ctrl+C to close.');

  await new Promise(() => {});
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});