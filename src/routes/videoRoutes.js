import express from 'express';
import models from '../models/index.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { getSignedUrl, getFileContents, downloadFromGCS, uploadTextToGCS } from '../services/gcsStorage.js';
import cdnAuthService from '../services/cdnAuthService.js';
import path from 'path';





const { Series, Episode, Category,EpisodeBundlePrice } = models;
const router = express.Router();




// Config: tune these per your infra
const PLAYLIST_EXPIRY_SECONDS = parseInt(process.env.PLAYLIST_EXPIRY_SECONDS || '600'); // 10 minutes
const SEGMENT_EXPIRY_SECONDS = parseInt(process.env.SEGMENT_EXPIRY_SECONDS || '6' * 3600); // 6 hours

// Helper: is this a variant (ends with .m3u8) or a media segment (.ts)
function isVariant(line) {
  return line.trim().toLowerCase().endsWith('.m3u8');
}
function isSegment(line) {
  return line.trim().toLowerCase().endsWith('.ts');
}

// Return signed playlist ready for mobile players
router.get('/episodes/:id/hls-cdn', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang } = req.query;

    if (!lang) return res.status(400).json({ error: 'Language code (lang) is required' });

    const episode = await models.Episode.findByPk(id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });

    if (!Array.isArray(episode.subtitles)) return res.status(404).json({ error: 'No HLS info for this episode' });

    const subtitle = episode.subtitles.find(s => s.language === lang);
    if (!subtitle || !subtitle.gcsPath) return res.status(404).json({ error: 'Playlist not found for this language' });

    // subtitle.gcsPath example: "hls_output/<uuid>/playlist.m3u8"
    const bucketPath = subtitle.gcsPath;

    // Step 1: fetch master playlist from private GCS
    const masterPlaylistText = await getFileContents(process.env.GCS_BUCKET_NAME, bucketPath);

    // We'll produce a modified master playlist:
    //  - For each variant line (e.g. hd.m3u8) produce a signed URL for that variant m3u8
    //  - For each variant m3u8, fetch it from GCS, replace all .ts lines with signed CDN URLs, and upload to memory
    //  - Replace the variant reference in master with the signed variant URL
    const masterLines = masterPlaylistText.split(/\r?\n/);

    // Detect the folder that contains the playlists and segments, e.g. "hls_output/<uuid>/"
    const folder = path.posix.dirname(bucketPath); // posix for / separators

    // We'll cache signedVariantText for each variant filename (e.g., hd.m3u8)
    const variantNameToSignedUrl = {};

    for (let i = 0; i < masterLines.length; i++) {
      const line = masterLines[i].trim();
      if (isVariant(line)) {
        const variantName = line; // e.g., "hd.m3u8" or "audio/eng.m3u8"
        const variantGcsPath = path.posix.join(folder, variantName);

        // fetch variant playlist from GCS
        const variantText = await getFileContents(process.env.GCS_BUCKET_NAME, variantGcsPath);

        // rewrite segment lines inside variant
        const updatedVariantText = variantText.split(/\r?\n/).map(vline => {
          if (isSegment(vline)) {
            const segName = vline.trim(); // e.g. hd0000000000.ts
            const segResourcePath = `/${path.posix.join(folder, segName)}`;
                         return cdnAuthService.generateCdnSignedUrl(segResourcePath, SEGMENT_EXPIRY_SECONDS);
          }
          return vline;
        }).join('\n');

        // generate signed URL for the variant playlist itself (so player can GET it)
        // we need to serve the updatedVariantText back to the player when they fetch the signed variant URL.
        // Since Cloud CDN expects to fetch content from your backend origin, simplest approach: return the updated master
        // with signed variant URL pointing to the CDN resource path that will be cached by CDN (the CDN will fetch origin on cache miss).
        // But because we replaced segments with signed CDN URLs, the variant content on origin doesn't need to be changed permanently.
        // We'll create a signed URL for the variant path (not the modified text), and the CDN will fetch the original variant from origin;
        // to ensure the player sees the updated segments (signed URLs), we will instead embed the signed variant URL but serve the updated variant text directly from our endpoint by using the signed variant URL path as a pointer.
        // Simpler and reliable approach (no extra upload): we will return a master playlist that points to *our server endpoint* that serves the modified variant.
        // But to keep this implementation minimal and fast, we will do the following:
        //  - Host the modified variant text **via a signed URL to the CDN domain** using the same path as variant and rely on the CDN to fetch from the origin (GCS).
        //  - The CDN cannot automatically know the modified text unless we upload it to GCS (not wanted).
        // So, to avoid extra writes, we'll instead **embed the full signed segment URLs directly in the master playlist** (i.e. inline the variant contents).
        // Practical: replace the variant filename in master with the signed CDN URL for the variant file path,
        // but the safe & guaranteed approach for mobile is to return the variant content (not just a URL) — however players expect the master to reference a playlist URL.
        // To remain compatible and avoid uploading: we will sign variant URL and ensure the variant retrieved by the player is the original one on GCS — but because that variant contains relative TS references (not signed), it would fail.
        // Therefore the correct production approach is to either:
        //   A) upload the modified variant back to GCS (recommended), or
        //   B) return the modified variant from your own backend endpoint (and sign that backend path), or
        //   C) inline segment signed URLs into the master by converting the master to a "flat" playlist (not standard).
        //
        // We'll implement option (A): upload the modified variant to GCS under the same folder with a generated filename (e.g. signed-<uuid>-hd.m3u8),
        // then return a signed CDN URL referencing that uploaded variant. This makes CDN + players happy.
        //
        // Upload step: write modifiedVariant to GCS under a temporary filename. (We need write access.)
        // For simplicity, we will rely on a helper that uploads; if you don't want uploads, we can implement option (B).
        //
        // BUT: to keep this answer concise and robust, we'll choose option (B): serve the modified variant from an authenticated backend endpoint and then sign that backend endpoint path.
        // That endpoint will return the variant contents (modified) and set caching headers. The signed CDN URL will point to the CDN domain mapped to your backend (load balancer).
        //
        // Implementation note: To use option B you need your load balancer frontend set to route /modified-hls/* to your backend service (this is normal).
        //
        // For this code, we will:
        //  - create an in-memory map variantName -> updatedVariantText
        //  - replace master variant reference with a URL that points to an internal backend route /internal/hls-variant/:token
        //  - generate a signed CDN URL that maps to /internal/hls-variant/:token (so CDN caches it)
        //
        // Generate a token (simple hash) and store updatedVariantText in memory map on server (for short TTL). For production, use Redis or write modified files to GCS.
        //
        // Simplify: we will write updated variant to GCS at path: `${folder}/_signed/${variantName}` and then sign that path.
        // (Uploading requires storage write permission; recommended in production with lifecycle rules for cleanup.)

        // For clarity in this PR I'll implement the upload-to-GCS approach.
        // Upload the updatedVariantText to GCS under _signed/<variantName>
        const signedVariantGcsPath = path.posix.join(folder, '_signed', `${Date.now()}-${variantName}`);
        // call a helper to upload (we'll require storage here)
        const { Storage } = require('@google-cloud/storage');
        const storage = new Storage();
        const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
        await bucket.file(signedVariantGcsPath).save(updatedVariantText, {
          contentType: 'application/vnd.apple.mpegurl',
          metadata: { cacheControl: 'public, max-age=300' }
        });

        // Now sign the variant path (the uploaded one)
                 const signedVariantUrl = cdnAuthService.generateCdnSignedUrl(`/${signedVariantGcsPath}`, PLAYLIST_EXPIRY_SECONDS);
        variantNameToSignedUrl[variantName] = signedVariantUrl;

        // replace the variant filename in masterLines with signedVariantUrl
        masterLines[i] = signedVariantUrl;
      }
    } // end for master lines

    // Return modified master playlist (with variant URLs pointing to signedVariantUrl)
    const modifiedMaster = masterLines.join('\n');

    // Response headers: short cache for playlists
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=60'); // 60s for master playlist
    res.send(modifiedMaster);

  } catch (err) {
    console.error('hls-cdn error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

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
    where.status = 'Active';
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