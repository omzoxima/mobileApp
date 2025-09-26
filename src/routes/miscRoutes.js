import express from 'express';
import { Op } from 'sequelize';
import models from '../models/index.js';
import { sequelize } from '../models/index.js';
import userContext from '../middlewares/userContext.js';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { generateCdnSignedUrlForThumbnail } from '../services/cdnService.js';
import { generateUniqueReferralCode } from '../utils/referralCodeGenerator.js';

const { Series, Episode, User, StaticContent, Wishlist, OTP, Category } = models;
const router = express.Router();

// Helper function to get local time instead of GMT
function getLocalTime() {
  const now = new Date();
  const localTime = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
  return localTime;
}


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
    const wishlistData = { wishlist: result, user_id };

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
    
    const seriesResults = await Series.findAll({
      where: { title: { [Op.iLike]: `%${q}%` } },
      include: [{ model: Episode }],
      order: [['created_at', 'DESC']]
    });
    
    // Deduplicate series by title - keep only the first occurrence
    const uniqueSeriesMap = new Map();
    seriesResults.forEach(series => {
      const seriesData = series.toJSON ? series.toJSON() : series;
      if (!uniqueSeriesMap.has(seriesData.title)) {
        uniqueSeriesMap.set(seriesData.title, seriesData);
      }
    });
    
    // Convert map values to array and limit to 10 results
    const uniqueSeries = Array.from(uniqueSeriesMap.values()).slice(0, 10);
    
    // Generate CDN signed URL for thumbnail_url in each series directly
    const seriesWithSignedUrl = await Promise.all(uniqueSeries.map(async series => {
      if (series.thumbnail_url) {
        series.thumbnail_url = generateCdnSignedUrlForThumbnail(series.thumbnail_url);
      }
      return series;
    }));
    
    const searchResults = { series: seriesWithSignedUrl, query: q };
    
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
    console.log('authHeader', deviceId);
    // Check if device ID is null or blank when no JWT token is provided
    if ((!deviceId || deviceId.trim() === '')) {
      return res.status(400).json({ error: 'device_id is required' });
    }
    
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findByPk(payload.userId, {
        attributes: ['id', 'Name', 'device_id', 'current_reward_balance', 'start_date', 'end_date', 'phone_or_email', 'referral_code', 'app_install_count']
      });
    } else if (deviceId) {
      // Fetch user directly from database
      user = await User.findOne({
        where: { device_id: deviceId },
        attributes: ['id', 'Name', 'device_id', 'current_reward_balance', 'start_date', 'end_date', 'phone_or_email', 'referral_code', 'app_install_count']
      });
    }
    
    if (!user) {
      // Only start transaction when creating new user
      t = await sequelize.transaction();
      
      // Generate unique referral code
      const referralCode = await generateUniqueReferralCode(User);
      
      user = await User.create({
        device_id: deviceId,
        Name: 'Guest User',
        login_type: 'guest',
        current_reward_balance: 0,
        is_active: true,
        referral_code: referralCode,
       // phone_or_email:'Guest User',
        created_at: getLocalTime(),
        updated_at: getLocalTime()
      }, { 
        transaction: t,
        returning: true
      });
      
      // Process rewards for new user
      const today = getLocalTime();
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
          updated_at: getLocalTime()
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

      // Calculate days left for new user if dates exist
      let daysLeft = null;
      if (user.start_date && user.end_date && today < user.end_date) {
        const timeDiff = user.end_date.getTime() - today.getTime();
        daysLeft = Math.ceil(timeDiff / (1000 * 3600 * 24));
      }

      return res.json({
        user: {
          id: user.id,
          name: user.Name,
          device_id: user.device_id,
          current_reward_balance: user.current_reward_balance,
          lock: true, // New users typically start locked
          start_date: user.start_date,
          end_date: user.end_date,
          days_left: daysLeft,
          phone_or_email: user.phone_or_email,
          referral_code:user.referral_code,
          app_install_count:user.app_install_count
        },
        pointsGranted
      });
    }
    
    // Existing user logic (no transaction needed for simple read)
    const today = getLocalTime();
    let lock = true;
    let daysLeft = null;
    
    if (user.start_date && user.end_date) {
      lock = !(today >= user.start_date && today <= user.end_date);
      
      // Calculate days left to end date when both dates are not null and today is less than end date
      if (today < user.end_date) {
        const timeDiff = user.end_date.getTime() - today.getTime();
        daysLeft = Math.ceil(timeDiff / (1000 * 3600 * 24));
      }
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
        days_left: daysLeft,
        phone_or_email: user.phone_or_email,
        referral_code: user.referral_code,
        app_install_count: user.app_install_count
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
      const { EpisodeUserAccess } = models;
      const records = await EpisodeUserAccess.findAll({ where: { series_id,user_id } });
      
      const accessData = { records, user_id, series_id };
      
      return res.json(accessData);
    } catch (error) {
      console.error('Episode access fetch error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  try {
    const { EpisodeUserAccess, User } = models;
    
    // If lock/unlock is explicitly requested, create/update record directly
    if (typeof lock === 'boolean') {
      let access = await EpisodeUserAccess.findOne({ where: { episode_id, user_id } });
      if (!access) {
        // Determine point value based on subscription
        //const pointValue = hasActiveSubscription ? 0 : -1;
        
        access = await EpisodeUserAccess.create({
          id: uuidv4(),
          episode_id,
          series_id,
          user_id,
          is_locked: lock,
          point: -1,
          created_at: getLocalTime(),
          updated_at: getLocalTime()
        });
      } else {
        access.is_locked = lock;
        // Update point value based on subscription
        access.point =-1;
        access.updated_at = getLocalTime();
        await access.save();
      }
      
      return res.json({ message: `Access ${lock ? 'locked' : 'unlocked'}`, access });
    }

    // Check if user has active subscription
    const user = await User.findByPk(user_id);
    const currentDate = getLocalTime();
    let hasActiveSubscription = false;
    
    if (user.start_date && user.end_date) {
      hasActiveSubscription = currentDate >= user.start_date && currentDate <= user.end_date;
    }

    // Otherwise, check existing access
    let access = await EpisodeUserAccess.findOne({ where: { episode_id, user_id } });
    
    if (access) {
      if (!access.is_locked) {
        return res.json({ message: 'Already unlocked', access });
      }
      
      // If locked, check subscription first, then user points
      if (hasActiveSubscription) {
        // Unlock episode using subscription (point = 0)
        access.is_locked = false;
        access.point = 0; // Subscription access = 0 points
        access.updated_at = getLocalTime();
        await access.save();
        
        return res.json({ 
          message: 'Unlocked using subscription', 
          access,
          subscription_used: true,
          points_deducted: 0,
          point: 0
        });
      } else if (user.current_reward_balance > 0) {
        // Unlock episode using points
        user.current_reward_balance -= 1;
        await user.save();
        access.is_locked = false;
        access.point = -1; // Points access = -1 points
        access.updated_at = getLocalTime();
        await access.save();
        
        return res.json({ 
          message: 'Unlocked using points', 
          access,
          subscription_used: false,
          points_deducted: 1,
          point: -1
        });
      } else {
        return res.json({ 
          message: 'Locked, not enough points and no active subscription', 
          access,
          subscription_used: false,
          points_deducted: 0
        });
      }
    } else {
      // No record exists, check subscription first, then user points
      if (hasActiveSubscription) {
        // Create access record and unlock using subscription (point = 0)
        access = await EpisodeUserAccess.create({
          id: uuidv4(),
          episode_id,
          series_id,
          user_id,
          is_locked: false,
          point: 0, // Subscription access = 0 points
          created_at: getLocalTime(),
          updated_at: getLocalTime()
        });
        
        return res.json({ 
          message: 'Unlocked using subscription', 
          access,
          subscription_used: true,
          points_deducted: 0,
          point: 0
        });
      } else if (user.current_reward_balance > 0) {
        // Create access record and unlock using points
        user.current_reward_balance -= 1;
        await user.save();
        access = await EpisodeUserAccess.create({
          id: uuidv4(),
          episode_id,
          series_id,
          user_id,
          is_locked: false,
          point: -1, // Points access = -1 points
          created_at: getLocalTime(),
          updated_at: getLocalTime()
        });
        
        return res.json({ 
          message: 'Unlocked using points', 
          access,
          subscription_used: false,
          points_deducted: 1,
          point: -1
        });
      } else {
        access = [];
        return res.json({ 
          message: 'Locked, not enough points and no active subscription', 
          access,
          subscription_used: false,
          points_deducted: 0
        });
      }
    }
  } catch (error) {
    console.error('Episode access error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/action (like, share, subscribe)
router.post('/action', async (req, res) => {
  try {
    const { action, series_id, episode_id } = req.body;
    const device_id = req.headers['x-device-id'];
    
    // Check for required x-device-id header
    if (!device_id) {
      return res.status(400).json({ error: 'x-device-id header is required' });
    }
    
    // Check for required fields
    if (!action) {
      return res.status(400).json({ error: 'action is required' });
    }
    
    if (!series_id) {
      return res.status(400).json({ error: 'series_id is required' });
    }
    
    // Try to find a user with this device_id
    let user_id = null;
    const user = await models.User.findOne({ where: { device_id } });
    if (user) {
      user_id = user.id;
    } else {
      return res.status(400).json({ error: 'Device ID is incorrect' });
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
    if (series_id) where.series_id = series_id;
    if (episode_id) where.episode_id = episode_id;
    let record;
    if (action === 'share') {
      // Allow multiple shares
      record = await Model.create({ ...where, created_at: new Date(), updated_at: new Date() });
    } else if (action === 'unsubscribe') {
      // For unsubscribe, only check series_id and user_id
      const unsubscribeWhere = { series_id };
      if (user_id) unsubscribeWhere.user_id = user_id;
      
      const deletedCount = await Model.destroy({ where: unsubscribeWhere });
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

// POST /api/referral - Handle referral code usage
router.post('/referral', async (req, res) => {
  try {
    const { referral_code } = req.body;
    const deviceId = req.headers['x-device-id'];
    
    // Validate required fields
    if (!referral_code) {
      return res.status(400).json({ error: 'referral_code is required' });
    }
    
    if (!deviceId) {
      return res.status(400).json({ error: 'x-device-id header is mandatory' });
    }

    // Find user by referral code
    const referrerUser = await User.findOne({ 
      where: { referral_code: referral_code } 
    });
    
    if (!referrerUser) {
      return res.status(404).json({ error: 'Invalid referral code' });
    }



    // Increment app_install_count for the referrer
    await referrerUser.increment('app_install_count');
    await referrerUser.reload(); // Reload to get updated count

    // Check if app_install_count matches any share type reward task unlock_value
    const shareRewardTask = await models.RewardTask.findOne({
      where: {
        type: 'share',
        unlock_value: referrerUser.app_install_count,
        is_active: true
      }
    });

      if (shareRewardTask) {
        // Add points to referrer's reward balance
        const newBalance = (referrerUser.current_reward_balance || 0) + shareRewardTask.points;
        await referrerUser.update({
          current_reward_balance: newBalance,
          updated_at: getLocalTime()
        });

        // Create reward transaction for referral
        const rewardTransaction = await models.RewardTransaction.create({
          user_id: referrerUser.id,
          type: 'earn',
          points: shareRewardTask.points,
          task_id: shareRewardTask.id,
          source: deviceId,
          created_at: getLocalTime()
        });

        // Invalidate user caches
        try {
          const { apiCache } = await import('../config/redis.js');
          await apiCache.invalidateUserSession(referrerUser.device_id);
          await apiCache.invalidateUserTransactionsCache(referrerUser.device_id);
          console.log('🗑️ Referrer user caches invalidated due to referral reward');
        } catch (cacheError) {
          console.error('Cache invalidation error:', cacheError);
        }

        return res.json({
          success: true,
          message: 'Referral successful! Reward points awarded.',
          referrer: {
            id: referrerUser.id,
            referral_code: referrerUser.referral_code,
            app_install_count: referrerUser.app_install_count,
            points_awarded: shareRewardTask.points,
            new_balance: newBalance
          },
          reward_task: {
            id: shareRewardTask.id,
            name: shareRewardTask.name,
            points: shareRewardTask.points
          },
          transaction: rewardTransaction
        });
      }

    // If no reward task found, just return success
    return res.json({
      success: true,
      message: 'Referral successful!',
      referrer: {
        id: referrerUser.id,
        referral_code: referrerUser.referral_code,
        app_install_count: referrerUser.app_install_count
      }
    });

  } catch (error) {
    console.error('Referral error:', error);
    res.status(500).json({ error: error.message || 'Failed to process referral' });
  }
});

// GET /api/carousel-series - Get popular series for carousel with categories
router.get('/carousel-series', async (req, res) => {
  try {
    // Get popular series with category information
    const popularSeries = await Series.findAll({
      where: {
        is_popular: true,
        status: 'Active',
        is_published: true
      },
      include: [{
        model: Category,
        attributes: ['id', 'name'],
        required: true // Only include categories that have series
      }],
      attributes: [
        'id', 
        'title', 
        'carousel_image_url',
        'category_id',
        'created_at',
        'updated_at'
      ],
      order: [['created_at', 'DESC']],
      limit: 5
    });

    // Process series data and generate CDN URLs
    const processedSeries = popularSeries.map(series => {
      const seriesData = series.toJSON();
      
      // Generate CDN signed URL for carousel image
      if (seriesData.carousel_image_url) {
        seriesData.carousel_image_url = generateCdnSignedUrlForThumbnail(seriesData.carousel_image_url);
      }
      
      return seriesData;
    });

    // Get unique categories that have series
    const categoriesWithSeries = await Category.findAll({
      include: [{
        model: Series,
        where: {
          status: 'Active',
          is_published: true
        },
        required: true,
        attributes: [] // Don't include series data, just check existence
      }],
      attributes: ['id', 'name'],
      order: [['name', 'DESC']]
    });

    const response = {
      carousel_series: processedSeries,
      categories: categoriesWithSeries.map(cat => ({
        id: cat.id,
        name: cat.name
      })),
      total_series: processedSeries.length,
      total_categories: categoriesWithSeries.length,
      cached_at: new Date().toISOString()
    };

    res.json(response);
  } catch (error) {
    console.error('Carousel series error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch carousel series' });
  }
});

// GET /api/series-by-category/:categoryId - Get series by category with pagination
router.get('/series-by-category/:categoryId', async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    
    // Validate category ID format
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidV4Regex.test(categoryId)) {
      return res.status(400).json({ error: 'Invalid category ID format' });
    }

    // Validate pagination parameters
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    
    if (pageNum < 1 || limitNum < 1 || limitNum > 50) {
      return res.status(400).json({ 
        error: 'Invalid pagination parameters. Page must be >= 1, limit must be between 1-50' 
      });
    }

    // Check if category exists
    const category = await Category.findByPk(categoryId);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Get series for the category with pagination
    const { count, rows } = await Series.findAndCountAll({
      where: {
        category_id: categoryId,
        status: 'Active',
        is_published: true
      },
      attributes: [
        'id', 
        'title', 
        'thumbnail_url',
        'created_at',
        'updated_at'
      ],
      order: [['created_at', 'DESC']],
      offset: (pageNum - 1) * limitNum,
      limit: limitNum
    });

    // Process series data and generate CDN URLs
    const processedSeries = rows.map(series => {
      const seriesData = series.toJSON();
      
      // Generate CDN signed URL for thumbnail
      if (seriesData.thumbnail_url) {
        seriesData.thumbnail_url = generateCdnSignedUrlForThumbnail(seriesData.thumbnail_url);
      }
      
      return seriesData;
    });

    const totalPages = Math.ceil(count / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    const response = {
      category: {
        id: category.id,
        name: category.name
      },
      series: processedSeries,
      pagination: {
        current_page: pageNum,
        total_pages: totalPages,
        total_series: count,
        series_per_page: limitNum,
        has_next_page: hasNextPage,
        has_prev_page: hasPrevPage,
        next_page: hasNextPage ? pageNum + 1 : null,
        prev_page: hasPrevPage ? pageNum - 1 : null
      },
      cached_at: new Date().toISOString()
    };

    res.json(response);
  } catch (error) {
    console.error('Series by category error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch series by category' });
  }
});

/**
 * ==========================
 * 🔹 Carousel Series v1
 * ==========================
 */
router.get('/carousel-series/v1', async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    
    const carouselSeries = await models.Series.findAll({
      where: { 
        is_popular: true,
        status: 'Active',
        is_published: true
      },
      attributes: [
        'id', 
        'title', 
        'carousel_image_url',
        'category_id',
        'created_at',
        'updated_at'
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit)
    });

    // Generate CDN signed URLs for carousel images
    const seriesWithSignedUrls = await Promise.all(
      carouselSeries.map(async (series) => {
        const seriesData = series.toJSON();
        
        // Generate CDN signed URL for carousel image
        if (seriesData.carousel_image_url) {
          try {
            const signedUrl = await generateCdnSignedUrlForThumbnail(seriesData.carousel_image_url);
            seriesData.carousel_image_url = signedUrl;
          } catch (error) {
            console.error('Error generating signed URL for series:', seriesData.id, error);
            // Keep original URL if signing fails
          }
        }
        
        return seriesData;
      })
    );

    res.json({
      success: true,
      data: seriesWithSignedUrls,
      count: seriesWithSignedUrls.length
    });
  } catch (error) {
    console.error('Carousel series error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to fetch carousel series' 
    });
  }
});

/**
 * ==========================
 * 🔹 Categories v1
 * ==========================
 */
router.get('/category/v1', async (req, res) => {
  try {
    const categories = await models.Category.findAll({
      attributes: ['id', 'name'],
      order: [['name', 'ASC']]
    });

    // Extract category IDs like in carousel-series
    const categoryIds = categories.map(category => category.id);

    res.json({
      success: true,
      data: categories,
      count: categories.length,
      category_ids: categoryIds
    });
  } catch (error) {
    console.error('Categories error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to fetch categories' 
    });
  }
});



export default router; 