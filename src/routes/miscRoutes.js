import express from 'express';
import { Op } from 'sequelize';
import models from '../models/index.js';
import { sequelize } from '../models/index.js';
import userContext from '../middlewares/userContext.js';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

const { Series, Episode, User, StaticContent } = models;
const router = express.Router();

// GET /api/search?q=searchstring
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query string q is required' });
    const seriesResults = await Series.findAll({
      where: { title: { [Op.iLike]: `%${q}%` } },
      include: [{ model: Episode }],
      limit: 10
    });
    res.json({ series: seriesResults });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Search failed' });
  }
});

// Optimized /profile route
router.get('/profile', async (req, res) => {
  const { User, RewardTask, RewardTransaction } = models;
  let t; // Declare transaction outside try block
  
  try {
    // Initial user fetching without transaction
    let user = null;
    const deviceId = req.headers['x-device-id'];
    const authHeader = req.headers['authorization'];
    
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findByPk(payload.userId, {
        attributes: ['id', 'Name', 'device_id', 'current_reward_balance', 'start_date', 'end_date']
      });
    } else if (deviceId) {
      user = await User.findOne({
        where: { device_id: deviceId },
        attributes: ['id', 'Name', 'device_id', 'current_reward_balance', 'start_date', 'end_date']
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
        is_active: true
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
          created_at: today
        });
        pointsGranted += task.points;
      }

      // Debug log for profile, points, and tasks
      console.log('PROFILE DEBUG:', {
        user: user.toJSON(),
        pointsGranted,
        appOpenTasks: appOpenTasks.map(t => t.toJSON())
      });

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
          end_date: user.end_date
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
        end_date: user.end_date
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
    const about = await StaticContent.findOne({ where: { type: 'about_us' } });
    if (!about) return res.status(404).json({ error: 'About Us not found' });
    res.json({ content: about.content });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to get About Us' });
  }
});

// GET /api/static/privacy-policy
router.get('/static/privacy-policy', async (req, res) => {
  try {
    const policy = await StaticContent.findOne({ where: { type: 'privacy_policy' } });
    if (!policy) return res.status(404).json({ error: 'Privacy Policy not found' });
    res.json({ content: policy.content });
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
      return res.json({ records });
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
          is_locked: lock
        });
      } else {
        access.is_locked = lock;
        await access.save();
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
        await access.save();
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
          is_locked: false
        });
        return res.json({ message: 'Unlocked using points', access });
      } else {
        access = await EpisodeUserAccess.create({
          id: uuidv4(),
          episode_id,
          series_id,
          user_id,
          is_locked: true
        });
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
    if (!['like', 'share', 'subscribe'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be like, share, or subscribe.' });
    }
    // Determine target model
    let Model = null;
    if (action === 'like') Model = models.Like;
    if (action === 'share') Model = models.Share;
    if (action === 'subscribe') Model = models.Wishlist;
    // Build where clause
    const where = { };
    if (user_id) where.user_id = user_id;
    if (device_id) where.device_id = device_id;
    if (series_id) where.series_id = series_id;
    if (episode_id) where.episode_id = episode_id;
    let record;
    if (action === 'share') {
      // Allow multiple shares
      record = await Model.create({ ...where, created_at: new Date(), id: uuidv4() });
    } else {
      // Deduplicate like/subscribe
      [record] = await Model.findOrCreate({ where, defaults: { created_at: new Date(), id: uuidv4() } });
    }
    res.json({ success: true, action, record });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to process action' });
  }
});

export default router; 