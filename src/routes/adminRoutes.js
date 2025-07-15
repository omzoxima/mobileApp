import express from 'express';
import multer from 'multer';
import models from '../models/index.js';
import { uploadHLSFolderToGCS, getSignedUrl, listSegmentFiles, downloadFromGCS, uploadTextToGCS } from '../services/gcsStorage.js';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import jwt from 'jsonwebtoken';

const { Series, Episode, Category, User } = models;
const router = express.Router();

// Configure Express for Cloud Run
router.use(express.json({ limit: '2gb' }));
router.use(express.urlencoded({ limit: '2gb', extended: true }));

// Configure FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Cloud Run-optimized Multer configuration
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      const tempDir = path.join(os.tmpdir(), 'uploads', uuidv4());
      try {
        await fs.mkdir(tempDir, { recursive: true });
        cb(null, tempDir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
    }
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB
    files: 10
  },
  fileFilter: (req, file, cb) => {
    const validMimes = [
      'video/mp4', 
      'video/quicktime', 
      'video/x-m4v', 
      'video/x-matroska',
      'application/octet-stream'
    ];
    cb(null, validMimes.includes(file.mimetype));
  }
});

/**
 * Convert video file to HLS format with relative paths
 */
async function convertToHLS(inputPath, outputDir) {
  const hlsPlaylist = path.join(outputDir, 'playlist.m3u8');
  
  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(inputPath)
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
        '-hls_segment_filename', 'segment_%03d.ts',
        '-f hls'
      ])
      .output(hlsPlaylist)
      .on('end', () => resolve(hlsPlaylist))
      .on('error', reject);
    
    const timeout = setTimeout(() => {
      command.kill('SIGTERM');
      reject(new Error('Conversion timed out after 10 minutes'));
    }, 600000);
    
    command.on('end', () => clearTimeout(timeout))
           .on('error', () => clearTimeout(timeout))
           .run();
  });
}

/**
 * Clean up temporary resources
 */
async function cleanupTempResources({ files = [], dirs = [] }) {
  const cleanupTasks = [
    ...files.map(file => 
      fs.unlink(file).catch(e => console.error('File cleanup error:', e))
    ),
    ...dirs.map(dir => 
      fs.rm(dir, { recursive: true, force: true })
        .catch(e => console.error('Directory cleanup error:', e))
    )
  ];
  
  await Promise.all(cleanupTasks);
}

/**
 * JWT Authentication Middleware
 */
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

/**
 * Login Endpoint
 */
router.post('/login', async (req, res) => {
  try {
    const { phone_or_email, password } = req.body;
    if (!phone_or_email || !password) {
      return res.status(400).json({ error: 'phone_or_email and password are required' });
    }

    const user = await User.findOne({ where: { phone_or_email } });
    if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await User.findOne({where: {password}});
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role }, 
      process.env.JWT_SECRET, 
      { expiresIn: '1d' }
    );

    res.json({ 
      token, 
      user: { 
        id: user.id, 
        role: user.role, 
        phone_or_email: user.phone_or_email, 
        Name: user.Name 
      } 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * HLS URL Generation Endpoint
 */
router.get('/episodes/:id/hls-url', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang } = req.query;
    
    if (!lang) {
      return res.status(400).json({ error: 'Language code (lang) is required' });
    }

    const episode = await Episode.findByPk(id);
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }

    if (!Array.isArray(episode.subtitles)) {
      return res.status(404).json({ error: 'No subtitles/HLS info found' });
    }

    const subtitle = episode.subtitles.find(s => s.language === lang);
    if (!subtitle || !subtitle.gcsPath) {
      return res.status(404).json({ error: 'No HLS video found for this language' });
    }

    // Generate signed URL for the playlist (segments will be accessed via relative paths)
    const signedUrl = await getSignedUrl(subtitle.gcsPath, 3600); // 1 hour expiry
    
    return res.json({ signedUrl });
  } catch (error) {
    console.error('Error generating HLS URL:', error);
    res.status(500).json({ error: error.message || 'Failed to generate URL' });
  }
});

/**
 * Video Upload Endpoint (Fixed version)
 */
router.post('/upload-multilingual', upload.fields([{ name: 'videos', maxCount: 10 }]), async (req, res) => {
  const tempResources = {
    files: req.files.videos?.map(f => f.path) || [],
    dirs: []
  };

  try {
    // Validate inputs
    const { title, episode_number, series_id, video_languages } = req.body;
    if (!episode_number || !series_id) {
      throw new Error('Episode number and series ID are required');
    }

    // Parse languages
    let languages;
    try {
      languages = JSON.parse(video_languages);
      if (!Array.isArray(languages)) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Invalid languages format' });
    }

    // Verify series exists
    const series = await Series.findByPk(series_id);
    if (!series) {
      return res.status(400).json({ error: 'Series not found' });
    }

    // Process each video file
    const subtitles = await Promise.all(
      req.files.videos.map(async (file, i) => {
        const lang = languages[i];
        const hlsDir = path.join(os.tmpdir(), 'hls', uuidv4());
        await fs.mkdir(hlsDir, { recursive: true });
        tempResources.dirs.push(hlsDir);

        try {
          // 1. Convert video to HLS format
          await convertToHLS(file.path, hlsDir);
          
          // 2. Prepare GCS paths
          const gcsFolder = `hls/${path.basename(hlsDir)}/`;
          
          // 3. Upload all files to GCS (segments + playlist)
          await uploadHLSFolderToGCS(hlsDir, gcsFolder);
          
          // 4. Generate signed URL for the playlist
          const playlistPath = `${gcsFolder}playlist.m3u8`;
          const signedUrl = await getSignedUrl(playlistPath);
          
          return {
            language: lang,
            gcsPath: playlistPath,
            videoUrl: signedUrl
          };
        } catch (error) {
          console.error(`Error processing ${lang} video:`, error);
          throw error;
        }
      })
    );

    // Create episode record
    const episode = await Episode.create({
      title,
      episode_number,
      series_id: series.id,
      description: req.body.episode_description || null,
      subtitles
    });

    res.status(201).json({
      success: true,
      episode,
      signedUrls: subtitles.map(s => s.videoUrl)
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      error: 'Video upload failed',
      details: error.message
    });
  } finally {
    await cleanupTempResources(tempResources);
  }
});

// Admin routes
router.get('/admins', async (req, res) => {
  try {
    const admins = await User.findAll({
      where: { role: 'admin' },
      attributes: ['role', 'phone_or_email', 'Name', 'created_at', 'updated_at']
    });
    res.json(admins);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch admins' });
  }
});

// Series routes
router.get('/series', async (req, res) => {
  try {
    const series = await Series.findAll({
      include: [{ model: Category, attributes: ['name'] }],
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
    const series = await Series.findByPk(req.params.id, {
      include: [
        { model: Category, attributes: ['name'] },
        { 
          model: Episode, 
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
    res.status(500).json({ error: error.message || 'Failed to fetch series' });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const newCategory = await Category.create({ name, description });
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
      const gcsPath = `thumbnails/${uuidv4()}${path.extname(req.file.originalname)}`;
      await uploadToGCS(req.file.path, gcsPath);
      thumbnail_url = await getSignedUrl(gcsPath);
    }

    const newSeries = await Series.create({ title, category_id, thumbnail_url });
    res.status(201).json({ 
      uuid: newSeries.id, 
      title: newSeries.title, 
      thumbnail_url: thumbnail_url 
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create series' });
  }
});

export default router;