
import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const bucketName = 'run-sources-tuktuki-464514-asia-south1';

export async function getSignedUrl(filePath, expiresInSeconds = 3600, action = 'read') {
  const [url] = await storage.bucket(bucketName).file(filePath).getSignedUrl({
    action,
    expires: Date.now() + expiresInSeconds * 1000,
  });
  return url;
}

export async function initiateResumableUpload(fileName) {
  const destination = `uploads/${uuidv4()}/${fileName}`;
  const file = storage.bucket(bucketName).file(destination);
  const [url] = await file.createResumableUpload();
  return { url, destination };
}

export async function listSegmentFiles(gcsFolder) {
  const [files] = await storage.bucket(bucketName).getFiles({ prefix: gcsFolder });
  return files.map(file => file.name);
}

export async function downloadFromGCS(filePath) {
  const [buffer] = await storage.bucket(bucketName).file(filePath).download();
  return buffer;
}

export async function uploadTextToGCS(filePath, content, contentType) {
  await storage.bucket(bucketName).file(filePath).save(content, {
    contentType,
  });
}

export async function uploadHLSFolderToGCS(localDir, gcsFolder) {
  const files = await fs.readdir(localDir);
  await Promise.all(files.map(async (file) => {
    const localPath = path.join(localDir, file);
    const gcsPath = `${gcsFolder}${file}`;
    await storage.bucket(bucketName).upload(localPath, {
      destination: gcsPath,
    });
  }));
}