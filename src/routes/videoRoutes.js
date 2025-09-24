import express from 'express';
import models from '../models/index.js';
import crypto from 'crypto';
import { Storage } from '@google-cloud/storage';
import sharp from "sharp";
import { promisify } from 'util';
import stream from 'stream';
import { generateCdnSignedUrlForThumbnail,generateCdnSignedCookie } from '../services/cdnService.js';
import { apiCache } from '../config/redis.js';
// POST /api/video/process-hls-cdn - Process video and generate HLS with CDN URLs






const { Series, Episode, Category,EpisodeBundlePrice } = models;
const router = express.Router();




const storage = new Storage();
const bucketName = "run-sources-tuktuki-464514-asia-south1";
router.get("/convert-to-webp", async (req, res) => {
  try {
    const filePath = (req.query.file || "").toString().trim();
    if (!filePath) return res.status(400).send("File path required");

    // Safety validations
    if (filePath.includes("..") || filePath.startsWith("/")) {
      return res.status(400).send("Invalid file path");
    }
    if (!filePath.startsWith("thumbnails/")) {
      return res.status(400).send("Only thumbnails can be converted");
    }

    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePath);

    // 1) Metadata (before conversion)
    const [metadataBefore] = await file.getMetadata();
    const sizeBefore = Number(metadataBefore.size || 0);
    const originalContentType = metadataBefore.contentType || "application/octet-stream";

    if (
      !originalContentType.includes("jpeg") &&
      !originalContentType.includes("jpg") &&
      !(filePath.toLowerCase().endsWith(".jpg") || filePath.toLowerCase().endsWith(".jpeg"))
    ) {
      return res.status(400).send("Only JPG/JPEG files can be converted to WebP");
    }

    // 2) Download file
    const [data] = await file.download();

    // 3) Convert to WebP
    const webpBuffer = await sharp(data)
      .webp({ quality: 80 }) // adjust quality as needed
      .toBuffer();

    // 4) Save as new file (replace .jpg/.jpeg with .webp)
    const newFilePath = filePath.replace(/\.(jpg|jpeg)$/i, ".webp");
    const newFile = bucket.file(newFilePath);

    await newFile.save(webpBuffer, {
      metadata: { contentType: "image/webp" },
    });

    // 5) Metadata after conversion
    const [metadataAfter] = await newFile.getMetadata();
    const sizeAfter = Number(metadataAfter.size || 0);

    // Logs
    console.log(`✅ Converted to WebP: ${filePath} -> ${newFilePath}`);
    console.log(`   Size before : ${(sizeBefore / 1024).toFixed(2)} KB`);
    console.log(`   Size after  : ${(sizeAfter / 1024).toFixed(2)} KB`);

    res.json({
      success: true,
      original_file: filePath,
      converted_file: newFilePath,
      size_before_kb: (sizeBefore / 1024).toFixed(2),
      size_after_kb: (sizeAfter / 1024).toFixed(2),
    });
  } catch (err) {
    console.error("❌ WebP Conversion Error:", err);
    res.status(500).send("Error converting image to WebP");
  }
});

