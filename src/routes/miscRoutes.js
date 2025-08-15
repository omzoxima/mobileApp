import express from 'express';
import { Op } from 'sequelize';
import models from '../models/index.js';
import { sequelize } from '../models/index.js';
import userContext from '../middlewares/userContext.js';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { generateCdnSignedUrlForThumbnail } from '../services/cdnService.js';

const { Series, Episode, User, StaticContent, Wishlist, OTP } = models;
const router = express.Router();




// GET /api/wishlist/series-episodes?user_id=USER_ID
router.get('/wishlist/series-episodes', async (req, res) => {
  try {
    const user_id = req.query.user_id || req.body.user_id;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // Validate UUID format (simple regex for UUID v4)
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidV4Regex.test(user_id)) {
      return res.status(400).json({ error: 'Invalid user_id format' });
    }

    // Try to get from cache first
    const { apiCache } = await import('../config/redis.js');
    const cachedWishlist = await apiCache.getWishlistSeriesCache(user_id);
    if (cachedWishlist) {
      console.log('📦 Wishlist data served from cache');
      return res.json(cachedWishlist);
    }

    // Fetch wishlist records for the user
    const wishlistRecords = await Wishlist.findAll({ where: { user_id } });
    if (!wishlistRecords || wishlistRecords.length === 0) {
      return res.status(404).json({ error: 'No record found' });
    }

    // Group wishlist records by series_id to avoid duplicates
    const seriesMap = new Map();
    
    for (const record of wishlistRecords) {
      if (record.series_id && !seriesMap.has(record.series_id)) {
        // Fetch the series with all fields
        const series = await Series.findByPk(record.series_id, { raw: true });
        if (series && series.status === 'Active') {
          // Generate CDN signed URL for thumbnail_url directly
          if (series.thumbnail_url) {
            series.thumbnail_url = generateCdnSignedUrlForThumbnail(series.thumbnail_url);
          }
          // Fetch all episodes for the series
          const episodes = await Episode.findAll({
            where: { series_id: record.series_id },
            attributes: ['id', 'title', 'subtitles'],
            raw: true
          });
          
          seriesMap.set(record.series_id, {
            ...series,
            episodes
          });
        }
      } 
    }

    // Convert map values to array
    const result = Array.from(seriesMap.values());
    const wishlistData = { wishlist: result, user_id, cached_at: new Date().toISOString() };

    // Cache wishlist data for 2 hours
    await apiCache.setWishlistSeriesCache(user_id, wishlistData);
    console.log('💾 Wishlist data cached for 2 hours');

    res.json(wishlistData);
  } catch (error) {
    if (error.name === 'SequelizeDatabaseError' && error.parent && error.parent.code === '22P02') {
      // Invalid UUID error from Postgres
      return res.status(400).json({ error: 'Invalid user_id format' });
    }
    console.error('Wishlist fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// GET /api/search?q=searchstring
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query string q is required' });
    
    // Try to get from cache first
    const { apiCache } = await import('../config/redis.js');
    const cachedSearch = await apiCache.getSearchCache(q);
    if (cachedSearch) {
      console.log('📦 Search results served from cache');
      return res.json(cachedSearch);
    }
    
    const seriesResults = await Series.findAll({
      where: { title: { [Op.iLike]: `%${q}%` } },
      include: [{ model: Episode }],
      limit: 10
    });
    
    // Generate CDN signed URL for thumbnail_url in each series directly
    const seriesWithSignedUrl = await Promise.all(seriesResults.map(async series => {
      let obj = series.toJSON ? series.toJSON() : series;
      if (obj.thumbnail_url) {
        obj.thumbnail_url = generateCdnSignedUrlForThumbnail(obj.thumbnail_url);
      }
      return obj;
    }));
    
    const searchResults = { series: seriesWithSignedUrl, query: q, cached_at: new Date().toISOString() };
    
    // Cache search results for 2 hours
    await apiCache.setSearchCache(q, searchResults);
    console.log('💾 Search results cached for 2 hours');
    
    res.json(searchResults);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Search failed' });
  }
});

