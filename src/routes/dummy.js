import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Readable } from 'stream';

const router = express.Router();
const storage = new Storage();
const bucketName = 'run-sources-tuktuki-464514-asia-south1';

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Upload HLS to GCS
async function uploadHLSFolderToGCS(localDir, gcsPath) {
  const files = await fs.readdir(localDir);
  
  for (const file of files) {
    const filePath = path.join(localDir, file);
    const fileContent = await fs.readFile(filePath);
    const destination = `${gcsPath}${file}`;
    
    await storage.bucket(bucketName).file(destination).save(fileContent);
    console.log(`Uploaded ${file} to ${destination}`);
  }
}

// Convert to HLS and upload
router.post('/upload-hls', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const hlsId = uuidv4();
    const hlsDir = path.join('/tmp', hlsId);
    await fs.mkdir(hlsDir, { recursive: true });

    const hlsPlaylist = path.join(hlsDir, 'index.m3u8');
    const inputStream = new Readable({
      read() {
        this.push(req.file.buffer);
        this.push(null);
      }
    });
    inputStream.path = req.file.originalname;

    // Convert to HLS
    await new Promise((resolve, reject) => {
      ffmpeg(inputStream)
        .inputFormat('mp4')
        .outputOptions([
          '-c:v libx264',
          '-profile:v baseline',
          '-level 3.0',
          '-pix_fmt yuv420p',
          '-preset fast',
          '-crf 23',
          '-c:a aac',
          '-b:a 128k',
          '-start_number 0',
          '-hls_time 10',
          '-hls_list_size 0',
          '-f hls'
        ])
        .output(hlsPlaylist)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Upload to GCS
    const gcsFolder = `hls/${hlsId}/`;
    await uploadHLSFolderToGCS(hlsDir, gcsFolder);

    // Clean up
    await fs.rm(hlsDir, { recursive: true, force: true });

    res.json({
      success: true,
      hlsPath: `${gcsFolder}index.m3u8`,
      bucket: bucketName
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;