// API: /compress-image?file=thumbnails/path/to/file.jpg
router.get("/compress-image", async (req, res) => {
  try {
    const filePath = (req.query.file || "").toString().trim();
    if (!filePath) return res.status(400).send("File path required");

    // Basic safety validations: prevent path traversal and enforce thumbnails folder
    if (filePath.includes("..") || filePath.startsWith("/")) {
      return res.status(400).send("Invalid file path");
    }
    if (!filePath.startsWith("thumbnails/")) {
      return res.status(400).send("Only thumbnails can be compressed");
    }

    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePath);

    // 1) Read current metadata (size + contentType)
    const [metadataBefore] = await file.getMetadata();
    const sizeBefore = Number(metadataBefore.size || 0);
    const originalContentType = metadataBefore.contentType || "application/octet-stream";

    // 2) Download bytes (private bucket is fine via server credentials)
    const [data] = await file.download();

    // 3) Format-aware optimization without resizing
    const lowerPath = filePath.toLowerCase();
    let optimizedBuffer;
    let targetContentType = originalContentType;

    const image = sharp(data, { failOn: "none" }); // strip metadata for smaller size

    if (originalContentType.includes("jpeg") || originalContentType.includes("jpg") ||
        lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) {
      // Near-lossless JPEG optimization: keep chroma detail, no resize
      optimizedBuffer = await image
        .jpeg({
          quality: 85,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: "4:4:4",
          optimizeCoding: true
        })
        .toBuffer();
      targetContentType = "image/jpeg";
    } else if (originalContentType.includes("png") || lowerPath.endsWith(".png")) {
      // PNG lossless compression
      optimizedBuffer = await image
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      targetContentType = "image/png";
    } else if (originalContentType.includes("webp") || lowerPath.endsWith(".webp")) {
      // WebP lossless
      optimizedBuffer = await image
        .webp({ lossless: true })
        .toBuffer();
      targetContentType = "image/webp";
    } else {
      // Unknown type: pass-through (no change)
      optimizedBuffer = data;
    }

    // 4) Overwrite the same object
    await file.save(optimizedBuffer, { metadata: { contentType: targetContentType } });

    // 5) Read new size
    const [metadataAfter] = await file.getMetadata();
    const sizeAfter = Number(metadataAfter.size || 0);

    // Logs
    console.log(`✅ File optimized: ${filePath}`);
    console.log(`   Type        : ${originalContentType} -> ${targetContentType}`);
    console.log(`   Size before : ${(sizeBefore / 1024).toFixed(2)} KB`);
    console.log(`   Size after  : ${(sizeAfter / 1024).toFixed(2)} KB`);

    res.send({
      success: true,
      file: filePath,
      content_type_before: originalContentType,
      content_type_after: targetContentType,
      size_before_kb: (sizeBefore / 1024).toFixed(2),
      size_after_kb: (sizeAfter / 1024).toFixed(2)
    });
  } catch (err) {
    console.error("❌ Compression error:", err);
    res.status(500).send("Error compressing image");
  }
});


router.post("/signedcookie", async (req, res) => {
  try {
    let key_name = process.env.CDN_KEY_NAME;
    let signed_cookie_key = process.env.CDN_KEY_SECRET;
    console.log("req.body=", req.body.url_prefix);
    const urlPrefix = req.body.url_prefix.trim();
   
    
    console.log('CDN Key Name:', key_name);
    console.log('CDN Key Secret exists:', !!signed_cookie_key);
    console.log('URL Prefix:', urlPrefix);

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
    console.log("signed_policy=", signed_policy);
    res.status(200).send({ status: 1, url: signed_policy })
  } catch (error) {
    res.status(500).send({ status: 0, message: error })
  }
});


