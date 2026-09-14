import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execSync } from 'child_process';
// NOTE: camoufox MUST load via its CJS build (createRequire). Its ESM build
// fails on this setup: "Dynamic require of events is not supported" (keyv).
const require = createRequire(import.meta.url);
const { Camoufox } = require('camoufox');
import { existsSync, mkdirSync, readFileSync, createReadStream, appendFileSync, accessSync, constants } from 'fs';
import { rename, unlink } from 'fs/promises';
import { sendTelegramMessage } from './telegram.js';
import { getDrive, ensureFolder } from './drive.js';
import { summarizeReport } from './ai-analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Self-contained display: on Linux without a DISPLAY (headless VPS), start a
// throwaway Xvfb for this run — Cloudflare blocks headless rendering on GCP
// IPs — and stop it when done. No-op on machines that already have a display.
async function ensureDisplay() {
  if (process.env.DISPLAY || process.platform !== 'linux') return null;
  const { existsSync, readFileSync } = await import('fs');
  let num = 99;
  for (; num < 130; num++) {
    const lock = `/tmp/.X${num}-lock`;
    if (!existsSync(lock)) break;
    let alive = false;
    try {
      const pid = parseInt(readFileSync(lock, 'utf8').trim().split(/\s+/)[0], 10);
      if (pid) { execSync(`kill -0 ${pid}`, { stdio: 'ignore' }); alive = true; }
    } catch { alive = false; }
    if (!alive) break; // stale lock, reuse this display
  }
  const display = `:${num}`;
  let xvfb;
  try {
    xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  } catch (e) {
    console.log('Xvfb unavailable, continuing headless:', e.message);
    return null;
  }
  let spawnError = null;
  xvfb.on('error', (e) => { spawnError = e; });
  await new Promise((r) => setTimeout(r, 1500));
  if (spawnError || xvfb.exitCode !== null) {
    console.log('Xvfb failed to start, continuing headless.');
    return null;
  }
  process.env.DISPLAY = display;
  console.log(`Xvfb started on ${display} (pid ${xvfb.pid})`);
  const { unlink } = await import('fs/promises');
  const lockFiles = [`/tmp/.X${num}-lock`, `/tmp/.X11-unix/X${num}`];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { xvfb.kill('SIGTERM'); } catch {}
    const exited = await new Promise((res) => {
      if (xvfb.exitCode !== null) return res(true);
      const t = setTimeout(() => res(false), 3000);
      xvfb.once('exit', () => { clearTimeout(t); res(true); });
    });
    if (!exited) { try { xvfb.kill('SIGKILL'); } catch {} }
    for (const f of lockFiles) { try { await unlink(f); } catch {} }
    console.log('Xvfb stopped');
  };
  const stopSync = () => {
    if (stopped) return;
    stopped = true;
    try { xvfb.kill('SIGKILL'); } catch {}
    const { unlinkSync } = require('node:fs');
    for (const f of lockFiles) { try { unlinkSync(f); } catch {} }
  };
  process.on('exit', stopSync);
  process.on('SIGINT', () => { stopSync(); process.exit(130); });
  process.on('SIGTERM', () => { stopSync(); process.exit(143); });
  return stop;
}

const stopXvfb = await ensureDisplay();
// Default to headed when we started our own X server; explicit HEADLESS env always wins.
const HEADLESS = process.env.HEADLESS !== undefined ? process.env.HEADLESS !== '0' : !stopXvfb;
const userDataDir = path.join(__dirname, 'camoufox-profile');
const keys = JSON.parse(readFileSync(path.join(__dirname, 'keys.json'), 'utf8')).ripley;
const drive = getDrive();
const downloadsDir = path.join(__dirname, 'downloads');
if (!existsSync(downloadsDir)) mkdirSync(downloadsDir, { recursive: true });

async function uploadToDrive(filePath, folderName, tenantName = 'Ripley') {
  const fileName = path.basename(filePath);
  try {
    const { markdown } = await summarizeReport({ store: tenantName, report: folderName, filePath });
    console.log('AI analysis:\n' + markdown);
  } catch (e) {
    console.error('AI analysis skipped:', e.message);
  }
  const rootFolder = await ensureFolder('fbusinesscenter', 'root');
  const tenantFolder = await ensureFolder(tenantName, rootFolder.id);
  const target = await ensureFolder(folderName, tenantFolder.id);
  const existing = await drive.files.list({
    q: `name='${fileName.replace(/'/g, "\\'")}' and '${target.id}' in parents and trashed=false`,
    orderBy: 'createdTime desc',
    pageSize: 1,
    fields: 'files(id, name, webViewLink)',
  });

  const media = { mimeType: 'text/csv', body: createReadStream(filePath) };
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

  recordUpload(res.data.name, `fbusinesscenter/${tenantName}/${folderName}`, res.data.webViewLink);

  await sendTelegramMessage(`${tenantName.toLowerCase()} ${folderName} file uploaded.`);

  await unlink(filePath);
  console.log('Removed local file:', filePath);
}

