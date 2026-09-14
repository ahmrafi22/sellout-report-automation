import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, createReadStream, appendFileSync } from 'fs';
import { rename, unlink } from 'fs/promises';
import { sendTelegramMessage } from './telegram.js';
import dateConfig from './date-workflows.json' with { type: 'json' };
import { getDrive, ensureFolder } from './drive.js';
import { getStore } from './config.js';
import { summarizeReport } from './ai-analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = path.join(__dirname, 'chrome-profile');

const HEADLESS = process.env.HEADLESS !== '0';

const siteKeys = getStore('fbusinesscenter');
const drive = getDrive();

async function uploadToDrive(filePath, folderName, tenantName = 'Falabella') {
  const fileName = path.basename(filePath);

  // AI analysis runs on the freshly downloaded file before it is uploaded and removed.
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

  const media = {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: createReadStream(filePath),
  };

  const existingFile = existing.data.files[0];
  const res = existingFile
    ? await drive.files.update({
        fileId: existingFile.id,
        media,
        fields: 'id, name, webViewLink',
      })
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

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: HEADLESS,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
  ],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
  permissions: ['geolocation'],
  geolocation: { longitude: -73.935242, latitude: 40.730610 },
  colorScheme: 'light',
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  ignoreHTTPSErrors: true,
});

const page = context.pages()[0] || await context.newPage();

// Remove webdriver property
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ],
  });

  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);

  window.chrome = { runtime: {} };
});

await page.setExtraHTTPHeaders({
  'Accept-Language': 'en-US,en;q=0.9',
});

await page.goto('https://fbusinesscenter.com/reports', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);

console.log('Page opened:', await page.title());

// Handle landing-page navigation and login before developing new workflows.

if (page.url().includes('/landing')) {
  console.log('Landing page detected, clicking CTA to go to login...');
  await page.waitForSelector('#cta');
  await page.click('#cta');
  await page.waitForTimeout(10000);
  console.log('Navigated to:', page.url());
}

async function humanType(selector, text) {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await page.waitForTimeout(50 + Math.random() * 150);
  }
}

const url = page.url();
if (url.includes('/login') || url.includes('access-key-corp.falabella.tech/auth')) {
  console.log('Login page detected, filling credentials...');

  await page.waitForSelector('#username');
  await humanType('#username', siteKeys.email);
  await page.waitForTimeout(300 + Math.random() * 500);

  await page.waitForSelector('#password');
  await humanType('#password', siteKeys.password);
  await page.waitForTimeout(300 + Math.random() * 500);

  await page.click('button.mt-0');
  console.log('Login submitted');

  await page.waitForTimeout(10000);
  console.log('Logged in, current URL:', page.url());
}

// Return to the reports page after login if the site redirected elsewhere.
if (!page.url().includes('/reports')) {
  await page.goto('https://fbusinesscenter.com/reports', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  console.log('Reports page loaded:', page.url());
}

async function selectTenant(tenantValue, tenantName) {
  await page.waitForSelector('[data-testid="select-header-tenant-business-unit"]');
  await page.click('.MuiInputBase-root:has(input[data-testid="select-header-tenant-business-unit"]) [role="combobox"]');
  await page.waitForSelector('ul[role="listbox"]');
  await page.waitForTimeout(500);
  await page.click(`li[data-value="${tenantValue}"]`);
  await page.waitForTimeout(3000);
  console.log(`${tenantName} selected`);
}

// Start with Falabella, which is the default tenant after login.
await selectTenant('FAL', 'Falabella');

// Auto-close the "Update Information" popup whenever it appears
(async () => {
  while (true) {
    try {
      const closeBtn = await page.waitForSelector('button[aria-label="close"]', { timeout: 5000 });
      if (closeBtn) {
        await closeBtn.click();
        console.log('Popup closed');
      }
    } catch {
      // timeout — no popup yet, keep waiting
    }
    try {
      await page.waitForTimeout(1000);
    } catch {
      break; // page/browser closed, exit loop
    }
  }
})();

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!existsSync(downloadsDir)) {
  mkdirSync(downloadsDir, { recursive: true });
}