// Profile route without cache
router.get('/profile', async (req, res) => {
  const { User, RewardTask, RewardTransaction } = models;
  let t; // Declare transaction outside try block
  
  try {
    // Initial user fetching without cache
    let user = null;
    const deviceId = req.headers['x-device-id'];
    const authHeader = req.headers['authorization'];
    
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findByPk(payload.userId, {
        attributes: ['id', 'Name', 'device_id', 'current_reward_balance', 'start_date', 'end_date','phone_or_email']
      });
    } else if (deviceId) {
      // Fetch user directly from database
      user = await User.findOne({
        where: { device_id: deviceId },
        attributes: ['id', 'Name', 'device_id', 'current_reward_balance', 'start_date', 'end_date','phone_or_email']
      });
    }
    
    if (!user) {
      // Only start transaction when creating new user
      t = await sequelize.transaction();
      user = await User.create({
        device_id: deviceId,
        Name: 'Guest User',
        login_type: 'guest',
        current_reward_balance: 0,
        is_active: true,
       // phone_or_email:'Guest User',
        created_at: new Date(),
        updated_at: new Date()
      }, { 
        transaction: t,
        returning: true
      });
      
      // Process rewards for new user
      const today = new Date();
      const appOpenTasks = await RewardTask.findAll({
        where: {
          type: 'app_open',
          is_active: true,
        },
        attributes: ['id', 'points', 'repeat_type'],
        transaction: t
      });

      const transactions = [];
      let pointsGranted = 0;
      for (const task of appOpenTasks) {
        transactions.push({
          id: uuidv4(),
          user_id: user.id,
          task_id: task.id,
          type: 'earn',
          points: task.points,
          created_at: today,
          updated_at: new Date()
        });
        pointsGranted += task.points;
      }

      // Debug log for profile, points, and tasks
    

      if (transactions.length > 0) {
        await user.increment('current_reward_balance', {
          by: pointsGranted,
          transaction: t
        });
        await RewardTransaction.bulkCreate(transactions, { transaction: t });
      }

      await t.commit();

      return res.json({
        user: {
          id: user.id,
          name: user.Name,
          device_id: user.device_id,
          current_reward_balance: user.current_reward_balance,
          lock: true, // New users typically start locked
          start_date: user.start_date,
          end_date: user.end_date,
          phone_or_email: user.phone_or_email
        },
        pointsGranted
      });
    }
    
    // Existing user logic (no transaction needed for simple read)
    const today = new Date();
    let lock = true;
    if (user.start_date && user.end_date) {
      lock = !(today >= user.start_date && today <= user.end_date);
    }
    
    res.json({
      user: {
        id: user.id,
        name: user.Name,
        device_id: user.device_id,
        current_reward_balance: user.current_reward_balance,
        lock,
        start_date: user.start_date,
        end_date: user.end_date,
        phone_or_email: user.phone_or_email
      },
      pointsGranted: 0
    });
    
  } catch (error) {
    if (t) await t.rollback();
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// GET /api/static/about-us
router.get('/static/about-us', async (req, res) => {
  try {
    // Try to get from cache first
    const { apiCache } = await import('../config/redis.js');
    const cachedAbout = await apiCache.getStaticContentCache('about_us');
    if (cachedAbout) {
      console.log('📦 About Us content served from cache');
      return res.json(cachedAbout);
    }
    
    const about = await StaticContent.findOne({ where: { type: 'about_us' } });
    if (!about) return res.status(404).json({ error: 'About Us not found' });
    
    const aboutData = { content: about.content, cached_at: new Date().toISOString() };
    
    // Cache static content for 2 hours
    await apiCache.setStaticContentCache('about_us', aboutData);
    console.log('💾 About Us content cached for 2 hours');
    
    res.json(aboutData);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to get About Us' });
  }
});

// GET /api/static/privacy-policy
router.get('/static/privacy-policy', async (req, res) => {
  try {
    // Try to get from cache first
    const { apiCache } = await import('../config/redis.js');
    const cachedPolicy = await apiCache.getStaticContentCache('privacy_policy');
    if (cachedPolicy) {
      console.log('📦 Privacy Policy content served from cache');
      return res.json(cachedPolicy);
    }
    
    const policy = await StaticContent.findOne({ where: { type: 'privacy_policy' } });
    if (!policy) return res.status(404).json({ error: 'Privacy Policy not found' });
    
    const policyData = { content: policy.content, cached_at: new Date().toISOString() };
    
    // Cache static content for 2 hours
    await apiCache.setStaticContentCache('privacy_policy', policyData);
    console.log('💾 Privacy Policy content cached for 2 hours');
    
    res.json(policyData);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to get Privacy Policy' });
  }
});

// POST /api/logout
router.post('/logout', userContext, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Logout only available for logged-in users' });
  }
  // For JWT, just instruct client to delete token
  res.json({ message: 'Logged out successfully' });
});

