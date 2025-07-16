import { Storage } from '@google-cloud/storage';
import path from 'path';
import { PassThrough } from 'stream';

const storage = new Storage();

const bucketName ='run-sources-tuktuki-464514-asia-south1';

// Generate signed URL for direct upload
export async function generateSignedUrl(fileName, contentType, expiresInMinutes = 100) {
  const options = {
    version: 'v4',
    action: 'write',
    expires: Date.now() + expiresInMinutes * 60 * 1000,
    contentType,
  };

  const [url] = await storage
    .bucket(bucketName)
    .file(fileName)
    .getSignedUrl(options);

  return url;
}
// Add to gcsStorage.js
export async function downloadFromGCS(filePath) {
  const file = storage.bucket(bucketName).file(filePath);
  const [content] = await file.download();
  return content.toString('utf-8');
}
// Stream data directly to GCS
export async function streamToGCS(destinationPath, readStream, contentType) {
  const writeStream = storage
    .bucket(bucketName)
    .file(destinationPath)
    .createWriteStream({
      metadata: {
        contentType: contentType || 'application/octet-stream'
      },
      resumable: false
    });

  return new Promise((resolve, reject) => {
    readStream
      .on('error', reject)
      .pipe(writeStream)
      .on('error', reject)
      .on('finish', resolve);
  });
}

// Get signed URL for reading
export async function getSignedUrl(filePath, expiresInMinutes = 60 * 24 * 7) {
  const options = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresInMinutes * 60 * 1000,
  };

  const [url] = await storage
    .bucket(bucketName)
    .file(filePath)
    .getSignedUrl(options);

  return url;
}

// Upload text content to GCS
export async function uploadTextToGCS(filePath, content, contentType) {
  await storage.bucket(bucketName).file(filePath).save(content, {
    metadata: {
      contentType: contentType || 'text/plain'
    }
  });
}

// List segment files in a GCS folder
export async function listSegmentFiles(folderPath) {
  const [files] = await storage.bucket(bucketName).getFiles({
    prefix: folderPath
  });

  return files
    .filter(file => file.name.endsWith('.ts'))
    .map(file => file.name);
}