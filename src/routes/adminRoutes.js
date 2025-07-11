import express from 'express';
import multer from 'multer';
import models from '../models/index.js';
import { uploadHLSFolderToGCS, getSignedUrl } from '../services/gcsStorage.js';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { uploadToGCS } from '../services/gcsStorage.js';

const { Series, Episode, Category } = models;
const router = express.Router();

// Configure FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Configure multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

// HLS Conversion Function
async function convertToHLS(videoBuffer, outputDir) {
  const tempInputPath = path.join(outputDir, 'input.mp4');
  await fs.writeFile(tempInputPath, videoBuffer);

  const hlsPlaylist = path.join(outputDir, 'playlist.m3u8');
  
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(tempInputPath)
      .inputOptions([
        '-re',
        '-analyzeduration 100M',
        '-probesize 100M'
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
        '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts'),
        '-f hls'
      ])
      .output(hlsPlaylist)
      .on('end', () => resolve(hlsPlaylist))
      .on('error', (err) => reject(err))
      .run();
  });
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

    const signedUrl = await getSignedUrl(subtitle.gcsPath, 3600); // 1 hour expiry
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
      attributes: ['role', 'phone_or_email', 'Name', 'created_at', 'updated_at']
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

router.post('/series', upload.single('thumbnail'), async (req, res) => {
  try {
    const { title, category_id } = req.body;
    if (!title || !category_id) {
      return res.status(400).json({ error: 'Title and category_id are required' });
    }

    let thumbnail_url = null;
    if (req.file) {
      // Check if it's an image file
      const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      
      if (imageTypes.includes(req.file.mimetype)) {
        // For images, use simple signed URL
        const gcsPath = await uploadToGCS(req.file, 'thumbnails');
        thumbnail_url = await getSignedUrl(gcsPath); // 10 years
      } else {
        // For video files, use HLS conversion
        const hlsId = uuidv4();
        const hlsDir = path.join('/tmp', hlsId);
        
        await fs.mkdir(hlsDir, { recursive: true });

        try {
          const playlistName = await convertToHLS(req.file.buffer, hlsDir);
          const gcsFolder = `thumbnails/${hlsId}/`;
          await uploadHLSFolderToGCS(hlsDir, gcsFolder);
          
          const playlistPath = `${gcsFolder}playlist.m3u8`;
          const signedUrl = await getSignedUrl(playlistPath); // 10 years

          thumbnail_url = signedUrl;
        } catch (error) {
          console.error('Error processing thumbnail:', error);
          throw error;
        } finally {
          // Cleanup
          await fs.rm(hlsDir, { recursive: true, force: true })
            .catch(e => console.error('Cleanup error:', e));
        }
      }
    }

    const newSeries = await models.Series.create({ title, category_id, thumbnail_url });
    res.status(201).json({ 
      uuid: newSeries.id, 
      title: newSeries.title, 
      thumbnail_url: thumbnail_url 
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create series' });
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
        
        await fs.mkdir(hlsDir, { recursive: true });
        tempDirs.push(hlsDir);

        try {
          const playlistName = await convertToHLS(file.buffer, hlsDir);
          const gcsFolder = `hls/${hlsId}/`;
          await uploadHLSFolderToGCS(hlsDir, gcsFolder);
          
          const playlistPath = `${gcsFolder}playlist.m3u8`;
          const signedUrl = await getSignedUrl(playlistPath);

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
        fs.rm(dir, { recursive: true, force: true })
          .catch(e => console.error('Cleanup error:', e))
    ));
  
  }
});

export default router;