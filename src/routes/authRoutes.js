import express from 'express';
import jwt from 'jsonwebtoken';
import models from '../models/index.js';
import fetch from 'node-fetch';

const { User, RewardTransaction } = models;
const router = express.Router();

// Helper: Generate JWT
function generateJwt(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// Helper: Get user details from provider
async function getUserFromProvider(provider, token) {
  if (provider === 'google') {
    // Google: verify token
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    const data = await res.json();
    if (!data.sub) throw new Error('Invalid Google token');
    return {
      providerId: data.sub,
      email: data.email,
      name: data.name,
      providerField: 'google_id',
    };
  } else if (provider === 'facebook') {
    // Facebook: verify token
    const res = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${token}`);
    const data = await res.json();
    if (!data.id) throw new Error('Invalid Facebook token');
    return {
      providerId: data.id,
      email: data.email,
      name: data.name,
      providerField: 'facebook_id',
    };
  } else if (provider === 'apple') {
    // Apple: decode JWT (no signature verification here)
    const [header, payload] = token.split('.');
    if (!payload) throw new Error('Invalid Apple token');
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (!decoded.sub) throw new Error('Invalid Apple token');
    return {
      providerId: decoded.sub,
      email: decoded.email,
      name: decoded.name || '',
      providerField: 'apple_id',
    };
  }
  throw new Error('Unsupported provider');
}

// Route 1: Social Login
router.post('/social-login', async (req, res) => {
  const { provider, token, deviceId } = req.body;
  if (!provider || !token) return res.status(400).json({ error: 'provider and token are required' });
  try {
    const { providerId, email, name, providerField } = await getUserFromProvider(provider, token);
    let user;
    if (deviceId) {
      user = await User.findOne({ where: { device_id: deviceId } });
      if (user) {
        // Update user with provider info
        user[providerField] = providerId;
        if (email) user.phone_or_email = email;
        if (name) user.Name = name;
        user.login_type = provider;
        user.is_active = true;
        await user.save();
      }
    }
    if (!user) {
      // Find by provider id
      let where = {};
      where[providerField] = providerId;
      user = await User.findOne({ where });
      if (!user) {
        user = await User.create({
          [providerField]: providerId,
          phone_or_email: email || '',
          Name: name || 'Guest User',
          login_type: provider,
          is_active: true,
          current_reward_balance: 0,
          device_id: deviceId || null
        });
      }
    }
    const jwtToken = generateJwt(user);
    // Award login reward points only if not already given
    const RewardTask = models.RewardTask || models.rewardTask;
    if (RewardTask) {
      const loginReward = await RewardTask.findOne({ where: { type: 'login' } });
      if (loginReward && loginReward.points) {
        // Check if reward already given
        const alreadyGiven = await RewardTransaction.findOne({
          where: { user_id: user.id, type: 'login' ,task_id: loginReward.id}
        });
        if (!alreadyGiven) {
          user.current_reward_balance += loginReward.points;
          await user.save();
          await RewardTransaction.create({
            user_id: user.id,
            type: 'login',
            points: loginReward.points,
            created_at: new Date(),
            task_id:loginReward.id
          });
        }
      }
    }
    
    // Invalidate user caches after login
    try {
      const { apiCache } = await import('../config/redis.js');
      if (deviceId) {
        await apiCache.invalidateUserSession(deviceId);
        await apiCache.invalidateUserProfileCache(deviceId);
        console.log('🗑️ User caches invalidated due to social login');
      }
    } catch (cacheError) {
      console.error('Cache invalidation error:', cacheError);
    }
    
    res.json({ token: jwtToken, user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Route 2: Reward Transaction
router.post('/reward-transaction', async (req, res) => {
  // Check for JWT or device_id in headers
  const authHeader = req.headers['authorization'];
  const deviceId = req.headers['x-device-id'];
  let user = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findByPk(decoded.userId);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid JWT token' });
    }
  } else if (deviceId) {
    user = await User.findOne({ where: { device_id: deviceId } });
    if (!user) return res.status(401).json({ error: 'Invalid device_id' });
  } else {
    return res.status(401).json({ error: 'Authorization required (JWT or device_id)' });
  }

  const { paymentType, episodeCount, startTime, endTime } = req.body;
  if (!paymentType) return res.status(400).json({ error: 'paymentType is required' });

  try {
    let transaction;
    if (paymentType === 'bundle') {
      if (!episodeCount) return res.status(400).json({ error: 'episodeCount is required for bundle paymentType' });
      // Example: 10 points per episode
      const points = episodeCount;
              user.current_reward_balance += points;
        await user.save();
        transaction = await RewardTransaction.create({
          user_id: user.id,
          type: 'earn',
          points,
          created_at: new Date()
        });
        
        // Invalidate user caches after reward transaction
        try {
          const { apiCache } = await import('../config/redis.js');
          if (deviceId) {
            await apiCache.invalidateUserSession(deviceId);
            await apiCache.invalidateUserProfileCache(deviceId);
            console.log('🗑️ User caches invalidated due to reward transaction');
          }
        } catch (cacheError) {
          console.error('Cache invalidation error:', cacheError);
        }
        
        res.json({
          Name: user.Name,
          start_date: user.start_date,
          end_date: user.end_date,
          points: user.current_reward_balance,
          login_type: user.login_type,
          transaction
        });
    } else if (paymentType === 'monthly') {
      if (!startTime || !endTime) return res.status(400).json({ error: 'startTime and endTime are required for monthly paymentType' });
      const start = new Date(startTime);
      const end = new Date(endTime);
              user.start_date = start;
        user.end_date = end;
        await user.save();
        transaction = await RewardTransaction.create({
          user_id: user.id,
          type: 'spend',
          points: 0,
          created_at: new Date()
        });
        
        // Invalidate user caches after monthly payment
        try {
          const { apiCache } = await import('../config/redis.js');
          if (deviceId) {
            await apiCache.invalidateUserSession(deviceId);
            await apiCache.invalidateUserProfileCache(deviceId);
            console.log('🗑️ User caches invalidated due to monthly payment');
          }
        } catch (cacheError) {
          console.error('Cache invalidation error:', cacheError);
        }
        
        res.json({
          Name: user.Name,
          start_date: user.start_date,
          end_date: user.end_date,
          points: user.current_reward_balance,
          login_type: user.login_type,
          transaction
        });
    } else {
      return res.status(400).json({ error: 'Invalid paymentType' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route 3: Verify JWT and get user details
router.post('/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
