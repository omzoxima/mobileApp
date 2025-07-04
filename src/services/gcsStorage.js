import { Storage } from '@google-cloud/storage';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';

const storage = new Storage(); // On GCP, credentials are handled automatically
const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || 'run-sources-tuktuki-464514-asia-south1');

// Upload a single file (buffer) to GCS
export async function uploadToGCS(file, folder = 'uploads') {
  const ext = path.extname(file.originalname);
  const filename = `${folder}/${uuidv4()}_${file.originalname}`;
  const blob = bucket.file(filename);
  await blob.save(file.buffer, {
    contentType: file.mimetype
  });
  return `https://storage.googleapis.com/${bucket.name}/${filename}`;
}

// Upload all files in a local folder to GCS under a given folder
export async function uploadHLSFolderToGCS(localDir, gcsFolder) {
  const files = await fs.readdir(localDir);
  for (const file of files) {
    await bucket.upload(path.join(localDir, file), {
      destination: `${gcsFolder}${file}`,
      predefinedAcl: 'private'
    });
  }
}

// Generate a signed URL for a GCS object
export async function getSignedUrl(filePath, expiresInSeconds = 3600) {
  const [url] = await bucket.file(filePath).getSignedUrl({
    action: 'read',
    expires: Date.now() + expiresInSeconds * 1000,
  });
  return url;
} 