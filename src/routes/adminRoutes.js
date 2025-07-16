import express from 'express';
import models from '../models/index.js';

import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import fsp from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { PassThrough } from 'stream';
import { Storage } from '@google-cloud/storage';

import os from 'os';
import multer from 'multer';

const { Series, Episode, Category } = models;
const router = express.Router();
// Configure multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB max per video
});
// Configure FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// JWT middleware (same as before)
const storage = new Storage();
const BUCKET_NAME = 'run-sources-tuktuki-464514-asia-south1';
const MAX_RETRIES = 3;
const SEGMENT_DURATION = 10; // seconds

// Helper function to generate signed URL
const generateSignedUrl = async (filePath, action = 'read', expiresMinutes = 30) => {
  const [url] = await storage.bucket(BUCKET_NAME)
    .file(filePath)
    .getSignedUrl({
      version: 'v4',
      action,
      expires: Date.now() + expiresMinutes * 60 * 1000,
    });
  return url;
};

// Process video with FFmpeg with memory limits
const processVideoToHLS = async ({ inputPath, outputDir }) => {
  return new Promise((resolve, reject) => {
    const playlistPath = path.join(outputDir, 'playlist.m3u8');
    const segmentPattern = path.join(outputDir, 'segment_%03d.ts');

    console.log(`Starting FFmpeg processing for ${inputPath}`);

    const command = ffmpeg()
      .input(inputPath)
      .inputOptions([
        '-re',
        '-threads 1', // Reduce threads to prevent memory issues
        '-max_muxing_queue_size 1024',
        '-max_alloc 5000000' // 5MB memory limit
      ])
      .outputOptions([
        '-c:v libx264',
        '-profile:v baseline',
        '-level 3.0',
        '-pix_fmt yuv420p',
        '-preset fast',
        '-crf 23',
        '-movflags +faststart',
        '-c:a aac',
        '-b:a 128k',
        `-hls_time ${SEGMENT_DURATION}`,
        '-hls_list_size 0',
        '-hls_segment_filename', segmentPattern,
        '-f hls'
      ])
      .output(playlistPath)
      .on('start', (commandLine) => {
        console.log('FFmpeg command:', commandLine);
      })
      .on('progress', (progress) => {
        console.log(`Processing: ${progress.timemark}`);
      })
      .on('end', () => {
        console.log('FFmpeg processing completed successfully');
        resolve({
          playlistPath,
          segmentPattern
        });
      })
      .on('error', (err, stdout, stderr) => {
        console.error('FFmpeg error:', err);
        console.error('FFmpeg stdout:', stdout);
        console.error('FFmpeg stderr:', stderr);
        reject(new Error(`Video processing failed: ${err.message}`));
      });

    command.run();
  });
};