// Reusable function: select a Descargables item, set dates, clear cache, download Excel
async function selectAndDownload(menuItemLabel, { setDates = true, datePreset = null, driveFolder = null, driveTenant = 'Falabella' } = {}) {
  // Helper: set a date field inside the iframe
  async function setDateField(testId, dateStr) {
    const el = dashFrame.locator(`[data-testid="${testId}"]`);
    await el.click();
    await el.press('Control+a');
    await el.press('Delete');
    await el.type(dateStr, { delay: 30 });
    await el.press('Tab');
  }
  console.log(`\n=== Starting workflow for: ${menuItemLabel} ===`);

  // Click the "Descargables" dropdown
  await page.locator('button:has-text("Descargables")').first().click();
  await page.waitForTimeout(2000);

  // Click the target menu item
  const menuItem = page.locator('.MuiPopover-paper button, .MuiPopover-paper [role="menuitem"]').filter({ hasText: menuItemLabel });
  await menuItem.first().waitFor({ state: 'visible', timeout: 30000 });
  await menuItem.first().click();
  console.log(`Clicked "${menuItemLabel}", waiting for dashboard iframe...`);

  // Wait for the newly opened Looker iframe to appear and load.
  // The previous workflow's iframe can remain in the DOM, so use the last one.
  const dashboardIframe = page.locator('iframe[src*="looker"]').last();
  await dashboardIframe.waitFor({ state: 'visible', timeout: 120000 });
  const dashFrame = page.frameLocator('iframe[src*="looker"]').last();
  await dashFrame.locator('body').waitFor({ state: 'visible', timeout: 120000 });
  console.log('Looker dashboard iframe loaded');

  // Wait for dashboard content inside the iframe (DashboardBody / loader)
  await dashFrame.locator('.FilterContainer-sc-ch0zup-0').or(dashFrame.locator('.ag-root')).first().waitFor({ state: 'visible', timeout: 60000 });
  // Wait for any loading spinner to finish
  try {
    await dashFrame.locator('div[role="progressbar"]').waitFor({ state: 'visible', timeout: 10000 });
    await dashFrame.locator('div[role="progressbar"]').waitFor({ state: 'hidden', timeout: 120000 });
  } catch {
    // no spinner appeared, dashboard already loaded
  }
  console.log('Dashboard rendered inside iframe');

  // Apply the date mode selected in date-workflows.json.
  if (setDates) {
    const mode = dateConfig.dateModes[datePreset];
    if (!mode) throw new Error(`Unknown date mode: ${datePreset}`);

    const fechaContainer = dashFrame.locator('.FilterContainer-sc-ch0zup-0').filter({ has: dashFrame.locator('span:has-text("Fecha")') });
    const openDate = fechaContainer.locator(mode.open.selector);
    const dateChip = mode.open.text ? openDate.filter({ hasText: mode.open.text }) : openDate;
    await dateChip.first().waitFor({ state: 'visible', timeout: 30000 });
    await dateChip.first().scrollIntoViewIfNeeded();
    await dateChip.first().click({ force: true });
    console.log(`Fecha ${mode.open.text || 'active chip'} clicked`);

    if (mode.dialog) {
      await dashFrame.locator('div[role="dialog"]').waitFor({ state: 'visible', timeout: 30000 });
      console.log('Date picker dialog opened');
    }

    let updateClicked = false;
    for (const step of mode.steps) {
      if (step.action === 'clickText') {
        await dashFrame.getByText(step.text, { exact: true }).last().click();
        console.log(`${step.text} selected`);
      } else if (step.action === 'fill') {
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        const values = {
          firstDayOfCurrentMonth: `${yesterday.getFullYear()}/${String(yesterday.getMonth() + 1).padStart(2, '0')}/01`,
          yesterday: `${yesterday.getFullYear()}/${String(yesterday.getMonth() + 1).padStart(2, '0')}/${String(yesterday.getDate()).padStart(2, '0')}`,
        };
        await setDateField(step.field, values[step.value]);
        console.log(`${step.value} set to: ${values[step.value]}`);
      } else if (step.action === 'click') {
        await dashFrame.locator(step.selector).click();
        updateClicked = true;
        console.log('Update button clicked, waiting for spinner...');
        await dashFrame.locator('div[role="progressbar"]').waitFor({ state: 'visible', timeout: 30000 });
        await dashFrame.locator('div[role="progressbar"]').waitFor({ state: 'hidden', timeout: 120000 });
        console.log('Date range update complete');
      }
    }

    if (!updateClicked) {
      try {
        const updateButton = dashFrame.locator('button[class*="RunButton__IconButtonWithBackground"]');
        await updateButton.waitFor({ state: 'visible', timeout: 5000 });
        await updateButton.click();
        console.log('Update button clicked, waiting for spinner...');
        await dashFrame.locator('div[role="progressbar"]').waitFor({ state: 'visible', timeout: 30000 });
        await dashFrame.locator('div[role="progressbar"]').waitFor({ state: 'hidden', timeout: 120000 });
        console.log('Date range update complete');
      } catch {
        console.log('Date preset applied without an Update button');
      }
    }
  } else {
    console.log('Skipping date range setup (not needed for this dashboard)');
  }

  // Click the Dashboard actions (kebab/three-dot menu) button and clear cache & refresh
  await dashFrame.locator('button[aria-controls]:has-text("Dashboard actions")').click();
  console.log('Dashboard actions menu opened');

  await dashFrame.locator('button[role="menuitem"]:has-text("Clear cache and refresh")').click();
  console.log('Clear cache and refresh clicked, waiting for spinner...');

  // Wait for the spinner to appear and disappear again during cache clear
  await dashFrame.locator('div[role="progressbar"]').waitFor({ state: 'visible', timeout: 30000 });
  await dashFrame.locator('div[role="progressbar"]').waitFor({ state: 'hidden', timeout: 120000 });
  console.log('Cache clear complete');

  // Click the Tile actions button (three dots on the tile)
  await dashFrame.locator('button[aria-label*="Tile actions"]').click();
  console.log('Tile actions menu opened');

  // Click "Download data"
  await dashFrame.locator('button[role="menuitem"]:has-text("Download data")').click();
  console.log('Download dialog opened');

  // Open Advanced data options accordion
  await dashFrame.locator('div[role="button"]:has-text("Advanced data options")').click();
  await page.waitForTimeout(1000);
  console.log('Advanced data options opened');

  // Select "All results" radio
  await dashFrame.locator('label:has-text("All results")').click();
  await page.waitForTimeout(500);
  console.log('All results selected');

  // Change format from CSV to Excel
  await dashFrame.locator('[data-testid="caret"]').click();
  await dashFrame.locator('[role="listbox"] [role="option"]:has-text("Excel")').click();
  await page.waitForTimeout(500);
  console.log('Format set to Excel');

  // Set up download watcher, then click Download button
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await dashFrame.locator('#qr-export-modal-download').click();
  console.log('Download button clicked, waiting for file...');

  const download = await downloadPromise;
  const savedPath = path.join(downloadsDir, download.suggestedFilename());
  await download.saveAs(savedPath);
  console.log('Download saved to:', savedPath);

  // Add today's date to the filename before uploading.
  // Slashes are invalid in Windows filenames, so use dd-mm-yy.
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

  if (driveFolder) {
    await uploadToDrive(datedPath, driveFolder, driveTenant);
  }

  await page.waitForTimeout(2000);
}

