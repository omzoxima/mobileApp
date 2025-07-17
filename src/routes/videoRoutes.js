import express from 'express';
import models from '../models/index.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import{getSignedUrl,listSegmentFiles,downloadFromGCS} from '../services/gcsStorage.js'



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
console.log('count',count);
    // Process all series in parallel for speed
    const seriesWithPoster = await Promise.all(rows.map(async series => {
      let thumbnail_url = series.thumbnail_url;
      let needsUpdate = false;

      // If already a public URL, use as is
      if (thumbnail_url && thumbnail_url.startsWith('http')) {
        // If it's a signed URL, check expiry
        if (thumbnail_url.includes('X-Goog-Expires') && isSignedUrlExpired(thumbnail_url)) {
          // Expired, generate new signed URL
          const gcsPath = thumbnail_url.split('storage.googleapis.com/')[1]?.split('?')[0];
          if (gcsPath) {
            thumbnail_url = await getSignedUrl(gcsPath, 60 * 24 * 7); // 7 days
            needsUpdate = true;
          }
        }
        // else: not expired, use as is
      } else if (thumbnail_url) {
        // Not a public URL, treat as GCS path
        thumbnail_url = await getSignedUrl(thumbnail_url, 60 * 24 * 7);
        needsUpdate = true;
      }

      // Update DB if needed
      if (needsUpdate) {
        await series.update({ thumbnail_url });
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