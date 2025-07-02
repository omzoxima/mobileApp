import express from 'express';
import { Op } from 'sequelize';
import models from '../models/index.js';
import userContext from '../middlewares/userContext.js';
import { v4 as uuidv4 } from 'uuid';

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

// GET /api/profile
router.get('/profile', userContext, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    res.json(req.user);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to get profile' });
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

export default router; 