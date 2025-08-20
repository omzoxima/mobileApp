import express from 'express';
import models from '../models/index.js';
import userContext from '../middlewares/userContext.js';
import { Op } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { generateUniqueReferralCode } from '../utils/referralCodeGenerator.js';

const { RewardTask, RewardTransaction, User, AdReward, EpisodeUserAccess } = models;
const router = express.Router();

// Helper function to get local time instead of GMT
function getLocalTime() {
  const now = new Date();
  const localTime = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
  return localTime;
}

// /reward_task route - NO CACHING as requested
router.get('/reward_task', async (req, res) => {
  const { User, RewardTask, RewardTransaction } = models;
  try {
    let user = null;
    let deviceId = req.headers['x-device-id'];
    const authHeader = req.headers['authorization'];
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findByPk(payload.userId);
    } else if (deviceId) {
      user = await User.findOne({ where: { device_id: deviceId } });
    }
    
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Get all active reward tasks (NO CACHE)
    const tasks = await RewardTask.findAll({ where: { is_active: true } });

    // Get all user's reward transactions for one_time tasks
    const oneTimeTaskIds = tasks.filter(t => t.repeat_type === 'one_time').map(t => t.id);
    const claimed = await RewardTransaction.findAll({
      where: { user_id: user.id, task_id: { [Op.in]: oneTimeTaskIds } }
    });
    const claimedIds = new Set(claimed.map(r => r.task_id));

    // --- Get streak task ids for current streak ---
    // Find user's current streak
    const currentStreak = user.current_streak || 0;
    // Get all streak tasks with unlock_value <= currentStreak
    const streakTasks = tasks.filter(t => t.type === 'streak' && t.unlock_value && t.unlock_value <= currentStreak);
    const streakTaskIds = streakTasks.map(t => t.id);
    // Find which of these have been completed (earned) by the user
    const completedStreakTransactions = await RewardTransaction.findAll({
      where: {
        user_id: user.id,
        task_id: { [Op.in]: streakTaskIds },
        type: 'earn'
      }
    });
    const completedStreakTaskIds = Array.from(new Set(completedStreakTransactions.map(r => r.task_id)));
    // --- End streak logic ---

    // --- Get share task completion status ---
    // Get all share task IDs
    const shareTaskIds = tasks.filter(t => t.type === 'share').map(t => t.id);
    // Check which share tasks are completed by looking in reward transactions
    const completedShareTransactions = await RewardTransaction.findAll({
      where: {
        user_id: user.id,
        task_id: { [Op.in]: shareTaskIds },
        type: 'earn'
      }
    });
    const completedShareTaskIds = Array.from(new Set(completedShareTransactions.map(r => r.task_id)));
    // --- End share logic ---

    // Filter out one-time tasks already claimed
    const result = tasks.map(task => ({
      id: task.id,
      name: task.name,
      description: task.description,
      points: task.points,
      type: task.type,
      trigger: task.trigger,
      repeat_type: task.repeat_type,
      unlock_value: task.unlock_value,
      max_count: task.max_count
    }));
    
    // Combine all completed task IDs: one-time, streak, and share
    const allCompletedTaskIds = Array.from(new Set([
      ...Array.from(claimedIds),
      ...completedStreakTaskIds,
      ...completedShareTaskIds
    ]));
    
    const responseData = {
      tasks: result,
      completed_streak_task_ids: allCompletedTaskIds
     
    };
    
    // NO CACHING - return fresh data every time
    res.json(responseData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/reward-tasks/:taskId/complete
router.post('/:taskId/complete', userContext, async (req, res) => {
  try {
    const { taskId } = req.params;
    let userId = null;
    let user = null;
    if (req.user) {
      userId = req.user.id;
      user = req.user;
    } else if (req.guestDeviceId) {
      // Find or create guest user
      const referralCode = await generateUniqueReferralCode(User);
      const [guestUser] = await User.findOrCreate({
        where: { device_id: req.guestDeviceId, login_type: 'guest' },
        defaults: { 
          current_reward_balance: 0, 
          is_active: true, 
          login_type: 'guest',
          referral_code: referralCode
        }
      });
      userId = guestUser.id;
      user = guestUser;
    } else {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Find the task
    const task = await RewardTask.findByPk(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!task.is_active) return res.status(400).json({ error: 'Task is not active' });

    // Check if already completed (by user)
    const alreadyCompleted = await RewardTransaction.findOne({
      where: { user_id: userId, task_id: taskId, type: 'earn' }
    });
    if (alreadyCompleted) {
      return res.status(409).json({ error: 'Task already completed by this user/guest' });
    }

    // Update user's reward balance
    user.current_reward_balance += task.points;
    await user.save();
    const new_balance = user.current_reward_balance;

    // Create reward transaction for user (registered or guest)
    const transaction = await RewardTransaction.create({
      user_id: userId,
      task_id: taskId,
      type: 'earn',
      points: task.points,
      created_at: getLocalTime(),
      updated_at: getLocalTime()
    });

    // Invalidate user session cache if device_id is available (reward tasks not cached)
    try {
      const { apiCache } = await import('../config/redis.js');
      
      if (req.guestDeviceId) {
        await apiCache.invalidateUserSession(req.guestDeviceId);
        await apiCache.invalidateUserTransactionsCache(req.guestDeviceId);
        console.log('🗑️ User caches invalidated due to reward task completion');
      }
    } catch (cacheError) {
      console.error('Cache invalidation error:', cacheError);
    }

    res.status(201).json({ message: 'Task completed, points awarded', transaction, new_balance });
  } catch (error) {
    console.error('Error completing reward task:', error);
    res.status(500).json({ error: error.message || 'Failed to complete reward task' });
  }
});

// POST /streak/episode-watched
router.post('/streak/episode-watched', async (req, res) => {
  try {
    let { user_id, device_id, series_id, episode_id } = req.body; // series_id and episode_id are optional
    let user = null;
    if (user_id) {
      user = await User.findByPk(user_id);
    } else if (device_id) {
      user = await User.findOne({ where: { device_id } });
    }
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = getLocalTime();
    const todayStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
    let lastStreakDateStr = null;
    if (user.last_streak_date) {
      const lastStreakDateObj = new Date(user.last_streak_date);
      lastStreakDateStr = !isNaN(lastStreakDateObj) ? lastStreakDateObj.toISOString().slice(0, 10) : null;
    }
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    let streakIncreased = false;
    let streakReset = false;
    let awardedPoints = 0;
    let rewardTask = null;
    let rewardTransaction = null;

    if (lastStreakDateStr === todayStr) {
      // Already counted today, do nothing
    } else if (lastStreakDateStr === yesterday) {
      user.current_streak += 1;
      user.last_streak_date = today;
      user.updated_at = getLocalTime();
      streakIncreased = true;
    } else {
      user.current_streak = 1;
      user.last_streak_date = today;
      user.updated_at = getLocalTime();
      streakReset = true;
    }
    await user.save();

    // Award points if streak matches a reward task
    rewardTask = await RewardTask.findOne({ where: { type: 'streak', unlock_value: user.current_streak, is_active: true } });
    if (rewardTask) {
      // Check if already awarded today for this streak task
      const alreadyStreakAwarded = await RewardTransaction.findOne({
        where: {
          user_id: user.id,
          task_id: rewardTask.id,
          type: 'earn',
          created_at: {
            [Op.gte]: todayStr + 'T00:00:00.000Z',
            [Op.lt]: todayStr + 'T23:59:59.999Z'
          }
        }
      });
      if (!alreadyStreakAwarded) {
        awardedPoints = rewardTask.points;
        rewardTransaction = await RewardTransaction.create({
          user_id: user.id,
          type: 'earn',
          points: rewardTask.points,
          streak_count: user.current_streak,
          disabled_streak_count: false,
          task_id: rewardTask.id,
          created_at: getLocalTime(),
          updated_at: getLocalTime()
        });
        user.current_reward_balance += rewardTask.points;
        await user.save();
      }
    }

    // --- Daily watch reward logic ---
    // Find the daily watch task
    const dailyWatchTask = await RewardTask.findOne({
      where: { type: 'daily_app_open', is_active: true }
    });
    let dailyWatchTransaction = null;
    let dailyWatchPointAwarded = false;
    if (dailyWatchTask) {
      // Check if already awarded today
      const alreadyAwarded = await RewardTransaction.findOne({
        where: {
          user_id: user.id,
          task_id: dailyWatchTask.id,
          type: 'earn',
          created_at: {
            [Op.gte]: todayStr + 'T00:00:00.000Z',
            [Op.lt]: todayStr + 'T23:59:59.999Z'
          }
        }
      });
      // Only award if user was created before today
      const userCreatedDate = user.created_at ? new Date(user.created_at).toISOString().slice(0, 10) : null;
      if (!alreadyAwarded && userCreatedDate && userCreatedDate < todayStr) {
        // Award daily point
        dailyWatchTransaction = await RewardTransaction.create({
          user_id: user.id,
          type: 'earn',
          points: dailyWatchTask.points,
          task_id: dailyWatchTask.id,
          created_at: getLocalTime(),
          updated_at: getLocalTime()
        });
        user.current_reward_balance += dailyWatchTask.points;
        await user.save();
        dailyWatchPointAwarded = true;
      } 
    }
    // --- End daily watch reward logic ---

    // Invalidate user session cache (reward tasks not cached)
    try {
      const { apiCache } = await import('../config/redis.js');
      
      if (device_id) {
        await apiCache.invalidateUserSession(device_id);
        await apiCache.invalidateUserTransactionsCache(device_id);
        console.log('🗑️ User caches invalidated due to streak update');
      }
    } catch (cacheError) {
      console.error('Cache invalidation error:', cacheError);
    }

    res.json({
      user_id: user.id,
      current_streak: user.current_streak,
      last_streak_date: user.last_streak_date,
      streakIncreased,
      streakReset,
      awardedPoints,
      rewardTask,
      rewardTransaction,
      dailyWatchPointAwarded,
      dailyWatchTransaction
    });
  } catch (error) {
    console.error('Error updating streak:', error);
    res.status(500).json({ error: error.message || 'Failed to update streak' });
  }
});

// GET /user-transaction
router.get('/user-transaction', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) {
      return res.status(400).json({ error: 'x-device-id header is required' });
    }
    
    
    const user = await User.findOne({ where: { device_id: deviceId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found for provided device_id' });
    }

    // Get all reward transactions for the user
    const transactions = await RewardTransaction.findAll({
      where: { user_id: user.id },
      order: [['created_at', 'DESC']]
    });

    // For each transaction, if task_id exists, add task name
    const taskIds = transactions.map(t => t.task_id).filter(Boolean);
    let tasks = [];
    if (taskIds.length > 0) {
      tasks = await RewardTask.findAll({
        where: { id: taskIds },
        attributes: ['id', 'name']
      });
    }
    const taskMap = {};
    tasks.forEach(task => { taskMap[task.id] = task.name; });

    // Get bundle information for payment_earn transactions
    const bundleIds = transactions
      .filter(t => t.type === 'payment_earn' && t.episode_bundle_id)
      .map(t => t.episode_bundle_id);
    
    let bundles = [];
    if (bundleIds.length > 0) {
      bundles = await models.EpisodeBundlePrice.findAll({
        where: { id: bundleIds },
        attributes: ['id', 'bundle_name', 'price_points', 'appleprice', 'productId', 'appleproductid']
      });
    }
    const bundleMap = {};
    bundles.forEach(bundle => { bundleMap[bundle.id] = bundle; });

    // Get platform from request headers
    const platform = req.headers['x-platform'] || 'android'; // Default to android

    const transactionsWithTask = transactions.map(t => {
      const transactionData = {
        ...t.toJSON(),
        task_name: t.task_id ? (taskMap[t.task_id] || null) : null
      };

      // Add bundle information for payment_earn transactions
      if (t.type === 'payment_earn' && t.episode_bundle_id && bundleMap[t.episode_bundle_id]) {
        const bundle = bundleMap[t.episode_bundle_id];
        transactionData.bundle_name = bundle.bundle_name;
        transactionData.bundle_price = platform === 'ios' ? bundle.appleprice : bundle.price_points;
        transactionData.price_id = platform === 'ios' ? bundle.appleproductid : bundle.productId;
      }

      return transactionData;
    });

    // Get all episode access records for the user
    const episodeAccessRecords = await models.EpisodeUserAccess.findAll({
      where: { user_id: user.id },
      attributes: ['episode_id', 'created_at','point']
    });
    // Get episode details for accessed episodes
    const accessEpisodeIds = episodeAccessRecords.map(e => e.episode_id);
    let accessEpisodes = [];
    if (accessEpisodeIds.length > 0) {
      accessEpisodes = await models.Episode.findAll({
        where: { id: accessEpisodeIds },
        attributes: ['id', 'title', 'series_id', 'episode_number']
      });
    }
    // Get unique series ids
    const seriesIds = [...new Set(accessEpisodes.map(ep => ep.series_id).filter(Boolean))];
    let seriesList = [];
    if (seriesIds.length > 0) {
      seriesList = await models.Series.findAll({
        where: { id: seriesIds },
        attributes: ['id', 'title', 'thumbnail_url']
      });
    }
    // Generate CDN signed URLs for each unique series only once
    const { generateCdnSignedUrlForThumbnail } = await import('../services/cdnService.js');
    const seriesSignedUrlMap = {};
    for (const s of seriesList) {
      if (s.thumbnail_url) {
        seriesSignedUrlMap[s.id] = generateCdnSignedUrlForThumbnail(s.thumbnail_url);
      } else {
        seriesSignedUrlMap[s.id] = null;
      }
    }
    // Map series id to title and signed url
    const seriesTitleMap = {};
    seriesList.forEach(s => { seriesTitleMap[s.id] = s.title; });
    // Map episode id to episode details
    const accessEpisodeMap = {};
    accessEpisodes.forEach(ep => { accessEpisodeMap[ep.id] = ep; });
    const episodeAccess = episodeAccessRecords.map(e => {
      const ep = accessEpisodeMap[e.episode_id];
      return {
        episode_id: e.episode_id,
        title: ep ? ep.title : null,
        series_id: ep ? ep.series_id : null,
        series_title: ep && ep.series_id ? seriesTitleMap[ep.series_id] || null : null,
        episode_number: ep ? ep.episode_number : null,
        series_thumbnail_url: ep && ep.series_id ? seriesSignedUrlMap[ep.series_id] || null : null,
        created_at: e.created_at,
        point: e.point // Include the point value
      };
    });

    const transactionData = {
      transactions: transactionsWithTask,
      episode_access: episodeAccess,
      user_id: user.id
    };

    res.json(transactionData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/task/ad-reward - Add ad reward points and grant episode access
router.post('/ad-reward', async (req, res) => {
  try {
    const { series_id, episode_id, points } = req.body;
    
    // Validate required fields
    if (!series_id || !episode_id || points === undefined) {
      return res.status(400).json({ error: 'series_id, episode_id, and points are required' });
    }

    // Validate points is a number
    if (typeof points !== 'number' || points <= 0) {
      return res.status(400).json({ error: 'points must be a positive number' });
    }

    // Get user from JWT token or device-id header
    let user = null;
    const deviceId = req.headers['x-device-id'];
    const authHeader = req.headers['authorization'];

    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        user = await User.findByPk(payload.userId);
      } catch (err) {
        return res.status(401).json({ error: 'Invalid JWT token' });
      }
    } else if (deviceId) {
      user = await User.findOne({ where: { device_id: deviceId } });
    }

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Create ad reward record
    await AdReward.create({
      user_id: user.id,
      points: 1.0,
      series_id: series_id,
      episode_id: episode_id,
      created_at: getLocalTime()
    });

    // Calculate total points for this user
    const totalPoints = await AdReward.sum('points', {
      where: { user_id: user.id }
    });

    // If total points >= 1, grant episode access and clear ad rewards
    if (totalPoints >= 1.0) {
      // Grant episode access
      await EpisodeUserAccess.create({
        id: uuidv4(),
        episode_id: episode_id,
        series_id: series_id,
        user_id: user.id,
        is_locked: false,
        point: -1,
        created_at: getLocalTime(),
        updated_at: getLocalTime()
      });

      // Delete all ad reward records for this user
      await AdReward.destroy({
        where: { user_id: user.id }
      });

      // Invalidate relevant caches (reward tasks not cached)
      try {
        const { apiCache } = await import('../config/redis.js');
        
        // Invalidate episode access cache
        await apiCache.invalidateEpisodeAccessCache(user.id, series_id);
        
        // Invalidate user session cache if device_id is available
        if (deviceId) {
          await apiCache.invalidateUserSession(deviceId);
          await apiCache.invalidateUserTransactionsCache(deviceId);
          console.log('🗑️ User caches invalidated due to ad reward episode access');
        }
      } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
      }

      return res.json({
        success: true,
        message: 'Episode access granted! Ad rewards cleared.',
        totalPoints: totalPoints,
        episodeAccess: {
          episode_id,
          series_id,
          user_id: user.id,
          is_locked: false
        }
      });
    } else {
      // Points not enough yet
      return res.json({
        success: true,
        message: 'Ad reward points added',
        currentPoints: totalPoints,
        pointsNeeded: 1.0 - totalPoints,
        episodeAccess: null
      });
    }

  } catch (error) {
    console.error('Ad reward error:', error);
    res.status(500).json({ error: error.message || 'Failed to process ad reward' });
  }
});

// POST /api/task/episode-bundle-purchase - Handle episode bundle purchase
router.post('/episode-bundle-purchase', async (req, res) => {
  try {
    const { episode_bundle_id, transaction_id, product_id, receipt, source } = req.body;
    
    // Validate required fields
    if (!episode_bundle_id || !transaction_id || !product_id || !receipt || !source) {
      return res.status(400).json({ error: 'episode_bundle_id, transaction_id, product_id, receipt, and source are required' });
    }

    // Check for mandatory x-device-id header
    const deviceId = req.headers['x-device-id'];
    if (!deviceId) {
      return res.status(400).json({ error: 'x-device-id header is required' });
    }

    // Find user by device_id
    const user = await User.findOne({ where: { device_id: deviceId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found for provided device_id' });
    }

    // Get episode bundle record
    const episodeBundle = await models.EpisodeBundlePrice.findByPk(episode_bundle_id);
    if (!episodeBundle) {
      return res.status(404).json({ error: 'Episode bundle not found' });
    }

    let result = {};

    // Check if product name contains "Package"
    if (episodeBundle.productName && episodeBundle.productName.toLowerCase().includes('package')) {
      // Handle subscription package - add months to current date
      const currentDate = getLocalTime();
      let endDate = new Date(currentDate);
      
      // Add bundle_count months to current date
      if (episodeBundle.bundle_count) {
        endDate.setMonth(endDate.getMonth() + episodeBundle.bundle_count);
      }

      // Update user subscription dates
      await user.update({
        start_date: currentDate,
        end_date: endDate,
        updated_at: getLocalTime()
      });

      // Create reward transaction record for subscription package
      const rewardTransaction = await RewardTransaction.create({
        user_id: user.id,
        type: 'payment_earn',
        points: episodeBundle.bundle_count || 0,
        episode_bundle_id: episode_bundle_id,
        product_id: product_id,
        transaction_id: transaction_id,
        receipt: receipt,
        source: source,
        task_name:episodeBundle.bundle_name,
        created_at: getLocalTime()
      });

      result = {
        type: 'subscription',
        start_date: currentDate,
        end_date: endDate,
        lock: false,
        bundle_count: episodeBundle.bundle_count,
        message: 'Subscription extended successfully',
        transaction: rewardTransaction
      };
    } else {
      // Handle reward points - add bundle_count to current reward balance
      const pointsToAdd = episodeBundle.bundle_count || 0;
      const newBalance = (user.current_reward_balance || 0) + pointsToAdd;
      
      // Update user's reward balance
      await user.update({
        current_reward_balance: newBalance,
        updated_at: getLocalTime()
      });

      // Create reward transaction record
      const rewardTransaction = await RewardTransaction.create({
        user_id: user.id,
        type: 'payment_earn',
        points: pointsToAdd,
        episode_bundle_id: episode_bundle_id,
        product_id: product_id,
        transaction_id: transaction_id,
        receipt: receipt,
        source: source,
        task_name:episodeBundle.bundle_name,
        created_at: getLocalTime()
      });

      result = {
        type: 'reward_points',
        points_added: pointsToAdd,
        new_balance: newBalance,
        transaction: rewardTransaction,
        message: 'Reward points added successfully'
      };
    }

    // Invalidate user session cache
    try {
      const { apiCache } = await import('../config/redis.js');
      await apiCache.invalidateUserSession(deviceId);
      await apiCache.invalidateUserTransactionsCache(deviceId);
      console.log('🗑️ User caches invalidated due to episode bundle purchase');
    } catch (cacheError) {
      console.error('Cache invalidation error:', cacheError);
    }

    res.json({
      success: true,
      user_id: user.id,
      episode_bundle: {
        id: episodeBundle.id,
        bundle_name: episodeBundle.bundle_name,
        product_name: episodeBundle.productName,
        bundle_count: episodeBundle.bundle_count
      },
      ...result
    });

  } catch (error) {
    console.error('Episode bundle purchase error:', error);
    res.status(500).json({ error: error.message || 'Failed to process episode bundle purchase' });
  }
});

export default router; 