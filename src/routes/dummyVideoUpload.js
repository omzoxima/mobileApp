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
  uploadToGCS
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
const HLS_SEGMENT_DURATION = 10; // seconds

// Generate upload URL endpoint
router.post('/generate-upload-url', async (req, res) => {
  try {
    const { contentType, language } = req.body;
    
    if (!contentType || !language) {
      return res.status(400).json({
        error: 'Content type and language are required',
        example: { contentType: 'video/mp4', language: 'en' }
      });
    }

    const fileId = crypto.randomBytes(16).toString('hex');
    const extension = contentType.split('/')[1] || 'bin';
    const fileName = `uploads/${fileId}.${extension}`;
    
    const signedUrl = await generateSignedUrl(fileName, contentType, 15, 'write');

    res.json({
      success: true,
      signedUrl,
      gcsPath: fileName,
      fileId,
      language,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });
  } catch (error) {
    console.error('URL generation error:', error);
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
    const required = { gcsPath, fileId, language, seriesId, episodeData };
    const missing = Object.entries(required)
      .filter(([_, value]) => !value)
      .map(([key]) => key);

    if (missing.length) {
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(', ')}`,
        required: Object.keys(required)
      });
    }

    // Verify series exists
    const series = await Series.findByPk(seriesId);
    if (!series) {
      return res.status(404).json({
        error: 'Series not found',
        availableSeries: await Series.findAll({ attributes: ['id', 'title'] })
      });
    }

    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `video-${fileId}-`));
    const hlsDir = path.join(tempDir, 'hls');
    await fs.mkdir(hlsDir, { recursive: true });

    // Generate signed URL for processing
    const videoUrl = await getFileUrl(gcsPath, 30);

    // Process video to HLS format
    await new Promise((resolve, reject) => {
      ffmpeg(videoUrl)
        .inputOptions([
          '-re',
          '-threads 1' // Limit to single thread to reduce memory usage
        ])
        .outputOptions([
          '-max_muxing_queue_size 1024',
          '-c:v libx264',
          '-profile:v baseline',
          '-level 3.0',
          '-pix_fmt yuv420p',
          '-preset ultrafast', // Use ultrafast preset for faster encoding
          '-crf 28', // Higher CRF for smaller file size
          '-movflags +faststart',
          '-c:a aac',
          '-b:a 96k', // Lower audio bitrate
          `-hls_time ${HLS_SEGMENT_DURATION}`,
          '-hls_list_size 0',
          '-hls_segment_filename', path.join(hlsDir, 'segment_%03d.ts'),
          '-f hls'
        ])
        .output(path.join(hlsDir, 'playlist.m3u8'))
        .on('start', (cmd) => console.log('FFmpeg command:', cmd))
        .on('progress', (p) => console.log(`Processing: ${p.percent}%`))
        .on('end', resolve)
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg error:', err.message);
          console.error('FFmpeg stderr:', stderr);
          reject(new Error(`FFmpeg failed: ${err.message}`));
        })
        .run();
    });

    // Upload processed files
    const files = await fs.readdir(hlsDir);
    const gcsPrefix = `processed/${fileId}/hls/`;
    
    for (const file of files) {
      const localPath = path.join(hlsDir, file);
      const remotePath = `${gcsPrefix}${file}`;
      const contentType = file.endsWith('.m3u8')
        ? 'application/x-mpegURL'
        : 'video/MP2T';
      
      await uploadToGCS(remotePath, localPath, contentType);
    }

    // Get playlist URL
    const playlistPath = `${gcsPrefix}playlist.m3u8`;
    const playlistUrl = await getFileUrl(playlistPath, 60 * 24 * 7);

    // Create/update episode
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
      episode = await Episode.create({
        title: episodeData.title,
        episode_number: episodeNumber,
        series_id: seriesId,
        description: episodeData.description,
        reward_cost_points: episodeData.reward_cost_points || 0,
        subtitles: [subtitleData]
      });
    } else {
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

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });

    res.json({
      success: true,
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
      await fs.rm(tempDir, { recursive: true, force: true })
        .catch(e => console.error('Cleanup error:', e));
    }

    res.status(500).json({
      error: 'Video processing failed',
      details: process.env.NODE_ENV === 'development' ? error.message : 'FFmpeg processing error'
    });
  }
});

// JWT middleware
function adminAuth(req, res, next) {
  if (
    req.path === '/login' ||
    (req.method === 'GET' && /^\/episodes\/[^/]+\/hls-url$/.test(req.path))
  ) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// Apply adminAuth middleware
router.use(adminAuth);



export default router;