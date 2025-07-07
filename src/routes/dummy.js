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

// Configure multer with file size limits
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

// Enhanced HLS upload function
async function uploadHLSFolderToGCS(localDir, gcsPath) {
  const files = await fs.readdir(localDir);
  
  await Promise.all(files.map(async (file) => {
    const filePath = path.join(localDir, file);
    const fileContent = await fs.readFile(filePath);
    const destination = `${gcsPath}${file}`;
    
    await storage.bucket(bucketName).file(destination).save(fileContent);
    console.log(`Uploaded ${file} to ${destination}`);
  }));
}

// Robust HLS conversion endpoint
router.post('/upload-hls', upload.single('video'), async (req, res) => {
  let hlsDir;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    // Create unique working directory
    const hlsId = uuidv4();
    hlsDir = path.join('/tmp', hlsId);
    await fs.mkdir(hlsDir, { recursive: true });

    // Save input to temporary file (more reliable than streams)
    const tempInputPath = path.join(hlsDir, 'input.mp4');
    await fs.writeFile(tempInputPath, req.file.buffer);

    // Verify file was written correctly
    const stats = await fs.stat(tempInputPath);
    if (stats.size === 0) {
      throw new Error('Empty input file after write');
    }

    // Set up HLS output
    const hlsPlaylist = path.join(hlsDir, 'playlist.m3u8');

    // Convert to HLS with better error handling
    await new Promise((resolve, reject) => {
      ffmpeg(tempInputPath)
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
          '-hls_segment_filename', path.join(hlsDir, 'segment_%03d.ts'),
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
          console.log('HLS conversion completed');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(new Error(`Video conversion failed: ${err.message}`));
        })
        .run();
    });

    // Upload to GCS
    const gcsFolder = `hls/${hlsId}/`;
    await uploadHLSFolderToGCS(hlsDir, gcsFolder);

    // Generate signed URL for the playlist
    const [signedUrl] = await storage
      .bucket(bucketName)
      .file(`${gcsFolder}playlist.m3u8`)
      .getSignedUrl({
        action: 'read',
        expires: Date.now() + 1000 * 60 * 60 // 1 hour
      });

    res.json({
      success: true,
      hlsPath: `${gcsFolder}playlist.m3u8`,
      signedUrl,
      bucket: bucketName
    });

  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ 
      error: 'Video processing failed',
      details: error.message
    });
  } finally {
    // Clean up temporary files
    if (hlsDir) {
      await fs.rm(hlsDir, { recursive: true, force: true })
        .catch(cleanupError => console.error('Cleanup error:', cleanupError));
    }
  }
});

export default router;