import express from 'express';
import models from '../models/index.js';
import userContext from '../middlewares/userContext.js';
import { Op } from 'sequelize';

const { RewardTask, RewardTransaction, User} = models;
const router = express.Router();

// GET /api/reward-tasks/reward-tasks - List all active tasks, filter 'login' for registered users
router.get('/reward-tasks', userContext, async (req, res) => {
  try {
    let where = { is_active: true };
    if (req.user && req.user.login_type !== 'guest') {
      // Exclude login task for registered users
      where.type = { [Op.ne]: 'login' };
        }
    // For guests, show all tasks
    const tasks = await RewardTask.findAll({ where });
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch tasks' });
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