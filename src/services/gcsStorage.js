import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

const storage = new Storage();
const bucketName = process.env.GCS_BUCKET_NAME || 'run-sources-tuktuki-464514-asia-south1';

// Stream file to GCS
export async function streamUploadToGCS(fileBuffer, fileName, contentType) {
  try {
    if (!fileName || !contentType) {
      throw new Error('fileName and contentType are required');
    }

    const destination = `uploads/${uuidv4()}/${fileName}`;
    const file = storage.bucket(bucketName).file(destination);

    // Verify bucket exists
    try {
      await storage.bucket(bucketName).getMetadata();
    } catch (err) {
      throw new Error(`Bucket ${bucketName} not found or inaccessible: ${err.message}`);
    }

    // Stream file to GCS
    const writeStream = file.createWriteStream({
      metadata: { contentType },
      resumable: false, // Disable resumable uploads
    });

    return new Promise((resolve, reject) => {
      writeStream.on('finish', () => {
        resolve(destination);
      });
      writeStream.on('error', (err) => {
        reject(new Error(`Failed to stream file to GCS: ${err.message}`));
      });
      writeStream.end(fileBuffer);
    });
  } catch (error) {
    console.error('Error in streamUploadToGCS:', {
      message: error.message,
      stack: error.stack,
      fileName,
      contentType,
    });
    throw error;
  }
}

// Upload HLS folder to GCS
export async function uploadHLSFolderToGCS(localDir, gcsFolder) {
  try {
    const files = await fs.readdir(localDir);
    await Promise.all(files.map(async (fileName) => {
      const localPath = path.join(localDir, fileName);
      const gcsPath = `${gcsFolder}${fileName}`;
      const file = storage.bucket(bucketName).file(gcsPath);
      const fileBuffer = await fs.readFile(localPath);
      const contentType = fileName.endsWith('.m3u8') ? 'application/x-mpegURL' : 'video/mp2t';
      await file.save(fileBuffer, { contentType, resumable: false });
    }));
  } catch (error) {
    console.error('Error in uploadHLSFolderToGCS:', {
      message: error.message,
      stack: error.stack,
      localDir,
      gcsFolder,
    });
    throw error;
  }
}

// Download file from GCS
export async function downloadFromGCS(gcsPath) {
  try {
    const file = storage.bucket(bucketName).file(gcsPath);
    const [buffer] = await file.download();
    return buffer;
  } catch (error) {
    console.error('Error in downloadFromGCS:', {
      message: error.message,
      stack: error.stack,
      gcsPath,
    });
    throw error;
  }
}

// List segment files in GCS folder
export async function listSegmentFiles(gcsFolder) {
  try {
    const [files] = await storage.bucket(bucketName).getFiles({ prefix: gcsFolder });
    return files.map(file => file.name);
  } catch (error) {
    console.error('Error in listSegmentFiles:', {
      message: error.message,
      stack: error.stack,
      gcsFolder,
    });
    throw error;
  }
}

// Upload text content to GCS
export async function uploadTextToGCS(gcsPath, content, contentType) {
  try {
    const file = storage.bucket(bucketName).file(gcsPath);
    await file.save(content, { contentType, resumable: false });
  } catch (error) {
    console.error('Error in uploadTextToGCS:', {
      message: error.message,
      stack: error.stack,
      gcsPath,
    });
    throw error;
  }
}

// Generate signed URL for GET
export async function getSignedUrl(fileName, expiresInSeconds = 3600) {
  try {
    const file = storage.bucket(bucketName).file(fileName);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresInSeconds * 1000,
    });
    return url;
  } catch (error) {
    console.error('Error in getSignedUrl:', {
      message: error.message,
      stack: error.stack,
      fileName,
    });
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
}