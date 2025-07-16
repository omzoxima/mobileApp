import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

const storage = new Storage();
const bucketName ='run-sources-tuktuki-464514-asia-south1';

if (!bucketName) {
  throw new Error('GCS_BUCKET_NAME environment variable is not set');
}

export async function initiateResumableUpload(fileName) {
  try {
    if (!fileName) {
      throw new Error('fileName is required');
    }

    const destination = `uploads/${uuidv4()}/${fileName}`;
    const file = storage.bucket(bucketName).file(destination);
    
    // Verify bucket exists
    try {
      await storage.bucket(bucketName).getMetadata();
    } catch (err) {
      throw new Error(`Bucket ${bucketName} not found or inaccessible: ${err.message}`);
    }

    const [url] = await file.createResumableUpload({
      metadata: { contentType: 'video/mp4' }, // Default to video/mp4, adjust if needed
    });

    return { url, destination };
  } catch (error) {
    console.error('Error in initiateResumableUpload:', {
      message: error.message,
      stack: error.stack,
      fileName,
    });
    throw new Error(`Failed to initiate resumable upload: ${error.message}`);
  }
}

export async function getSignedUrl(filePath, expiresInSeconds = 3600, action = 'read') {
  try {
    const [url] = await storage.bucket(bucketName).file(filePath).getSignedUrl({
      action,
      expires: Date.now() + expiresInSeconds * 1000,
    });
    return url;
  } catch (error) {
    console.error('Error in getSignedUrl:', {
      message: error.message,
      stack: error.stack,
      filePath,
      action,
    });
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
}

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
    throw new Error(`Failed to list segment files: ${error.message}`);
  }
}

export async function downloadFromGCS(filePath) {
  try {
    const [buffer] = await storage.bucket(bucketName).file(filePath).download();
    return buffer;
  } catch (error) {
    console.error('Error in downloadFromGCS:', {
      message: error.message,
      stack: error.stack,
      filePath,
    });
    throw new Error(`Failed to download from GCS: ${error.message}`);
  }
}

export async function uploadTextToGCS(filePath, content, contentType) {
  try {
    await storage.bucket(bucketName).file(filePath).save(content, {
      contentType,
    });
  } catch (error) {
    console.error('Error in uploadTextToGCS:', {
      message: error.message,
      stack: error.stack,
      filePath,
    });
    throw new Error(`Failed to upload text to GCS: ${error.message}`);
  }
}

export async function uploadHLSFolderToGCS(localDir, gcsFolder) {
  try {
    const files = await fs.readdir(localDir);
    await Promise.all(files.map(async (file) => {
      const localPath = path.join(localDir, file);
      const gcsPath = `${gcsFolder}${file}`;
      await storage.bucket(bucketName).upload(localPath, {
        destination: gcsPath,
      });
    }));
  } catch (error) {
    console.error('Error in uploadHLSFolderToGCS:', {
      message: error.message,
      stack: error.stack,
      localDir,
      gcsFolder,
    });
    throw new Error(`Failed to upload HLS folder to GCS: ${error.message}`);
  }
}