import express from 'express';
import models from '../models/index.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { getSignedUrl, getFileContents, downloadFromGCS, uploadTextToGCS } from '../services/gcsStorage.js';
import cdnAuthService from '../services/cdnAuthService.js';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import crypto from 'crypto';




const { Series, Episode, Category,EpisodeBundlePrice } = models;
const router = express.Router();








// Config: tune these per your infra
const PLAYLIST_EXPIRY_SECONDS = parseInt(process.env.PLAYLIST_EXPIRY_SECONDS || '600'); // 10 minutes
const SEGMENT_EXPIRY_SECONDS = parseInt(process.env.SEGMENT_EXPIRY_SECONDS || '6' * 3600); // 6 hours

router.get('/episodes/:id/hls-cdn', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang } = req.query;
    if (!lang) return res.status(400).json({ error: 'Language code (lang) is required' });

    const episode = await models.Episode.findByPk(id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    const subtitle = episode.subtitles?.find(s => s.language === lang);
    if (!subtitle?.gcsPath) return res.status(404).json({ error: 'Playlist not found' });

         const bucketName = process.env.GCS_BUCKET_NAME;
     const storage = new Storage();
     const bucket = storage.bucket(bucketName);

    // 1. Read master playlist
    const [masterData] = await bucket.file(subtitle.gcsPath).download();
    const masterLines = masterData.toString().split(/\r?\n/);

    // 2. Get folder path
    const folder = path.posix.dirname(subtitle.gcsPath);

    // 3. Process each variant
    for (let i = 0; i < masterLines.length; i++) {
      const line = masterLines[i].trim();
      if (line && !line.startsWith('#')) { // variant file
        const variantPath = `${folder}/${line}`;
        const [variantData] = await bucket.file(variantPath).download();
        const updatedVariant = variantData.toString().split(/\r?\n/).map(segLine => {
          if (segLine && !segLine.startsWith('#')) {
            const segPath = `/${folder}/${segLine}`;
            return cdnAuthService.generateCdnSignedUrl(segPath, 3600); // 1h
          }
          return segLine;
        }).join('\n');

        // Upload updated variant to GCS
        const newVariantName = `signed_${Date.now()}_${line}`;
        const newVariantPath = `${folder}/${newVariantName}`;
        await bucket.file(newVariantPath).save(updatedVariant, {
          contentType: 'application/vnd.apple.mpegurl',
          metadata: { cacheControl: 'public,max-age=300' }
        });

        // Replace master variant line with signed URL
        masterLines[i] = cdnAuthService.generateCdnSignedUrl(`/${newVariantPath}`, 3600);
      }
    }

    // 4. Save updated master playlist to GCS
    const newMasterName = `signed_${Date.now()}_playlist.m3u8`;
    const newMasterPath = `${folder}/${newMasterName}`;
    await bucket.file(newMasterPath).save(masterLines.join('\n'), {
      contentType: 'application/vnd.apple.mpegurl',
      metadata: { cacheControl: 'public,max-age=60' }
    });

    // 5. Generate signed URL for master
    const signedMasterUrl = cdnAuthService.generateCdnSignedUrl(`/${newMasterPath}`, 3600);

    res.json({ signedUrl: signedMasterUrl });

  } catch (err) {
    console.error(err);
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

// Cloud CDN signed URL and cookie generation route
router.get('/episodes/:id/stream', async (req, res) => {
  try {
    // Security: Ensure HTTPS in production
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
      return res.status(403).json({ 
        error: 'HTTPS required for secure video streaming',
        message: 'This endpoint requires HTTPS connection'
      });
    }

    const { id } = req.params;
    const { lang } = req.query;
    
    if (!lang) {
      return res.status(400).json({ error: 'Language code (lang) is required' });
    }

    // Get episode and subtitle info
    const episode = await models.Episode.findByPk(id);
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }

    if (!Array.isArray(episode.subtitles)) {
      return res.status(404).json({ error: 'No HLS info found for this episode' });
    }

    const subtitle = episode.subtitles.find(s => s.language === lang);
    if (!subtitle || !subtitle.gcsPath) {
      return res.status(404).json({ error: 'Playlist not found for this language' });
    }

    // Configuration from environment variables
    const CDN_DOMAIN = process.env.CDN_DOMAIN || 'https://cdn.tuktuki.com';
    const KEY_NAME = process.env.CDN_KEY_NAME || 'media-key-1';
    const SECRET_KEY = process.env.CDN_KEY_SECRET || 'YOUR_BASE64URL_ENCODED_SECRET_KEY';

    // Decode the key from base64
    const keyBytes = Buffer.from(SECRET_KEY.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    // Helper function to generate signed URL
    function generateSignedUrl(urlPath) {
      const expirationTimestamp = Math.floor(Date.now() / 1000) + 300; // 5 minutes validity
      const stringToSign = `${urlPath}?Expires=${expirationTimestamp}&KeyName=${KEY_NAME}`;
      const hmac = crypto.createHmac('sha1', keyBytes);
      hmac.update(stringToSign);
      const signature = hmac.digest('base64url');
      return `${CDN_DOMAIN}${stringToSign}&Signature=${signature}`;
    }

    // Helper function to generate signed cookie value
    function generateSignedCookieValue(urlPrefix) {
      const expirationTimestamp = Math.floor(Date.now() / 1000) + 10800; // 3 hours validity
      const encodedPrefix = Buffer.from(urlPrefix).toString('base64url');
      const policy = `URLPrefix=${encodedPrefix}:Expires=${expirationTimestamp}:KeyName=${KEY_NAME}`;
      const hmac = crypto.createHmac('sha1', keyBytes);
      hmac.update(policy);
      const signature = hmac.digest('base64url');
      return `${policy}:Signature=${signature}`;
    }

    // The path where your video files are stored in the GCS bucket
    const gcsVideoPath = `/${path.dirname(subtitle.gcsPath)}`;

    // 1. Generate the signed URL for the master playlist
    const manifestUrl = generateSignedUrl(`${gcsVideoPath}/playlist.m3u8`);
    
    // 2. Generate the signed cookie for the TS segments
    const cookieUrlPrefix = `${CDN_DOMAIN}${gcsVideoPath}/`;
    const cookieValue = generateSignedCookieValue(cookieUrlPrefix);
    
    // 3. Set the cookie in the HTTP response
    // The cookie name 'gcdn-auth' is required by Google Cloud CDN
    res.cookie('gcdn-auth', cookieValue, {
      httpOnly: true, // Prevents client-side script from accessing the cookie
      secure: true,   // Ensures the cookie is sent only over HTTPS
      sameSite: 'strict', // Provides protection against CSRF
      domain: '.tuktuki.com', // Allow subdomain access (cdn.tuktuki.com)
      path: '/', // Cookie available across the entire domain
      maxAge: 10800000 // 3 hours in milliseconds
    });

    // 4. Set security headers
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // 5. Send the signed manifest URL to the client
    res.status(200).json({ 
      manifestUrl,
      message: 'Streaming credentials generated successfully',
      episodeId: id,
      language: lang,
      security: {
        https: true,
        cookieSecure: true,
        cookieHttpOnly: true,
        cookieSameSite: 'strict'
      }
    });

  } catch (error) {
    console.error('Error generating streaming credentials:', error);
    res.status(500).json({ error: error.message || 'Failed to generate streaming credentials' });
  }
});

export default router;