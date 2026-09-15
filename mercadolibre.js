import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, mkdirSync, createReadStream, readdirSync, writeFileSync } from 'fs';
import { rename, unlink } from 'fs/promises';
import { chromium } from 'playwright';
import { google } from 'googleapis';
import { sendTelegramMessage, getConfigRecipients } from './telegram.js';
import { getStore, getCapsolverKey } from './config.js';
import { summarizeReport } from './ai-analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = path.join(__dirname, 'chrome-profile');
const sessionCookiesFile = path.join(userDataDir, 'mercadolibre_cookie.json');

const HEADLESS =  process.env.HEADLESS !== '0';

const CHROME_EXE = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';

function resolveChromeExecutable() {
  const candidates = [process.env.CHROME_EXE, CHROME_EXE];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

let keys;
let capsolverApiKey;
try {
  const parsed = JSON.parse(readFileSync(path.join(__dirname, 'keys.json'), 'utf8'));
  keys = parsed.mercadolibre;
  capsolverApiKey = parsed.capsolver?.apiKey || null;
} catch {
  keys = null;
}

const CAPSOLVER_API_KEY = capsolverApiKey || process.env.CAPSOLVER_API_KEY || '';
const CAPSOLVER_API_URL = 'https://api.capsolver.com';
const RECAPTCHA_SITE_KEY_FALLBACK = '6LchwzUaAAAAAI3Am_n1zyxszhpA9zA2_BZ9feFH';

// --- VPS OTP server (HTTP API on localhost) ---
// OTPs are posted to the otp-server by tg-bot.js / external sources.
// This script polls GET /otp/latest instead of reading otp-state.json directly.
const OTP_SERVER_BASE = process.env.OTP_SERVER_URL || 'http://127.0.0.1';
let lastProcessedOtpTs = 0;

async function fetchLatestOtpFromServer() {
  try {
    const res = await fetch(OTP_SERVER_BASE + '/otp/latest', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.ok || !data.code || !data.receivedAt) return null;
    if (data.receivedAt <= lastProcessedOtpTs) return null;
    lastProcessedOtpTs = data.receivedAt;
    return data;
  } catch {
    return null;
  }
}

// --- Google Drive setup (uses token.json from gdrive-auth.mjs) ---
const downloadsDir = path.join(__dirname, 'downloads');
if (!existsSync(downloadsDir)) mkdirSync(downloadsDir, { recursive: true });
let drive = null;
try {
  const tokenPath = path.join(__dirname, 'token.json');
  if (!existsSync(tokenPath)) throw new Error('token.json not found. Run `node gdrive-auth.mjs` once to authorize Google Drive.');
  const secretFile = readdirSync(__dirname).find((f) => f.startsWith('client_secret') && f.endsWith('.json'));
  if (!secretFile) throw new Error('client_secret*.json not found.');
  const cred = JSON.parse(readFileSync(path.join(__dirname, secretFile), 'utf8')).installed;
  const oauth2Client = new google.auth.OAuth2(cred.client_id, cred.client_secret);
  oauth2Client.setCredentials(JSON.parse(readFileSync(tokenPath, 'utf8')));
  drive = google.drive({ version: 'v3', auth: oauth2Client });
} catch (e) {
  console.error('Drive setup skipped (' + e.message + '). Uploads will be skipped, file kept locally.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function randomDelay(minMs, maxMs) {
  await sleep(minMs + Math.floor(Math.random() * (maxMs - minMs)));
}

function shortUrl(url, maxLen = 80) {
  if (!url) return '';
  return url.length > maxLen ? url.slice(0, maxLen) + '...' : url;
}

function recipientMentions() {
  const names = getConfigRecipients()
    .map((r) => (typeof r === 'object' && r && r.username ? r.username : null))
    .filter(Boolean);
  return names.length ? names.join(', ') + ', ' : '';
}

async function ensureFolder(name, parentId) {
  const list = await drive.files.list({
    q: "name='" + name.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.folder' and '" + parentId + "' in parents and trashed=false",
    fields: 'files(id)',
  });
  if (list.data.files[0]) return list.data.files[0];
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  console.log('Created Drive folder:', name);
  return created.data;
}

async function uploadToDrive(filePath, folderName, tenantName = 'Mercadolibre') {
  if (!drive) {
    console.log('Drive not configured. Keeping local file:', filePath);
    return;
  }
  const fileName = path.basename(filePath);
  const rootFolder = await ensureFolder('fbusinesscenter', 'root');
  const tenantFolder = await ensureFolder(tenantName, rootFolder.id);
  const target = await ensureFolder(folderName, tenantFolder.id);
  const existing = await drive.files.list({
    q: "name='" + fileName.replace(/'/g, "\\'") + "' and '" + target.id + "' in parents and trashed=false",
    orderBy: 'createdTime desc',
    pageSize: 1,
    fields: 'files(id, name, webViewLink)',
  });

  const mimeType = fileName.toLowerCase().endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv';
  const media = { mimeType, body: createReadStream(filePath) };
  const existingFile = existing.data.files[0];
  const res = existingFile
    ? await drive.files.update({ fileId: existingFile.id, media, fields: 'id, name, webViewLink' })
    : await drive.files.create({
        requestBody: { name: fileName, parents: [target.id] },
        media,
        fields: 'id, name, webViewLink',
      });

  console.log(`${existingFile ? 'Drive file updated' : 'Drive upload OK'}: ${res.data.name} -> fbusinesscenter/${tenantName}/${folderName}`);
  console.log('Link:', res.data.webViewLink);

  await sendTelegramMessage(`${tenantName.toLowerCase()} ${folderName} file uploaded.`);

  await unlink(filePath);
  console.log('Removed local file:', filePath);
}

async function saveDateStampedDownload(download, driveFolder) {
  const savedPath = path.join(downloadsDir, download.suggestedFilename());
  await download.saveAs(savedPath);

  const now = new Date();
  const dateSuffix = [
    String(now.getDate()).padStart(2, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getFullYear()).slice(-2),
  ].join('-');
  const parsedName = path.parse(savedPath);
  const datedPath = path.join(parsedName.dir, `${parsedName.name}-${dateSuffix}${parsedName.ext}`);
  await rename(savedPath, datedPath);
  console.log('Date added to filename:', datedPath);
  await uploadToDrive(datedPath, driveFolder);
}

async function capsolverCreateTask(taskType, siteKey, pageUrl) {
  const res = await fetch(CAPSOLVER_API_URL + '/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: CAPSOLVER_API_KEY,
      task: {
        type: taskType,
        websiteURL: pageUrl,
        websiteKey: siteKey,
        isInvisible: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }),
  });
  const data = await res.json();
  if (data.errorId !== 0) {
    throw new Error('Capsolver createTask (' + taskType + ') error: ' + JSON.stringify(data.errorDescription || data));
  }
  return data.taskId;
}

async function capsolverWaitForResult(taskId) {
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const res = await fetch(CAPSOLVER_API_URL + '/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId }),
    });
    const data = await res.json();
    if (data.status === 'ready' && data.solution?.gRecaptchaResponse) {
      return data.solution.gRecaptchaResponse;
    }
    if (data.errorId !== 0 || data.status === 'failed') {
      throw new Error('Capsolver task failed: ' + JSON.stringify(data.errorDescription || data));
    }
  }
  throw new Error('Capsolver task timed out.');
}

