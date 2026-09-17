import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync, createReadStream } from 'fs';
import { getDrive, ensureFolder } from './drive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drive = getDrive();

function run(script) {
  return new Promise((resolve, reject) => {
    // ripley.js is self-sufficient: it starts its own throwaway Xvfb when no
    // DISPLAY exists (headless VPS) and stops it on exit.
    const child = spawn('node', [script], { stdio: 'inherit', cwd: __dirname });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

// Exit code 7 signals a retryable failure (the known Playwright pageError
// crash). Run the workflow up to maxAttempts times for those; other failures
// are treated as fatal and reported right away.
async function runWithRetry(script, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n===== [${label}] WORKFLOW (attempt ${attempt}/${maxAttempts}) =====`);
    try {
      await run(script);
      return;
    } catch (e) {
      const retryable = /exited with code 7/.test(e.message);
      console.error(e.message);
      if (!retryable || attempt >= maxAttempts) {
        failures.push(`${script}: ${e.message}`);
        return;
      }
      console.log(`Retryable failure detected - restarting ${script} in 10 seconds...`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

// Build today's report from the per-day upload records and upload it to Drive -> logs/.
async function uploadDailyReport() {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const recordPath = path.join(__dirname, `upload-records-${dateKey}.jsonl`);
  const reportPath = path.join(__dirname, `${dateKey}.txt`);

  let content = `Upload report for ${dateKey}\nGenerated: ${now.toISOString()}\n\n`;
  if (existsSync(recordPath)) {
    const lines = readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) content += 'No files were uploaded today.\n';
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        content += `- ${r.file}\n  -> ${r.drivePath}\n  Link: ${r.link}\n\n`;
      } catch {}
    }
  } else {
    content += 'No files were uploaded today (no records found).\n';
  }

  writeFileSync(reportPath, content);

  const fbusinesscenterFolder = await ensureFolder('fbusinesscenter', 'root');
  const logsFolder = await ensureFolder('logs', fbusinesscenterFolder.id);
  const fileName = path.basename(reportPath);
  const existing = await drive.files.list({
    q: `name='${fileName.replace(/'/g, "\\'")}' and '${logsFolder.id}' in parents and trashed=false`,
    fields: 'files(id)',
  });

  const media = { mimeType: 'text/plain', body: createReadStream(reportPath) };
  const res = existing.data.files[0]
    ? await drive.files.update({ fileId: existing.data.files[0].id, media, fields: 'id, name, webViewLink' })
    : await drive.files.create({ requestBody: { name: fileName, parents: [logsFolder.id] }, media, fields: 'id, name, webViewLink' });

  console.log(`Log report uploaded: ${res.data.name} -> logs/`);
  console.log('Link:', res.data.webViewLink);
  unlinkSync(reportPath);
  if (existsSync(recordPath)) unlinkSync(recordPath);
  console.log('Daily upload records cleared.');
}

const failures = [];
await runWithRetry('falabella.js', '1/4 FALABELLA');
await runWithRetry('ripley.js', '2/4 RIPLEY');
await runWithRetry('mercadolibre.js', '3/4 MERCADOLIBRE');
await runWithRetry('wall-mart.js', '4/4 WALLMART');

try {
  await uploadDailyReport();
} catch (e) {
  console.error('Failed to upload daily report:', e.message);
}

if (failures.length) {
  console.error('\n===== WORKFLOWS WITH FAILURES =====');
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log('\n===== ALL WORKFLOWS COMPLETED =====');
