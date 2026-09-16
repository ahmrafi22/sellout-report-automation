import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { sendTelegramMessage, getConfigRecipients } from './telegram.js';
import { getDrive, ensureFolder } from './drive.js';
import { summarizeReport } from './ai-analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Camoufox } = require('camoufox');

const userDataDir = path.join(__dirname, 'camoufox-profile');
const sessionCookiesFile = path.join(userDataDir, 'wallmart_cookie.json');
const submittedJobsFile = path.join(__dirname, 'submitted_jobs.json');

// Track which reports have already been submitted (and their Job Ids) so a
// report is never clicked/submitted twice - the site blocks duplicate Run Now.
function loadSubmittedJobs() {
  try {
    return JSON.parse(readFileSync(submittedJobsFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveSubmittedJobs(jobs) {
  try {
    writeFileSync(submittedJobsFile, JSON.stringify(jobs, null, 2));
  } catch (e) {
    console.log('Could not save submitted jobs state:', e.message);
  }
}

const COOKIE_FILTER = /walmart|wal-mart|retaillink/i;

const HEADLESS = false //process.env.HEADLESS !== '0';

const LOGIN_URL = 'https://retaillink.login.wal-mart.com/login';
const PORTAL_URL = 'https://retaillink2.wal-mart.com/rl_portal/#/';

// The saved report the automated flow runs on (the flow is identical for
// every report - the tree id is discovered dynamically by name).
// The saved reports the automated flow runs on (the flow is identical for
// every report - the tree id is discovered dynamically by name). All three
// are submitted first, then each file is downloaded as soon as it is Done.
const TARGET_REPORTS = [
  'Sell out for Store diario',
  // 'Stock en CD All warehouses diario',
  // 'Stock en salas diario',
];

let keys;
try {
  const parsed = JSON.parse(readFileSync(path.join(__dirname, 'keys.json'), 'utf8'));
  keys = parsed.walmart || parsed['wall-mart'] || null;
} catch {
  keys = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function randomDelay(minMs, maxMs) {
  await sleep(minMs + Math.floor(Math.random() * (maxMs - minMs)));
}

function recipientMentions() {
  const names = getConfigRecipients()
    .map((r) => (typeof r === 'object' && r && r.username ? r.username : null))
    .filter(Boolean);
  return names.length ? names.join(', ') + ', ' : '';
}

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

const downloadsDir = path.join(__dirname, 'downloads');
if (!existsSync(downloadsDir)) mkdirSync(downloadsDir, { recursive: true });
let drive = null;
try {
  drive = getDrive();
} catch (e) {
  console.error('Drive setup skipped (' + e.message + '). Uploads will be skipped, file kept locally.');
}

// Today's date in the same dd-mm-yy format used for the file suffix.
function todayStr() {
  const d = new Date();
  return [
    String(d.getDate()).padStart(2, '0'),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getFullYear()).slice(-2),
  ].join('-');
}

// Short display labels for the Telegram upload notification.
const SHORT_LABELS = {
  'Sell out for Store diario': 'sell out',
  'Stock en CD All warehouses diario': 'stock cd',
  'Stock en salas diario': 'stock salas',
};

// Upload one report to fbusinesscenter/Wallmart/<today>/ and notify Telegram.
async function uploadReportToDrive(filePath, shortLabel) {
  if (!drive) {
    console.log('Drive not configured. Keeping local file:', filePath);
    return;
  }
  const fileName = path.basename(filePath);
  try {
    const { markdown } = await summarizeReport({ store: 'Walmart', report: shortLabel, filePath });
    console.log('AI analysis:\n' + markdown);
  } catch (e) {
    console.error('AI analysis skipped:', e.message);
  }
  const rootFolder = await ensureFolder('fbusinesscenter', 'root');
  const tenantFolder = await ensureFolder('Wallmart', rootFolder.id);
  const target = await ensureFolder(todayStr(), tenantFolder.id);
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

  console.log(`${existingFile ? 'Drive file updated' : 'Drive upload OK'}: ${res.data.name} -> fbusinesscenter/Wallmart/${todayStr()}`);
  console.log('Link:', res.data.webViewLink);

  await sendTelegramMessage(`wallmart ${shortLabel} file uploaded.`);

  await unlink(filePath);
  console.log('Removed local file:', filePath);
}

// Poll every frame of a page until one contains the given selector.
async function findFrameContaining(pageObj, selector, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of pageObj.frames()) {
      try {
        if (await f.locator(selector).count()) return f;
      } catch {}
    }
    await sleep(500);
  }
  return null;
}

// Yesterday's date in the site's MM-DD-YYYY mask format.
function yesterdayStr() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}-${d.getFullYear()}`;
}

// Search every page/window and every frame for the Report Builder time tree.
async function findTimeTreeFrame(ctx, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    for (const pg of ctx.pages()) {
      for (const fr of pg.frames()) {
        try {
          // NOTE: ids like "204F1000010Parent" start with a digit, so
          // "#204..." is invalid CSS - use an attribute selector instead.
          if (await fr.locator('[id="204F1000010Parent"]').count()) return { page: pg, frame: fr };
        } catch {}
      }
    }
    if (Date.now() - lastLog > 8000) {
      lastLog = Date.now();
      console.log(`RB: waiting for time tree... pages=${ctx.pages().length}`);
      for (const pg of ctx.pages()) {
        for (const fr of pg.frames()) {
          try {
            const has = await fr.evaluate(() => !!document.body && document.body.innerHTML.indexOf('Pos Date') >= 0).catch(() => false);
            if (has) console.log('RB: "Pos Date" text found in page:', pg.url(), '| frame:', fr.url());
          } catch {}
        }
      }
    }
    await sleep(500);
  }
  return null;
}

// Known Playwright internal crash: pageError.location is undefined on Firefox
// (site JS error thrown without a usable stack), which kills the Node process.
// Exit with a retryable code instead of a raw stack trace so run-all.js can
// re-run the whole workflow.
process.on('uncaughtException', (err) => {
  if (err && /Cannot read properties of undefined \(reading 'url'\)/.test(err.message)) {
    console.log('Known Playwright pageError crash detected - exiting to retry the workflow.');
    process.exit(7);
  }
  throw err;
});

(async () => {
  console.log('Launching Camoufox (Firefox, Windows fingerprint)...');
  const context = await Camoufox({
    os: 'windows',
    headless: HEADLESS,
    locale: 'en-US',
    humanize: false,
    data_dir: userDataDir,
    viewport: null,
    noViewport: true,
  });
  try {
    await context.acceptDownloads(true);
  } catch {}

  const page = typeof context.pages === 'function'
    ? (context.pages()[0] || await context.newPage())
    : await context.newPage();

  // Restore the last saved Walmart session cookies so the session survives
  // even if the profile's own cookie DB is reset.
  try {
    if (existsSync(sessionCookiesFile)) {
      const cookies = JSON.parse(readFileSync(sessionCookiesFile, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
        console.log(`Restored ${cookies.length} saved Walmart session cookies.`);
      }
    }
  } catch (e) {
    console.log('Could not restore session cookies:', e.message);
  }

  let lastSavedCookieJson = null;

  async function saveSessionCookies() {
    try {
      const u = page.url() || '';
      // Never overwrite a good saved session with a pre-auth (login/MFA) state.
      if (u.includes('/login') || u.includes('/mfa')) return;
      const cookies = (await context.cookies()).filter((c) => COOKIE_FILTER.test(c.domain || ''));
      const json = JSON.stringify(cookies, null, 2);
      if (json === lastSavedCookieJson) return; // nothing changed since last save
      mkdirSync(path.dirname(sessionCookiesFile), { recursive: true });
      writeFileSync(sessionCookiesFile, json);
      lastSavedCookieJson = json;
      console.log(`Saved ${cookies.length} Walmart session cookies.`);
    } catch (e) {
      if (/has been closed|closed/i.test(e.message || '')) return; // interval fired after browser exit - nothing to do
      console.log('Could not save session cookies:', e.message);
    }
  }

  // Best-effort save when the script is stopped with Ctrl+C.
  process.on('SIGINT', () => {
    saveSessionCookies().finally(() => process.exit(0));
  });

  const loginBtn = page.locator('button[data-automation-id="loginBtn"]');

  const unameField = page.locator('input[data-automation-id="uname"], input[name*="user" i], input[type="email"]').first();
  const pwdField = page.locator('input[data-automation-id="pwd"], input[type="password"]').first();

  // Wait for both login fields, fill them with the saved credentials and
  // verify the values actually landed. Returns true only when both are filled
  // (matching keys.json when credentials are configured).
  async function fillLoginFields(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await unameField.count()) > 0 && (await pwdField.count()) > 0) break;
      await sleep(500);
    }
    if ((await unameField.count()) === 0 || (await pwdField.count()) === 0) {
      console.log(`Login fields missing: user=${(await unameField.count()) > 0 ? 'ok' : 'NOT FOUND'}, pass=${(await pwdField.count()) > 0 ? 'ok' : 'NOT FOUND'}`);
      return false;
    }
    const wantU = keys && keys.email;
    const wantP = keys && keys.password;
    if (wantU && (await unameField.inputValue().catch(() => '')) !== wantU) {
      await unameField.click();
      await unameField.fill(wantU);
      await randomDelay(800, 1500);
    }
    if (wantP && (await pwdField.inputValue().catch(() => '')) !== wantP) {
      await pwdField.click();
      await pwdField.fill(wantP);
      await randomDelay(800, 1500);
    }
    const gotU = await unameField.inputValue().catch(() => '');
    const gotP = await pwdField.inputValue().catch(() => '');
    const uOk = gotU.length > 0 && (!wantU || gotU === wantU);
    const pOk = gotP.length > 0 && (!wantP || gotP === wantP);
    console.log(`Login fields: user=${uOk ? gotU : 'INVALID'}, pass=${pOk ? 'filled' : 'INVALID'}`);
    return uOk && pOk;
  }

  async function isPxCaptchaVisible() {
    try {
      return await page.evaluate(() => {
        const host = document.querySelector('#px-captcha');
        if (host) {
          const r = host.getBoundingClientRect();
          const style = window.getComputedStyle(host);
          if (style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0) return true;
        }
        return false;
      }).catch(() => false);
    } catch {
      return false;
    }
  }

  async function findPxChallengeFrame() {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try {
        const hasFill = await f.evaluate(() => {
          const el = document.querySelector('#vKJczLAjrOYTCzy');
          return !!el;
        });
        if (hasFill) return f;
      } catch {}
    }
    return null;
  }

  async function readFillWidth(frame) {
    try {
      return await frame.evaluate(() => {
        const el = document.querySelector('#vKJczLAjrOYTCzy');
        if (!el) return null;
        const w = parseFloat(el.style.width);
        if (!isNaN(w)) return w;
        return el.getBoundingClientRect().width;
      });
    } catch {
      return null;
    }
  }

  async function isCheckmarkVisible(frame) {
    try {
      return await frame.evaluate(() => {
        const c = document.querySelector('#checkmark');
        if (!c) return false;
        const s = window.getComputedStyle(c);
        const r = c.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
    } catch {
      return false;
    }
  }

  async function findPxCaptchaBox() {
    try {
      return await page.evaluate(() => {
        const host = document.querySelector('#px-captcha');
        if (!host) return null;
        const r = host.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }).catch(() => null);
    } catch {
      return null;
    }
  }

  async function getPxButtonPoint() {
    const frame = await findPxChallengeFrame();
    if (!frame) return null;
    try {
      const frameBox = await frame.frameElement().boundingBox();
      if (!frameBox) return null;
      const rect = await frame.evaluate(() => {
        const el = document.querySelector('#vKJczLAjrOYTCzy');
        const pill = el && el.parentElement ? el.parentElement : null;
        const anchor = pill || document.querySelector('#xfrNIXUDuOQhokM') || el;
        if (!anchor) return null;
        const r = anchor.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      if (!rect) return null;
      return {
        x: frameBox.x + rect.x + rect.width / 2,
        y: frameBox.y + rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
      };
    } catch {
      return null;
    }
  }

  async function waitForHoldTargetStable(maxWaitMs = 12000) {
    const start = Date.now();
    let last = null;
    let stableCount = 0;
    while (Date.now() - start < maxWaitMs) {
      const cur = await getPxButtonPoint();
      if (cur) {
        if (last && Math.abs(cur.x - last.x) < 2 && Math.abs(cur.y - last.y) < 2) {
          stableCount++;
          if (stableCount >= 2) return cur;
        } else {
          stableCount = 0;
        }
        last = cur;
      }
      await sleep(150);
    }
    return last;
  }

  async function solvePxPressHold() {
    console.log('PX: solving press-and-hold challenge...');
    for (let attempt = 1; attempt <= 5; attempt++) {
      let box = await findPxCaptchaBox();
      if (!box) {
        console.log(`PX: attempt ${attempt} - captcha box not found, retrying...`);
        await sleep(2000);
        continue;
      }
      await page.evaluate(() => {
        const host = document.querySelector('#px-captcha');
        if (host) host.scrollIntoView({ block: 'center', inline: 'center' });
      }).catch(() => {});
      await sleep(150);
      const settled = await waitForHoldTargetStable();
      let target = settled || await getPxButtonPoint();
      box = await findPxCaptchaBox();
      if (!target && box) {
        target = {
          x: box.x + box.width * 0.45,
          y: box.y + box.height * 0.5,
          width: box.width,
          height: box.height,
        };
      }
      if (!target) {
        console.log(`PX: attempt ${attempt} - could not locate hold target, retrying...`);
        await sleep(2000);
        continue;
      }
      let cx = target.x + (Math.random() - 0.5) * 6;
      let cy = target.y + (Math.random() - 0.5) * 6;
      console.log(`PX: attempt ${attempt} - pressing and holding button at (${Math.round(cx)}, ${Math.round(cy)}), button=${Math.round(target.width)}x${Math.round(target.height)}...`);
      // Enter the widget from outside, like a human would
      await page.mouse.move(target.x + target.width / 2 + 140, cy - 30);
      await page.mouse.move(target.x + target.width / 2 + 80, cy - 12);
      await page.mouse.move(cx + 24, cy - 6);
      await page.mouse.move(cx + 10, cy + 3);
      await page.mouse.move(cx, cy);
      await sleep(150 + Math.floor(Math.random() * 200));
      // Re-check the button position right before pressing in case the layout shifted
      const fresh = await getPxButtonPoint();
      if (fresh) {
        cx = fresh.x + (Math.random() - 0.5) * 6;
        cy = fresh.y + (Math.random() - 0.5) * 6;
        await page.mouse.move(cx, cy);
        await sleep(120 + Math.floor(Math.random() * 120));
      }
      await page.mouse.down();
      const holdStart = Date.now();
      const maxHoldMs = 25000;
      let released = 'timeout';
      let fillCompleteLogged = false;
      while (Date.now() - holdStart < maxHoldMs) {
        if (!(await isPxCaptchaVisible())) {
          released = 'captcha-gone';
          break;
        }
        if (await loginBtn.count() === 0 || !page.url().includes('/login')) {
          released = 'navigated';
          break;
        }
        // Follow the button if the page layout shifts during the hold
        const cur = await getPxButtonPoint();
        if (cur && (Math.abs(cur.x - cx) > 3 || Math.abs(cur.y - cy) > 3)) {
          cx = cur.x + (Math.random() - 0.5) * 4;
          cy = cur.y + (Math.random() - 0.5) * 4;
        }
        const frame = await findPxChallengeFrame();
        if (frame) {
          const width = await readFillWidth(frame);
          if (width != null && !fillCompleteLogged && width >= 260) {
            fillCompleteLogged = true;
            console.log(`PX: attempt ${attempt} - fill complete (${Math.round(width)}px), holding for auto-submit...`);
          }
          if (await isCheckmarkVisible(frame)) {
            released = 'checkmark';
            break;
          }
        }
        const t = Date.now() - holdStart;
        await page.mouse.move(
          cx + Math.sin(t / 90) * 1.2 + (Math.random() - 0.5) * 0.4,
          cy + Math.cos(t / 110) * 1.2 + (Math.random() - 0.5) * 0.4,
        );
        await sleep(100 + Math.floor(Math.random() * 60));
      }
      await page.mouse.up();
      console.log(`PX: attempt ${attempt} - released (${released}). Waiting for validation...`);
      const deadline = Date.now() + 20000;
      let solved = false;
      while (Date.now() < deadline) {
        if (!(await isPxCaptchaVisible())) {
          solved = true;
          break;
        }
        if (await loginBtn.count() === 0 || !page.url().includes('/login')) {
          solved = true;
          break;
        }
        const btnEnabled = await page.evaluate(() => {
          const btn = document.querySelector('button[data-automation-id="loginBtn"]');
          return !!btn && !btn.disabled && btn.getAttribute('disabled') === null;
        }).catch(() => false);
        if (btnEnabled) {
          solved = true;
          break;
        }
        await sleep(500);
      }
      if (solved) {
        console.log('PX: press-and-hold solved!');
        return true;
      }
      console.log(`PX: attempt ${attempt} - still showing captcha, retrying...`);
    }
    return false;
  }

  async function handlePxCaptcha() {
    if (!(await isPxCaptchaVisible())) return;
    console.log('PerimeterX captcha detected. Complete the Press & Hold challenge manually.');
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (!(await isPxCaptchaVisible())) {
        console.log('PX captcha cleared manually.');
        return;
      }
      await sleep(2000);
    }
    console.log('Timed out waiting for PX captcha.');
  }

  async function attemptPxAutoSolve() {
    if (await solvePxPressHold()) return true;
    console.log('PX: auto-solve failed, waiting for manual solving...');
    await handlePxCaptcha();
    return false;
  }

  const waitForLoginBtnEnabled = async (timeoutMs = 45000) => {
    try {
      await page.waitForFunction(() => {
        const btn = document.querySelector('button[data-automation-id="loginBtn"]');
        return btn && !btn.disabled && btn.getAttribute('disabled') === null;
      }, { timeout: timeoutMs });
      console.log('LOG IN button enabled.');
      return true;
    } catch {
      console.log('LOG IN button still disabled after wait.');
      return false;
    }
  };

  const clickLoginBtn = async () => {
    if (await loginBtn.count() === 0) return false;
    if (!(await fillLoginFields())) {
      console.log('LOG IN not clicked - fields not filled.');
      return false;
    }
    console.log('Clicking LOG IN...');
    try {
      await loginBtn.click();
    } catch {
      await loginBtn.evaluate((el) => { el.click(); });
    }
    return true;
  };

  const waitForPxOrNavigation = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await loginBtn.count() === 0) return 'navigated';
      if (!page.url().includes('/login')) return 'navigated';
      if (await isPxCaptchaVisible()) return 'px';
      await sleep(500);
    }
    return 'nothing';
  };

  // Report Builder: Times -> Time Range 1 -> Pos Date -> "Time Range 1 Is
  // Between" -> load the existing filter (select + Modify) -> set both dates
  // to yesterday -> apply with "And".
  async function configureReportBuilderTimes(builderPage) {
    try {
      // STEP A: "Times" in the left menu.
      let f = await findFrameContaining(builderPage, 'a#step4a');
      if (!f) {
        console.log('RB: "Times" link not found.');
        return false;
      }
      console.log('RB: clicking "Times"...');
      try {
        await f.locator('a#step4a').first().click({ timeout: 8000, force: true });
      } catch {
        await f.locator('a#step4a').first().evaluate((el) => { el.click(); });
      }
      await sleep(1500);

      // STEP B: "Time Range 1" submenu link.
      f = await findFrameContaining(builderPage, 'a.leftlink#F1000010');
      if (!f) {
        console.log('RB: "Time Range 1" link not found.');
        return false;
      }
      console.log('RB: clicking "Time Range 1"...');
      try {
        await f.locator('a.leftlink#F1000010').first().click({ timeout: 8000, force: true });
      } catch {
        await f.locator('a.leftlink#F1000010').first().evaluate((el) => { el.click(); });
      }
      await sleep(2000);

      // STEP C: wait for the time tree to load (takes 2-3s), then
      // double-click the "Pos Date. (mm/dd/yyyy)" node to reveal the dates.
      // The tree renders deep inside content_4's nested frames - search every
      // page and frame in the context in case it opened elsewhere.
      const treeHit = await findTimeTreeFrame(context, 60000);
      if (!treeHit) {
        console.log('RB: Pos Date folder not found in any frame.');
        return false;
      }
      f = treeHit.frame;
      console.log('RB: time tree loaded in frame:', f.url());
      await sleep(1500);
      const posLabel = f.locator('a[id="204F1000010"]').first();
      const posItem = f.locator('a[id="204comma8F1000010"]');
      let itemVisible = false;
      for (let attempt = 1; attempt <= 3 && !itemVisible; attempt++) {
        const childVisible = await f.evaluate(() => {
          const c = document.getElementById('204F1000010Child');
          return !!c && c.style.display !== 'none' && c.children.length > 0;
        }).catch(() => false);
        if (!childVisible) {
          console.log(`RB: double-clicking "Pos Date. (mm/dd/yyyy)" (attempt ${attempt})...`);
          try {
            await posLabel.dblclick({ timeout: 10000 });
          } catch {
            await posLabel.evaluate((el) => {
              el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
            }).catch(() => {});
          }
        }
        itemVisible = await posItem.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
      }
      if (!itemVisible) {
        console.log('RB: "Time Range 1 Is Between" item did not appear.');
        return false;
      }
      console.log('RB: clicking "Time Range 1 Is Between"...');
      try {
        await posItem.click({ timeout: 8000, force: true });
      } catch {
        await posItem.evaluate((el) => { el.click(); });
      }
      await sleep(2000);

      // STEP D: delete every existing "Pos Date / Time Range 1" entry from
      // the TIMES step's #filllist. The filllist lives in the filter_values
      // iframe that is a DIRECT child of the step-4 Bot_Wiz_Right pane - the
      // Delete button must come from that same pane (other steps have their
      // own hidden panes and must NOT be used).
      await sleep(3000);
      const delDeadline = Date.now() + 30000;
      let removed = 0;
      let emptyChecks = 0;
      while (Date.now() < delDeadline) {
        const rightFrame = builderPage.frames().find((f) => {
          const u = f.url();
          return u.includes('Bot_Wiz_Right') && (u.includes('step=4') || u.includes('e_sel=E100001'));
        }) || null;
        const listFrame = rightFrame
          ? (rightFrame.childFrames().find((f) => f.url().includes('filter_values')) || null)
          : null;
        if (!rightFrame || !listFrame) {
          await sleep(500);
          continue;
        }

        const matchIdx = await listFrame.evaluate(() => {
          const s = document.getElementById('filllist');
          if (!s) return -1;
          for (let i = 0; i < s.options.length; i++) {
            const o = s.options[i];
            if (/pos date/i.test(o.textContent) && /time range 1/i.test(o.textContent)) return i;
          }
          return -1;
        }).catch(() => -1);

        if (matchIdx < 0) {
          emptyChecks++;
          if (emptyChecks >= 3) break;
          await sleep(1000);
          continue;
        }
        emptyChecks = 0;

        // Select inside the list, enable Delete without touching the page,
        // then click ONLY Delete (nothing else in between).
        let pickedText = '';
        try {
          const sel = listFrame.locator('select[id="filllist"]').first();
          pickedText = ((await sel.locator('option').nth(matchIdx).textContent().catch(() => '')) || '').trim();
          await sel.selectOption({ index: matchIdx });
        } catch {
          await listFrame.evaluate((i) => {
            const s = document.getElementById('filllist');
            s.selectedIndex = i;
            if (s.options[i]) s.options[i].selected = true;
          }, matchIdx).catch(() => {});
        }
        await listFrame.evaluate(() => {
          try {
            if (parent && typeof parent.toggleButtons === 'function') parent.toggleButtons();
          } catch {}
        }).catch(() => {});

        console.log(`RB: selected for deletion: ${pickedText}`);
        const delBtn = rightFrame.locator('input[id="Delete"]').first();
        let clicked = false;
        try {
          await delBtn.click({ timeout: 5000, force: true });
          clicked = true;
        } catch {}
        if (!clicked) {
          await delBtn.evaluate((el) => {
            el.disabled = false;
            el.click();
          }).catch(() => {});
        }
        await sleep(1800);
        removed++;
      }
      console.log(removed ? `RB: removed ${removed} old entry(ies).` : 'RB: no existing Pos Date entries found.');

      // STEP E: set both date inputs to yesterday and apply with "And".
      const valFrame = await findFrameContaining(builderPage, '#firstValue');
      if (!valFrame) {
        console.log('RB: #firstValue input not found.');
        return false;
      }
      const yest = yesterdayStr();
      const firstVal = valFrame.locator('#firstValue').first();
      const lastVal = valFrame.locator('#lastValue').first();
      await firstVal.fill('');
      await firstVal.fill(yest);
      await lastVal.fill('');
      await lastVal.fill(yest);
      const gotFirst = await firstVal.inputValue().catch(() => '');
      const gotLast = await lastVal.inputValue().catch(() => '');
      console.log(`RB: dates set - first="${gotFirst}" last="${gotLast}" (yesterday=${yest})`);
      if (gotFirst !== yest || gotLast !== yest) {
        console.log('RB: WARNING - date inputs do not match yesterday after fill.');
      }

      const andBtn = valFrame.locator('input#btnAnd').first();
      if (await andBtn.count()) {
        console.log('RB: clicking "And" to apply the filter...');
        // Try multiple click strategies to ensure the filter is actually applied.
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await andBtn.click({ timeout: 8000 });
          } catch {
            await andBtn.evaluate((el) => { el.click(); });
          }
          await sleep(2500);

          // Check if the filter list updated after this click.
          const checkNow = await (async () => {
            for (const fr of builderPage.frames()) {
              const found = await fr.evaluate((y) => {
                const t = document.body ? document.body.innerText : '';
                const d = y.replace(/-/g, '[-/]');
                return new RegExp('Pos Date[\\s\\S]{0,120}' + d + '[\\s\\S]{0,15}and[\\s\\S]{0,15}' + d, 'i').test(t);
              }, yest).catch(() => false);
              if (found) return true;
            }
            return false;
          })();
          if (checkNow) {
            console.log(`RB: "And" applied on attempt ${attempt}.`);
            break;
          }
          console.log(`RB: "And" attempt ${attempt} - filter not yet applied, retrying...`);
          // Force a re-click via disabled override on the 2nd attempt.
          if (attempt === 2) {
            await andBtn.evaluate((el) => { el.disabled = false; el.click(); }).catch(() => {});
            await sleep(2000);
          }
        }
      } else {
        console.log('RB: "And" button not found.');
      }

      // Verify the applied filter now shows yesterday on both sides.
      let verified = false;
      const vDeadline = Date.now() + 20000;
      while (Date.now() < vDeadline && !verified) {
        for (const fr of builderPage.frames()) {
          const found = await fr.evaluate((y) => {
            const t = document.body ? document.body.innerText : '';
            const d = y.replace(/-/g, '[-/]');
            return new RegExp('Pos Date[\\s\\S]{0,120}' + d + '[\\s\\S]{0,15}and[\\s\\S]{0,15}' + d, 'i').test(t);
          }, yest).catch(() => false);
          if (found) {
            verified = true;
            break;
          }
        }
        if (!verified) await sleep(1000);
      }
      if (!verified) {
        throw new Error(`Filter verification failed - dates ${yest} not found in filter list after "And" click.`);
      }
      console.log(`RB: VERIFIED - filter list shows Pos Date between ${yest} and ${yest}.`);
      return true;
    } catch (e) {
      console.log('RB: configure failed:', e.message);
      return false;
    }
  }

  // Report Builder (one report): Submit -> Save (accept any browser alert) ->
  // Run Now -> wait for "Query Submitted" -> parse the Job Id -> close the
  // builder window. Returns the job id (string) or null.
  async function submitReportAndGetJobId(builderPage, reportName) {
    builderPage.on('dialog', (d) => {
      console.log('RB: accepting browser dialog:', String(d.message()).slice(0, 120));
      d.accept().catch(() => {});
    });

    // STEP F: "Submit" in the menu frame.
    let f = await findFrameContaining(builderPage, 'a#step6a');
    if (!f) {
      console.log('RB: Submit link not found.');
      return null;
    }
    console.log('RB: clicking Submit...');
    try {
      await f.locator('a#step6a').first().click({ timeout: 8000, force: true });
    } catch {
      await f.locator('a#step6a').first().evaluate((el) => { el.click(); });
    }
    await sleep(2500);

    // STEP G: Save.
    f = await findFrameContaining(builderPage, 'input[id="btnsave"]');
    if (!f) {
      console.log('RB: Save button not found.');
      return null;
    }
    console.log('RB: clicking Save...');
    try {
      await f.locator('input[id="btnsave"]').first().click({ timeout: 8000 });
    } catch {
      await f.locator('input[id="btnsave"]').first().evaluate((el) => { el.click(); });
    }
    await sleep(2500);

    // STEP H: Run Now.
    f = await findFrameContaining(builderPage, 'input[id="subnow"]');
    if (!f) {
      console.log('RB: Run Now button not found.');
      return null;
    }
    console.log('RB: clicking Run Now...');
    try {
      await f.locator('input[id="subnow"]').first().click({ timeout: 8000 });
    } catch {
      await f.locator('input[id="subnow"]').first().evaluate((el) => { el.click(); });
    }

    // STEP I: wait for "Query Submitted / Job Id = ..." and parse the id.
    let jobId = null;
    const sDeadline = Date.now() + 45000;
    while (Date.now() < sDeadline && !jobId) {
      for (const fr of builderPage.frames()) {
        const t = await fr.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        if (/Query Submitted/i.test(t)) {
          const m = t.match(/Job\s*Id\s*[=:]\s*(\d+)/i);
          if (m) jobId = m[1];
          break;
        }
      }
      if (!jobId) await sleep(1000);
    }
    if (jobId) {
      console.log(`RB: "${reportName}" submitted - Job Id = ${jobId}`);
    } else {
      console.log('RB: WARNING - did not see "Query Submitted" within timeout.');
    }

    // STEP J: close the whole Report Builder window.
    await sleep(2000);
    try {
      await builderPage.close();
      console.log('RB: builder window closed.');
    } catch {
      console.log('RB: builder window already closed.');
    }
    await sleep(1000);
    return jobId;
  }

  // Phase 2: on the Status page, keep refreshing until every submitted job is
  // Done, then download each file the moment it becomes ready.
  async function waitForJobsAndDownload(dsPage, jobIds, submitted) {
    try {
      await dsPage.bringToFront();
    } catch {}
    const statusLink = dsPage.locator('a.homepage_toplink[title="Report Status Page"]').first();
    try {
      await statusLink.waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      console.log('DS: Status link not found on:', dsPage.url());
      return;
    }
    console.log('DS: clicking Status...');
    try {
      await statusLink.click();
    } catch {
      await statusLink.evaluate((el) => { el.click(); });
    }
    await sleep(3500);

    const statusF = dsPage.frameLocator('#ifrContent');
    const jobF = statusF.frameLocator('#JobTable');
    const refreshLink = statusF.locator('a:has-text("Refresh")').first();
    const downloadDir = path.join(__dirname, 'downloads');
    const pending = { ...jobIds };
    const downloaded = {};
    const noDownloadTries = {};
    const failedReports = {};
    const PENDING = /waiting|active|running|queued|submitted|processing|working|pending/i;
    // Keep the 15-minute base wait, but extend it in 5-minute chunks while any
    // report is still pending, so the run only ends when everything is done
    // (hard cap of 60 minutes to avoid a runaway process).
    const BASE_WAIT_MS = 15 * 60 * 1000;
    const EXTEND_MS = 5 * 60 * 1000;
    const MAX_TOTAL_MS = 60 * 60 * 1000;
    let deadline = Date.now() + BASE_WAIT_MS;
    const startTime = Date.now();
    // Pages that currently have an in-flight download - never close those.
    const downloading = new Set();

    // The retrieve/download window is never closed by the site itself - close
    // it for real, retrying with window.close() as a fallback.
    async function forceClosePage(p, label) {
      if (!p || p.isClosed()) return;
      for (let i = 0; i < 4; i++) {
        if (p.isClosed()) break;
        try {
          await p.close();
        } catch {}
        if (!p.isClosed()) {
          try {
            await p.evaluate(() => window.close()).catch(() => {});
          } catch {}
        }
        if (!p.isClosed()) await sleep(400);
      }
      console.log(p.isClosed()
        ? `DS: ${label} closed.`
        : `DS: WARNING - ${label} could not be closed.`);
    }

    // Sweep: force-close any leftover popup windows (retrieve/download/blank),
    // but NEVER a page that still has a download in progress.
    function closeStrayPages() {
      for (const p of context.pages()) {
        if (p === page || p === dsPage) continue;
        if (p.isClosed()) continue;
        if (downloading.has(p)) continue;
        const u = p.url() || '';
        if (/Status_retrieve_request|about:blank|download/i.test(u)) {
          console.log('DS: force-closing stray window:', u.slice(0, 120));
          p.close().catch(() => {});
        }
      }
    }

    console.log('DS: status page loaded. Refreshing every 15s (first 8 min), 30s (next 7 min), then 45s until all jobs are Done...');
    while (Date.now() < deadline && Object.keys(pending).length > 0) {
      for (const name of Object.keys(pending)) {
        const lcName = name.toLowerCase();
        let statusCell = '';
        let fileSize = '';
        let hasGetFile = false;
        try {
          const row = jobF.locator('tr', { hasText: lcName }).first();
          await row.waitFor({ state: 'attached', timeout: 3000 });
          statusCell = ((await row.locator('td').nth(2).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
          fileSize = ((await row.locator('td').nth(5).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
          hasGetFile = (await row.locator('span.status_table').count()) > 0;
        } catch {}

        if (!statusCell || PENDING.test(statusCell) || !hasGetFile) {
          if (statusCell) console.log(`DS: "${name}" still ${statusCell} - waiting...`);
          continue;
        }
        console.log(`DS: "${name}" is Done (${fileSize}) - downloading...`);

        // Watch for the popup BEFORE clicking so the download listener is
        // attached the instant the window is created - never miss the event.
        const knownPages = new Set(context.pages());
        const newPagePromise = typeof context.waitForEvent === 'function'
          ? context.waitForEvent('page', { timeout: 20000 }).catch(() => null)
          : Promise.resolve(null);
        const titleSpan = jobF.locator('span.status_table', { hasText: name }).first();
        try {
          await titleSpan.click({ timeout: 8000 });
        } catch {
          await titleSpan.evaluate((el) => { el.click(); }).catch(() => {});
        }
        let dlPage = await newPagePromise;
        if (!dlPage) {
          const dlDeadline = Date.now() + 20000;
          while (Date.now() < dlDeadline && !dlPage) {
            dlPage = context.pages().find((p) => !knownPages.has(p)) || null;
            if (!dlPage) await sleep(500);
          }
        }
        if (dlPage) {
          console.log('DS: retrieve window opened:', dlPage.url());
          // A "Done" job can still return no real file: the retrieve URL then
          // carries status=N and an empty outbound filename (/Outbound/_<JobId>_).
          // No download event will ever fire for it, so skip it right away
          // instead of waiting 60s and retrying forever, and flag it so the
          // caller can re-submit the report and re-run the whole flow.
          const dlUrl = dlPage.url() || '';
          const statusMatch = dlUrl.match(/[?&]status=([A-Za-z])/);
          const dlStatus = statusMatch ? statusMatch[1].toUpperCase() : '';
          const emptyOutbound = /filename=\/Outbound\/_[^&]+_/.test(dlUrl);
          if (dlStatus === 'N' || emptyOutbound) {
            console.log(`DS: "${name}" has no output file (status=${dlStatus || '?'}) - flagging for re-run.`);
            await forceClosePage(dlPage, 'retrieve window (no file)');
            delete pending[name];
            failedReports[name] = true;
            continue;
          }
          const downloadPromise = dlPage.waitForEvent('download', { timeout: 60000 });
          let download = null;
          try {
            download = await downloadPromise;
          } catch (e) {
            noDownloadTries[name] = (noDownloadTries[name] || 0) + 1;
            console.log(`DS: no download event within 60s (attempt ${noDownloadTries[name]}/3):`, e.message);
          }
          if (download) {
            noDownloadTries[name] = 0;
            downloading.add(dlPage);
            try {
              const dateSuffix = todayStr();
              const suggested = download.suggestedFilename() || `${name.replace(/[^\w\-]+/g, '_')}.xlsx`;
              const ext = path.extname(suggested) || '.xlsx';
              const filename = `${name}-${dateSuffix}${ext}`;
              console.log('DS: download started:', filename);
              mkdirSync(downloadDir, { recursive: true });
              const dest = path.join(downloadDir, filename);
              await download.saveAs(dest);
              console.log('DS: file saved to:', dest);
              // await uploadReportToDrive(dest, SHORT_LABELS[name] || name.toLowerCase());
              downloaded[name] = dest;
              delete pending[name];
              if (submitted && submitted[name]) {
                submitted[name].downloaded = true;
                saveSubmittedJobs(submitted);
              }
            } catch (e) {
              console.log('DS: save failed:', e.message);
              await sleep(1500);
            } finally {
              downloading.delete(dlPage);
            }
          }
          // Close ONLY after the download is saved/finished - never while in flight.
          await sleep(2000);
          await forceClosePage(dlPage, 'retrieve window');
          // 3 consecutive timeouts on a "Done" job means the file will never
          // arrive - flag it so the caller re-submits and re-runs the flow.
          if ((noDownloadTries[name] || 0) >= 3) {
            console.log(`DS: "${name}" failed 3 download attempts - flagging for re-run.`);
            delete pending[name];
            failedReports[name] = true;
          }
        } else {
          console.log('DS: retrieve window did not open.');
        }
      }
      if (Object.keys(pending).length === 0) break;
      closeStrayPages();
      try {
        await refreshLink.click({ timeout: 5000, force: true });
      } catch {
        await refreshLink.evaluate((el) => { el.click(); }).catch(() => {});
      }
      const elapsed = Date.now() - startTime;
      const refreshInterval = elapsed < 8 * 60 * 1000 ? 15000 : elapsed < 15 * 60 * 1000 ? 30000 : 45000;
      await sleep(refreshInterval);
      if (Date.now() >= deadline && Object.keys(pending).length > 0 && elapsed < MAX_TOTAL_MS) {
        deadline = Date.now() + EXTEND_MS;
        console.log(`DS: ${Math.round(BASE_WAIT_MS / 60000)} min elapsed with files still pending - extending the wait by ${Math.round(EXTEND_MS / 60000)} more minutes.`);
      }
    }
    closeStrayPages();
    console.log('DS: finished. Downloaded:', JSON.stringify(downloaded));
    console.log('DS: still pending:', JSON.stringify(pending));
    console.log('DS: skipped/failed (no output file):', JSON.stringify(failedReports));
    return { downloaded, pending, failed: failedReports };
  }

  // Open the Decision Support app in a new tab (reused for every report).
  async function openDecisionSupportTab() {
    if (!page.url().includes('rl_portal')) {
      console.log('Navigating to the portal for the app cards...');
      await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    }

    const appCard = page.locator('div.app-card-sec-2-app-name:has-text("Decision Support - New")').first();
    let cardReady = false;
    for (let attempt = 1; attempt <= 2 && !cardReady; attempt++) {
      try {
        await appCard.waitFor({ state: 'visible', timeout: 20000 });
        cardReady = true;
      } catch {
        console.log(`"Decision Support - New" card not found (attempt ${attempt}). URL:`, page.url());
        if ((/login|\/mfa/.test(page.url()) || page.url().includes('resumePath=')) && attempt === 1) {
          console.log('Bounced to login/MFA/resumePath - waiting for SSO to settle and retrying the portal...');
          await sleep(5000);
          if (page.url().includes('resumePath=')) {
            console.log('On resumePath - going to /login to complete SSO...');
            await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await page.waitForTimeout(3000);
          }
          await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }
      }
    }
    if (!cardReady) return null;

    console.log('Clicking "Decision Support - New" (opens in a new tab)...');
    const knownPages = new Set(context.pages());
    const dsPagePromise = typeof context.waitForEvent === 'function'
      ? context.waitForEvent('page', { timeout: 30000 }).catch(() => null)
      : Promise.resolve(null);
    try {
      await appCard.click();
    } catch {
      await appCard.evaluate((el) => { el.click(); });
    }
    let dsPage = await dsPagePromise;
    if (!dsPage) {
      // Poll for a newly created tab (reliable even if page events don't fire).
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !dsPage) {
        const newPages = context.pages().filter((p) => !knownPages.has(p));
        if (newPages.length) dsPage = newPages[newPages.length - 1];
        else await sleep(500);
      }
    }
    if (!dsPage) {
      console.log('No new tab detected; checking if the same tab navigated...');
      await page.waitForTimeout(3000);
      if (!page.url().includes('rl_portal')) {
        dsPage = page;
      } else {
        console.log('Decision Support did not open.');
        return null;
      }
    }
    await dsPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await dsPage.waitForTimeout(3000);
    console.log('Decision Support tab opened:', dsPage.url());
    return dsPage;
  }

  // Reusable: find the frame containing the saved reports tree.
  async function findReportsFrame(dsPage, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const f of dsPage.frames()) {
        try {
          if (await f.locator('#savedReportsDiv').count()) return f;
        } catch {}
      }
      await sleep(500);
    }
    return null;
  }

  // Open "My Reports" on the DS tab and return the frame with the report tree.
  // The tree keeps its expanded state between reports, so if it is already on
  // screen it is reused without reloading or re-expanding.
  async function openMyReports(dsPage) {
    try {
      await dsPage.bringToFront();
    } catch {}

    let reportsFrame = await findReportsFrame(dsPage, 5000);
    if (reportsFrame) {
      console.log('Reports tree already on screen - reusing it.');
    } else {
      const myReports = dsPage.locator('a.homepage_toplink[title="My Saved Reports"]').first();
      try {
        await myReports.waitFor({ state: 'visible', timeout: 20000 });
      } catch {
        console.log('"My Reports" link not found on:', dsPage.url());
        return null;
      }
      console.log('Opening "My Reports"...');
      try {
        await myReports.click();
      } catch {
        await myReports.evaluate((el) => { el.click(); });
      }
      await sleep(2000);
      reportsFrame = await findReportsFrame(dsPage, 30000);
    }

    if (!reportsFrame) {
      console.log('savedReportsDiv not found in any frame. Frames on page:',
        JSON.stringify(dsPage.frames().map((f) => f.url())));
      return null;
    }
    console.log('savedReportsDiv found. Frame URL:', reportsFrame.url());

    // Expand the folder only if it is collapsed (plus icon visible). Once it
    // is expanded the plus is hidden, so the 2nd/3rd report skips this step.
    const plus = reportsFrame.locator('img#IMG2SYS1');
    if (await plus.count() && await plus.isVisible().catch(() => false)) {
      console.log('Expanding the reports folder (+)...');
      try {
        await plus.click();
      } catch {
        await plus.evaluate((el) => { el.click(); });
      }
    } else {
      console.log('Plus icon not visible (folder already expanded) - skipping.');
    }
    await reportsFrame.waitForFunction(() => {
      const fc = document.querySelector('#FCSYS1');
      return !!fc && fc.style.display !== 'none';
    }, { timeout: 10000 }).catch(() => {});
    return reportsFrame;
  }

  // Select a report in the tree, right-click -> Modify -> return the Report
  // Builder page (a new browser window).
  async function openReportInBuilder(reportsFrame, dsPage, reportName) {
    const normName = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const target = normName(reportName);

    // Find the report row by name (exact match first, contains as fallback).
    // The old fallback to the first row clicked the WRONG report when the name
    // did not match - now it logs the available names and bails out instead.
    let report = null;
    let foundName = '';
    let rdId = '';
    const findDeadline = Date.now() + 15000;
    while (Date.now() < findDeadline && !report) {
      const spans = reportsFrame.locator('#savedReportsDiv span[reportinfostring]');
      const count = await spans.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const span = spans.nth(i);
        const text = ((await span.textContent().catch(() => '')) || '').trim();
        const attr = ((await span.getAttribute('reportinfostring').catch(() => '')) || '').trim();
        const nText = normName(text);
        if (nText === target || nText.includes(target) || normName(attr).includes(target)) {
          // The tree contains hidden zero-size duplicate nodes (history entries)
          // before the real visible rows - skip them so right-click hits the
          // actual visible row instead of failing on an invisible duplicate.
          const box = await span.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { w: r.width, h: r.height };
          }).catch(() => ({ w: 0, h: 0 }));
          if (!box.w || !box.h) continue;
          report = span;
          foundName = text;
          rdId = attr.split('|')[0];
          break;
        }
      }
      if (!report) await sleep(500);
    }
    if (!report) {
      const names = [];
      const spans = reportsFrame.locator('#savedReportsDiv span[reportinfostring]');
      const count = await spans.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        names.push(((await spans.nth(i).textContent().catch(() => '')) || '').trim());
      }
      console.log(`Report "${reportName}" not found in the tree. Available: ${JSON.stringify(names)}`);
      return null;
    }
    console.log(`Right-clicking report: "${foundName}" (id ${rdId})`);
    await report.scrollIntoViewIfNeeded().catch(() => {});

    let candidates = [];
    for (let attempt = 1; attempt <= 3 && !candidates.length; attempt++) {
      let rightClicked = false;
      try {
        await report.click({ button: 'right', timeout: 15000 });
        rightClicked = true;
      } catch {}
      if (!rightClicked) {
        try {
          await report.click({ button: 'right', timeout: 10000, force: true });
          rightClicked = true;
        } catch {}
      }
      if (!rightClicked) {
        // Last resort: synthesize the contextmenu event the inline handler expects.
        rightClicked = await report.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const ev = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: Math.round(r.x + r.width / 2),
            clientY: Math.round(r.y + r.height / 2),
            button: 2,
          });
          el.dispatchEvent(ev);
          return true;
        }).catch(() => false);
      }
      if (!rightClicked) {
        console.log('Right-click failed.');
        return null;
      }
      await dsPage.waitForTimeout(1200);

      candidates = await reportsFrame.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
          const cs = window.getComputedStyle(el);
          if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 5 || r.height < 5 || r.width > 900 || r.height > 900) continue;
          const id = el.id || '';
          const cls = typeof el.className === 'string' ? el.className : '';
          const isTopLevel = el.parentElement === document.body;
          if (!(/menu|context|popup|float|layer/i.test(id + ' ' + cls) || isTopLevel)) continue;
          out.push({
            tag: el.tagName,
            id,
            cls,
            box: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          });
        }
        return out;
      }).catch(() => []);

      if (!candidates.length) {
        console.log(`No context menu captured (attempt ${attempt}/3) - right-clicking again...`);
        await dsPage.waitForTimeout(800);
      }
    }

    // Click the first context-menu item ("Modify") - opens Report_Builder
    // in a completely new browser window.
    const modifyItem = reportsFrame.locator('#popmenu .menuitems a').first();
    if (!(await modifyItem.count())) {
      console.log('Context menu (#popmenu) not found or already closed.');
      return null;
    }
    console.log('Clicking "Modify" in the context menu...');
    try {
      await modifyItem.click({ timeout: 10000 });
    } catch {
      await modifyItem.evaluate((el) => { el.click(); });
    }

    const knownBefore = new Set(context.pages());
    let builderPage = null;
    const builderDeadline = Date.now() + 30000;
    while (Date.now() < builderDeadline && !builderPage) {
      builderPage = context.pages().find((p) => !knownBefore.has(p)) || null;
      if (!builderPage) await sleep(500);
    }
    if (!builderPage) {
      console.log('No new window detected after Modify click.');
      return null;
    }
    await builderPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await builderPage.waitForURL(/Report_Builder\.aspx/, { timeout: 20000 }).catch(() => {});
    await builderPage.waitForTimeout(2500);
    console.log('Report Builder window opened:', builderPage.url());

    // Duplicate guard: the builder window must match the report we clicked.
    // If it opened a different report, close it and return null so we never
    // run the same report twice.
    if (rdId && !builderPage.url().includes(`jobid=${rdId}`)) {
      console.log(`WARNING: builder opened for the WRONG report (expected jobid=${rdId}) - closing to avoid a duplicate run.`);
      await builderPage.close().catch(() => {});
      return null;
    }
    return builderPage;
  }

  // Driver: submit ALL reports one by one (each fully closed before the next
  // is opened), capture every Job Id, then download all three together from
  // the Status page as each turns Done.
  async function runAllReports(reportNames) {
    const dsPage = await openDecisionSupportTab();
    if (!dsPage) {
      console.log('Could not open Decision Support.');
      return false;
    }
    const jobIds = {};
    const submitted = loadSubmittedJobs();

    // Submit one report and capture its Job Id. Used both for the initial
    // pass and to re-run reports that come back with no output file.
    async function submitReport(name) {
      console.log(`=== REPORT: ${name} ===`);
      const reportsFrame = await openMyReports(dsPage);
      if (!reportsFrame) return null;
      const builderPage = await openReportInBuilder(reportsFrame, dsPage, name);
      if (!builderPage) return null;
      const configured = await configureReportBuilderTimes(builderPage);
      if (!configured) {
        console.log('RB: configuration failed - skipping this report.');
        await builderPage.close().catch(() => {});
        return null;
      }
      const jobId = await submitReportAndGetJobId(builderPage, name);
      if (jobId) {
        jobIds[name] = jobId;
        submitted[name] = { jobId, at: new Date().toISOString(), downloaded: false };
        saveSubmittedJobs(submitted);
        console.log(`Captured Job Id ${jobId} for "${name}".`);
      }
      return jobId;
    }

    for (const name of reportNames) {
      // Skip only when this report was already submitted today - the site
      // blocks duplicate Run Now on the same day.
      const sub = submitted[name];
      if (sub && sub.at && new Date(sub.at).toDateString() === new Date().toDateString()) {
        console.log(`"${name}" already submitted today (Job Id ${sub.jobId}) - skipping.`);
        continue;
      }
      if (sub) {
        console.log(`"${name}" was submitted on a previous day (Job Id ${sub.jobId}) - submitting again.`);
      }
      if (jobIds[name]) {
        console.log(`"${name}" already submitted in this session (Job Id ${jobIds[name].jobId}) - skipping.`);
        continue;
      }
      await submitReport(name);
    }
    // Merge in jobs from previous runs that still have downloaded: false.
    for (const name of reportNames) {
      const sub = submitted[name];
      if (sub && sub.jobId && !sub.downloaded && !jobIds[name]) {
        jobIds[name] = sub.jobId;
        console.log(`"${name}" (Job Id ${sub.jobId}) was not downloaded yet - checking status.`);
      }
    }
    console.log('=== Jobs to download. Job IDs:', JSON.stringify(jobIds));
    if (Object.keys(jobIds).length === 0) {
      console.log('No jobs to download - closing the browser.');
      await saveSessionCookies();
      try {
        await context.close();
      } catch {}
      console.log('Browser closed. Exiting.');
      process.exit(0);
    }

    // Phase 2: refresh the Status page and download each file as it becomes
    // Done (all pending jobs handled together in one refresh loop). Reports
    // that come back with no output file (status=N) are re-submitted and the
    // whole flow re-run for them, up to MAX_RETRIES attempts total. If they
    // still produce nothing after all attempts, notify Telegram.
    const MAX_RETRIES = 3;
    const failedAfterAll = [];
    let activeIds = { ...jobIds };
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await waitForJobsAndDownload(dsPage, activeIds, submitted);
      const failed = Object.keys(result.failed || {});
      if (failed.length === 0) break;

      if (attempt < MAX_RETRIES) {
        console.log(`No data found for: ${failed.join(', ')} - re-running the flow for them (attempt ${attempt}/${MAX_RETRIES})...`);
        const newIds = {};
        for (const name of failed) {
          console.log(`Re-submitting "${name}" (retry ${attempt}/${MAX_RETRIES})...`);
          const newJobId = await submitReport(name);
          if (newJobId) {
            newIds[name] = newJobId;
            console.log(`"${name}" re-submitted with new Job Id ${newJobId}.`);
          } else {
            console.log(`"${name}" could not be re-submitted.`);
            failedAfterAll.push(name);
          }
        }
        if (Object.keys(newIds).length === 0) {
          failedAfterAll.push(...failed);
          break;
        }
        activeIds = newIds;
      } else {
        failedAfterAll.push(...failed);
      }
    }

    if (failedAfterAll.length > 0) {
      console.log('No data found after retries for:', failedAfterAll.join(', '));
      // await sendTelegramMessage(`${recipientMentions()}Wallmart: no data found for report(s): ${failedAfterAll.join(', ')} after ${MAX_RETRIES} attempts.`);
    }
    const allDone = failedAfterAll.length === 0;
    console.log(allDone
      ? 'All reports downloaded - closing all browser instances...'
      : 'Some reports were not downloaded - closing the browser so the next run can retry them.');
    await saveSessionCookies();
    try {
      await context.close();
    } catch {}
    console.log('Browser closed. Exiting.');
    process.exit(0);
  }

  async function runFullFlow() {
  console.log('Opening Walmart Retail Link portal...');
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for whichever outcome arrives first: redirect to the login page or
  // to the SSO resumePath interstitial (both mean "not logged in"). Returns
  // immediately on either, so the not-logged-in path stays fast.
  try {
    await page.waitForURL(/retaillink\.login\.wal-mart\.com\/(login|\?resumePath=)/, { timeout: 10000 });
    console.log('Redirected (session invalid):', page.url());
  } catch {
    console.log('No redirect within timeout (session may be valid).');
  }

  // An SSO resumePath interstitial means the session is not usable - go to the
  // login URL and run the full login flow from there.
  if (/retaillink\.login\.wal-mart\.com\/\?resumePath=/.test(page.url())) {
    console.log('SSO resumePath interstitial detected - navigating to the login URL...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
  } else {
    await page.waitForTimeout(3000);
  }
  console.log('Page opened:', await page.title(), '- URL:', page.url());

  const curUrl = page.url();
  const onLoginForm = (await loginBtn.count()) > 0 || curUrl.includes('/login');
  const onMfaPage = curUrl.includes('/mfa');

  if (!onLoginForm && !onMfaPage) {
    console.log('Already logged in (portal home). URL:', page.url());
    await saveSessionCookies();
    const ok = await runAllReports(TARGET_REPORTS);
    if (ok === false) throw new Error('Decision Support could not be opened.');
    return;
  }

  console.log(onMfaPage
    ? 'Saved session landed on the MFA challenge - continuing with OTP flow.'
    : 'Not logged in - login form detected.');

  // STEP 1+2: wait for the User ID + Password fields and fill them. The
  // clickLoginBtn gate below never presses LOG IN unless both are verified.
  await fillLoginFields();

  if (onLoginForm) await waitForLoginBtnEnabled();

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await clickLoginBtn() === false) break;
    const state = await waitForPxOrNavigation(12000);
    if (state === 'navigated') break;
    if (state === 'px') {
      console.log(`PX challenge appeared after submit (cycle ${attempt + 1}).`);
      await attemptPxAutoSolve();
      await randomDelay(800, 1500);
      const afterSolve = await waitForPxOrNavigation(15000);
      if (afterSolve === 'navigated') break;
      if (afterSolve === 'px') {
        console.log('PX still present after solve, retrying...');
        continue;
      }
      if (await loginBtn.count() === 0) break;
      continue;
    }
    console.log('No PX and still on login page after submit; waiting a bit more...');
    await sleep(4000);
    if (await loginBtn.count() === 0) break;
    if (await isPxCaptchaVisible()) {
      console.log(`PX challenge appeared late (cycle ${attempt + 1}).`);
      await attemptPxAutoSolve();
      await randomDelay(800, 1500);
      const afterSolve = await waitForPxOrNavigation(15000);
      if (afterSolve === 'navigated') break;
    }
  }

  if (onLoginForm) {
    const finalNav = await waitForPxOrNavigation(15000);
    if (finalNav === 'navigated') {
      console.log('After login, URL:', page.url());
      console.log('After login, title:', await page.title());
      await saveSessionCookies();
    } else {
      console.log('Login did not navigate within timeout; final URL:', page.url());
    }
  }

  // STEP 3: MFA - click "Verify with Text Message" if the challenge card appears.
  const verifyTextBtn = page.locator('button[data-automation-id="card-button"]:has-text("Verify with Text Message")');
  const codeInput = page.locator('input[data-automation-id="code"]');
  const resendLink = page.locator('a[dataautomationid="resendBtn"]');
  const verifyReady = await verifyTextBtn.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
  if (verifyReady && await verifyTextBtn.count() > 0) {
    console.log('Clicking "Verify with Text Message"...');
    try {
      await verifyTextBtn.first().click();
    } catch {
      await verifyTextBtn.first().evaluate((el) => { el.click(); });
    }
    await randomDelay(1500, 3000);
    console.log('Verify with Text Message clicked. URL:', page.url());
  } else {
    console.log('Verify with Text Message button not found (may already be past MFA or on a different challenge).');
  }

  // Wait for the code input. If Walmart fails to send the SMS it shows an
  // "Error sending Code" alert with a Resend link - click it and retry.
  let codeInputReady = false;
  for (let attempt = 1; attempt <= 4 && !codeInputReady; attempt++) {
    codeInputReady = await codeInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (codeInputReady) break;
    const resendVisible = await resendLink.first().isVisible().catch(() => false);
    const verifyVisible = await verifyTextBtn.first().isVisible().catch(() => false);
    if (resendVisible) {
      console.log(`SMS send failed ("Error sending Code") - clicking Resend (attempt ${attempt})...`);
      try {
        await resendLink.first().click();
      } catch {
        await resendLink.first().evaluate((el) => { el.click(); });
      }
      await randomDelay(2000, 3500);
    } else if (verifyVisible) {
      console.log(`Code input missing - re-clicking "Verify with Text Message" (attempt ${attempt})...`);
      try {
        await verifyTextBtn.first().click();
      } catch {
        await verifyTextBtn.first().evaluate((el) => { el.click(); });
      }
      await randomDelay(1500, 3000);
    }
  }
  if (!codeInputReady) {
    console.log('OTP code input never appeared after retries.');
    // If we actually got logged in without a code challenge, continue to the
    // reports; otherwise fail so the flow is redone from the login page.
    const loggedIn = page.url().includes('rl_portal') || (await loginBtn.count()) === 0;
    if (!loggedIn) throw new Error('Walmart MFA code input never appeared and login did not complete.');
  }

  // STEP 3.5: OTP flow - poll the VPS OTP server for the code, fill it in and
  // submit. If no OTP arrives within 65 seconds, click the resend link.
  // Stop and close the browser after MAX_OTP_TRIES attempts.

  if (codeInputReady && await codeInput.count() > 0) {
    const MAX_OTP_TRIES = 4;
    const OTP_WAIT_MS = 65000;
    const OTP_POLL_MS = 1000;
    const otpStartTime = Date.now();

    async function enterOtpAndSubmit(code) {
      const otp = String(code);
      if (await codeInput.count() === 0) {
        console.log('OTP code input not found on the page.');
        return false;
      }
      console.log('Filling the OTP code into the code input...');
      await codeInput.click();
      await codeInput.fill(otp);
      await randomDelay(500, 1500);
      const submitBtn = page.locator('button[dataautomationid="card-button"]');
      if (await submitBtn.count() > 0) {
        // The button is disabled until a code is entered.
        for (let i = 0; i < 30; i++) {
          const disabled = await submitBtn.isDisabled().catch(() => false);
          const hasDisabledAttr = await submitBtn.getAttribute('disabled').then((v) => v !== null).catch(() => false);
          if (!disabled && !hasDisabledAttr) break;
          await sleep(500);
        }
        console.log('Clicking Submit...');
        try {
          await submitBtn.click();
        } catch {
          await submitBtn.evaluate((el) => { el.click(); });
        }
        await randomDelay(2000, 3500);
        console.log('Submit clicked. URL:', page.url());

        const errorText = await page.evaluate(() => {
          const helper = document.querySelector('[data-automation-id*="error" i], [class*="error" i], [role="alert"]');
          return helper ? helper.textContent.trim() : null;
        }).catch(() => null);
        if (errorText && errorText.length > 0) {
          console.log('OTP error detected:', errorText);
          let waitMsg = '';
          try {
            const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
            const m = bodyText.match(/[Rr]esend verification code in\s*(\d+)\s*seconds?/);
            if (m) {
              const sec = parseInt(m[1], 10);
              waitMsg = ` Next OTP will be sent in ${sec}s.`;
            }
          } catch {}
          // await sendTelegramMessage(`Walmart OTP error: ${errorText}.${waitMsg}`);
          return false;
        }
        return true;
      }
      console.log('Submit button not found.');
      return false;
    }

    let otpEntered = false;

    const clickResend = async () => {
      const resendLink = page.locator('a[dataautomationid="resendBtn"]');
      // The resend link appears after the countdown ("Re-send verification code in 45 seconds").
      for (let i = 0; i < 90; i++) {
        if (await resendLink.count() > 0 && await resendLink.isVisible().catch(() => false)) {
          break;
        }
        await sleep(1000);
      }
      if (await resendLink.count() > 0) {
        console.log('Clicking "Re-send verification code"...');
        try {
          await resendLink.first().click();
        } catch {
          await resendLink.first().evaluate((el) => { el.click(); });
        }
        await randomDelay(1500, 3000);
        console.log('Re-send verification code clicked. URL:', page.url());
        // await sendTelegramMessage(`${recipientMentions()}Walmart OTP was re-sent. Check the configured OTP phone number. Reply to this bot with the 6-digit OTP using /wallmart.`);
      } else {
        console.log('Resend link not found.');
      }
    };

    for (let tryNum = 1; tryNum <= MAX_OTP_TRIES && !otpEntered; tryNum++) {
      console.log(`OTP attempt ${tryNum}/${MAX_OTP_TRIES}...`);
      if (tryNum === 1) {
        // await sendTelegramMessage(`${recipientMentions()}OTP for Walmart was sent. Check the configured OTP phone number. Reply to this bot with the 6-digit OTP using /wallmart.`);
      } else {
        await clickResend();
      }

      const attemptDeadline = Date.now() + OTP_WAIT_MS;
      while (Date.now() < attemptDeadline && !otpEntered) {
        await sleep(OTP_POLL_MS);
        const lastOtp = await fetchLatestOtpFromServer();
        if (lastOtp && lastOtp.receivedAt > otpStartTime && (!lastOtp.store || lastOtp.store === 'wallmart')) {
          console.log('OTP received via OTP server:', lastOtp.code, lastOtp.store ? `[${lastOtp.store}]` : '');
          otpEntered = await enterOtpAndSubmit(lastOtp.code);
          if (!otpEntered) {
            console.log('OTP was rejected.');
          }
        }
      }
    }

    if (!otpEntered) {
      console.log(`OTP not received after ${MAX_OTP_TRIES} tries.`);
      // await sendTelegramMessage(`${recipientMentions()}Walmart OTP was not received after ${MAX_OTP_TRIES} attempts.`);
      throw new Error('Walmart OTP not received after max tries.');
    }

    // Wait for the SSO resume to finish bouncing us off the MFA page.
    // Only consider rl_portal as "done" (the query string may contain
    // retaillink.wal-mart.com and cause false positives).
    try {
      await page.waitForURL(/rl_portal/, { timeout: 45000 });
      console.log('Post-OTP redirect to portal complete:', page.url());
    } catch {
      console.log('Post-OTP redirect did not reach portal; URL:', page.url());
    }
    // Some logins land on a resumePath instead of the portal.
    if (/retaillink\.login\.wal-mart\.com\/\?resumePath=/.test(page.url())) {
      console.log('Post-OTP landed on resumePath - navigating to /login to complete SSO...');
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      try {
        await page.waitForURL(/rl_portal/, { timeout: 30000 });
        console.log('SSO redirect to portal complete:', page.url());
      } catch {
        console.log('SSO did not redirect after goto /login; URL:', page.url());
      }
    }
    await sleep(3000);
  } else {
    console.log('OTP code input not found (may already be logged in or on a different challenge).');
  }

  await saveSessionCookies();
  const ok = await runAllReports(TARGET_REPORTS);
  if (ok === false) throw new Error('Decision Support could not be opened after login.');
  }

  // Run the full flow (portal -> login -> OTP -> reports). If anything fails,
  // go back to the login page and redo the flow from the start (max 3 attempts).
  const MAX_FLOW_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_FLOW_ATTEMPTS; attempt++) {
    try {
      await runFullFlow();
      break;
    } catch (e) {
      console.log(`Walmart flow failed (attempt ${attempt}/${MAX_FLOW_ATTEMPTS}):`, e.message);
      if (attempt >= MAX_FLOW_ATTEMPTS) break;
      console.log('Going back to the login page and re-running the flow from the start...');
      for (const p of context.pages()) {
        if (p !== page && !p.isClosed()) {
          try { await p.close(); } catch {}
        }
      }
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
  await saveSessionCookies().catch(() => {});
  try { await context.close(); } catch {}
  console.log('Browser closed. Exiting.');
  process.exit(1);
})();
