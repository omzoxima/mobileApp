import express from 'express';
import models from '../models/index.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import{getSignedUrl,listSegmentFiles,downloadFromGCS,uploadTextToGCS} from '../services/gcsStorage.js'



const { Series, Episode, Category,EpisodeBundlePrice } = models;
const router = express.Router();




// Helper to check if a signed URL is expired (assumes X-Goog-Expires and X-Goog-Date in URL)
function isSignedUrlExpired(url) {
  try {
    const urlObj = new URL(url);
    const expires = urlObj.searchParams.get('X-Goog-Expires');
    const date = urlObj.searchParams.get('X-Goog-Date');
    if (!expires || !date) return true; // Not a signed URL or missing params
    // X-Goog-Date is in format YYYYMMDDTHHmmssZ
    const start = Date.parse(date.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
    const expiryMs = parseInt(expires, 10) * 1000;
    return (Date.now() > (start + expiryMs));
  } catch {
    return true;
  }
}
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
    if (!subtitle) {
      return res.status(404).json({ error: 'No subtitle found for the requested language.' });
    }

    // Only generate signed URL for hdTsPath if present
    let signedUrl = null;
    if (subtitle.hdTsPath) {
      signedUrl = await getSignedUrl(subtitle.hdTsPath, 3600);
    }

    return res.json({ signedUrl });
  } catch (error) {
    console.error('Error generating HD segment signed URL:', error);
    res.status(500).json({ error: error.message || 'Failed to generate signed URL' });
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
    // Process all series in parallel for speed
    const seriesWithPoster = await Promise.all(rows.map(async series => {
      let thumbnail_url = series.thumbnail_url;
      if (thumbnail_url) {
        // Always treat as GCS path and generate signed URL
        thumbnail_url = await getSignedUrl(thumbnail_url, 60 * 24 * 7); // 7 days
      }
      return { ...series.toJSON(), thumbnail_url };
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

    // Get user by x-device-id header
    const deviceId = req.headers['x-device-id'];
    let user = null;
    if (deviceId) {
      user = await models.User.findOne({ where: { device_id: deviceId } });
    }

    let likedEpisodeIds = [];
    let wishlisted = false;
    if (user) {
      // Get all liked episode ids for this user
      const likes = await models.Like.findAll({
        where: { user_id: user.id, episode_id: episodes.map(e => e.id) }
      });
      likedEpisodeIds = likes.map(l => l.episode_id);
      // Check if this series is in the user's wishlist
      const wishlist = await models.Wishlist.findOne({
        where: { user_id: user.id, series_id: req.params.seriesId }
      });
      wishlisted = !!wishlist;
    }

    // Add liked and wishlisted keys to each episode
    const episodesWithFlags = episodes.map(ep => ({
      ...ep.toJSON(),
      liked: likedEpisodeIds.includes(ep.id),
      wishlisted
    }));

    res.json(episodesWithFlags);
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
    // If episode includes Series, generate signed URL for its thumbnail
    let episodeObj = episode.toJSON();
    if (episodeObj.Series && episodeObj.Series.thumbnail_url) {
      episodeObj.Series.thumbnail_url = await getSignedUrl(episodeObj.Series.thumbnail_url, 60 * 24 * 7);
    }
    res.json(episodeObj);
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

// Endpoint to get signed URL for a segment (e.g., hdTsPath in subtitles)
router.get('/segment-signed-url', async (req, res) => {
  try {
    const { segmentPath } = req.query;
    if (!segmentPath) {
      return res.status(400).json({ error: 'segmentPath query parameter is required' });
    }
    const signedUrl = await getSignedUrl(segmentPath, 60); // 1 hour expiry
    res.json({ signedUrl });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to generate signed URL' });
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