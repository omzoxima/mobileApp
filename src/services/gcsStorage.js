import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const bucketName = 'run-sources-tuktuki-464514-asia-south1';
 

 
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
export async function listSegmentFiles(gcsFolder) {
  const [files] = await storage.bucket(bucketName).getFiles({ prefix: gcsFolder });
  return files.filter(f => f.name.endsWith('.ts')).map(f => f.name);
}
 
// Download a file from GCS
export async function downloadFromGCS(gcsPath) {
  const [contents] = await storage.bucket(bucketName).file(gcsPath).download();
  return contents.toString();
}
export async function uploadTextToGCS(gcsPath, text, contentType = 'application/x-mpegURL') {
  await storage.bucket(bucketName).file(gcsPath).save(text, {
    metadata: { contentType, cacheControl: 'public, max-age=31536000' },
    resumable: false
  });
}
