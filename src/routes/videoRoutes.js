import express from 'express';
import multer from 'multer';
import models from '../models/index.js';
import { uploadToGCS, uploadHLSFolderToGCS, getSignedUrl } from '../services/gcsStorage.js';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

const { Series, Episode, Category } = models;
const router = express.Router();

// Configure FFmpeg path for both local and Cloud Run
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB limit
});

// Enhanced HLS conversion function
async function convertToHLS(videoBuffer, outputDir) {
  const tempInputPath = path.join(outputDir, 'input.mp4');
  await fs.writeFile(tempInputPath, videoBuffer);

  const hlsPlaylist = path.join(outputDir, 'playlist.m3u8');
  
  await new Promise((resolve, reject) => {
    ffmpeg(tempInputPath)
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
      .on('start', (command) => console.log('FFmpeg command:', command))
      .on('progress', (progress) => console.log(`Processing: ${progress.timemark}`))
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

  return path.basename(hlsPlaylist);
}

// POST /api/videos/upload-multilingual
router.post('/upload-multilingual', upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'videos', maxCount: 10 }
]), async (req, res) => {
  let tempDirs = [];
  
  try {
    // Validate required fields
    const { title, episode_number, series_id, series_title, category, video_languages } = req.body;
    if (!title || !episode_number) {
      return res.status(400).json({ error: 'Title and episode number are required' });
    }

    // Parse languages
    let languages;
    try {
      languages = JSON.parse(video_languages);
      if (!Array.isArray(languages)) throw new Error();
    } catch {
      return res.status(400).json({ error: 'video_languages must be a valid JSON array' });
    }

    // Validate files
    const thumbnailFile = req.files.thumbnail?.[0];
    const videoFiles = req.files.videos || [];
    
    if (videoFiles.length !== languages.length) {
      return res.status(400).json({ error: 'Number of videos must match number of languages' });
    }

    // Validate thumbnail
    if (thumbnailFile) {
      const ext = path.extname(thumbnailFile.originalname).toLowerCase();
      if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
        return res.status(400).json({ error: 'Thumbnail must be JPG or PNG' });
      }
    }

    // Validate videos
    for (const file of videoFiles) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext !== '.mp4') {
        return res.status(400).json({ error: 'Only MP4 videos are allowed' });
      }
    }

    // Process category
    let categoryRecord = await Category.findOne({ 
      where: { name: category } 
    });
    
    if (!categoryRecord && /^[0-9a-fA-F-]{36}$/.test(category)) {
      categoryRecord = await Category.findByPk(category);
    }
    
    if (!categoryRecord) {
      return res.status(400).json({ error: 'Category not found' });
    }

    // Process series
    let series;
    let thumbnailUrl = null;
    
    if (series_id) {
      series = await Series.findByPk(series_id);
      if (!series) return res.status(400).json({ error: 'Series not found' });
      thumbnailUrl = series.thumbnail_url;
    } else if (series_title) {
      series = await Series.findOne({ where: { title: series_title } });
      
      if (!series) {
        if (!thumbnailFile) {
          return res.status(400).json({ error: 'Thumbnail required for new series' });
        }
        
        thumbnailUrl = await uploadToGCS(thumbnailFile, 'thumbnails');
        series = await Series.create({
          title: series_title,
          thumbnail_url: thumbnailUrl,
          category_id: categoryRecord.id
        });
      } else {
        thumbnailUrl = series.thumbnail_url;
      }
    } else {
      return res.status(400).json({ error: 'Either series_id or series_title must be provided' });
    }

    // Upload thumbnail if provided (overrides series thumbnail)
    if (thumbnailFile && series_id) {
      thumbnailUrl = await uploadToGCS(thumbnailFile, 'thumbnails');
    }

    // Process videos
    const subtitles = [];
    
    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      const lang = languages[i];
      const hlsId = uuidv4();
      const hlsDir = path.join('/tmp', hlsId);
      
      await fs.mkdir(hlsDir, { recursive: true });
      tempDirs.push(hlsDir);

      // Convert to HLS
      await convertToHLS(file.buffer, hlsDir);
      
      // Upload to GCS
      const gcsFolder = `hls/${hlsId}/`;
      await uploadHLSFolderToGCS(hlsDir, gcsFolder);
      
      // Generate signed URL
      const playlistPath = `${gcsFolder}playlist.m3u8`;
      const signedUrl = await getSignedUrl(playlistPath, 3600);

      subtitles.push({
        language: lang,
        gcsPath: playlistPath,
        videoUrl: signedUrl
      });
    }

    // Create episode
    const episode = await Episode.create({
      title,
      episode_number,
      series_id: series.id,
      thumbnail_url: thumbnailUrl,
      description: req.body.episode_description || null,
      reward_cost_points: req.body.reward_cost_points || 0,
      subtitles: JSON.stringify(subtitles)
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
    // Cleanup temp directories
    await Promise.all(
      tempDirs.map(dir => 
        fs.rm(dir, { recursive: true, force: true })
          .catch(e => console.error('Cleanup error:', e))
      )
    );
  }
});

// GET /api/series (paginated, filter by category)
router.get('/series', async (req, res) => {
  try {
    const { page = 1, limit = 10, category } = req.query;
    const where = {};
    if (category) where.category_id = category;
    const { count, rows } = await Series.findAndCountAll({
      where,
      offset: (page - 1) * limit,
      limit: parseInt(limit),
      include: [{ model: Category }],
      order: [['created_at', 'DESC']]
    });
    // Map to include poster_url in the response
    const seriesWithPoster = rows.map(series => ({
      ...series.toJSON(),
      thumbnail_url: series.thumbnail_url
    }));
    res.json({ total: count, series: seriesWithPoster });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/series/:seriesId/episodes
router.get('/series/:seriesId/episodes', async (req, res) => {
  try {
    const episodes = await Episode.findAll({
      where: { series_id: req.params.seriesId },
      order: [['episode_number', 'ASC']]
    });
    res.json(episodes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/episodes/:id
router.get('/episodes/:id', async (req, res) => {
  try {
    const episode = await Episode.findByPk(req.params.id, {
      include: [{ model: Series, include: [Category] }]
    });
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    res.json(episode);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/episodes/:id/hls-url?lang=xx
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
    // Generate a fresh signed URL
    const signedUrl = await getSignedUrl(subtitle.gcsPath, 3600); // 1 hour expiry
    return res.json({ signedUrl });
  } catch (error) {
    console.error('Error generating HLS signed URL:', error);
    res.status(500).json({ error: error.message || 'Failed to generate signed URL' });
  }
});

// GET /api/categories
router.get('/categories', async (req, res) => {
  try {
    const categories = await Category.findAll();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/episode-bundles
router.get('/episode-bundles', async (req, res) => {
  try {
    const bundles = await EpisodeBundlePrice.findAll();
    res.json(bundles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Add this test endpoint
router.get('/test-ffmpeg', (req, res) => {
  ffmpeg().getAvailableFormats((err, formats) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      ffmpeg: ffmpegInstaller.path,
      version: ffmpegInstaller.version,
      h264: formats.h264 ? 'Available' : 'Missing',
      aac: formats.aac ? 'Available' : 'Missing'
    });
  });
});

export default router;