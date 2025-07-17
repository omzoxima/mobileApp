import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import {
  generateSignedUrl,
  getFileUrl,
  uploadToGCS,
  downloadFromGCS
} from '../services/gcsStorage.js';
import models from '../models/index.js';
import multer from 'multer';

const { Series, Episode } = models;
const router = express.Router();

// Configure multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB max per video
});

// Configure FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// JWT middleware
function adminAuth(req, res, next) {
  if (
    req.path === '/login' ||
    req.path === '/generate-upload-url' || // Bypass auth for /generate-upload-url
    req.path === '/process-video' || // Bypass auth for /process-video
    (req.method === 'GET' && /^\/episodes\/[^/]+\/hls-url$/.test(req.path))
  ) {
    console.log(`Bypassing auth for path: ${req.path}`);
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error('Unauthorized: No token provided');
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = payload;
    console.log('Token verified, proceeding...');
    next();
  } catch (err) {
    console.error('Unauthorized: Invalid token', err.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// Apply adminAuth middleware
router.use(adminAuth);

const HLS_SEGMENT_DURATION = 10; // seconds

// Generate upload URL endpoint
router.post('/generate-upload-url', async (req, res) => {
  try {
    const { contentType, language } = req.body;
    
    console.log('Received /generate-upload-url request with body:', { contentType, language });
    if (!contentType || !language) {
      console.error('Validation failed: Missing contentType or language');
      return res.status(400).json({
        error: 'Content type and language are required',
        example: { contentType: 'video/mp4', language: 'en' }
      });
    }

    const fileId = crypto.randomBytes(16).toString('hex');
    const extension = contentType.split('/')[1] || 'bin';
    const fileName = `uploads/${fileId}.${extension}`;
    
    console.log(`Generating signed URL for file: ${fileName}, contentType: ${contentType}`);
    const signedUrl = await generateSignedUrl(fileName, contentType, 15, 'write');
    console.log(`Signed URL generated: ${signedUrl}`);

    res.json({
      signedUrl,
      gcsPath: fileName,
      fileId,
      language,
      expiresAt: new Date(Date.now() + 15 * 60 * 100).toISOString()
    });
  } catch (error) {
    console.error('URL generation error:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      error: 'Failed to generate upload URL',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Process video endpoint
router.post('/process-video', async (req, res) => {
  let tempDir;
  try {
    const { gcsPath, fileId, language, seriesId, episodeData } = req.body;

    // Validation
    console.log('Received /process-video request with body:', { gcsPath, fileId, language, seriesId, episodeData });
    const required = { gcsPath, fileId, language, seriesId, episodeData };
    const missing = Object.entries(required)
      .filter(([_, value]) => !value)
      .map(([key]) => key);

    if (missing.length) {
      console.error(`Validation failed: Missing required fields: ${missing.join(', ')}`);
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(', ')}`,
        required: Object.keys(required)
      });
    }

    // Verify series exists
    console.log(`Verifying series ID: ${seriesId}`);
    const series = await Series.findByPk(seriesId);
    if (!series) {
      console.error('Series not found');
      return res.status(404).json({
        error: 'Series not found',
        availableSeries: await Series.findAll({ attributes: ['id', 'title'] })
      });
    }

    // Create temp directory
    console.log(`Creating temporary directory for fileId: ${fileId}`);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `video-${fileId}-`));
    const hlsDir = path.join(tempDir, 'hls');
    await fs.mkdir(hlsDir, { recursive: true });
    console.log(`Temporary directory created: ${tempDir}`);

    // Download file locally to avoid signed URL issues
    console.log(`Downloading file from GCS: ${gcsPath}`);
    const tempFilePath = path.join(tempDir, 'input-video.mp4');
    const fileContents = await downloadFromGCS(gcsPath);
    await fs.writeFile(tempFilePath, fileContents);
    console.log(`File downloaded to: ${tempFilePath}`);

    // Probe file to validate
    console.log('Probing input file...');
    const probe = await new Promise((resolve, reject) => {
      ffmpeg(tempFilePath)
        .ffprobe((err, metadata) => {
          if (err) {
            console.error('FFprobe error:', err.message);
            reject(new Error(`FFprobe failed: ${err.message}`));
          } else {
            resolve(metadata);
          }
        });
    });
    console.log('File metadata:', JSON.stringify( probe, null, 2));

    // Process video to HLS format
    console.log('Starting FFmpeg processing...');
    await new Promise((resolve, reject) => {
      ffmpeg(tempFilePath)
        .inputOptions(['-re', '-threads 1'])
        .outputOptions([
          '-max_muxing_queue_size 1024',
          '-c:v libx264',
          '-profile:v baseline',
          '-level 3.0',
          '-pix_fmt yuv420p',
          '-preset ultrafast',
          '-crf 28',
          '-movflags +faststart',
          '-c:a aac',
          '-b:a 96k',
          `-hls_time ${HLS_SEGMENT_DURATION}`,
          '-hls_list_size 0',
          '-hls_segment_filename', path.join(hlsDir, 'segment_%03d.ts'),
          '-f hls'
        ])
        .output(path.join(hlsDir, 'playlist.m3u8'))
        .on('start', (cmd) => console.log('FFmpeg command:', cmd))
        .on('progress', (p) => console.log(`Processing: ${p.percent}%`))
        .on('end', () => {
          console.log('FFmpeg processing completed');
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg error:', err.message);
          console.error('FFmpeg stdout:', stdout);
          console.error('FFmpeg stderr:', stderr);
          reject(new Error(`FFmpeg failed: ${err.message}. Stderr: ${stderr}`));
        })
        .run();
    });

    // Upload processed files
    console.log('Reading HLS directory...');
    const files = await fs.readdir(hlsDir);
    const gcsPrefix = `processed/${fileId}/hls/`;
    console.log(`Uploading ${files.length} files to GCS with prefix: ${gcsPrefix}`);
    for (const file of files) {
      const localPath = path.join(hlsDir, file);
      const remotePath = `${gcsPrefix}${file}`;
      console.log(`Uploading: ${localPath} to ${remotePath}`);
      await uploadToGCS(remotePath, localPath);
      console.log(`Uploaded: ${remotePath}`);
    }

    // Get playlist URL
    const playlistPath = `${gcsPrefix}playlist.m3u8`;
    console.log(`Generating signed URL for playlist: ${playlistPath}`);
    const playlistUrl = await getFileUrl(playlistPath, 60 * 24 * 7);
    console.log(`Playlist URL: ${playlistUrl}`);

    // Create/update episode
    console.log(`Processing episode data for series: ${seriesId}, episode: ${episodeData.episode_number}`);
    const episodeNumber = parseInt(episodeData.episode_number);
    let episode = await Episode.findOne({
      where: { series_id: seriesId, episode_number: episodeNumber }
    });

    const subtitleData = {
      language,
      gcsPath: playlistPath,
      videoUrl: playlistUrl
    };

    if (!episode) {
      console.log('Creating new episode...');
      episode = await Episode.create({
        title: episodeData.title,
        episode_number: episodeNumber,
        series_id: seriesId,
        description: episodeData.description,
        reward_cost_points: episodeData.reward_cost_points || 0,
        subtitles: [subtitleData]
      });
    } else {
      console.log('Updating existing episode...');
      const updatedSubtitles = [
        ...(episode.subtitles || []).filter(s => s.language !== language),
        subtitleData
      ];
      await episode.update({
        subtitles: updatedSubtitles,
        ...(episodeData.title && { title: episodeData.title }),
        ...(episodeData.description && { description: episodeData.description }),
        ...(episodeData.reward_cost_points && {
          reward_cost_points: episodeData.reward_cost_points
        })
      });
    }
    console.log(`Episode processed: ${episode.id}`);

    // Cleanup
    console.log('Cleaning up temporary directory:', tempDir);
    await fs.rm(tempDir, { recursive: true, force: true });

    res.json({
      episode: {
        id: episode.id,
        title: episode.title,
        episode_number: episode.episode_number,
        video_url: playlistUrl
      }
    });
  } catch (error) {
    console.error('Video processing error:', error.message);
    console.error('Stack trace:', error.stack);

    if (tempDir) {
      console.log('Cleaning up temporary directory due to error:', tempDir);
      await fs.rm(tempDir, { recursive: true, force: true })
        .catch(e => console.error('Cleanup error:', e));
    }

    res.status(500).json({
      error: 'Video processing failed',
      details: process.env.NODE_ENV === 'development' ? error.message : 'FFmpeg processing error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

export default router;