// Upload file with retry logic
const uploadFileWithRetry = async (localPath, gcsPath, contentType) => {
  const bucket = storage.bucket(BUCKET_NAME);
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Upload attempt ${attempt} for ${gcsPath}`);
      await bucket.upload(localPath, {
        destination: gcsPath,
        metadata: { contentType },
        resumable: false
      });
      return gcsPath;
    } catch (err) {
      console.error(`Attempt ${attempt} failed:`, err.message);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
};

// Main processing endpoint
router.post('/process-video', async (req, res) => {
  let tempDir;
  try {
    const { gcsPath, fileId, language, seriesId, episodeData } = req.body;
    
    // Validation
    if (!gcsPath || !fileId || !language || !seriesId || !episodeData) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['gcsPath', 'fileId', 'language', 'seriesId', 'episodeData']
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

    // Generate signed URL for the source video
    const videoUrl = await generateSignedUrl(gcsPath, 'read', 30);

    // Process video to HLS format
    await processVideoToHLS({
      inputPath: videoUrl,
      outputDir: hlsDir
    });

    // Upload processed files
    const files = await fs.readdir(hlsDir);
    const gcsPrefix = `processed/${fileId}/hls/`;
    const uploadResults = [];

    // Upload files sequentially to avoid memory issues
    for (const file of files) {
      try {
        const localPath = path.join(hlsDir, file);
        const remotePath = `${gcsPrefix}${file}`;
        const contentType = file.endsWith('.m3u8') 
          ? 'application/x-mpegURL' 
          : 'video/MP2T';

        const uploadedPath = await uploadFileWithRetry(localPath, remotePath, contentType);
        uploadResults.push(uploadedPath);
        console.log(`Uploaded ${file} to ${uploadedPath}`);
      } catch (err) {
        console.error(`Failed to upload ${file}:`, err);
        throw new Error(`Failed to upload ${file}: ${err.message}`);
      }
    }

    // Get the playlist URL
    const playlistPath = `${gcsPrefix}playlist.m3u8`;
    const playlistUrl = await generateSignedUrl(playlistPath, 'read', 60 * 24 * 7); // 1 week expiry

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
        title: episodeData.title || episode.title,
        description: episodeData.description || episode.description,
        reward_cost_points: episodeData.reward_cost_points || episode.reward_cost_points
      });
    }

    // Cleanup temp files
    await fs.rm(tempDir, { recursive: true, force: true });

    return res.json({
      success: true,
      episode: {
        id: episode.id,
        title: episode.title,
        episode_number: episode.episode_number,
        video_url: playlistUrl
      }
    });

  } catch (error) {
    console.error('Video processing error:', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    // Cleanup temp directory if it exists
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(console.error);
    }

    return res.status(500).json({
      error: 'Video processing failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Generate signed URL for direct upload (same as before)
// Add this route before your process-video endpoint
router.post('/generate-upload-url', async (req, res) => {
  try {
    const { contentType, language } = req.body;
    
    // Validate input
    if (!contentType || !language) {
      return res.status(400).json({ 
        error: 'Both contentType and language are required',
        exampleRequest: {
          contentType: 'video/mp4',
          language: 'en'
        }
      });
    }

    // Generate unique file ID and path
    const fileId = require('crypto').randomBytes(16).toString('hex');
    const fileExtension = contentType.split('/')[1] || 'bin';
    const gcsPath = `uploads/${fileId}.${fileExtension}`;

    // Generate signed URL with strict conditions
    const [signedUrl] = await storage
      .bucket(BUCKET_NAME)
      .file(gcsPath)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + 15 * 60 * 1000, // 15 minutes
        contentType: contentType,
        extensionHeaders: {
          'x-goog-content-length-range': '0,1073741824' // 0-1GB file size limit
        }
      });

    res.json({
      success: true,
      signedUrl,
      gcsPath,  // The permanent storage path
      fileId,
      language,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });

  } catch (error) {
    console.error('URL Generation Error:', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    res.status(500).json({
      error: 'Failed to generate upload URL',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
// Process uploaded video and create HLS (improved version)


// Helper Functions

async function processVideoWithFFmpeg({ inputUrl, outputDir, fileId }) {
  return new Promise((resolve, reject) => {
    const playlistPath = path.join(outputDir, 'master.m3u8');
    const segmentPattern = path.join(outputDir, 'segment_%03d.ts');

    const command = ffmpeg(inputUrl)
      .inputOptions([
        '-re',
        '-threads 2',
        '-max_alloc 50000000'
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
        '-hls_time 10',
        '-hls_list_size 0',
        '-hls_segment_filename', segmentPattern,
        '-f hls'
      ])
      .output(playlistPath)
      .on('start', (cmd) => console.log('FFmpeg command:', cmd))
      .on('progress', (progress) => console.log(`Processing: ${progress.timemark}`))
      .on('end', () => resolve({ duration: command._ffmpeg.stdin._duration }))
      .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)));

    command.run();
  });
}

async function uploadProcessedFiles({ localDir, gcsPrefix }) {
  const files = await fs.readdir(localDir);
  const bucket = storage.bucket(process.env.GCS_BUCKET);
  
  const uploads = files.map(async (file) => {
    const filePath = path.join(localDir, file);
    const gcsPath = `${gcsPrefix}${file}`;
    await bucket.upload(filePath, { destination: gcsPath });
    return gcsPath;
  });

  const uploadedPaths = await Promise.all(uploads);
  
  return {
    segments: uploadedPaths.filter(p => p.endsWith('.ts')),
    playlistUrl: uploadedPaths.find(p => p.endsWith('.m3u8'))
  };
}

async function handleEpisode({ seriesId, language, episodeData, hlsMasterUrl }) {
  const episodeNumber = parseInt(episodeData.episode_number);
  
  let episode = await Episode.findOne({
    where: { series_id: seriesId, episode_number: episodeNumber }
  });

  const subtitleData = {
    language,
    gcsPath: hlsMasterUrl,
    videoUrl: await generateSignedUrl(hlsMasterUrl, 'read')
  };

  if (!episode) {
    return await Episode.create({
      title: episodeData.title,
      episode_number: episodeNumber,
      series_id: seriesId,
      description: episodeData.description,
      reward_cost_points: episodeData.reward_cost_points || 0,
      subtitles: [subtitleData]
    });
  }

  const updatedSubtitles = [
    ...(episode.subtitles || []).filter(s => s.language !== language),
    subtitleData
  ];

  await episode.update({
    subtitles: updatedSubtitles,
    title: episodeData.title || episode.title,
    description: episodeData.description || episode.description,
    reward_cost_points: episodeData.reward_cost_points || episode.reward_cost_points
  });

  return episode;
}

 
// JWT middleware
function adminAuth(req, res, next) {
  // Skip auth for login and HLS URL endpoints
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
 
// Apply adminAuth middleware to all routes except the excluded ones
router.use(adminAuth);
 
// POST /login
router.post('/login', async (req, res) => {
  const { phone_or_email, password } = req.body;
  if (!phone_or_email || !password) {
    return res.status(400).json({ error: 'phone_or_email and password are required' });
  }
 
  const user = await models.User.findOne({ where: { phone_or_email } });
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    console.log('check');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
 
  const match = await models.User.findOne({ where: { password }});
  if (!match) {
    console.log('check11')
    return res.status(401).json({ error: 'Invalid credentials' });
  }
 
  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
  res.json({
    token,
    user: {
      id: user.id,
      role: user.role,
      phone_or_email: user.phone_or_email,
      Name: user.Name
    }
  });
});
 
// GET /episodes/:id/hls-url
router.get('/episodes/:id/hls-url', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang } = req.query;
    
    if (!lang) {
      return res.status(400).json({ error: 'Language code (lang) is required as a query parameter.' });
    }
 
    const episode = await models.Episode.findByPk(id);
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found.' });
    }
 
    if (!Array.isArray(episode.subtitles)) {
      return res.status(404).json({ error: 'No subtitles/HLS info found for this episode.' });
    }
 
    const subtitle = episode.subtitles.find(s => s.language === lang);
    if (!subtitle || !subtitle.gcsPath) {
      return res.status(404).json({ error: 'No HLS video found for the requested language.' });
    }
 
    // --- Begin playlist rewrite logic ---
    const gcsFolder = subtitle.gcsPath.replace(/playlist\.m3u8$/, '');
    const segmentFiles = await listSegmentFiles(gcsFolder);
    const segmentSignedUrls = {};
    await Promise.all(segmentFiles.map(async (seg) => {
      segmentSignedUrls[seg] = await getSignedUrl(seg, 3600); // 1 hour expiry
    }));
    let playlistText = await downloadFromGCS(subtitle.gcsPath);
    playlistText = playlistText.replace(/^(segment_\d+\.ts)$/gm, (match) => segmentSignedUrls[`${gcsFolder}${match}`] || match);
    await uploadTextToGCS(subtitle.gcsPath, playlistText, 'application/x-mpegURL');
    const signedUrl = await getSignedUrl(subtitle.gcsPath, 3600);
    // --- End playlist rewrite logic ---
 
    return res.json({ signedUrl });
  } catch (error) {
    console.error('Error generating HLS signed URL:', error);
    res.status(500).json({ error: error.message || 'Failed to generate signed URL' });
  }
});
 
// Admin routes
router.get('/admins', async (req, res) => {
  try {
    const admins = await models.User.findAll({
      where: { role: 'admin' },
      attributes: ['id','role', 'phone_or_email', 'Name', 'created_at', 'updated_at']
    });
    res.json(admins);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch admin users' });
  }
});
 
router.get('/series', async (req, res) => {
  try {
    const series = await models.Series.findAll({
      include: [{ model: models.Category, attributes: ['name'] }],
      attributes: ['id', 'title', 'thumbnail_url', 'created_at', 'updated_at']
    });
    
    res.json(series.map(s => ({
      id: s.id,
      title: s.title,
      thumbnail_url: s.thumbnail_url,
      created_at: s.created_at,
      updated_at: s.updated_at,
      category_name: s.Category ? s.Category.name : null
    })));
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch series' });
  }
});
 
router.get('/series/:id', async (req, res) => {
  try {
    const series = await models.Series.findByPk(req.params.id, {
      include: [
        { model: models.Category, attributes: ['name'] },
        {
          model: models.Episode,
          attributes: ['title', 'episode_number', 'description'],
          order: [['episode_number', 'ASC']]
        }
      ],
      attributes: ['id', 'title', 'thumbnail_url', 'created_at', 'updated_at']
    });
 
    if (!series) return res.status(404).json({ error: 'Series not found' });
 
    res.json({
      id: series.id,
      title: series.title,
      thumbnail_url: series.thumbnail_url,
      created_at: series.created_at,
      updated_at: series.updated_at,
      category_name: series.Category ? series.Category.name : null,
      episodes: series.Episodes ? series.Episodes.map(e => ({
        title: e.title,
        episode_number: e.episode_number,
        description: e.description
      })) : []
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch series details' });
  }
});
 
router.post('/categories', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
 
    const newCategory = await models.Category.create({ name, description });
    res.status(201).json({ uuid: newCategory.id, name: newCategory.name });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create category' });
  }
});
 
router.post('/series', upload.single('media'), async (req, res) => {
  try {
    const { title, category_id } = req.body;
    if (!title || !category_id) {
      return res.status(400).json({ error: 'Title and category_id are required' });
    }

    let thumbnail_url = null;
    let hls_url = null;

    if (req.file) {
      const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (imageTypes.includes(req.file.mimetype)) {
        // Upload image as thumbnail
        const gcsPath = await uploadToGCS(req.file, 'thumbnails');
        thumbnail_url = await getSignedUrl(gcsPath); // 10 years
      } else if (req.file.mimetype.startsWith('video/')) {
        // Optionally upload original video
        // const videoGcsPath = await uploadToGCS(req.file, 'series-videos');
        // const video_url = await getSignedUrl(videoGcsPath);

        // Convert to HLS and upload
        const hlsId = uuidv4();
        const hlsDir = path.join('/tmp', hlsId);
        await fsp.mkdir(hlsDir, { recursive: true });

        try {
          const playlistName = await convertToHLS(req.file.buffer, hlsDir);
          const gcsFolder = `series-hls/${hlsId}/`;
          await uploadHLSFolderToGCS(hlsDir, gcsFolder);

          const playlistPath = `${gcsFolder}playlist.m3u8`;
          hls_url = await getSignedUrl(playlistPath); // 10 years
        } catch (error) {
          console.error('Error processing video:', error);
          throw error;
        } finally {
          await fsp.rm(hlsDir, { recursive: true, force: true })
            .catch(e => console.error('Cleanup error:', e));
        }
      } else {
        return res.status(400).json({ error: 'Unsupported file type' });
      }
    }

    const newSeries = await models.Series.create({
      title,
      category_id,
      thumbnail_url,
      hls_url // Save HLS URL if video was uploaded
    });

    res.status(201).json({
      uuid: newSeries.id,
      title: newSeries.title,
      thumbnail_url,
      hls_url
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create series' });
  }
});
 
// GET /categories (admin only)
router.get('/categories', async (req, res) => {
  try {
    const categories = await models.Category.findAll({
      attributes: ['id', 'name', 'description','created_at','updated_at']
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch categories' });
  }
});
 
// Upload Endpoint (unchanged from your original)
router.post('/upload-multilingual', upload.fields([{ name: 'videos', maxCount: 10 }]), async (req, res) => {
  let tempDirs = [];
  
  try {
    // Validate inputs
    const { title, episode_number, series_id, video_languages } = req.body;
    if (!episode_number || !series_id) {
      return res.status(400).json({ error: 'Title, episode number, and series ID are required' });
    }
 
    // Parse languages
    let languages;
    try {
      languages = JSON.parse(video_languages);
      if (!Array.isArray(languages)) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Invalid languages format' });
    }
 
    // Validate files
    const videoFiles = req.files.videos || [];
    
    if (videoFiles.length !== languages.length) {
      return res.status(400).json({ error: 'Video and language count mismatch' });
    }
 
    // Verify series exists
    const series = await Series.findByPk(series_id);
    if (!series) {
      return res.status(400).json({ error: 'Series not found' });
    }
 
    // Process videos
    const subtitles = await Promise.all(
      videoFiles.map(async (file, i) => {
        const lang = languages[i];
        const hlsId = uuidv4();
        const hlsDir = path.join('/tmp', hlsId);
        
        await fsp.mkdir(hlsDir, { recursive: true });
        tempDirs.push(hlsDir);
 
        try {
          const playlistName = await convertToHLS(file.buffer, hlsDir);
          const gcsFolder = `hls/${hlsId}/`;
          await uploadHLSFolderToGCS(hlsDir, gcsFolder);
          
          // --- Begin playlist rewrite logic ---
          // 1. List all .ts segment files in GCS
          const segmentFiles = await listSegmentFiles(gcsFolder);
          // 2. Generate signed URLs for each segment
          const segmentSignedUrls = {};
          await Promise.all(segmentFiles.map(async (seg) => {
            segmentSignedUrls[seg] = await getSignedUrl(seg, 60 * 24 * 7); // 7 days expiry
          }));
          // 3. Download the playlist
          const playlistPath = `${gcsFolder}playlist.m3u8`;
          let playlistText = await downloadFromGCS(playlistPath);
          // 4. Replace segment references with signed URLs
          playlistText = playlistText.replace(/^(segment_\d+\.ts)$/gm, (match) => segmentSignedUrls[`${gcsFolder}${match}`] || match);
          // 5. Upload the modified playlist back to GCS
          await uploadTextToGCS(playlistPath, playlistText, 'application/x-mpegURL');
          // 6. Generate signed URL for the playlist
          const signedUrl = await getSignedUrl(playlistPath);
          // --- End playlist rewrite logic ---
 
          return {
            language: lang,
            gcsPath: playlistPath,
            videoUrl: signedUrl
          };
        } catch (error) {
          console.error(`Error processing video for language ${lang}:`, error);
          throw error;
        }
      })
    );
 
    // Create episode
    const episode = await Episode.create({
      title,
      episode_number,
      series_id: series.id,
      description: req.body.episode_description || null,
      reward_cost_points: req.body.reward_cost_points || 0,
      subtitles: subtitles
    });
 
    res.status(201).json({
      success: true,
      episode,
      signedUrls: subtitles.map(s => ({ language: s.language, url: s.videoUrl }))
    });
 
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      error: 'Video upload failed',
      details: error.message
    });
  } finally {
    // Cleanup
    await Promise.all(
      tempDirs.map(dir =>
        fsp.rm(dir, { recursive: true, force: true })
          .catch(e => console.error('Cleanup error:', e))
    ));
  }
});
 
// DELETE /users/:id (admin only)
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await models.User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    await user.destroy();
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to delete user' });
  }
});
 
export default router;
 