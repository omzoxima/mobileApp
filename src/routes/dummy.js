import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const storage = new Storage();
const bucketName = 'run-sources-tuktuki-464514-asia-south1';

// Configure multer with limits
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB
    files: 1
  }
});

// Improved HLS upload function
async function uploadHLSFolderToGCS(localDir, gcsPath) {
  try {
    const files = await fs.readdir(localDir);
    
    await Promise.all(files.map(async (file) => {
      const filePath = path.join(localDir, file);
      const fileContent = await fs.readFile(filePath);
      const destination = `${gcsPath}${file}`;
      
      await storage.bucket(bucketName).file(destination).save(fileContent);
      console.log(`Uploaded ${file} to ${destination}`);
    }));
    
    return true;
  } catch (error) {
    console.error('GCS upload error:', error);
    throw error;
  }
}

// Enhanced HLS conversion endpoint
router.post('/upload-hls', upload.single('video'), async (req, res) => {
  try {
    // Validate input
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    // Create working directory
    const hlsId = uuidv4();
    const hlsDir = path.join('/tmp', hlsId);
    await fs.mkdir(hlsDir, { recursive: true });

    // Save uploaded file to disk first (more reliable than streams)
    const tempInputPath = path.join(hlsDir, 'input.mp4');
    await fs.writeFile(tempInputPath, req.file.buffer);

    // Verify the file was written correctly
    const stats = await fs.stat(tempInputPath);
    if (stats.size === 0) {
      throw new Error('Empty file after write');
    }

    // Set up HLS output
    const hlsPlaylist = path.join(hlsDir, 'index.m3u8');

    // Convert to HLS with better error handling
    await new Promise((resolve, reject) => {
      const command = ffmpeg(tempInputPath)
        .inputOptions([
          '-re', // Read input at native frame rate
          '-analyzeduration 100M', // Increase analysis duration
          '-probesize 100M' // Increase probe size
        ])
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
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          console.log(`Processing: ${progress.timemark}`);
        })
        .on('end', () => {
          console.log('Conversion completed successfully');
          resolve();
        })
        .on('error', (err) => {
          console.error('Conversion error:', err);
          reject(new Error(`FFmpeg error: ${err.message}`));
        });

      command.run();
    });

    // Upload to GCS
    const gcsFolder = `hls/${hlsId}/`;
    await uploadHLSFolderToGCS(hlsDir, gcsFolder);

    // Clean up
    await fs.rm(hlsDir, { recursive: true, force: true });

    // Generate signed URL for the playlist
    const signedUrl = await storage
      .bucket(bucketName)
      .file(`${gcsFolder}index.m3u8`)
      .getSignedUrl({
        action: 'read',
        expires: Date.now() + 1000 * 60 * 60 // 1 hour
      });

    res.json({
      success: true,
      hlsPath: `${gcsFolder}index.m3u8`,
      signedUrl: signedUrl[0],
      bucket: bucketName
    });

  } catch (error) {
    console.error('Endpoint error:', error);
    res.status(500).json({ 
      error: 'Video processing failed',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

export default router;