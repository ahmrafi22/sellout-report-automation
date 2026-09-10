import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let driveInstance = null;

function loadCredentials() {
  const cred = JSON.parse(readFileSync(path.join(__dirname, 'client_secret.json'), 'utf8')).installed;
  return cred;
}

function loadToken() {
  const tokenPath = path.join(__dirname, 'token.json');
  if (!existsSync(tokenPath)) throw new Error('token.json not found. Run gdrive-auth.mjs once to authorize Google Drive.');
  return JSON.parse(readFileSync(tokenPath, 'utf8'));
}

export function getDrive() {
  if (driveInstance) return driveInstance;
  const cred = loadCredentials();
  const oauth2Client = new google.auth.OAuth2(cred.client_id, cred.client_secret);
  oauth2Client.setCredentials(loadToken());
  driveInstance = google.drive({ version: 'v3', auth: oauth2Client });
  return driveInstance;
}

// Ensure a Drive folder exists under parentId, return its file object ({id})
export async function ensureFolder(name, parentId) {
  const drive = getDrive();
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const list = await drive.files.list({ q, fields: 'files(id)' });
  if (list.data.files[0]) return list.data.files[0];
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  console.log('Created Drive folder:', name);
  return created.data;
}

// Generic upload: ensures folder chain fbusinesscenter/<tenant>/<folder> then uploads/updates file
// Returns Drive file response
export async function uploadToDriveGeneric(filePath, tenant, folderName, createReadStreamFn, mimeType) {
  const drive = getDrive();
  const fileName = path.basename(filePath);
  const rootFolder = await ensureFolder('fbusinesscenter', 'root');
  const tenantFolder = await ensureFolder(tenant, rootFolder.id);
  const target = await ensureFolder(folderName, tenantFolder.id);
  const existing = await drive.files.list({
    q: `name='${fileName.replace(/'/g, "\\'")}' and '${target.id}' in parents and trashed=false`,
    orderBy: 'createdTime desc',
    pageSize: 1,
    fields: 'files(id, name, webViewLink)',
  });
  const media = { mimeType, body: createReadStreamFn(filePath) };
  const existingFile = existing.data.files[0];
  const res = existingFile
    ? await drive.files.update({ fileId: existingFile.id, media, fields: 'id, name, webViewLink' })
    : await drive.files.create({ requestBody: { name: fileName, parents: [target.id] }, media, fields: 'id, name, webViewLink' });
  return { res, existingFile, target };
}
