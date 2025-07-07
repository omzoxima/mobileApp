import express from 'express';
import multer from 'multer';
import models from '../models/index.js';
import userContext from '../middlewares/userContext.js';
import { uploadToGCS, uploadHLSFolderToGCS, getSignedUrl } from '../services/gcsStorage.js';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import ffmpegPath from 'ffmpeg-static';

ffmpeg.setFfmpegPath(ffmpegPath);

const { Series, Episode, Category, EpisodeBundlePrice } = models;

const router = express.Router();

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB limit
});

// POST /api/videos/upload-multilingual
router.post('/upload-multilingual', upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'videos', maxCount: 10 }
]), async (req, res) => {
  try {
    const { title, episode_number, series_id, series_title, category, reward_cost_points, episode_description, video_languages } = req.body;
    if (!title) {
      console.log('Episode title is required.');
      return res.status(400).json({ error: 'Episode title is required.' });
    }
    const thumbnailFile = req.files.thumbnail?.[0];
    // 1. Validate all files before any DB or storage operation
    // Validate thumbnail
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
    // 2. Proceed with DB and storage operations only if all validations pass
    // Resolve category
    let category_id = null;
    let categoryObj = await Category.findOne({ where: { name: category } });
    if (!categoryObj && /^[0-9a-fA-F-]{36}$/.test(category)) {
      categoryObj = await Category.findByPk(category);
    }
    if (!categoryObj) {
      return res.status(400).json({ error: 'Category not found' });
    }
    category_id = categoryObj.id;
    // Resolve or create series
    let resolvedSeriesId = series_id;
    let series;
    let seriesThumbnailUrl = null;
    if (!resolvedSeriesId && series_title) {
      series = await Series.findOne({ where: { title: series_title } });
      if (!series) {
        if (!thumbnailFile) return res.status(400).json({ error: 'Thumbnail image required for new series' });
        seriesThumbnailUrl = await uploadToGCS(thumbnailFile, 'thumbnails');
        series = await Series.create({
          title: series_title,
          thumbnail_url: seriesThumbnailUrl,
          category_id
        });
      } else if (category_id && series.category_id !== category_id) {
        await series.update({ category_id });
      }
      resolvedSeriesId = series.id;
      if (!seriesThumbnailUrl) seriesThumbnailUrl = series.thumbnail_url;
    } else if (resolvedSeriesId) {
      series = await Series.findByPk(resolvedSeriesId);
      if (!series) {
        return res.status(400).json({ error: 'Series not found for provided series_id' });
      }
      if (category_id && series.category_id !== category_id) {
        await series.update({ category_id });
      }
      seriesThumbnailUrl = series.thumbnail_url;
    } else {
      return res.status(400).json({ error: 'Either series_id or series_title must be provided' });
    }
    // Create episode
    const episode = await Episode.create({
      title,
      episode_number,
      series_id: resolvedSeriesId,
      thumbnail_url: seriesThumbnailUrl,
      reward_cost_points: reward_cost_points || 0,
      description: episode_description || null
    });
    // Validate video languages
    let languages = [];
    try {
      languages = JSON.parse(video_languages);
    } catch (e) {
      return res.status(400).json({ error: 'video_languages must be a JSON array of language codes.' });
    }
    console.log((req.files.videos || []).length);
    if (!Array.isArray(languages) || languages.length !== (req.files.videos || []).length) {
      return res.status(400).json({ error: 'video_languages array length must match number of video files.' });
    }
    // Upload videos per language as HLS
    const subtitlesArr = [];
    for (let i = 0; i < (req.files.videos || []).length; i++) {
      const file = req.files.videos[i];
      const lang = languages[i];
      const hlsId = uuidv4();
      const hlsDir = path.join('/tmp', hlsId);
      await fs.mkdir(hlsDir, { recursive: true });

      // 1. Transcode to HLS
      const hlsPlaylist = path.join(hlsDir, 'index.m3u8');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(file.buffer)
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

      // 2. Upload HLS files to GCS
      const gcsFolder = `hls/${hlsId}/`;
      await uploadHLSFolderToGCS(hlsDir, gcsFolder);

      // 3. Store the GCS path for the .m3u8
      const gcsPath = `${gcsFolder}index.m3u8`;

      // 4. Generate signed URL for .m3u8
      const signedUrl = await getSignedUrl(gcsPath, 3600);

      // 5. Store both the GCS path and signed URL for this language
      subtitlesArr.push({ language: lang, gcsPath, videoUrl: signedUrl });

      // 6. Clean up
      await fs.rm(hlsDir, { recursive: true, force: true });
    }

    episode.subtitles = subtitlesArr;
    await episode.save();
    res.status(201).json({ message: 'Upload successful', episode });
  } catch (error) {
    console.error('Error uploading video:', error);
    res.status(500).json({ error: error.message || 'Failed to upload video' });
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

export default router;