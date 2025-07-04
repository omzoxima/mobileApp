import { Storage } from '@google-cloud/storage';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const storage = new Storage(); // On GCP, credentials are handled automatically
const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || 'run-sources-tuktuki-464514-asia-south1');

export async function uploadToGCS(file, folder = 'uploads') {
  const ext = path.extname(file.originalname);
  const filename = `${folder}/${uuidv4()}_${file.originalname}`;
  const blob = bucket.file(filename);
  await blob.save(file.buffer, {
    contentType: file.mimetype
  });
  return `https://storage.googleapis.com/${bucket.name}/${filename}`;
} 