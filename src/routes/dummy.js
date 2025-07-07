import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import models from '../models/index.js';

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

// Multer for multiple videos and thumbnail
const multiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }
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

// POST /upload-multilingual
router.post('/upload-multilingual', multiUpload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'videos', maxCount: 10 }
]), async (req, res) => {
  try {
    const { title, episode_number, series_id, series_title, category, reward_cost_points, episode_description, video_languages } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Episode title is required.' });
    }
    // Validate thumbnail
    const thumbnailFile = req.files.thumbnail?.[0];
    if (thumbnailFile) {
      const ext = path.extname(thumbnailFile.originalname).toLowerCase();
      if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
        return res.status(400).json({ error: 'Thumbnail must be a JPG or PNG image.' });
      }
    }
    // Validate all videos
    for (const file of req.files.videos || []) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext !== '.mp4') {
        return res.status(400).json({ error: 'Only .mp4 video files are allowed.' });
      }
    }
    // Validate video languages
    let languages = [];
    try {
      languages = JSON.parse(video_languages);
    } catch (e) {
      return res.status(400).json({ error: 'video_languages must be a JSON array of language codes.' });
    }
    if (!Array.isArray(languages) || languages.length !== (req.files.videos || []).length) {
      return res.status(400).json({ error: 'video_languages array length must match number of video files.' });
    }
    // Upload thumbnail if present
    let thumbnailUrl = null;
    if (thumbnailFile) {
      const destination = `thumbnails/${Date.now()}_${thumbnailFile.originalname}`;
      await storage.bucket(bucketName).file(destination).save(thumbnailFile.buffer);
      thumbnailUrl = `gs://${bucketName}/${destination}`;
    }
    // HLS processing for each video
    const subtitlesArr = [];
    for (let i = 0; i < (req.files.videos || []).length; i++) {
      const file = req.files.videos[i];
      const lang = languages[i];
      const hlsId = uuidv4();
      const hlsDir = path.join('/tmp', hlsId);
      await fs.mkdir(hlsDir, { recursive: true });
      // Save uploaded file to disk
      const tempInputPath = path.join(hlsDir, 'input.mp4');
      await fs.writeFile(tempInputPath, file.buffer);
      // Transcode to HLS
      const hlsPlaylist = path.join(hlsDir, 'index.m3u8');
      await new Promise((resolve, reject) => {
        ffmpeg(tempInputPath)
          .outputOptions([
            '-profile:v baseline',
            '-level 3.0',
            '-start_number 0',
            '-hls_time 10',
            '-hls_list_size 0',
            '-f hls',
          ])
          .output(hlsPlaylist)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      // Upload HLS files to GCS
      const gcsFolder = `hls/${hlsId}/`;
      await uploadHLSFolderToGCS(hlsDir, gcsFolder);
      // Generate signed URL for .m3u8
      const [signedUrl] = await storage
        .bucket(bucketName)
        .file(`${gcsFolder}index.m3u8`)
        .getSignedUrl({ action: 'read', expires: Date.now() + 1000 * 60 * 60 });
      // Store info
      subtitlesArr.push({ language: lang, gcsPath: `${gcsFolder}index.m3u8`, videoUrl: signedUrl });
      // Clean up
      await fs.rm(hlsDir, { recursive: true, force: true });
    }

    // Save to DB
    const { Episode, Series, Category } = models;
    let series = null;
    if (series_id) {
      series = await Series.findByPk(series_id);
    } else if (series_title) {
      series = await Series.findOrCreate({ where: { title: series_title }, defaults: { category_id: null } });
      series = Array.isArray(series) ? series[0] : series;
    }
    let categoryObj = null;
    if (category) {
      categoryObj = await Category.findOne({ where: { name: category } });
    }
    const episode = await Episode.create({
      title,
      episode_number,
      series_id: series ? series.id : null,
      thumbnail_url: thumbnailUrl,
      reward_cost_points: reward_cost_points || 0,
      description: episode_description || null,
      category_id: categoryObj ? categoryObj.id : null,
      subtitles: subtitlesArr
    });

    res.status(201).json({
      message: 'Upload successful',
      title,
      episode_number,
      series_id,
      series_title,
      category,
      reward_cost_points,
      episode_description,
      thumbnailUrl,
      subtitles: subtitlesArr,
      episode
    });
  } catch (error) {
    console.error('Error uploading video:', error);
    res.status(500).json({ error: error.message || 'Failed to upload video' });
  }
});

// GET /get-hls-signed-url
router.get('/get-hls-signed-url', async (req, res) => {
  try {
    const { gcsPath } = req.query;
    if (!gcsPath) {
      return res.status(400).json({ error: 'gcsPath query parameter is required.' });
    }
    const [signedUrl] = await storage
      .bucket(bucketName)
      .file(gcsPath)
      .getSignedUrl({ action: 'read', expires: Date.now() + 1000 * 60 * 60 }); // 1 hour
    res.json({ signedUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;