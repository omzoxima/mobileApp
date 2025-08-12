import express from 'express';
import models from '../models/index.js';
import crypto from 'crypto';
import { Storage } from '@google-cloud/storage';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import stream from 'stream';
import { generateCdnSignedUrlForThumbnail } from '../services/cdnService.js';

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
      if (thumbnail_url) {
        // Generate CDN signed URL for thumbnail using common method
        thumbnail_url = generateCdnSignedUrlForThumbnail(thumbnail_url);
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
    const bundles = await EpisodeBundlePrice.findAll();
    res.json(bundles);
  } catch (error) {
    res.status(500).json({ error: error.message });
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

// POST /api/episodes/:Id/convert-ts-to-m3u8 - Convert TS file to M3U8 using Google Cloud services
router.post('/episodes/:Id/convert-ts-to-m3u8', async (req, res) => {
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

    // GCS Configuration
    const storage = new Storage();
    const bucketName = process.env.GCS_BUCKET_NAME || 'run-sources-tuktuki-464514-asia-south1';
    const bucket = storage.bucket(bucketName);

    // Extract path and filename from hdTsPath
    const tsPath = subtitle.hdTsPath;
    const tsDir = path.dirname(tsPath);
    const tsName = path.basename(tsPath, '.ts');
    const m3u8Path = path.join(tsDir, `${tsName}.m3u8`);

    console.log('🔄 Processing TS to M3U8 conversion in Google Cloud...');
    console.log('Bucket:', bucketName);
    console.log('Input TS Path:', tsPath);
    console.log('Output M3U8 Path:', m3u8Path);

    // Check if TS file exists in GCS
    const tsFile = bucket.file(tsPath);
    const [tsExists] = await tsFile.exists();
    
    if (!tsExists) {
      return res.status(404).json({ error: 'TS file not found in GCS bucket' });
    }

    // For Google Cloud, we'll create a simple M3U8 playlist that references the existing TS file
    // This is a common approach when you already have TS files and just need a playlist
    const m3u8Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.0,
${tsPath}
#EXT-X-ENDLIST`;

    console.log('📝 Creating M3U8 playlist content...');
    console.log('M3U8 Content:', m3u8Content);

    // Upload M3U8 file to GCS bucket in the same folder
    console.log('📤 Uploading M3U8 file to GCS...');
    await bucket.file(m3u8Path).save(m3u8Content, {
      metadata: {
        contentType: 'application/vnd.apple.mpegurl'
      }
    });
    console.log('✅ M3U8 file uploaded to GCS:', m3u8Path);

    // Update subtitle hdTsPath to point to M3U8 file
    subtitle.hdTsPath = m3u8Path;
    await episode.save();
    console.log('💾 Database updated with new M3U8 path');

    // Generate signed URL for the new M3U8 file
    const p = `/${m3u8Path}`;
    const CDN_HOST = process.env.CDN_DOMAIN || 'cdn.tuktuki.com';
    const KEY_NAME = process.env.CDN_KEY_NAME || 'key1';
    const KEY_B64URL = process.env.CDN_KEY_SECRET;
    const TTL_SECS = parseInt(process.env.TTL_SECS || '1800', 10);

    if (!KEY_B64URL) {
      return res.status(500).json({ error: 'CDN_KEY_SECRET environment variable not set' });
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

    const upstream = new URL(`https://${CDN_HOST}${p}`);
    const expires = Math.floor(Date.now() / 1000) + TTL_SECS;
    const signed = signFullUrl(upstream.toString(), KEY_NAME, KEY_BYTES, expires);

    console.log('🔐 Generated signed URL for M3U8 file');
    console.log('Original Path:', p);
    console.log('Signed URL:', signed);

    return res.json({
      success: true,
      message: 'TS file converted to M3U8 successfully using Google Cloud services',
      bucketName: bucketName,
      originalTsPath: tsPath,
      newM3u8Path: m3u8Path,
      signedUrl: signed,
      ttl: TTL_SECS,
      cdnHost: CDN_HOST,
      expiresAt: new Date(expires * 1000).toISOString()
    });

  } catch (error) {
    console.error('TS to M3U8 conversion error:', error);
    return res.status(500).json({ 
      error: 'Conversion failed', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// POST /api/video/process-hls-cdn - Process video and generate HLS with CDN URLs
router.post('/video/process-hls-cdn', async (req, res) => {
  try {
    const { outputPrefix } = req.body;
    
    // Use the specific video path
    const videoFileName = 'videos/hi/0039b436-38cb-456a-bf2e-bec12ab15eca.mp4';

    // Configuration
    const CDN_CONFIG = {
      domain: process.env.CDN_DOMAIN || 'cdn.tuktuki.com',
      keyName: process.env.CDN_KEY_NAME || 'key1',
      base64Key: process.env.CDN_KEY_SECRET,
      defaultTtl: parseInt(process.env.TTL_SECS || '3600', 10)
    };

    if (!CDN_CONFIG.base64Key) {
      return res.status(500).json({ error: 'CDN_KEY_SECRET environment variable not set' });
    }

    const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'run-sources-tuktuki-464514-asia-south1';
    const VIDEO_SEGMENT_DURATION = 10;
    const HLS_PLAYLIST_NAME = 'playlist.m3u8';

    // Initialize Google Cloud Storage
    const storage = new Storage();
    const bucket = storage.bucket(BUCKET_NAME);

    // Generate CDN signed URL
    function generateCdnSignedUrl(path, expiresAt = null) {
      const expiryTime = expiresAt || Math.floor(Date.now() / 1000) + CDN_CONFIG.defaultTtl;
      const urlToSign = `${path}?Expires=${expiryTime}&KeyName=${CDN_CONFIG.keyName}`;
      
      // Decode the base64 key
      const key = Buffer.from(CDN_CONFIG.base64Key, 'base64');
      
      // Create HMAC signature
      const hmac = crypto.createHmac('sha1', key);
      hmac.update(urlToSign);
      const signature = hmac.digest('base64');
      
      // URL encode the signature
      const urlSafeSignature = signature
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      
      // Construct final URL
      return `https://${CDN_CONFIG.domain}${urlToSign}&Signature=${urlSafeSignature}`;
    }

    // Convert video to HLS format using fluent-ffmpeg with GCS streams
    async function convertVideoToHLS(inputVideoPath, outputPrefix) {
      return new Promise((resolve, reject) => {
        // Create read stream from GCS
        const inputStream = bucket.file(inputVideoPath).createReadStream();
        
        // Create write stream to GCS for M3U8 playlist
        const m3u8WriteStream = bucket.file(`${outputPrefix}/${HLS_PLAYLIST_NAME}`).createWriteStream({
          metadata: {
            contentType: 'application/x-mpegURL'
          }
        });

        // Create write stream to GCS for TS segments
        const tsWriteStream = bucket.file(`${outputPrefix}/segment.ts`).createWriteStream({
          metadata: {
            contentType: 'video/MP2T'
          }
        });

        ffmpeg(inputStream)
          .outputOptions([
            '-profile:v baseline',
            '-level 3.0',
            '-start_number 0',
            `-hls_time ${VIDEO_SEGMENT_DURATION}`,
            '-hls_list_size 0',
            '-f hls'
          ])
          .output(m3u8WriteStream)
          .on('end', () => resolve(outputPrefix))
          .on('error', (err) => reject(err))
          .run();
      });
    }

    // No local upload needed - everything goes directly to GCS

    console.log('🎬 Starting video processing with HLS and CDN...');
    console.log('Video File:', videoFileName);
    console.log('Full GCS Path:', `${BUCKET_NAME}/${videoFileName}`);
    console.log('Bucket:', BUCKET_NAME);

    const uniquePrefix = outputPrefix || `hls_output/${uuidv4()}`;
    
    // Convert video directly from GCS to HLS in GCS
    console.log('🔄 Converting video to HLS format directly in GCS...');
    await convertVideoToHLS(videoFileName, uniquePrefix);
    console.log('✅ HLS conversion completed in GCS');

    // Generate CDN signed URL for the playlist
    const playlistPath = `${gcsOutputPath}/${HLS_PLAYLIST_NAME}`;
    const cdnSignedUrl = generateCdnSignedUrl(playlistPath);
    console.log('🔐 Generated CDN signed URL for playlist');

    // No local files to clean up - everything is in GCS

    const result = {
      success: true,
      message: 'Video processed successfully with HLS and CDN URLs',
      cdnPlaylistUrl: cdnSignedUrl,
      gcsPlaylistPath: playlistPath,
      gcsSegmentsPath: gcsOutputPath,
      bucketName: BUCKET_NAME,
      cdnDomain: CDN_CONFIG.domain,
      ttl: CDN_CONFIG.defaultTtl
    };

    console.log('🎉 Video processing completed successfully!');
    console.log('CDN Signed Playlist URL:', cdnSignedUrl);
    console.log('GCS Playlist Path:', playlistPath);

    return res.json(result);

  } catch (error) {
    console.error('Video processing error:', error);

    return res.status(500).json({ 
      error: 'Video processing failed', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

export default router;