// POST /api/episode/access
router.post('/episode/access', async (req, res) => {
  let { series_id, episode_id, user_id, device_id, lock } = req.body;

  // If user_id is not provided, but device_id is, try to find the user by device_id
  if (!user_id && device_id) {
    const user = await models.User.findOne({ where: { device_id } });
    if (user) {
      user_id = user.id;
    } else {
      return res.status(404).json({ error: 'User not found for provided device_id' });
    }
  }

  // Now continue with the rest of your logic using user_id
  if (!series_id || !user_id) {
    //console.log('series_id, episode_id, and user_id (or device_id) are required', series_id, episode_id, user_id);
    return res.status(400).json({ error: 'series_id,and user_id (or device_id) are required' });
  }

  // If only series_id is provided, return all access records for that series
  if (series_id && !episode_id && user_id) {
    try {
      // Try to get from cache first
      const { apiCache } = await import('../config/redis.js');
      const cachedAccess = await apiCache.getEpisodeAccessCache(user_id, series_id);
      if (cachedAccess) {
        console.log('📦 Episode access data served from cache');
        return res.json(cachedAccess);
      }
      
      const { EpisodeUserAccess } = models;
      const records = await EpisodeUserAccess.findAll({ where: { series_id,user_id } });
      
      const accessData = { records, user_id, series_id, cached_at: new Date().toISOString() };
      
      // Cache episode access data for 2 hours
      await apiCache.setEpisodeAccessCache(user_id, series_id, accessData);
      console.log('💾 Episode access data cached for 2 hours');
      
      return res.json(accessData);
    } catch (error) {
      console.error('Episode access fetch error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  try {
    const { EpisodeUserAccess, User } = models;    // If lock/unlock is explicitly requested, create/update record directly
    if (typeof lock === 'boolean') {
      let access = await EpisodeUserAccess.findOne({ where: { episode_id, user_id } });
      if (!access) {
        access = await EpisodeUserAccess.create({
          id: uuidv4(),
          episode_id,
          series_id,
          user_id,
          is_locked: lock,
          created_at: new Date(),
          updated_at: new Date()
        });
      } else {
        access.is_locked = lock;
        access.updated_at = new Date();
        await access.save();
      }
      // Invalidate episode access cache
      try {
        const { apiCache } = await import('../config/redis.js');
        await apiCache.invalidateEpisodeAccessCache(user_id, series_id);
        console.log('🗑️ Episode access cache invalidated due to access change');
      } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
      }
      
      return res.json({ message: `Access ${lock ? 'locked' : 'unlocked'}`, access });
    }
    // Otherwise, check existing access
    let access = await EpisodeUserAccess.findOne({ where: { episode_id, user_id } });
    if (access) {
      if (!access.is_locked) {
        return res.json({ message: 'Already unlocked', access });
      }
      // If locked, check user points
      const user = await User.findByPk(user_id);
      if (user.current_reward_balance > 0) {
        user.current_reward_balance -= 1;
        await user.save();
        access.is_locked = false;
        access.updated_at = new Date();
        await access.save();
        
        // Invalidate episode access cache
        try {
          const { apiCache } = await import('../config/redis.js');
          await apiCache.invalidateEpisodeAccessCache(user_id, series_id);
          console.log('🗑️ Episode access cache invalidated due to unlock with points');
        } catch (cacheError) {
          console.error('Cache invalidation error:', cacheError);
        }
        
        return res.json({ message: 'Unlocked using points', access });
      } else {
        return res.json({ message: 'Locked, not enough points', access });
      }
    } else {
      // No record exists, check user points
      const user = await User.findByPk(user_id);
      if (user.current_reward_balance > 0) {
        user.current_reward_balance -= 1;
        await user.save();
        access = await EpisodeUserAccess.create({
          id: uuidv4(),
          episode_id,
          series_id,
          user_id,
          is_locked: false,
          created_at: new Date(),
          updated_at: new Date()
        });
        
        // Invalidate episode access cache
        try {
          const { apiCache } = await import('../config/redis.js');
          await apiCache.invalidateEpisodeAccessCache(user_id, series_id);
          console.log('🗑️ Episode access cache invalidated due to new access creation');
        } catch (cacheError) {
          console.error('Cache invalidation error:', cacheError);
        }
        
        return res.json({ message: 'Unlocked using points', access });
      } else {
       access=[];
        return res.json({ message: 'Locked, not enough points', access });
      }
    }
  } catch (error) {
    console.error('Episode access error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/action (like, share, subscribe)
router.post('/action', userContext, async (req, res) => {
  try {
    const { action, series_id, episode_id } = req.body;
    let user_id = null;
    let device_id = null;
    if (req.user) {
      user_id = req.user.id;
    } else if (req.guestDeviceId) {
      device_id = req.guestDeviceId;
      // Try to find a user with this device_id
      const user = await models.User.findOne({ where: { device_id } });
      if (user) {
        user_id = user.id;
        device_id = null; // Prefer user_id if found
      }
    } else {
      return res.status(401).json({ error: 'Authentication required: provide JWT or x-device-id header' });
    }
    if (!series_id && !episode_id) {
      return res.status(400).json({ error: 'series_id or episode_id is required' });
    }
    if (!['like', 'share', 'subscribe','unsubscribe','unlike'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be like, share, or subscribe.' });
    }
    // Determine target model
    let Model = null;
    if (action === 'like') Model = models.Like;
    if (action === 'share') Model = models.Share;
    if (action === 'subscribe') Model = models.Wishlist;
    if (action === 'unsubscribe') Model = models.Wishlist;
    if (action === 'unlike') Model = models.Like;


    // Build where clause
    const where = { };
    if (user_id) where.user_id = user_id;
    if (device_id) where.device_id = device_id;
    if (series_id) where.series_id = series_id;
    if (episode_id) where.episode_id = episode_id;
    let record;
    if (action === 'share') {
      // Allow multiple shares
      record = await Model.create({ ...where, created_at: new Date(), updated_at: new Date() });
    } else if (action === 'unsubscribe') {
      const deletedCount = await Model.destroy({ where });
      if (deletedCount === 0) {
        return res.status(404).json({ error: 'No matching wishlist entries found' });
      }
      return res.json({ success: true, action, removed: deletedCount });
    } if (action === 'unlike') {
      const deletedCount = await Model.destroy({ where });
      if (deletedCount === 0) {
        return res.status(404).json({ error: 'No matching Like entries found' });
      }
      return res.json({ success: true, action, removed: deletedCount });
    }else {
      // Deduplicate like/subscribe
      [record] = await Model.findOrCreate({ where, defaults: { created_at: new Date(), updated_at: new Date() } });
    }
    
    // Invalidate relevant caches when action is performed
    try {
      const { apiCache } = await import('../config/redis.js');
      
      if (series_id) {
        // Invalidate series-related caches
        await apiCache.invalidateAllSeriesCaches(series_id);
        console.log('🗑️ Series caches invalidated due to action:', action);
      }
      
      if (user_id) {
        // Invalidate user-related caches
        const user = await models.User.findByPk(user_id);
        if (user && user.device_id) {
          await apiCache.invalidateAllUserCaches(user_id, user.device_id);
          console.log('🗑️ User caches invalidated due to action:', action);
        }
      }
    } catch (cacheError) {
      console.error('Cache invalidation error:', cacheError);
      // Continue with response even if cache invalidation fails
    }
    
    res.json({ success: true, action, record });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to process action' });
  }
});



export default router; 