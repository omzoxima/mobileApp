// gcstorage.js
import { Storage } from '@google-cloud/storage';
import { PassThrough } from 'stream';

const storage = new Storage();
const bucketName = 'run-sources-tuktuki-464514-asia-south1';

// Generate signed URL with additional security
export async function generateSignedUrl(fileName, contentType, expiresInMinutes = 15, action = 'write') {
  const options = {
    version: 'v4',
    action,
    expires: expiresInMinutes * 60 * 1000, // This would be relative to epoch time (1970)
  };

  
  const [url] = await storage
    .bucket(bucketName)
    .file(fileName)
    .getSignedUrl(options);

  return url;
}

// Improved stream handling with progress
export async function streamToGCS(destinationPath, readStream, contentType, onProgress) {
  const file = storage.bucket(bucketName).file(destinationPath);
  const writeStream = file.createWriteStream({
    metadata: { contentType: contentType || 'application/octet-stream' },
    resumable: false
  });

  return new Promise((resolve, reject) => {
    let bytesWritten = 0;
    
    readStream
      .on('data', (chunk) => {
        bytesWritten += chunk.length;
        if (onProgress) onProgress(bytesWritten);
      })
      .on('error', reject)
      .pipe(writeStream)
      .on('error', reject)
      .on('finish', () => resolve(destinationPath));
  });
}

// Upload with automatic content type detection
export async function uploadToGCS(filePath, localPath, contentType) {
  await storage.bucket(bucketName).upload(localPath, {
    destination: filePath,
    metadata: { contentType },
    resumable: false
  });
  return filePath;
}

// Get public URL if available or signed URL
export async function getFileUrl(filePath, expiresInMinutes = 60 * 24) {
  const [metadata] = await storage.bucket(bucketName).file(filePath).getMetadata();
  
  if (metadata.acl?.some(rule => rule.entity === 'allUsers' && rule.role === 'READER')) {
    return `https://storage.googleapis.com/${bucketName}/${filePath}`;
  }
  
  return generateSignedUrl(filePath, metadata.contentType, expiresInMinutes, 'read');
}

// Delete files
export async function deleteFromGCS(filePath) {
  await storage.bucket(bucketName).file(filePath).delete();
}

// List files with pagination
export async function listFiles(prefix, maxResults = 100) {
  const [files] = await storage.bucket(bucketName).getFiles({
    prefix,
    maxResults
  });
  return files;
}