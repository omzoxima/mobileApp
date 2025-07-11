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
    // Filter out one_time tasks already claimed
    const availableTasks = tasks.filter(t => !(t.repeat_type === 'one_time' && claimedIds.has(t.id)));
    // Add lock status
    const today = new Date();
    const result = availableTasks.map(task => ({
      id: task.id,
      name: task.name,
      description: task.description,
      points: task.points,
      type: task.type,
      trigger: task.trigger,
      repeat_type: task.repeat_type,
      unlock_value: task.unlock_value,
      max_count: task.max_count,
      lock: (task.start_date && task.end_date)
        ? !(today >= task.start_date && today <= task.end_date)
        : true
    }));
    res.json(result);
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
      points: task.points
    });

    res.status(201).json({ message: 'Task completed, points awarded', transaction, new_balance });
  } catch (error) {
    console.error('Error completing reward task:', error);
    res.status(500).json({ error: error.message || 'Failed to complete reward task' });
  }
});

export default router; 