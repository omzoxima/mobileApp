import { Storage } from '@google-cloud/storage';
import mime from 'mime-types';
import fs from 'fs/promises';
import path from 'path';


const storage   = new Storage();
const bucket    = storage.bucket('run-sources-tuktuki-464514-asia-south1');

/* ---------------- signed URLs ---------------- */
export async function getSignedUploadUrl(filePath, contentType, expiresMin = 15) {
  const [url] = await bucket.file(filePath).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + expiresMin * 60 * 1000,
    contentType
  });
  return url;
}

export async function getSignedUrl(filePath, expiresMin = 60) {
  const [url] = await bucket.file(filePath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresMin * 60 * 1000
  });
  return url;
}

/* ------------- folder upload (HLS) ------------- */
export async function uploadHLSFolderToGCS(localDir, gcsPrefix) {
  const entries = await fs.readdir(localDir);
  await Promise.all(entries.map(async (file) => {
    const localPath = path.join(localDir, file);
    const gcsPath   = `${gcsPrefix}${file}`;
    await bucket.upload(localPath, {
      destination: gcsPath,
      resumable: true,
      contentType: mime.lookup(file) || 'application/octet-stream',
    });
  }));
}

/* ------------- helpers for playlist rewrite ------------- */
export async function listSegmentFiles(gcsPrefix) {
  const [files] = await bucket.getFiles({ prefix: gcsPrefix, autoPaginate: false });
  return files
    .filter(f => f.name.endsWith('.ts'))
    .map(f => f.name);
}

export async function downloadFromGCS(filePath) {
  const [contents] = await bucket.file(filePath).download();
  return contents.toString('utf8');
}

export async function uploadTextToGCS(filePath, text, contentType = 'text/plain') {
  await bucket.file(filePath).save(text, { resumable: false, contentType });
}

export async function downloadFileFromGCS(filePath, destPath) {
  await bucket.file(filePath).download({ destination: destPath });
}