// --- Falabella workflows ---
await selectAndDownload('Ventas históricas diarias (1p)', {
  datePreset: dateConfig.workflowDateVariables.falabellaVentasHistoricas,
  driveFolder: 'ventas',
  driveTenant: 'Falabella',
});
console.log('\n=== First Falabella download complete, starting second workflow ===');

await selectAndDownload('Análisis semanal e inventario', {
  setDates: dateConfig.workflowDateVariables.falabellaAnalisisInventario !== 'none',
  datePreset: dateConfig.workflowDateVariables.falabellaAnalisisInventario,
  driveFolder: 'inventarios',
  driveTenant: 'Falabella',
});
console.log('\n=== Falabella workflows complete ===');

await selectTenant('SOD', 'Sodimac');

// --- Sodimac workflows ---
await selectAndDownload('Ventas históricas diarias (1p)', {
  datePreset: dateConfig.workflowDateVariables.sodimacVentasHistoricas,
  driveFolder: 'ventas',
  driveTenant: 'Sodimac',
});
console.log('\n=== First Sodimac download complete, starting second workflow ===');

await selectAndDownload('Análisis semanal e inventario', {
  setDates: dateConfig.workflowDateVariables.sodimacAnalisisInventario !== 'none',
  datePreset: dateConfig.workflowDateVariables.sodimacAnalisisInventario,
  driveFolder: 'inventarios',
  driveTenant: 'Sodimac',
});
console.log('\n=== Sodimac workflows complete ===');

await selectTenant('TOT', 'Tottus');

// --- Tottus workflow 1: Ventas históricas diarias (1p) ---
await selectAndDownload('Ventas históricas diarias (1p)', {
  datePreset: dateConfig.workflowDateVariables.tottusVentasHistoricas,
  driveFolder: 'ventas',
  driveTenant: 'Tottus',
});
console.log('\n=== First Tottus download complete, starting second workflow ===');

// --- Tottus workflow 2: Ventas e inventario ---
await selectAndDownload('Ventas e inventario', {
  datePreset: dateConfig.workflowDateVariables.tottusVentasInventario,
  driveFolder: 'inventarios',
  driveTenant: 'Tottus',
});
console.log('\n=== Second Tottus download complete ===');

await context.close();
console.log('Browser closed');
