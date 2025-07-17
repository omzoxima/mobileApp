import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { createReadStream } from 'fs';
import { PassThrough } from 'stream';
import retry from 'async-retry';

const storage = new Storage({
  timeout: 30000, // 30-second timeout for GCS operations
});
const bucketName = 'run-sources-tuktuki-464514-asia-south1';

// Supported file extensions for validation
const VALID_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.ts', '.m3u8', '.jpg', '.jpeg', '.png', '.gif', '.webp'];

// Retry configuration for transient errors
const RETRY_OPTIONS = {
  retries: 3,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 5000,
};

// Stream file to GCS (used for direct uploads from signed URLs)
export async function streamToGCS(gcsPath, contentType) {
  try {
    const fileObj = storage.bucket(bucketName).file(gcsPath);
    return fileObj.createWriteStream({
      metadata: {
        contentType,
        cacheControl: 'public, max-age=31536000', // 1 year cache
      },
      resumable: true, // Enable resumable uploads for reliability
    });
  } catch (error) {
    console.error('Error creating GCS write stream:', error);
    throw new Error(`Failed to create stream: ${error.message}`);
  }
}

// Upload single file to GCS
export async function uploadToGCS(gcsPath, localPathOrBuffer, makePublic = false) {
  try {
    const ext = path.extname(gcsPath).toLowerCase();
    if (!VALID_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported file extension: ${ext}`);
    }

    const fileObj = storage.bucket(bucketName).file(gcsPath);

    await retry(async () => {
      if (Buffer.isBuffer(localPathOrBuffer)) {
        // Handle buffer (e.g., from multer)
        const stream = new PassThrough();
        stream.end(localPathOrBuffer);

        await new Promise((resolve, reject) => {
          stream
            .pipe(
              fileObj.createWriteStream({
                metadata: {
                  contentType,
                  cacheControl: 'public, max-age=31536000',
                },
                resumable: localPathOrBuffer.length > 5 * 1024 * 1024, // Resumable for > 5MB
              })
            )
            .on('error', reject)
            .on('finish', resolve);
        });
      } else {
        // Handle local file path
        await new Promise((resolve, reject) => {
          createReadStream(localPathOrBuffer)
            .pipe(
              fileObj.createWriteStream({
                metadata: {
                  contentType,
                  cacheControl: 'public, max-age=31536000',
                },
                resumable: true,
              })
            )
            .on('error', reject)
            .on('finish', resolve);
        });
      }
    }, RETRY_OPTIONS);

    if (makePublic) {
      await fileObj.makePublic();
      return `https://storage.googleapis.com/${bucketName}/${gcsPath}`;
    }

    return gcsPath;
  } catch (error) {
    console.error('Error uploading to GCS:', error);
    throw new Error(`Failed to upload file: ${error.message}`);
  }
}

// Delete file from GCS
export async function deleteFromGCS(gcsPath) {
  try {
    await retry(async () => {
      await storage.bucket(bucketName).file(gcsPath).delete();
    }, RETRY_OPTIONS);
  } catch (error) {
    console.error('Error deleting from GCS:', error);
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}

// Generate v4 signed URL
export async function generateSignedUrl(gcsPath, contentType, expiryMinutes = 60, action = 'read') {
  try {
    const options = {
      version: 'v4',
      action,
      expires: Date.now() + expiryMinutes * 60 * 1000,
    };



    const [url] = await retry(async () => {
      return await storage.bucket(bucketName).file(gcsPath).getSignedUrl(options);
    }, RETRY_OPTIONS);

    return url;
  } catch (error) {
    console.error('Error generating signed URL:', error);
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
}

// Get file URL (public or signed)
export async function getFileUrl(gcsPath, expiryMinutes = 60) {
  try {
    const fileObj = storage.bucket(bucketName).file(gcsPath);
    const [metadata] = await fileObj.getMetadata();

    if (metadata.acl?.some((rule) => rule.role === 'READER' && rule.entity === 'allUsers')) {
      return `https://storage.googleapis.com/${bucketName}/${gcsPath}`;
    }

    const contentType = metadata.contentType || 'application/octet-stream';
    return await generateSignedUrl(gcsPath, contentType, expiryMinutes, 'read');
  } catch (error) {
    console.error('Error getting file URL:', error);
    throw new Error(`Failed to get file URL: ${error.message}`);
  }
}

// List all .ts segment files in a GCS folder
export async function listSegmentFiles(gcsFolder) {
  try {
    const [files] = await retry(async () => {
      return await storage.bucket(bucketName).getFiles({ prefix: gcsFolder });
    }, RETRY_OPTIONS);

    return files
      .filter((f) => f.name.endsWith('.ts'))
      .map((f) => f.name);
  } catch (error) {
    console.error('Error listing segment files:', error);
    throw new Error(`Failed to list segment files: ${error.message}`);
  }
}

// Download a file from GCS
export async function downloadFromGCS(gcsPath) {
  try {
    const [contents] = await retry(async () => {
      return await storage.bucket(bucketName).file(gcsPath).download();
    }, RETRY_OPTIONS);

    return contents.toString();
  } catch (error) {
    console.error('Error downloading from GCS:', error);
    throw new Error(`Failed to download file: ${error.message}`);
  }
}

// Upload text to GCS (overwrite)
export async function uploadTextToGCS(gcsPath, text, contentType = 'application/x-mpegURL') {
  try {
    await retry(async () => {
      await storage.bucket(bucketName).file(gcsPath).save(text, {
        metadata: {
          contentType,
          cacheControl: 'public, max-age=3600', // 1 hour cache for playlists
        },
        resumable: false,
      });
    }, RETRY_OPTIONS);
  } catch (error) {
    console.error('Error uploading text to GCS:', error);
    throw new Error(`Failed to upload text: ${error.message}`);
  }
}