import express from 'express';
import models from '../models/index.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { generateSignedUrl } from '../services/gcsStorage.js';


const { Series, Episode, Category,EpisodeBundlePrice } = models;
const router = express.Router();




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

    // Process all series in parallel for speed
    const seriesWithPoster = await Promise.all(rows.map(async series => {
      let thumbnail_url = series.thumbnail_url;

      // If already a public URL, use as is
      if (thumbnail_url && thumbnail_url.startsWith('http')) {
        return { ...series.toJSON(), thumbnail_url };
      }

      // If missing or expired, generate a new signed URL
      if (thumbnail_url) {
        // Optionally: check if the URL is expired (if you store expiry info)
        // For simplicity, always generate a new signed URL here
        const newSignedUrl = await generateSignedUrl(thumbnail_url, 60 * 24 * 7); // 7 days expiry

        // Update DB if needed (optional, only if you want to store the new URL)
        // await series.update({ thumbnail_url: newSignedUrl });

        return { ...series.toJSON(), thumbnail_url: newSignedUrl };
      }

      // If no thumbnail, return as is
      return { ...series.toJSON(), thumbnail_url: null };
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