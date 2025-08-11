import express from 'express';
import models from '../models/index.js';

import { getSignedUrl } from '../services/gcsStorage.js';

import crypto from 'crypto';




const { Series, Episode, Category,EpisodeBundlePrice } = models;
const router = express.Router();


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

// HLS Signer Route - Based on server.js functionality
router.get('/sign', (req, res) => {
  try {
    const p = req.query.path;
    if (!p || typeof p !== 'string' || !p.startsWith('/')) {
      return res.status(400).json({ error: 'missing or invalid ?path=...' });
    }

    // Configuration from environment variables
    const CDN_HOST = process.env.CDN_DOMAIN || 'cdn.tuktuki.com';
    const KEY_NAME = process.env.CDN_KEY_NAME || 'key1';
    const KEY_B64URL = process.env.CDN_KEY_SECRET;
    const TTL_SECS = parseInt(process.env.TTL_SECS || '1800', 10);

    // Console logging for debugging
    console.log('🔑 HLS Signer Route - Configuration:');
    console.log('   CDN_HOST:', CDN_HOST);
    console.log('   KEY_NAME:', KEY_NAME);
    console.log('   KEY_B64URL:', KEY_B64URL ? `${KEY_B64URL.substring(0, 10)}...` : 'NOT SET');
    console.log('   TTL_SECS:', TTL_SECS);
    console.log('   Requested Path:', p);
    console.log('   Environment:', process.env.NODE_ENV || 'development');

    if (!KEY_B64URL) {
      console.error('❌ ERROR: KEY_B64URL environment variable not set');
      return res.status(500).json({ error: 'KEY_B64URL environment variable not set' });
    }

    // Base64url helpers
    function b64urlDecode(b64url) {
      let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';
      return Buffer.from(b64, 'base64');
    }

    function b64urlEncode(buf) {
      return Buffer.from(buf)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    const KEY_BYTES = b64urlDecode(KEY_B64URL);

    // Sign a FULL URL
    function signFullUrl(fullUrl, keyName, keyBytes, expiresEpoch) {
      const sep = fullUrl.includes('?') ? '&' : '?';
      const urlToSign = `${fullUrl}${sep}Expires=${expiresEpoch}&KeyName=${encodeURIComponent(keyName)}`;

      const hmac = crypto.createHmac('sha1', keyBytes);
      hmac.update(urlToSign, 'utf8');
      const sig = b64urlEncode(hmac.digest());

      return `${urlToSign}&Signature=${sig}`;
    }

    // Build the upstream URL and sign it
    const upstream = new URL(`https://${CDN_HOST}${p}`);
    const expires = Math.floor(Date.now() / 1000) + TTL_SECS;
    
    console.log('🔐 Signing Process:');
    console.log('   Upstream URL:', upstream.toString());
    console.log('   Expires Timestamp:', expires);
    console.log('   Expires Date:', new Date(expires * 1000).toISOString());
    console.log('   Current Time:', new Date().toISOString());
    console.log('   Time Until Expiry:', TTL_SECS, 'seconds');
    
    const signed = signFullUrl(upstream.toString(), KEY_NAME, KEY_BYTES, expires);
    
    console.log('✅ Signed URL Generated:');
    console.log('   Original Path:', p);
    console.log('   CDN Host:', CDN_HOST);
    console.log('   Key Name:', KEY_NAME);
    console.log('   TTL Seconds:', TTL_SECS);
    console.log('   Full Signed URL:', signed);
    
    // Parse the signed URL to show components
    try {
      const signedUrl = new URL(signed);
      console.log('🔍 Signed URL Components:');
      console.log('   Protocol:', signedUrl.protocol);
      console.log('   Host:', signedUrl.host);
      console.log('   Pathname:', signedUrl.pathname);
      console.log('   Expires Param:', signedUrl.searchParams.get('Expires'));
      console.log('   KeyName Param:', signedUrl.searchParams.get('KeyName'));
      console.log('   Signature Param:', signedUrl.searchParams.get('Signature'));
      console.log('   Signature Length:', signedUrl.searchParams.get('Signature')?.length || 0);
    } catch (parseError) {
      console.log('⚠️ Could not parse signed URL for component analysis');
    }

    return res.json({ 
      url: signed, 
      ttl: TTL_SECS,
      originalPath: p,
      cdnHost: CDN_HOST,
      expiresAt: new Date(expires * 1000).toISOString()
    });

  } catch (e) {
    console.error('Sign failure:', e);
    return res.status(500).json({ error: 'sign failure', details: e.message });
  }
});
router.get('/episodes/:Id/hls-url', async (req, res) => {
  try {
    const { Id } = req.params;
    const { lang } = req.query;
    
    if (!lang) {
      return res.status(400).json({ error: 'Language code (lang) is required as a query parameter.' });
    }

    // Get episode and subtitle info
    const episode = await models.Episode.findByPk(Id);
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }

    if (!Array.isArray(episode.subtitles)) {
      return res.status(404).json({ error: 'No HLS info found for this episode' });
    }

    const subtitle = episode.subtitles.find(s => s.language === lang);
    if (!subtitle) {
      return res.status(404).json({ error: 'No subtitle found for the requested language' });
    }

    if (!subtitle.hdTsPath) {
      return res.status(404).json({ error: 'No hdTsPath found for this subtitle' });
    }

    // Use hdTsPath from subtitle
    const p = `/${subtitle.hdTsPath}`;

    // Configuration from environment variables
    const CDN_HOST = process.env.CDN_DOMAIN || 'cdn.tuktuki.com';
    const KEY_NAME = process.env.CDN_KEY_NAME || 'key1';
    const KEY_B64URL = process.env.CDN_KEY_SECRET;
    const TTL_SECS = parseInt(process.env.TTL_SECS || '1800', 10);

    // Console logging for debugging
    console.log('🔑 HLS Signer Route - Configuration:');
    console.log('   CDN_HOST:', CDN_HOST);
    console.log('   KEY_NAME:', KEY_NAME);
    console.log('   KEY_B64URL:', KEY_B64URL ? `${KEY_B64URL.substring(0, 10)}...` : 'NOT SET');
    console.log('   TTL_SECS:', TTL_SECS);
    console.log('   Requested Path:', p);
    console.log('   Environment:', process.env.NODE_ENV || 'development');

    if (!KEY_B64URL) {
      console.error('❌ ERROR: KEY_B64URL environment variable not set');
      return res.status(500).json({ error: 'KEY_B64URL environment variable not set' });
    }

    // Base64url helpers
    function b64urlDecode(b64url) {
      let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';
      return Buffer.from(b64, 'base64');
    }

    function b64urlEncode(buf) {
      return Buffer.from(buf)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    const KEY_BYTES = b64urlDecode(KEY_B64URL);

    // Sign a FULL URL
    function signFullUrl(fullUrl, keyName, keyBytes, expiresEpoch) {
      const sep = fullUrl.includes('?') ? '&' : '?';
      const urlToSign = `${fullUrl}${sep}Expires=${expiresEpoch}&KeyName=${encodeURIComponent(keyName)}`;

      const hmac = crypto.createHmac('sha1', keyBytes);
      hmac.update(urlToSign, 'utf8');
      const sig = b64urlEncode(hmac.digest());

      return `${urlToSign}&Signature=${sig}`;
    }

    // Build the upstream URL and sign it
    const upstream = new URL(`https://${CDN_HOST}${p}`);
    const expires = Math.floor(Date.now() / 1000) + TTL_SECS;
    
    console.log('🔐 Signing Process:');
    console.log('   Upstream URL:', upstream.toString());
    console.log('   Expires Timestamp:', expires);
    console.log('   Expires Date:', new Date(expires * 1000).toISOString());
    console.log('   Current Time:', new Date().toISOString());
    console.log('   Time Until Expiry:', TTL_SECS, 'seconds');
    
    const signed = signFullUrl(upstream.toString(), KEY_NAME, KEY_BYTES, expires);
    
    console.log('✅ Signed URL Generated:');
    console.log('   Original Path:', p);
    console.log('   CDN Host:', CDN_HOST);
    console.log('   Key Name:', KEY_NAME);
    console.log('   TTL Seconds:', TTL_SECS);
    console.log('   Full Signed URL:', signed);
    
    // Parse the signed URL to show components
    try {
      const signedUrl = new URL(signed);
      console.log('🔍 Signed URL Components:');
      console.log('   Protocol:', signedUrl.protocol);
      console.log('   Host:', signedUrl.host);
      console.log('   Pathname:', signedUrl.pathname);
      console.log('   Expires Param:', signedUrl.searchParams.get('Expires'));
      console.log('   KeyName Param:', signedUrl.searchParams.get('KeyName'));
      console.log('   Signature Param:', signedUrl.searchParams.get('Signature'));
      console.log('   Signature Length:', signedUrl.searchParams.get('Signature')?.length || 0);
    } catch (parseError) {
      console.log('⚠️ Could not parse signed URL for component analysis');
    }

    return res.json({ 
      url: signed, 
      ttl: TTL_SECS,
      originalPath: p,
      cdnHost: CDN_HOST,
      expiresAt: new Date(expires * 1000).toISOString()
    });

  } catch (e) {
    console.error('Sign failure:', e);
    return res.status(500).json({ error: 'sign failure', details: e.message });
  }
});


export default router;