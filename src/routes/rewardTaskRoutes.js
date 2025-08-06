import express from 'express';
import models from '../models/index.js';
import userContext from '../middlewares/userContext.js';
import { Op } from 'sequelize';

const { RewardTask, RewardTransaction, User} = models;
const router = express.Router();

// Optimized /reward_task route
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

    // Get all active reward tasks
    const tasks = await RewardTask.findAll({ where: { is_active: true } });

    // Get all user's reward transactions for one_time tasks
    const oneTimeTaskIds = tasks.filter(t => t.repeat_type === 'one_time').map(t => t.id);
    const claimed = await RewardTransaction.findAll({
      where: { user_id: user.id, task_id: { [Op.in]: oneTimeTaskIds } }
    });
    const claimedIds = new Set(claimed.map(r => r.task_id));
   //console.log(claimedIds);
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

    // Filter out one_time tasks already claimed
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
    // Combine claimed one-time and completed streak task IDs for completed_streak_task_ids
    const allCompletedTaskIds = Array.from(new Set([
      ...Array.from(claimedIds),
      ...completedStreakTaskIds
    ]));
    res.json({
      tasks: result,
      completed_streak_task_ids: allCompletedTaskIds
    });
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
      const [guestUser] = await User.findOrCreate({
        where: { device_id: req.guestDeviceId, login_type: 'guest' },
        defaults: { current_reward_balance: 0, is_active: true, login_type: 'guest' }
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
      created_at: new Date(),
      updated_at: new Date()
    });

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

    const today = new Date();
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
      user.updated_at = new Date();
      streakIncreased = true;
    } else {
      user.current_streak = 1;
      user.last_streak_date = today;
      user.updated_at = new Date();
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
          created_at: new Date(),
          updated_at: new Date()
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
          created_at: new Date(),
          updated_at: new Date()
        });
        user.current_reward_balance += dailyWatchTask.points;
        await user.save();
        dailyWatchPointAwarded = true;
      } 
    }
    // --- End daily watch reward logic ---

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
    const transactionsWithTask = transactions.map(t => ({
      ...t.toJSON(),
      task_name: t.task_id ? (taskMap[t.task_id] || null) : null
    }));

    // Get all episode access records for the user with sorting by created_at descending
    const episodeAccessRecords = await models.EpisodeUserAccess.findAll({
      where: { user_id: user.id },
      attributes: ['episode_id', 'created_at'],
      order: [['created_at', 'DESC']]
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
    // Generate signed URLs for each unique series only once
    const { getSignedUrl } = await import('../services/gcsStorage.js');
    const seriesSignedUrlMap = {};
    for (const s of seriesList) {
      if (s.thumbnail_url) {
        seriesSignedUrlMap[s.id] = await getSignedUrl(s.thumbnail_url, 60 * 24 * 7);
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
        created_at: e.created_at
      };
    });

    res.json({
      transactions: transactionsWithTask,
      episode_access: episodeAccess
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /episode-bundle-purchase
router.post('/episode-bundle-purchase', async (req, res) => {
  try {
    const { episode_bundle_id } = req.body;
    const deviceId = req.headers['x-device-id'];
    
    // Validate required parameters
    if (!deviceId) {
      return res.status(400).json({ error: 'x-device-id header is mandatory' });
    }
    
    if (!episode_bundle_id) {
      return res.status(400).json({ error: 'episode_bundle_id is required' });
    }

    // Find user by device_id
    const user = await User.findOne({ where: { device_id: deviceId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found for provided device_id' });
    }

    // Find episode bundle
    const { EpisodeBundlePrice } = models;
    const episodeBundle = await EpisodeBundlePrice.findByPk(episode_bundle_id);
    if (!episodeBundle) {
      return res.status(404).json({ error: 'Episode bundle not found' });
    }

    const currentTime = new Date();
    let transactionData = {
      user_id: user.id,
      episode_bundle_id: episode_bundle_id,
      type: 'payment_earn',
      points: 0,
      created_at: currentTime,
      updated_at: currentTime
    };

    // Check if bundle is subscription type (has start_date and end_date logic)
    if (episodeBundle.productName && episodeBundle.productName.includes('Package')) {
      // Handle subscription - update user start_time and end_time
      const startTime = new Date();
      const endTime = new Date();
      // Use bundle_count as number of months for subscription duration
      const subscriptionMonths = episodeBundle.bundle_count || 1; // Default to 1 month if not specified
      endTime.setMonth(endTime.getMonth() + subscriptionMonths);
      
      user.start_date = startTime;
      user.end_date = endTime;
      user.updated_at = currentTime;
      await user.save();
      
      transactionData.points = 0; // No points for subscription
    } else {
      // Handle episode count bundle - add points to user
      const pointsToAdd = episodeBundle.bundle_count || 0;
      user.current_reward_balance += pointsToAdd;
      user.updated_at = currentTime;
      await user.save();
      
      transactionData.points = pointsToAdd;
    }

    // Create reward transaction record
    const transaction = await RewardTransaction.create(transactionData);

    res.json({
      success: true,
      message: 'Episode bundle purchase successful',
      user: {
        id: user.id,
        current_reward_balance: user.current_reward_balance,
        start_date: user.start_date,
        end_date: user.end_date
      },
      episode_bundle: {
        id: episodeBundle.id,
        bundle_name: episodeBundle.bundle_name,
        bundle_count: episodeBundle.bundle_count,
        price_points: episodeBundle.price_points
      },
      transaction: {
        id: transaction.id,
        type: transaction.type,
        points: transaction.points,
        created_at: transaction.created_at
      }
    });

  } catch (error) {
    console.error('Episode bundle purchase error:', error);
    res.status(500).json({ error: error.message || 'Failed to process episode bundle purchase' });
  }
});

export default router; 