// Append successful uploads to a per-day record so run-all.js can compile the daily report.
function recordUpload(fileName, drivePath, link) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const recordPath = path.join(__dirname, `upload-records-${dateKey}.jsonl`);
  appendFileSync(recordPath, JSON.stringify({ ts: new Date().toISOString(), file: fileName, drivePath, link }) + '\n');
}

// The portal iframes re-render mid-click, which can hang Playwright's
// actionability protocol. Try a normal check first, fall back to a direct
// DOM click, and verify the final state.
async function robustCheck(frameLocator, selector, label) {
  const loc = frameLocator.locator(selector);
  try {
    await loc.check({ timeout: 15000 });
  } catch {
    console.log(`"${label}": normal check timed out, trying JS click...`);
    await loc.evaluate((el) => { el.scrollIntoView(); el.click(); });
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!(await loc.isChecked())) {
    console.log(`"${label}": forcing checked state...`);
    await loc.evaluate((el) => {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  console.log(`"${label}" selected:`, await loc.isChecked());
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

(async () => {
  // Fail fast when run as the wrong user: Firefox hangs for minutes on an
  // unwritable profile instead of erroring. Run as the profile owner.
  for (const [label, dir] of [['browser profile', userDataDir], ['downloads', downloadsDir]]) {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
    } catch {
      console.error(`FATAL: ${label} dir is not writable: ${dir}. Run as the profile owner (e.g. sudo -u ingenieria node ripley.js).`);
      if (stopXvfb) await stopXvfb();
      process.exit(2);
    }
  }

  const context = await Camoufox({
    os: 'windows',
    headless: HEADLESS,
    locale: 'en-US',
    humanize: false,
    data_dir: userDataDir,
    viewport: null,
    noViewport: true,
  });

  const page = typeof context.pages === 'function'
    ? (context.pages()[0] || await context.newPage())
    : await context.newPage();

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

  // Navigate to Ripley
  await page.goto('https://b2b.ripley.cl/b2bWeb/portal/logon.do', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the page to fully load
  await page.waitForLoadState('networkidle');

  if (await isCloudflareChallenge()) {
    await waitForChallengeToClear();
  }

  // Clearance cookies sometimes only apply on a fresh load: re-request the
  // logon page once and give the challenge a second chance before failing.
  if (await isCloudflareChallenge()) {
    console.log('Still challenged, reloading logon page for clearance retry...');
    await page.goto('https://b2b.ripley.cl/b2bWeb/portal/logon.do', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(8000);
    if (await isCloudflareChallenge()) {
      await waitForChallengeToClear();
    }
  }

  await page.waitForLoadState('networkidle').catch(() => {});

  console.log('Page opened:', await page.title());
  try {
    console.log('Browser fingerprint:', await page.evaluate(() => navigator.userAgent));
  } catch (e) {
    console.log('Page navigated during challenge clear, continuing...');
  }

  // Fill in login credentials and submit
  await page.locator('#txtCodUsuario').fill(keys.email);
  await page.locator('#txtPassword').fill(keys.password);
  console.log('Credentials entered. Clicking login...');

  const loginButton = page.locator('input[type="submit"], input[type="button"], button:has-text("Entrar"), button:has-text("Ingresar"), button:has-text("Login")').first();
  if (await loginButton.count() > 0) {
    await loginButton.evaluate((el) => { el.click(); });
  } else {
    await page.locator('form').first().evaluate((form) => form.submit());
  }

  try {
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    console.log('After login, URL:', page.url());
    console.log('After login, title:', await page.title());
  } catch (e) {
    console.log('Login submit done, waiting for navigation:', e.message);
  }

  // Wait 1 second after login, then open the "Ventas" menu
  await page.waitForTimeout(1000);

  async function findFrameWith(selector) {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const loc = frame.locator(selector).first();
        if (await loc.count() > 0) return frame;
      } catch {}
    }
    return null;
  }

  console.log('Frames:', page.frames().map((f) => `${f.name()} -> ${f.url()}`));

  async function clickInFrame(selector, label) {
    let frame = await findFrameWith(selector);
    if (!frame) {
      console.log(`Selector "${selector}" not found in any frame.`);
      return false;
    }
    const link = frame.locator(selector).first();
    await link.evaluate((el) => { el.click(); });
    console.log(`Clicked "${label}".`);
    return true;
  }

  // Portal frames can take a while to load after login. Wait for the Ventas
  // menu to appear (up to 2 minutes) before trying to click anything.
  let portalReady = false;
  for (let i = 0; i < 240; i++) {
    if (await findFrameWith('#proceso14 a.clFoldLinks') || await findFrameWith('a.clFoldLinks:has-text("Ventas")')) {
      portalReady = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log('Portal frames ready:', portalReady, '| URL:', page.url());

  const ventasClicked = await clickInFrame('#proceso14 a.clFoldLinks', 'Ventas');
  if (!ventasClicked) await clickInFrame('a.clFoldLinks:has-text("Ventas")', 'Ventas (by text)');

  const actividadClicked = await clickInFrame('#actividad1348 a.clSubLinks', 'Consulta Detallada de Ventas por día o mes');
  if (!actividadClicked) await clickInFrame('a.clSubLinks:has-text("Consulta Detallada de Ventas")', 'Consulta Detallada de Ventas (by text)');

  // Continue as soon as the activity form is available in the app iframe.
  // Waiting for networkidle/iframe URL changes can add unnecessary delay here.
  let reportFrame = null;
  for (let i = 0; i < 120; i++) {
    reportFrame = await findFrameWith('#txtFechaDesde');
    if (reportFrame) break;
    await page.waitForTimeout(250);
  }

  if (!reportFrame) {
    throw new Error('Could not find the report form iframe.');
  }
  console.log('loaded');

  // Fill the activity form inside the app iframe.

  const formatDate = (date) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}-${month}-${date.getFullYear()}`;
  };

  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const startDate = formatDate(yesterday);
  const endDate = formatDate(yesterday);

  await reportFrame.locator('#txtFechaDesde').fill(startDate);
  await reportFrame.locator('#txtFechaHasta').fill(endDate);
  await robustCheck(reportFrame, 'input[name="chkFile"]', 'Salida a Archivo');

  console.log(`Report dates entered: ${startDate} to ${endDate}`);
  console.log('"Salida a Archivo" selected.');

  // Submit the report search.
  const searchButton = reportFrame.locator('input[type="submit"][name="action"][value="Buscar"]');
  await searchButton.click();
  console.log('Clicked "Buscar".');

  // Wait for either the generated-file link or the zero-records result.
  let resultFrame = null;
  let noFileFound = false;
  for (let i = 0; i < 240; i++) {
    resultFrame = await findFrameWith('a[href*="ConsDetalladaVentasSinStockResult.do"]');
    if (resultFrame) break;

    for (const frame of page.frames()) {
      try {
        if (await frame.getByText(/Se encontraron 0 registros|No se encontraron registros/i).count() > 0) {
          noFileFound = true;
          break;
        }
      } catch {}
    }
    if (noFileFound) break;
    await page.waitForTimeout(250);
  }

  if (!resultFrame && noFileFound) {
    console.log('No file found for the detailed sales report.');
  } else if (!resultFrame) {
    throw new Error('Could not find the generated CSV download link.');
  } else {
    const downloadLink = resultFrame.locator('a[href*="ConsDetalladaVentasSinStockResult.do"]').first();
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await downloadLink.click();
    const download = await downloadPromise;
    await saveDateStampedDownload(download, 'ventas');
  }

  // Open Stock Ripley > Consulta Detallada Stock Ripley.
  const stockClicked = await clickInFrame('#proceso17 a.clFoldLinks', 'Stock Ripley');
  if (!stockClicked) await clickInFrame('a.clFoldLinks:has-text("Stock Ripley")', 'Stock Ripley (by text)');

  const stockActivityClicked = await clickInFrame('#actividad1268 a.clSubLinks', 'Consulta Detallada Stock Ripley');
  if (!stockActivityClicked) {
    await clickInFrame('a.clSubLinks:has-text("Consulta Detallada Stock Ripley")', 'Consulta Detallada Stock Ripley (by text)');
  }

  let stockFrame = null;
  for (let i = 0; i < 240; i++) {
    stockFrame = await findFrameWith('input[name="chkFile"]');
    if (stockFrame) break;
    await page.waitForTimeout(250);
  }
  if (!stockFrame) throw new Error('Could not find the Stock Ripley form iframe.');

  await robustCheck(stockFrame, 'input[name="chkFile"]', 'Stock Salida a Archivo');
  await stockFrame.locator('input[type="submit"][name="buscar"][value="Buscar"]').click();
  console.log('Stock Ripley search submitted.');

  // Save the stock CSV, or report that the query returned no records.
  resultFrame = null;
  noFileFound = false;
  for (let i = 0; i < 240; i++) {
    resultFrame = await findFrameWith('a[href*="ConsDetalladaStock"][href*="Result.do"]');
    if (resultFrame) break;

    for (const frame of page.frames()) {
      try {
        if (await frame.getByText(/Se encontraron 0 registros|No se encontraron registros/i).count() > 0) {
          noFileFound = true;
          break;
        }
      } catch {}
    }
    if (noFileFound) break;
    await page.waitForTimeout(250);
  }

  if (!resultFrame && noFileFound) {
    console.log('No file found for the Stock Ripley report.');
  } else if (!resultFrame) {
    throw new Error('Could not find the generated Stock Ripley CSV link.');
  } else {
    const stockDownloadLink = resultFrame.locator('a[href*="ConsDetalladaStock"][href*="Result.do"]').first();
    const stockDownloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await stockDownloadLink.click();
    const stockDownload = await stockDownloadPromise;
    await saveDateStampedDownload(stockDownload, 'inventarios');
  }

  // Close the browser after all workflows and uploads are complete.
  await context.close();
  console.log('Browser closed');
  if (stopXvfb) await stopXvfb();
})();