router.get('/series', async (req, res) => {
  try {
    const { page = 1, limit = 10, category } = req.query;
    
    // Fetch directly from database
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
    
    // Process all series in parallel for speed - generate signed URLs once
    const seriesWithPoster = await Promise.all(rows.map(async series => {
      let thumbnail_url = series.thumbnail_url;
      let carousel_image_url = series.carousel_image_url;
      
      // Generate signed URLs directly
      if (thumbnail_url) {
        thumbnail_url = generateCdnSignedUrlForThumbnail(thumbnail_url);
      }
      
      if (carousel_image_url) {
        carousel_image_url = generateCdnSignedUrlForThumbnail(carousel_image_url);
      }
      
      return { ...series.toJSON(), thumbnail_url, carousel_image_url };
    }));
    
    const responseData = { 
      total: count, 
      series: seriesWithPoster,
      signed_urls_generated: true,
      urls_expire_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours from now
    };
    
    res.json(responseData);
  } catch (error) {
    console.error('Series API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function removed - no longer needed without Redis caching

// GET /api/series/:seriesId/episodes
router.get('/series/:seriesId/episodes', async (req, res) => {
  try {
    const { seriesId } = req.params;
    const deviceId = req.headers['x-device-id'];
    
    const episodes = await Episode.findAll({
      where: { series_id: seriesId },
      order: [['episode_number', 'ASC']]
    });

    // Get user by x-device-id header
    let user = null;
    let likedEpisodeIds = [];
    let wishlisted = false;
    
    if (deviceId) {
      // Fetch user from database
      user = await models.User.findOne({ where: { device_id: deviceId } });
      
      if (user) {
        // Get all liked episode ids for this user
        const likes = await models.Like.findAll({
          where: { user_id: user.id, episode_id: episodes.map(e => e.id) }
        });
        likedEpisodeIds = likes.map(l => l.episode_id);
        
        // Check if this series is in the user's wishlist
        const wishlist = await models.Wishlist.findOne({
          where: { user_id: user.id, series_id: seriesId }
        });
        wishlisted = !!wishlist;
      }
    }

    // Add liked and wishlisted keys to each episode
    const episodesWithFlags = episodes.map(ep => ({
      ...ep.toJSON(),
      liked: likedEpisodeIds.includes(ep.id),
      wishlisted
    }));

    res.json(episodesWithFlags);
  } catch (error) {
    console.error('Episodes API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/episodes/:id
router.get('/episodes/:id', async (req, res) => {
  try {
    const episodeId = req.params.id;
    
    // Try to get from cache first
    const cachedEpisode = await apiCache.getEpisodeCache(episodeId);
    if (cachedEpisode) {
      console.log('📦 Episode data served from cache');
      return res.json(cachedEpisode);
    }
    
    const episode = await Episode.findByPk(episodeId, {
      include: [{ model: Series, include: [Category] }]
    });
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    
    // If episode includes Series, generate CDN signed URL for its thumbnail
    let episodeObj = episode.toJSON();
    if (episodeObj.Series && episodeObj.Series.thumbnail_url) {
      episodeObj.Series.thumbnail_url = generateCdnSignedUrlForThumbnail(episodeObj.Series.thumbnail_url);
    }
    
    // Cache the episode data for 2 hours
    await apiCache.setEpisodeCache(episodeId, episodeObj);
    console.log('💾 Episode data cached for 2 hours');
    
    res.json(episodeObj);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});




// GET /api/episode-bundles
router.get('/episode-bundles', async (req, res) => {
  try {
    const { platform } = req.query; // Get platform from query params
    
    // Try to get from cache first
    const cachedData = await apiCache.getBundleCache(platform);
    
    if (cachedData) {
      console.log('📦 Bundle data served from cache');
      const sortedCached = Array.isArray(cachedData)
        ? [...cachedData].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
        : cachedData;
      return res.json(sortedCached);
    }
    
    const bundles = await EpisodeBundlePrice.findAll({ order: [['updated_at', 'DESC']] });
    
    let responseData;
    
    // If iOS platform is requested, include Apple product details but exclude price_points and productId
    if (platform === 'ios') {
      responseData = bundles.map(bundle => {
        const bundleData = bundle.toJSON();
        // Remove price_points and productId for iOS
        delete bundleData.price_points;
        delete bundleData.productId;
        return bundleData;
      });
    } else {
      // For Android or any other platform, return existing response
      responseData = bundles;
    }
    
    // Cache the response for 2 hours
    await apiCache.setBundleCache(platform, responseData);
    console.log('💾 Bundle data cached for 2 hours');
    
    res.json(responseData);
  } catch (error) {
    console.error('Bundle API error:', error);
    res.status(500).json({ error: error.message });
  }
});
router.get("/signedcookie/:episodeId/:language", async (req, res, next) => {
  try {
    const { episodeId, language } = req.params;
    const deviceId = req.headers['x-device-id'];
    
    // Check for mandatory x-device-id header
    if (!deviceId) {
      return res.status(401).json({ 
        status: 0, 
        message: 'x-device-id header is required' 
      });
    }
    
    // Check if user exists against device ID
    const user = await models.User.findOne({ where: { device_id: deviceId } });
    if (!user) {
      console.log('No user found for device ID:', deviceId);
      return res.status(401).json({ 
        status: 0, 
        message: 'Device ID has no use - user not found' 
      });
    }
    
    console.log('=== SIGNED COOKIE ROUTE DEBUG ===');
    console.log('Episode ID received:', episodeId);
    console.log('Language received:', language);
    console.log('Device ID received:', deviceId);
    console.log('User found:', { id: user.id, device_id: user.device_id });
    
    // Get episode by ID
    const episode = await models.Episode.findByPk(episodeId);
    if (!episode) {
      console.log('Episode not found for ID:', episodeId);
      return res.status(404).json({ status: 0, message: 'Episode not found' });
    }
    
    console.log('Episode found:', {
      id: episode.id,
      title: episode.title,
      language: episode.language,
      subtitles: episode.subtitles
    });
    
    // Get subtitle information
    const subtitles = episode.subtitles;
    if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) {
      console.log('No subtitles array found in episode');
      return res.status(404).json({ status: 0, message: 'No subtitles found for this episode' });
    }
    
    console.log('Subtitles array:', subtitles);
    
    // Find subtitle matching the requested language
    const subtitle = subtitles.find(sub => sub.language === language);
    if (!subtitle || !subtitle.hdTsPath) {
      console.log('No subtitle found for language:', language);
      console.log('Available languages:', subtitles.map(sub => sub.language));
      return res.status(404).json({ 
        status: 0, 
        message: `No subtitle found for language: ${language}`,
        availableLanguages: subtitles.map(sub => sub.language)
      });
    }
    
    console.log('Found subtitle for language:', language);
    console.log('Subtitle data:', subtitle);
    console.log('hdTsPath extracted:', subtitle.hdTsPath);
    
    let key_name = process.env.CDN_KEY_NAME;
    let signed_cookie_key = process.env.CDN_KEY_SECRET;
    const urlPrefix = subtitle.hdTsPath.trim();
    
    console.log('CDN Key Name:', key_name);
    console.log('CDN Key Secret exists:', !!signed_cookie_key);
    console.log('URL Prefix:', urlPrefix);

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
    res.status(200).send({ status: 1, url: signed_policy, playlistUrl: subtitle.gcsPath })
  } catch (error) {
    res.status(500).send({ status: 0, message: error })
  }

})

router.get('/episodes/:Id/hls-url1', async (req, res) => {
  try {
    const { Id } = req.params;
    const { lang } = req.query;

    if (!lang) {
      return res.status(400).json({ error: 'Language code  is required as a query parameter.' });
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



// Cache management routes (for admin use)
router.post('/cache/invalidate', async (req, res) => {
  try {
    const { type, userId, seriesId, deviceId, episodeId } = req.body;
    
    switch (type) {
      case 'series':
        if (seriesId) {
          await apiCache.invalidateAllSeriesCaches(seriesId);
          console.log(`🗑️ All series-related caches invalidated for series: ${seriesId}`);
        } else {
          await apiCache.invalidateSeriesCache();
          console.log('🗑️ Series cache invalidated');
        }
        break;
      case 'wishlist':
        if (userId) {
          await apiCache.invalidateUserWishlistCache(userId);
          await apiCache.invalidateWishlistSeriesCache(userId);
          console.log(`🗑️ Wishlist caches invalidated for user: ${userId}`);
        } else {
          // Invalidate all wishlist caches
          const wishlistKeys = await apiCache.keys('wishlist:*');
          const wishlistSeriesKeys = await apiCache.keys('wishlist_series:*');
          for (const key of [...wishlistKeys, ...wishlistSeriesKeys]) {
            await apiCache.del(key);
          }
          console.log('🗑️ All wishlist caches invalidated');
        }
        break;
      case 'bundles':
        await apiCache.invalidateBundleCache();
        console.log('🗑️ Bundle cache invalidated');
        break;
      case 'episodes':
        if (episodeId) {
          await apiCache.invalidateEpisodeCache(episodeId);
          console.log(`🗑️ Episode cache invalidated for episode: ${episodeId}`);
        } else {
          const episodeKeys = await apiCache.keys('episode:*');
          for (const key of episodeKeys) {
            await apiCache.del(key);
          }
          console.log('🗑️ All episode caches invalidated');
        }
        break;
      case 'user_session':
        if (deviceId) {
          await apiCache.invalidateUserSession(deviceId);
          console.log(`🗑️ User session cache invalidated for device: ${deviceId}`);
        } else {
          console.log('⚠️ Device ID required for user session invalidation');
        }
        break;
      case 'user_profile':
        if (deviceId) {
          await apiCache.invalidateUserProfileCache(deviceId);
          console.log(`🗑️ User profile cache invalidated for device: ${deviceId}`);
        } else {
          console.log('⚠️ Device ID required for user profile invalidation');
        }
        break;
      case 'user_transactions':
        if (deviceId) {
          await apiCache.invalidateUserTransactionsCache(deviceId);
          console.log(`🗑️ User transactions cache invalidated for device: ${deviceId}`);
        } else {
          console.log('⚠️ Device ID required for user transactions invalidation');
        }
        break;
      case 'episode_access':
        if (userId && seriesId) {
          await apiCache.invalidateEpisodeAccessCache(userId, seriesId);
          console.log(`🗑️ Episode access cache invalidated for user: ${userId}, series: ${seriesId}`);
        } else {
          console.log('⚠️ User ID and Series ID required for episode access invalidation');
        }
        break;
      case 'search':
        await apiCache.invalidateSearchCache();
        console.log('🗑️ Search cache invalidated');
        break;
      case 'static_content':
        const contentType = req.body.contentType || 'all';
        if (contentType === 'all') {
          const staticKeys = await apiCache.keys('static:*');
          for (const key of staticKeys) {
            await apiCache.del(key);
          }
          console.log('🗑️ All static content caches invalidated');
        } else {
          await apiCache.invalidateStaticContentCache(contentType);
          console.log(`🗑️ Static content cache invalidated for type: ${contentType}`);
        }
        break;
      case 'reward_tasks':
        await apiCache.invalidateRewardTasksCache();
        console.log('🗑️ Reward tasks cache invalidated');
        break;
      case 'user_all':
        if (userId && deviceId) {
          await apiCache.invalidateAllUserCaches(userId, deviceId);
          console.log(`🗑️ All user-related caches invalidated for user: ${userId}, device: ${deviceId}`);
        } else {
          console.log('⚠️ User ID and Device ID required for complete user cache invalidation');
        }
        break;
      case 'all':
        await apiCache.invalidateSeriesCache();
        await apiCache.invalidateBundleCache();
        await apiCache.invalidateSearchCache();
        await apiCache.invalidateRewardTasksCache();
        
        const allKeys = await apiCache.keys('*');
        for (const key of allKeys) {
          await apiCache.del(key);
        }
        console.log('🗑️ All caches invalidated');
        break;
      default:
        return res.status(400).json({ error: 'Invalid cache type' });
    }
    
    res.json({ success: true, message: `${type} cache invalidated` });
  } catch (error) {
    console.error('Cache invalidation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Redis health check route
router.get('/cache/health', async (req, res) => {
  try {
    // Test Redis connection
    const redis = await import('../config/redis.js');
    const redisClient = redis.default;
    
    // Ping Redis to check connection
    const pingResult = await redisClient.ping();
    
    if (pingResult === 'PONG') {
      // Test basic Redis operations
      const testKey = 'health_check_test';
      const testValue = { timestamp: new Date().toISOString(), status: 'healthy' };
      
      // Test write
      await redisClient.setex(testKey, 10, JSON.stringify(testValue));
      
      // Test read
      const readValue = await redisClient.get(testKey);
      
      // Test delete
      await redisClient.del(testKey);
      
      // Get Redis info
      const info = await redisClient.info();
      const memoryInfo = await redisClient.info('memory');
      
      res.json({
        status: 'healthy',
        redis: 'connected',
        ping: pingResult,
        operations: {
          write: 'success',
          read: 'success',
          delete: 'success'
        },
        info: {
          version: info.split('\r\n').find(line => line.startsWith('redis_version'))?.split(':')[1],
          memory_used: memoryInfo.split('\r\n').find(line => line.startsWith('used_memory_human'))?.split(':')[1],
          connected_clients: info.split('\r\n').find(line => line.startsWith('connected_clients'))?.split(':')[1]
        },
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        status: 'unhealthy',
        redis: 'disconnected',
        ping: pingResult,
        error: 'Redis ping failed'
      });
    }
  } catch (error) {
    console.error('Redis health check error:', error);
    res.status(500).json({
      status: 'unhealthy',
      redis: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Cache warming route (for admin use)
router.post('/cache/warm', async (req, res) => {
  try {
    const { type } = req.body;
    
    switch (type) {
      case 'series':
        await apiCache.warmSeriesCache();
        break;
      case 'bundles':
        await apiCache.warmBundleCache();
        break;
      case 'episodes':
        console.log('🔥 Warming episode caches...');
        // Episode caches are warmed when individual episodes are accessed
        break;
      case 'search':
        console.log('🔥 Warming search caches...');
        // Search caches are warmed when searches are performed
        break;
      case 'static':
        console.log('🔥 Warming static content caches...');
        // Static content caches are warmed when content is accessed
        break;
      case 'reward_tasks':
        console.log('🔥 Warming reward tasks caches...');
        // Reward tasks caches are warmed when tasks are accessed
        break;
      case 'all':
        await apiCache.warmSeriesCache();
        await apiCache.warmBundleCache();
        console.log('🔥 Warming all cache types...');
        break;
      default:
        return res.status(400).json({ error: 'Invalid cache type' });
    }
    
    res.json({ success: true, message: `${type} cache warming initiated` });
  } catch (error) {
    console.error('Cache warming error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/video/cache/refresh-urls - Refresh expired URLs in cache
router.post('/cache/refresh-urls', async (req, res) => {
  try {
    const { type, page, limit, category } = req.body;
    
    switch (type) {
      case 'series':
        if (page && limit) {
          await refreshSeriesUrlsInCache(page, limit, category);
          console.log('🔄 Series URLs refreshed for page:', page, 'limit:', limit);
        } else {
          // Refresh all series caches
          const seriesKeys = await apiCache.keys('series:*');
          for (const key of seriesKeys) {
            // Extract page, limit, category from key
            const keyParts = key.split(':');
            if (keyParts.length >= 3) {
              const pageNum = parseInt(keyParts[1]) || 1;
              const limitNum = parseInt(keyParts[2]) || 10;
              const cat = keyParts[3] || null;
              await refreshSeriesUrlsInCache(pageNum, limitNum, cat);
            }
          }
          console.log('🔄 All series URLs refreshed');
        }
        break;
      case 'all':
        // Refresh all URL-based caches
        await refreshAllUrlCaches();
        break;
      default:
        return res.status(400).json({ error: 'Invalid refresh type. Use: series, all' });
    }
    
    res.json({ success: true, message: `${type} URLs refreshed successfully` });
  } catch (error) {
    console.error('URL refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to refresh all URL caches
async function refreshAllUrlCaches() {
  try {
    // Refresh series caches
    const seriesKeys = await apiCache.keys('series:*');
    for (const key of seriesKeys) {
      const keyParts = key.split(':');
      if (keyParts.length >= 3) {
        const pageNum = parseInt(keyParts[1]) || 1;
        const limitNum = parseInt(keyParts[2]) || 10;
        const cat = keyParts[3] || null;
        await refreshSeriesUrlsInCache(pageNum, limitNum, cat);
      }
    }
    
    // Refresh search caches
    const searchKeys = await apiCache.keys('search:*');
    for (const key of searchKeys) {
      await apiCache.invalidateSearchCache();
    }
    
    // Refresh wishlist caches
    const wishlistKeys = await apiCache.keys('wishlist_series:*');
    for (const key of wishlistKeys) {
      await apiCache.del(key);
    }
    
    console.log('🔄 All URL caches refreshed');
  } catch (error) {
    console.error('Error refreshing all URL caches:', error);
    throw error;
  }
}
router.get('/razorpay-episode-bundles', async (req, res) => {
  try {
    const bundles = await models.RazorpayEpisodeBundle.findAll({
      attributes: ['id', 'plan_id', 'price', 'name'],
      order: [['updated_at', 'DESC']]
    });
    res.json(bundles);
  } catch (error) {
    console.error('Bundle API error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;