(async () => {
  async function launchBrowser() {
    const executablePath = resolveChromeExecutable();
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      ...(executablePath ? { executablePath } : {}),
      headless: HEADLESS,
      acceptDownloads: true,
      locale: 'es-CL',
      viewport: HEADLESS ? { width: 1920, height: 1080 } : null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
    });

    // Mask automation signals so the page can't tell this is a bot
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['es-CL', 'es', 'en-US'] });
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

    const pg = ctx.pages()[0] || await ctx.newPage();
    return { context: ctx, page: pg };
  }

  function isBrowserAlive() {
    try {
      const browser = context.browser();
      if (!browser || !browser.isConnected()) return false;
      return context.pages().length > 0;
    } catch {
      return false;
    }
  }

  // Restore the last saved MercadoLibre session cookies (explicit
  // persistence, so the session survives even if Chrome fails to flush its
  // own cookie DB).
  async function restoreSessionCookies() {
    try {
      if (existsSync(sessionCookiesFile)) {
        const cookies = JSON.parse(readFileSync(sessionCookiesFile, 'utf8'));
        if (Array.isArray(cookies) && cookies.length > 0) {
          await context.addCookies(cookies);
          console.log(`Restored ${cookies.length} saved MercadoLibre session cookies.`);
        }
      }
    } catch (e) {
      console.log('Could not restore session cookies:', e.message);
    }
  }

  let { context, page } = await launchBrowser();
  await restoreSessionCookies();

  async function saveSessionCookies() {
    try {
      const cookies = (await context.cookies()).filter((c) => /mercadolibre/i.test(c.domain || ''));
      mkdirSync(path.dirname(sessionCookiesFile), { recursive: true });
      writeFileSync(sessionCookiesFile, JSON.stringify(cookies, null, 2));
      console.log(`Saved ${cookies.length} MercadoLibre session cookies.`);
    } catch (e) {
      console.log('Could not save session cookies:', e.message);
    }
  }

  // Sales report flow: open the sales list, pick yesterday via "Fecha personalizada",
  // download the Excel, date-stamp it and upload it to Google Drive.
  async function downloadSalesReport(skipInitialNav = false) {
    if (!skipInitialNav) {
      console.log('Navigating to MercadoLibre home...');
      await page.goto('https://www.mercadolibre.cl', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // If we're already on the sales list page, do a full refresh instead of
    // navigating to the same URL (goto while a natural redirect is still in
    // flight throws "navigation interrupted by another navigation").
    console.log('Navigating to the sales list page...');
    if (page.url().includes('/ventas/omni/listado')) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    } else {
      await page.goto('https://vendedores.mercadolibre.cl/ventas/omni/listado', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    if (await isCloudflareChallenge()) {
      await waitForChallengeToClear();
    }

    // Open the date range dropdown, select "Fecha personalizada", pick
    // yesterday and click "Descargar Excel de ventas".
    async function selectYesterdayAndDownload() {
      // Open the date range dropdown and select "Fecha personalizada".
      // If the option does not appear within the timeout, do a full page
      // reload and retry.
      let customOption = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const dropdownTrigger = page.locator('button.andes-dropdown__trigger').first();
          await dropdownTrigger.waitFor({ state: 'visible', timeout: 60000 });
          console.log('Sales list loaded. Opening the date range dropdown...');
          await dropdownTrigger.click();

          customOption = page.locator('[data-key="WITH_DATE_CLOSED_CUSTOM"]').first();
          await customOption.waitFor({ state: 'visible', timeout: 15000 });
          console.log('Selecting "Fecha personalizada"...');
          await customOption.click();
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          console.log(`Dropdown/option failed (attempt ${attempt}): ${e.message.split('\n')[0]}. Doing a full page reload...`);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          if (await isCloudflareChallenge()) {
            await waitForChallengeToClear();
          }
          await page.waitForTimeout(3000);
        }
      }

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      console.log('Date picker: selecting', dayKey, '(yesterday)');

      await page.locator('.andes-datepicker').first().waitFor({ state: 'visible', timeout: 15000 });

      let dayButton = page.locator(`td[data-andes-datepicker-day="true"][data-day="${dayKey}"] button.andes-datepicker__day`).first();
      for (let i = 0; i < 2 && (await dayButton.count()) === 0; i++) {
        const prevMonth = page.locator('button.andes-datepicker__button--previous').first();
        await prevMonth.click().catch(() => {});
        await page.waitForTimeout(500);
        dayButton = page.locator(`td[data-andes-datepicker-day="true"][data-day="${dayKey}"] button.andes-datepicker__day`).first();
      }
      if ((await dayButton.count()) === 0) {
        throw new Error('Could not find yesterday (' + dayKey + ') in the date picker.');
      }

      const applyButton = page.locator('button.sc-sales-datepicker--apply-button').first();
      await dayButton.click();
      await page.waitForTimeout(400);
      const applyDisabled = await applyButton.isDisabled().catch(() => true);
      if (applyDisabled) {
        await dayButton.click();
        await page.waitForTimeout(400);
      }
      console.log('Clicking "Aplicar fecha"...');
      await applyButton.click();

      console.log('Waiting for the sales list to load...');
      await page.waitForFunction(() => {
        const list = document.querySelector('.sc-list');
        return list && list.classList.contains('sc-list-marketplace') && !list.classList.contains('sc-list-skeleton');
      }, { timeout: 120000, polling: 1000 });

      const reportButton = page.locator('button.report-link').first();
      await reportButton.waitFor({ state: 'visible', timeout: 30000 });
      console.log('Sales list loaded. Waiting 1 second before clicking "Descargar Excel de ventas"...');
      await page.waitForTimeout(1000);

      console.log('Clicking "Descargar Excel de ventas"...');
      await reportButton.click();
    }

    // Download the latest generated Excel (the last entry in the process panel)
    // and upload it to Google Drive. Returns true if a file was downloaded.
    async function downloadLatestFromNotification() {
      const latestProcess = page.locator('.process-notification-process').last();
      const link = latestProcess.locator('a.process-notification-link');
      if ((await link.count()) === 0) return false;
      console.log('Clicking "Descargar" for the latest generated Excel...');
      const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
      await link.click().catch(async () => { await link.evaluate((el) => { el.click(); }); });
      const download = await downloadPromise;
      await saveDateStampedDownload(download, 'ventas');
      console.log('Excel downloaded and uploaded to Google Drive.');
      return true;
    }

    const waitForGenerationFinished = async () => {
      await page.waitForSelector('.process-notification', { timeout: 30000 }).catch(() => {});
      return page.waitForFunction(() => {
        const header = document.querySelector('.process-notification-header__title');
        return header && /finalizados/i.test(header.textContent);
      }, { timeout: 120000, polling: 2000 }).catch(() => null);
    };

    await selectYesterdayAndDownload();

    console.log('Waiting for the Excel generation process to finish...');
    let finished = await waitForGenerationFinished();
    let downloaded = finished ? await downloadLatestFromNotification() : false;

    if (!downloaded) {
      // Generation timed out (2 min). Reload the page and check the process
      // notification panel for an already-created Excel file; if none is
      // found, re-run the whole date selection and download flow.
      console.log('Excel generation timed out or no download link. Reloading the page...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      if (await isCloudflareChallenge()) {
        await waitForChallengeToClear();
      }
      await page.waitForTimeout(3000);
      await page.waitForSelector('.process-notification', { timeout: 15000 }).catch(() => {});

      const existingLink = page.locator('a.process-notification-link').last();
      if (await existingLink.count() > 0 && await existingLink.isVisible().catch(() => false)) {
        console.log('Found an already-created Excel in the notification panel, downloading it...');
        downloaded = await downloadLatestFromNotification();
      } else {
        console.log('No existing Excel found. Re-running the date selection and download flow...');
        await selectYesterdayAndDownload();
        console.log('Waiting for the Excel generation process to finish...');
        finished = await waitForGenerationFinished();
        if (finished) {
          downloaded = await downloadLatestFromNotification();
        }
      }
    }

    if (!downloaded) {
      throw new Error('Timed out waiting for the Excel generation process.');
    }

    // Close the process notification panel after the upload is done.
    const notifClose = page.locator('button.process-notification-header__close').first();
    if (await notifClose.count() > 0 && await notifClose.isVisible().catch(() => false)) {
      console.log('Closing the process notification panel...');
      try {
        await notifClose.click();
      } catch {
        await notifClose.evaluate((el) => { el.click(); });
      }
      await page.waitForTimeout(1000);
    }
  }

  async function getRecaptchaSiteKey() {
    return page.evaluate(() => {
      const el = document.querySelector('.g-recaptcha');
      if (el && el.getAttribute('data-sitekey')) return el.getAttribute('data-sitekey');
      const iframe = document.querySelector('iframe[src*="recaptcha"][src*="k="]');
      if (iframe) {
        const m = iframe.src.match(/[?&]k=([^&]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
      return null;
    }).catch(() => null);
  }

  async function injectRecaptchaToken(token) {
    await page.evaluate((t) => {
      const ta = document.querySelector('#g-recaptcha-response');
      if (ta) {
        ta.value = t;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const spinner = document.querySelector('.recaptcha__spinner');
      if (spinner) spinner.classList.add('recaptcha__spinner--hide');
    }, token);
  }

  async function solveRecaptchaWithCapsolver() {
    const pageUrl = page.url();
    const siteKey = (await getRecaptchaSiteKey()) || RECAPTCHA_SITE_KEY_FALLBACK;
    const taskTypes = ['ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess'];
    let lastError = null;
    for (const taskType of taskTypes) {
      try {
        console.log(`Capsolver: solving reCAPTCHA v2 via ${taskType} (siteKey=${siteKey}, url=${pageUrl})...`);
        const taskId = await capsolverCreateTask(taskType, siteKey, pageUrl);
        console.log('Capsolver: task created:', taskId);
        const token = await capsolverWaitForResult(taskId);
        console.log('Capsolver: solved, injecting token...');
        await injectRecaptchaToken(token);
        return true;
      } catch (e) {
        lastError = e;
        console.log(`Capsolver: ${taskType} failed (${e.message}), trying next type...`);
      }
    }
    if (lastError && /Invalid input/i.test(lastError.message || '')) {
      // The captcha/URL state is broken (e.g. the password page hands Capsolver
      // a huge redirect_url it rejects). Can't be solved by waiting - signal the
      // caller to reload and restart the whole login flow from the top.
      throw new Error('CAPTCHA_RESTART: ' + lastError.message);
    }
    throw lastError || new Error('Capsolver could not solve the reCAPTCHA.');
  }

  async function submitLoginFormNative() {
    return page.evaluate(() => {
      const ta = document.querySelector('#g-recaptcha-response');
      const form = ta && ta.closest('form');
      if (!form) return false;
      const submitBtn = form.querySelector('button[type="submit"][name][value]');
      if (submitBtn && !form.querySelector('input[name="' + submitBtn.name + '"]')) {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = submitBtn.name;
        hidden.value = submitBtn.value;
        form.appendChild(hidden);
      }
      form.submit();
      return true;
    }).catch(() => false);
  }

  async function isCloudflareChallenge() {
    try {
      const url = page.url();
      const hasChallengeFrame = await page.locator('iframe[src*="challenges.cloudflare.com"]').count() > 0;
      const title = await page.title();
      const hasText = /just a moment|verify you are human|attention required/i.test(title);
      return hasChallengeFrame || hasText || url.includes('challenges.cloudflare.com');
    } catch {
      return false;
    }
  }

  async function waitForChallengeToClear() {
    console.log('Cloudflare challenge detected. Solve it manually in the browser window...');
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(2000);
      if (!(await isCloudflareChallenge())) {
        console.log('Challenge cleared.');
        return;
      }
    }
    console.log('Timed out waiting for Cloudflare challenge to clear.');
  }

  async function hasVisibleRecaptcha() {
    try {
      return await page.evaluate(() => {
        const widget = document.querySelector('#g-recaptcha');
        if (widget && widget.offsetParent !== null) {
          const r = widget.getBoundingClientRect();
          if (r.width >= 40 && r.height >= 30) return true;
        }
        const iframes = [...document.querySelectorAll('iframe[src*="recaptcha"]')].filter(
          (f) => !/bframe/i.test(f.src || '')
        );
        for (const f of iframes) {
          const r = f.getBoundingClientRect();
          if (r.width >= 40 && r.height >= 30 &&
              r.top < window.innerHeight && r.bottom > 0 &&
              r.left < window.innerWidth && r.right > 0 &&
              !f.closest('[style*="display: none"], [hidden]')) {
            return true;
          }
        }
        return false;
      }).catch(() => false);
    } catch {
      return false;
    }
  }

  async function isRecaptchaSolved() {
    try {
      return await page.evaluate(() => {
        const ta = document.querySelector('#g-recaptcha-response');
        if (ta && ta.value && ta.value.length > 20) return true;
        return !!document.querySelector('.recaptcha-checkbox-checked');
      });
    } catch {
      return false;
    }
  }

  async function hasCaptchaError() {
    try {
      return await page.locator('.andes-message--error, .captcha-error, [class*="captcha-error"], .andes-ui-message--error').count() > 0;
    } catch {
      return false;
    }
  }

  async function handleCaptchaAfterSubmit(stepLabel, refillField) {
    await page.waitForTimeout(4000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const needsCaptcha = await hasVisibleRecaptcha() || await hasCaptchaError();
      if (!needsCaptcha) {
        console.log(stepLabel + ': no captcha required, continuing.');
        return;
      }
      console.log(stepLabel + `: captcha required (attempt ${attempt + 1}), solving...`);
      const solved = await waitForRecaptchaSolved();
      if (!solved) return;
      if (refillField) await refillField();
      await randomDelay(500, 1500);
      console.log(stepLabel + ': re-submitting after captcha...');
      const native = await submitLoginFormNative();
      if (!native) await submitLoginForm();
      await page.waitForTimeout(3000);
    }
  }

  async function waitForRecaptchaSolved() {
    if (!(await hasVisibleRecaptcha())) return true;
    if (await isRecaptchaSolved()) return true;
    if (CAPSOLVER_API_KEY) {
      try {
        return await solveRecaptchaWithCapsolver();
      } catch (e) {
        if (/CAPTCHA_RESTART/i.test(e.message || '')) throw e;
        console.log('Capsolver failed (' + e.message + '), solve the reCAPTCHA manually in the browser window...');
      }
    } else {
      console.log('No Capsolver key found. Solve the reCAPTCHA manually in the browser window...');
    }
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (!(await hasVisibleRecaptcha())) {
        console.log('reCAPTCHA is no longer visible on the page, continuing.');
        return true;
      }
      if (await isRecaptchaSolved()) {
        console.log('reCAPTCHA solved.');
        return true;
      }
      await page.waitForTimeout(1000);
    }
    console.log('Timed out waiting for reCAPTCHA.');
    return false;
  }

  async function submitLoginForm() {
    const submit = page.locator('button.login-form__submit[type="submit"], #login_user_form button[type="submit"], #login_user_form input[type="submit"], button[type="submit"]').first();
    if (await submit.count() > 0) {
      const text = await submit.innerText().catch(() => '');
      console.log('Clicking submit button' + (text ? ` (${text.trim()})` : '') + '...');
      try {
        await submit.click();
      } catch {
        await submit.evaluate((el) => { el.click(); });
      }
    } else {
      await page.locator('#login_user_form').first().evaluate((form) => form.submit());
    }
  }

  // Full login flow: email -> password -> SMS -> OTP. Only runs when the sales
  // page redirected us to the login page (i.e. the session is not logged in).
  // Wrapped so a broken captcha state (Capsolver "Invalid input" / oversized
  // URL) auto-restarts the whole flow from scratch instead of hanging.
  const MAX_LOGIN_RESTARTS = 3;
  async function doLoginFlow() {
    for (let attempt = 1; attempt <= MAX_LOGIN_RESTARTS; attempt++) {
      try {
        await doLoginFlowOnce();
        return;
      } catch (e) {
        if (!/CAPTCHA_RESTART/i.test(e.message || '')) throw e;
        console.log(`Login captcha state broken (attempt ${attempt}/${MAX_LOGIN_RESTARTS}) - reloading and restarting the login flow from the beginning...`);
        await page.waitForTimeout(3000);
        await page.goto('https://vendedores.mercadolibre.cl/ventas/omni/listado', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
        if (await isCloudflareChallenge()) {
          await waitForChallengeToClear();
        }
      }
    }
    console.log('Login flow could not complete after several restarts.');
  }

  async function doLoginFlowOnce() {
    console.log('Page opened:', await page.title());

    // STEP 1: email / phone
    const emailFieldReady = await page.waitForSelector('#user_id, input[name="userId"]', { timeout: 30000 }).then(() => true).catch(() => false);
    const userField = page.locator('#user_id, input[name="userId"]').first();

    const ensureEmailFilled = async () => {
      if (!keys || !keys.email) return;
      try {
        const current = await userField.inputValue().catch(() => '');
        if (current !== keys.email) {
          console.log('Email field was empty/cleared, re-filling:', keys.email);
          await userField.click();
          await userField.fill(keys.email);
          await randomDelay(500, 1500);
        }
      } catch (e) {
        console.log('Could not re-fill email field:', e.message);
      }
    };

    if (emailFieldReady && await userField.count() > 0) {
      const current = await userField.inputValue().catch(() => '');
      if (!current && keys && keys.email) {
        await userField.click();
        await userField.fill(keys.email);
        const typed = await userField.inputValue().catch(() => '');
        if (typed === keys.email) {
          console.log('Email entered:', typed);
        } else {
          console.log('Email fill may have failed, current value:', typed);
        }
        await randomDelay(1000, 2500);
      } else if (current) {
        console.log('Email already filled in form:', current);
      }
      await randomDelay(500, 1500);
      const captchaBefore = await hasVisibleRecaptcha();
      if (captchaBefore) {
        console.log('Email step: reCAPTCHA visible on the form, solving before submit...');
        const solved = await waitForRecaptchaSolved();
        if (solved) {
          await ensureEmailFilled();
          await randomDelay(500, 1500);
          console.log('Email step: submitting with native form submit...');
          const native = await submitLoginFormNative();
          if (!native) await submitLoginForm();
        } else {
          console.log('Clicking Continuar...');
          await submitLoginForm();
        }
      } else {
        console.log('Clicking Continuar...');
        await submitLoginForm();
      }
      await handleCaptchaAfterSubmit('Email step', ensureEmailFilled);
    }

    try {
      await page.waitForTimeout(3000);
      console.log('After email step, URL:', shortUrl(page.url()));
    } catch (e) {
      console.log('Email step submitted, waiting for navigation:', e.message);
    }

    // STEP 1.5: challenge options list (Contraseña / SMS / WhatsApp / E-mail)
    const challengeList = page.locator('.challenge-options__list li.challenge-option');
    if (await challengeList.count() > 0) {
      console.log('Challenge options detected, clicking first option (Contraseña)...');
      const firstButton = challengeList.first().locator('button.andes-ui-list__item-actionable');
      try {
        await firstButton.click();
      } catch {
        await firstButton.evaluate((el) => { el.click(); });
      }
      await randomDelay(1500, 3000);
      console.log('After challenge option click, URL:', shortUrl(page.url()));
    }

    // STEP 2: password
    await page.waitForSelector('#password, input[name="password"]', { timeout: 30000 }).catch(() => {});
    const passwordField = page.locator('#password, input[name="password"]').first();

    const ensurePasswordFilled = async () => {
      if (!keys || !keys.password) return;
      try {
        const current = await passwordField.inputValue().catch(() => '');
        if (current !== keys.password) {
          console.log('Password field was empty/cleared, re-filling.');
          await passwordField.click();
          await passwordField.fill(keys.password);
          await randomDelay(500, 1500);
        }
      } catch (e) {
        console.log('Could not re-fill password field:', e.message);
      }
    };

    if (await passwordField.count() > 0) {
      if (keys && keys.password) {
        await passwordField.fill(keys.password);
        await randomDelay(1000, 2500);
        console.log('Password entered.');
      } else {
        console.log('Password field found but no password in keys.json. Type it manually in the browser window.');
      }
      await randomDelay(500, 1500);
      console.log('Clicking Confirmar...');
      const confirmButton = page.locator('button.password-form__button--complete[type="submit"]');
      let confirmClicked = false;
      for (let i = 0; i < 10; i++) {
        if (await confirmButton.count() > 0) {
          const disabled = await confirmButton.isDisabled().catch(() => true);
          if (!disabled) {
            try {
              await confirmButton.click();
            } catch {
              await confirmButton.evaluate((el) => { el.click(); });
            }
            confirmClicked = true;
            break;
          }
        }
        await page.waitForTimeout(1000);
      }
      if (!confirmClicked) {
        console.log('Confirmar button not ready, pressing Enter as fallback...');
        await passwordField.press('Enter').catch(async () => {
          await submitLoginForm();
        });
      }
    }

    try {
      await page.waitForTimeout(3000);
      console.log('After login, URL:', shortUrl(page.url()));
      console.log('After login, title:', await page.title());
    } catch (e) {
      console.log('Login submit done, waiting for navigation:', e.message);
    }
    await handleCaptchaAfterSubmit('Password step', ensurePasswordFilled);

    // Click the "Continuar" button that appears after the password step.
    // It can be a <button> or an <a> (Andes UI), so wait for a VISIBLE
    // instance instead of blindly clicking the first match (which may be a
    // hidden leftover from the email form).
    const continueButton = page.locator('button:has-text("Continuar"), a:has-text("Continuar")');
    let continueClicked = false;
    for (let i = 0; i < 30 && !continueClicked; i++) {
      const count = await continueButton.count();
      for (let j = 0; j < count; j++) {
        if (await continueButton.nth(j).isVisible().catch(() => false)) {
          console.log('Clicking Continuar...');
          try {
            await continueButton.nth(j).click();
          } catch {
            await continueButton.nth(j).evaluate((el) => { el.click(); });
          }
          continueClicked = true;
          break;
        }
      }
      if (!continueClicked) await page.waitForTimeout(1000);
    }
    if (continueClicked) {
      await randomDelay(1500, 3000);
      console.log('After Continuar, URL:', shortUrl(page.url()));
    }

    // NEW: 2FA landing page shows "Usa un segundo método..." with a blue
    // "Elegir método" button. The SMS/WhatsApp picker only appears AFTER
    // clicking it, so click it here if present.
    const elegirButton = page.locator('button:has-text("Elegir método"), button:has-text("Elegir metodo")');
    for (let i = 0; i < 15; i++) {
      let elegirClicked = false;
      const count = await elegirButton.count();
      for (let j = 0; j < count; j++) {
        if (await elegirButton.nth(j).isVisible().catch(() => false)) {
          console.log('Clicking Elegir método...');
          try {
            await elegirButton.nth(j).click();
          } catch {
            await elegirButton.nth(j).evaluate((el) => { el.click(); });
          }
          elegirClicked = true;
          break;
        }
      }
      if (elegirClicked) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);
    console.log('After Elegir método check, URL:', shortUrl(page.url()));

    // STEP 3: picker page - click SMS (fallback to WhatsApp, same phone_validation flow)
    const smsStrict = page.locator('button.andes-ui-list__item-actionable[aria-labelledby="sms-content"]');
    const smsText = page.locator('button:has-text("SMS"), li:has-text("SMS") button');
    const waStrict = page.locator('button.andes-ui-list__item-actionable[aria-labelledby="whatsapp-content"]');
    const waText = page.locator('button:has-text("WhatsApp")');
    let smsButton = smsStrict;
    let smsReady = await smsStrict.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (!smsReady) {
      console.log('Strict SMS selector not found, trying text-based SMS selector...');
      smsReady = await smsText.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      if (smsReady) smsButton = smsText;
    }
    if (!smsReady) {
      console.log('SMS option not found, trying WhatsApp fallback...');
      smsReady = await waStrict.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      if (smsReady) {
        smsButton = waStrict;
        console.log('WhatsApp option found, will use it instead of SMS.');
      } else {
        smsReady = await waText.first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        if (smsReady) {
          smsButton = waText;
          console.log('WhatsApp (text) option found, will use it instead of SMS.');
        }
      }
    }
    if (smsReady && await smsButton.count() > 0) {
      console.log('Clicking SMS option button...');
      try {
        await smsButton.first().click();
      } catch {
        await smsButton.first().evaluate((el) => { el.click(); });
      }
      await randomDelay(1500, 3000);
      console.log('SMS option clicked. URL:', shortUrl(page.url()));

      // STEP 3.5: wait for the OTP to arrive via the VPS OTP server (poll every
      // second), fill it in and confirm. If the code is not received, re-send it.
      // Keep the browser open after MAX_OTP_TRIES attempts.
      const MAX_OTP_TRIES = 4;
      const OTP_WAIT_MS = 45000;
      const OTP_POLL_MS = 1000;
      const otpStartTime = Date.now();

      const codeInputs = page.locator('input[data-andes-codeinput-input="true"]');

      async function enterOtpAndConfirm(code) {
        const otp = String(code);
        if (await codeInputs.count() >= 6) {
          console.log('Filling the 6 OTP digits into the code inputs...');
          for (let i = 0; i < 6; i++) {
            const input = codeInputs.nth(i);
            await input.click();
            await input.fill(otp[i] || '');
          }
          await randomDelay(500, 1500);
          const verifyButton = page.locator('button.validation-form__button--verify-code, button:has-text("Confirmar código")').first();
          if (await verifyButton.count() > 0) {
            console.log('Clicking Confirmar código...');
            try {
              await verifyButton.click();
            } catch {
              await verifyButton.evaluate((el) => { el.click(); });
            }
            await randomDelay(1500, 3000);
            console.log('Confirmar código clicked. URL:', shortUrl(page.url()));

            const errorText = await page.evaluate(() => {
              const helper = document.querySelector('.andes-helper--error [data-andes-helper-label="true"], .andes-helper__label[data-andes-helper-label="true"]');
              return helper ? helper.textContent.trim() : null;
            }).catch(() => null);
            if (errorText) {
              console.log('OTP error detected:', errorText);
              let waitMsg = '';
              try {
                const resendButton = page.locator('a.validation-form__button--send-code, a:has-text("Reenviar código")').first();
                const label = await resendButton.innerText().catch(() => '');
                const m = label.match(/en\s*(\d+):(\d+)/);
                if (m) {
                  const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
                  waitMsg = ` Next OTP will be sent in ${sec}s.`;
                }
              } catch {}
              return false;
            }
            return true;
          }
          console.log('Confirmar código button not found.');
        } else {
          console.log('OTP code inputs not found on the page.');
        }
        return false;
      }

      let otpEntered = false;

      const clickResend = async () => {
        const resendButton = page.locator('a.validation-form__button--send-code, a:has-text("Reenviar código")').first();
        if (await resendButton.count() > 0) {
          // The button is disabled with a cooldown timer (e.g. "Reenviar código en 00:23").
          // Parse the countdown from the label text and wait until it becomes enabled.
          for (let i = 0; i < 180; i++) {
            const disabled = await resendButton.isDisabled().catch(() => false);
            const hasDisabledAttr = await resendButton.getAttribute('disabled').then((v) => v !== null).catch(() => false);
            if (!disabled && !hasDisabledAttr) break;
            const label = await resendButton.innerText().catch(() => '');
            const m = label.match(/en\s*(\d+):(\d+)/);
            const remainingSec = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
            if (remainingSec !== null && remainingSec > 0) {
              console.log(`Resend cooldown: ${remainingSec}s remaining, waiting...`);
              await sleep(1000);
            } else {
              await sleep(1000);
            }
          }
          console.log('Clicking "Reenviar código"...');
          try {
            await resendButton.click();
          } catch {
            await resendButton.evaluate((el) => { el.click(); });
          }
          await randomDelay(1500, 3000);
          console.log('Reenviar código clicked. URL:', shortUrl(page.url()));
        } else {
          console.log('Reenviar código button not found.');
        }
      };

      // Retry loop: try to get + enter the OTP up to MAX_OTP_TRIES times.
      for (let tryNum = 1; tryNum <= MAX_OTP_TRIES && !otpEntered; tryNum++) {
        console.log(`OTP attempt ${tryNum}/${MAX_OTP_TRIES}...`);
        if (tryNum > 1) {
          await clickResend();
        }

        const attemptDeadline = Date.now() + OTP_WAIT_MS;
        while (Date.now() < attemptDeadline && !otpEntered) {
          await sleep(OTP_POLL_MS);
          const lastOtp = await fetchLatestOtpFromServer();
          if (lastOtp && lastOtp.receivedAt > otpStartTime && (!lastOtp.store || lastOtp.store === 'mercadolibre')) {
            console.log('OTP received via OTP server:', lastOtp.code, lastOtp.store ? `[${lastOtp.store}]` : '');
            otpEntered = await enterOtpAndConfirm(lastOtp.code);
            if (!otpEntered) {
              console.log('OTP was rejected.');
            }
          }
        }
      }

      if (!otpEntered) {
        console.log(`OTP not received after ${MAX_OTP_TRIES} tries. Closing the browser.`);
        await sendTelegramMessage(`${recipientMentions()}MercadoLibre OTP was not received after ${MAX_OTP_TRIES} attempts. Closing the browser.`);
        await context.close();
        console.log('Browser closed.');
        process.exit(0);
      }
    } else {
      console.log('SMS option button not found on the final page.');
      try { await context.close(); } catch {}
      console.log('Browser closed.');
      process.exit(1);
      return;
    }
  }

  // Open MercadoLibre first, wait 2 seconds, then open the sales list page.
  await page.goto('https://www.mercadolibre.cl/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.goto('https://vendedores.mercadolibre.cl/ventas/omni/listado', { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (await isCloudflareChallenge()) {
    await waitForChallengeToClear();
  }

  // SESSION CHECK: if the session is logged in, the sales page loads normally.
  // If not, MercadoLibre redirects to the login page automatically.
  let onLoginPage = false;
  for (let i = 0; i < 30; i++) {
    if (page.url().includes('/msl/login') || (await page.locator('#user_id, input[name="userId"]').count()) > 0) {
      onLoginPage = true;
      break;
    }
    if ((await page.locator('button.andes-dropdown__trigger').count()) > 0) {
      onLoginPage = false;
      break;
    }
    await page.waitForTimeout(1000);
  }
  onLoginPage = onLoginPage || page.url().includes('/msl/login');

  if (onLoginPage) {
    console.log('Not logged in, redirected to the login page. URL:', shortUrl(page.url()));
    await doLoginFlow();
    console.log('Login flow completed. URL:', shortUrl(page.url()));
    await saveSessionCookies();

    // After a successful login (OTP), stay on the page it landed on
    // naturally for 2 seconds. The login flow usually redirects back to
    // the sales list page by itself, so wait for that natural redirect
    // instead of forcing a goto (which triggers "navigation interrupted
    // by another navigation" errors). If it never happens, do a full
    // refresh.
    console.log('Staying on the post-login page for 2 seconds...');
    await page.waitForTimeout(2000);
    try {
      await page.waitForURL(/\/ventas\/omni\/listado/, { timeout: 20000 });
      console.log('Natural redirect to the sales list page detected.');
    } catch {
      console.log('Natural redirect not detected. Doing a full refresh...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    if (await isCloudflareChallenge()) {
      await waitForChallengeToClear();
    }
  } else {
    console.log('Already logged in. URL:', shortUrl(page.url()));
  }

  // Download yesterday's sales report and upload it to Google Drive.
  // On failure, go back to the post-login landing page (home -> sales list)
  // and redo the whole workflow instead of waiting for manual handling.
  const MAX_REPORT_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt++) {
    try {
      // First pass reuses the startup navigation; retries start from the
      // home page like a fresh run (skipInitialNav = false).
      await downloadSalesReport(attempt === 1 ? onLoginPage : false);
      console.log('Sales report flow completed. Closing the browser.');
      await saveSessionCookies();
      await context.close();
      console.log('Browser closed.');
      process.exit(0);
    } catch (e) {
      console.log(`Sales report flow failed (attempt ${attempt}/${MAX_REPORT_ATTEMPTS}):`, e.message);
      if (attempt >= MAX_REPORT_ATTEMPTS) break;

      // The browser itself may have died (e.g. Chrome crashed during the
      // download: "Target page, context or browser has been closed").
      // Relaunch a fresh browser instead of crashing on a dead page handle.
      if (!isBrowserAlive()) {
        console.log('Browser/context is dead - relaunching a fresh browser...');
        try { await context.close(); } catch {}
        try {
          ({ context, page } = await launchBrowser());
          await restoreSessionCookies();
          console.log('Relaunched. Retrying the workflow from the home page...');
        } catch (relaunchErr) {
          console.log('Relaunch failed:', relaunchErr.message);
          break;
        }
      } else {
        console.log('Restarting the whole workflow from the home page...');
        await page.waitForTimeout(5000).catch(() => {});
      }

      // If the session was lost, run the login flow again before retrying.
      try {
        let needsLogin = false;
        for (let i = 0; i < 10; i++) {
          if (page.url().includes('/msl/login') || (await page.locator('#user_id, input[name="userId"]').count()) > 0) {
            needsLogin = true;
            break;
          }
          if ((await page.locator('button.andes-dropdown__trigger').count()) > 0) break;
          await page.waitForTimeout(1000);
        }
        if (needsLogin || page.url().includes('/msl/login')) {
          console.log('Session lost, redirected to the login page. Running the login flow again...');
          await doLoginFlow();
          await saveSessionCookies();
          await page.waitForTimeout(2000);
          try {
            await page.waitForURL(/\/ventas\/omni\/listado/, { timeout: 20000 });
            console.log('Natural redirect to the sales list page detected.');
          } catch {
            console.log('Natural redirect not detected. Doing a full refresh...');
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          }
          if (await isCloudflareChallenge()) {
            await waitForChallengeToClear();
          }
        }
      } catch (recoveryErr) {
        console.log('Recovery check failed:', recoveryErr.message, '- retrying the report flow directly.');
      }
      onLoginPage = false;
    }
  }

  // All attempts failed — fully automatic
  await sendTelegramMessage(`${recipientMentions()}MercadoLibre download failed after ${MAX_REPORT_ATTEMPTS} attempts`);
  try { await context.close(); } catch {}
  console.log('Browser closed.');
  process.exit(1);
})();