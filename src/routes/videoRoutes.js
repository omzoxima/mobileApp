import express from 'express';
import models from '../models/index.js';
import crypto from 'crypto';
import { Storage } from '@google-cloud/storage';
//import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import stream from 'stream';
import { generateCdnSignedUrlForThumbnail,generateCdnSignedCookie } from '../services/cdnService.js';
// POST /api/video/process-hls-cdn - Process video and generate HLS with CDN URLs
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);
const pipeline = promisify(stream.pipeline);




const { Series, Episode, Category,EpisodeBundlePrice } = models;
const router = express.Router();

// Common method to generate CDN signed URL for thumbnails



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
      let carousel_image_url = series.carousel_image_url;
      
      if (thumbnail_url) {
        // Generate CDN signed URL for thumbnail using common method
        thumbnail_url = generateCdnSignedUrlForThumbnail(thumbnail_url);
      }
      
      if (carousel_image_url) {
        // Generate CDN signed URL for carousel image if it exists
        carousel_image_url = generateCdnSignedUrlForThumbnail(carousel_image_url);
      }
      
      return { ...series.toJSON(), thumbnail_url, carousel_image_url };
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
    // If episode includes Series, generate CDN signed URL for its thumbnail
    let episodeObj = episode.toJSON();
    if (episodeObj.Series && episodeObj.Series.thumbnail_url) {
      episodeObj.Series.thumbnail_url = generateCdnSignedUrlForThumbnail(episodeObj.Series.thumbnail_url);
    }
    res.json(episodeObj);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});




// GET /api/episode-bundles
router.get('/episode-bundles', async (req, res) => {
  try {
    const { platform } = req.query; // Get platform from query params
    
    const bundles = await EpisodeBundlePrice.findAll();
    
    // If iOS platform is requested, include Apple product details but exclude price_points and productId
    if (platform === 'ios') {
      const iosBundles = bundles.map(bundle => {
        const bundleData = bundle.toJSON();
        // Remove price_points and productId for iOS
        delete bundleData.price_points;
        delete bundleData.productId;
        return bundleData;
      });
      return res.json(iosBundles);
    }
    
    // For Android or any other platform, return existing response
    res.json(bundles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
router.post("/signedcookie", async (req, res, next) => {
  try {
    let key_name = process.env.CDN_KEY_NAME;
    let signed_cookie_key = process.env.CDN_KEY_SECRET;
    const urlPrefix = req.body.url_prefix.trim();

    console.log("key_name=", key_name, "signed_cookie_key=", signed_cookie_key)
    
    const lastIndex = urlPrefix.lastIndexOf("/");
    let urlPrefixNew = urlPrefix.substring(0, lastIndex + 1)
    const encoded_url_prefix = Buffer.from(urlPrefixNew).toString('base64');
    let ms = new Date().getTime() + 86400000;
    let tomorrow = new Date(ms);
    let time = tomorrow.getTime();
    console.log(time, urlPrefixNew,key_name,signed_cookie_key);
    const keyBytes = Buffer.from(signed_cookie_key, 'base64');
    const policy_pattern = `URLPrefix=${encoded_url_prefix}:Expires=${time}:KeyName=${key_name}`;
    const signature = crypto.createHmac('sha1', keyBytes)
      .update(policy_pattern)
      .digest('base64').replace(/\+/g, '-')
      .replace(/\//g, '_');
    const signed_policy = `${policy_pattern}:Signature=${signature}`;
    res.status(200).send({ status: 1, url: signed_policy })
  } catch (error) {
    res.status(500).send({ status: 0, message: error })
  }

})

router.get('/episodes/:Id/hls-url1', async (req, res) => {
  try {
    const { Id } = req.params;
    const { lang } = req.query;

    if (!lang) {
      return res.status(400).json({ error: 'Language code (lang) is required as a query parameter.' });
    }

    // Fetch episode just for validation
    const episode = await models.Episode.findByPk(Id);
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found' });
    }

    // Hardcoded HLS folder
    const folderPrefix ='/hls_output/017b94ad-7468-40d0-a41b-ed7b40d21753/';

    // Environment vars
    const CDN_HOST = process.env.CDN_DOMAIN || 'cdn.tuktuki.com';
    const KEY_NAME = process.env.CDN_KEY_NAME || 'key1';
    const KEY_B64URL = process.env.CDN_KEY_SECRET;
    const TTL_SECS = parseInt(process.env.TTL_SECS || '54000', 10);

    if (!KEY_B64URL) {
      console.error('❌ ERROR: CDN_KEY_SECRET not set');
      return res.status(500).json({ error: 'CDN_KEY_SECRET not set' });
    }

    // Helpers
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

    // Generate signed cookie string
    function generateSignedCookie(urlPrefix, keyName, keyBytes, expiresEpoch) {
      const stringToSign = `${urlPrefix}?Expires=${expiresEpoch}&KeyName=${keyName}`;
      const sig = crypto.createHmac('sha1', keyBytes)
        .update(stringToSign, 'utf8')
        .digest();
      const encodedSig = b64urlEncode(sig);
      return `Expires=${expiresEpoch}&KeyName=${keyName}&Signature=${encodedSig}`;
    }

    const expires = Math.floor(Date.now() / 1000) + TTL_SECS;
    const urlPrefix = `https://${CDN_HOST}${folderPrefix}`;
    const cookieValue = generateSignedCookie(urlPrefix, KEY_NAME, KEY_BYTES, expires);

    // Example: first file you want to play
    const playlistUrl = `https://${CDN_HOST}${folderPrefix}playlist.m3u8`;

    // Set cookie header for the folder
    res.cookie('Cloud-CDN-Cookie', cookieValue, {
      domain: CDN_HOST,  // e.g., 'cdn.tuktuki.com'
      path: folderPrefix, // Must match the path of files
      httpOnly: false,
      secure: true,
      sameSite: 'None',
      expires: new Date(expires * 1000)
    });

    return res.json({
      playlistUrl,
      expiresAt: new Date(expires * 1000).toISOString(),
      ttl: TTL_SECS,
      cookieValue
    });

  } catch (e) {
    console.error('Signed cookie generation failure:', e);
    return res.status(500).json({ error: 'sign failure', details: e.message });
  }
});



// HLS Signer Route - Based on server.js functionality

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
   
    
    const signed = signFullUrl(upstream.toString(), KEY_NAME, KEY_BYTES, expires);
  
    
    // Parse the signed URL to show components
    try {
      const signedUrl = new URL(signed);
     
    } catch (parseError) {
      console.log('⚠️ Could not parse signed URL for component analysis');
    }

    return res.json({ 
      signedUrl: signed, 
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