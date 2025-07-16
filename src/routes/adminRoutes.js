import express from 'express';
import multer from 'multer';
import models from '../models/index.js';
import { uploadHLSFolderToGCS, getSignedUrl, listSegmentFiles, downloadFromGCS, uploadTextToGCS, initiateResumableUpload } from '../services/gcsStorage.js';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

const { Series, Episode, Category } = models;
const router = express.Router();

// Configure FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Configure multer (for thumbnail uploads only)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max for thumbnails
});

// HLS Conversion Function
async function convertToHLS(inputPath, outputDir) {
  const hlsPlaylist = path.join(outputDir, 'playlist.m3u8');
  
  return new Promise((resolve, reject) => {
    ffmpeg()
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

router.use(adminAuth);

// POST /upload-url (Updated for resumable uploads)
router.post('/upload-url', async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    const { url, destination } = await initiateResumableUpload(fileName);
    res.json({ url, destination });
  } catch (error) {
    console.error('Error initiating resumable upload:', error);
    res.status(500).json({ error: 'Failed to initiate resumable upload' });
  }
});

// POST /login
router.post('/login', async (req, res) => {
  const { phone_or_email, password } = req.body;
  if (!phone_or_email || !password) {
    return res.status(400).json({ error: 'phone_or_email and password are required' });
  }

  const user = await models.User.findOne({ where: { phone_or_email } });
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const match = await models.User.findOne({ where: { password } });
  if (!match) {
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
      return res.status(404).json({ error: 'No HLS video found for the requested language' });
    }

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

    return res.json({ signedUrl });
  } catch (error) {
    console.error('Error generating HLS signed URL:', error);
    res.status(500).json({ error: 'Failed to generate signed URL' });
  }
});

// GET /admins
router.get('/admins', async (req, res) => {
  try {
    const admins = await models.User.findAll({
      where: { role: 'admin' },
      attributes: ['id', 'role', 'phone_or_email', 'Name', 'created_at', 'updated_at']
    });
    res.json(admins);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch admin users' });
  }
});

// GET /series
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
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

// GET /series/:id
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
      category_name: series.Category ? s.Category.name : null,
      episodes: series.Episodes ? series.Episodes.map(e => ({
        title: e.title,
        episode_number: e.episode_number,
        description: e.description
      })) : []
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch series details' });
  }
});

// POST /categories
router.post('/categories', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const newCategory = await Category.create({ name, description });
    res.status(201).json({ uuid: newCategory.id, name: newCategory.name });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// POST /series
router.post('/series', upload.single('thumbnail'), async (req, res) => {
  try {
    const { title, category_id } = req.body;
    if (!title || !category_id) {
      return res.status(400).json({ error: 'Title and category_id are required' });
    }

    let thumbnail_url = null;
    if (req.file) {
      const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!imageTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: 'Thumbnail must be an image' });
      }
      const gcsPath = `thumbnails/${uuidv4()}/${req.file.originalname}`;
      await uploadTextToGCS(gcsPath, req.file.buffer, req.file.mimetype);
      thumbnail_url = await getSignedUrl(gcsPath, 315360000); // 10 years
    }

    const newSeries = await Series.create({ title, category_id, thumbnail_url });
    res.status(201).json({
      uuid: newSeries.id,
      title: newSeries.title,
      thumbnail_url: thumbnail_url
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create series' });
  }
});

// GET /categories
router.get('/categories', async (req, res) => {
  try {
    const categories = await Category.findAll({
      attributes: ['id', 'name', 'description', 'created_at', 'updated_at']
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// POST /upload-multilingual
router.post('/upload-multilingual', async (req, res) => {
  let tempDirs = [];
  
  try {
    const { title, episode_number, series_id, video_languages, videos, episode_description, reward_cost_points } = req.body;
    if (!title || !episode_number || !series_id || !video_languages || !videos) {
      return res.status(400).json({ error: 'Title, episode_number, series_id, video_languages, and videos are required' });
    }

    let languages, videoPaths;
    try {
      languages = JSON.parse(video_languages);
      videoPaths = JSON.parse(videos);
      if (!Array.isArray(languages) || !Array.isArray(videoPaths) || languages.length !== videoPaths.length) {
        throw new Error();
      }
    } catch {
      return res.status(400).json({ error: 'Invalid languages or videos format' });
    }

    const series = await Series.findByPk(series_id);
    if (!series) {
      return res.status(400).json({ error: 'Series not found' });
    }

    // Process videos
    const subtitles = await Promise.all(
      videoPaths.map(async (gcsPath, i) => {
        const lang = languages[i];
        const hlsId = uuidv4();
        const hlsDir = path.join('/tmp', hlsId);
        await fs.mkdir(hlsDir, { recursive: true });
        tempDirs.push(hlsDir);

        try {
          // Download video from GCS
          const videoBuffer = await downloadFromGCS(gcsPath);
          const tempInputPath = path.join(hlsDir, 'input.mp4');
          await fs.writeFile(tempInputPath, videoBuffer);

          // Convert to HLS
          const playlistName = await convertToHLS(tempInputPath, hlsDir);
          const gcsFolder = `hls/${hlsId}/`;
          await uploadHLSFolderToGCS(hlsDir, gcsFolder);

          const playlistPath = `${gcsFolder}playlist.m3u8`;
          const segmentFiles = await listSegmentFiles(gcsFolder);
          const segmentSignedUrls = {};
          await Promise.all(segmentFiles.map(async (seg) => {
            segmentSignedUrls[seg] = await getSignedUrl(seg, 60 * 24 * 7); // 7 days expiry
          }));
          let playlistText = await downloadFromGCS(playlistPath);
          playlistText = playlistText.replace(/^(segment_\d+\.ts)$/gm, (match) => segmentSignedUrls[`${gcsFolder}${match}`] || match);
          await uploadTextToGCS(playlistPath, playlistText, 'application/x-mpegURL');
          const signedUrl = await getSignedUrl(playlistPath, 3600);

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
      episode_number: parseInt(episode_number),
      series_id: series.id,
      description: episode_description || null,
      reward_cost_points: parseInt(reward_cost_points) || 0,
      subtitles
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
      )
    );
  }
});

// DELETE /users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await models.User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    await user.destroy();
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

export default router;