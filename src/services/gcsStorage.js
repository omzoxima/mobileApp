import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises'; // Missing import

const storage = new Storage();
const bucketName = 'run-sources-tuktuki-464514-asia-south1';

// Upload single file to GCS
export async function uploadToGCS(file, folder) {
  const fileName = `${folder}/${uuidv4()}${path.extname(file.originalname)}`;
  const fileObj = storage.bucket(bucketName).file(fileName);
  
  await fileObj.save(file.buffer, {
    metadata: {
      contentType: file.mimetype,
      // Add cache control for better CDN performance
      cacheControl: 'public, max-age=31536000'
    },
    // Important for public files
    public: true // Uniform bucket-level access doesn't use this, but good to be explicit
  });
  
  return fileName;
}

// Upload HLS folder to GCS
export async function uploadHLSFolderToGCS(localDir, gcsPath) {
  const files = await fs.readdir(localDir);
  
  await Promise.all(files.map(async (file) => {
    const filePath = path.join(localDir, file);
    const fileContent = await fs.readFile(filePath);
    const destination = `${gcsPath}${file}`;
    
    const contentType = file.endsWith('.m3u8') ? 'application/x-mpegURL' : 
                      file.endsWith('.ts') ? 'video/MP2T' : 
                      'application/octet-stream';
    
    await storage.bucket(bucketName).file(destination).save(fileContent, {
      metadata: {
        contentType,
        cacheControl: 'public, max-age=31536000' // Cache for 1 year
      },
      resumable: false // Better for small files like HLS segments
    });
  }));
}

// Generate v4 signed URL
export async function getSignedUrl(gcsPath, expiryMinutes = 60) {
  try {
    const [url] = await storage
      .bucket(bucketName)
      .file(gcsPath)
      .getSignedUrl({
        action: 'read',
        expires: Date.now() + expiryMinutes * 60 * 1000,
        version: 'v4',
        // For HLS streaming, it's good to include the response headers
       
      });
    return url;
  } catch (error) {
    console.error('Error generating signed URL:', error);
    throw new Error('Failed to generate signed URL');
  }
}