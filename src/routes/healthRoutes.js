import express from 'express';
import { sequelize } from '../models/index.js';

const router = express.Router();

// Health check endpoint
router.get('/health', async (req, res) => {
  try {
    // Check database connection
    await sequelize.authenticate();
    
    // Check Redis connection
    let redisStatus = 'unknown';
    try {
      const { checkRedisHealth } = await import('../config/redis.js');
      redisStatus = await checkRedisHealth();
    } catch (error) {
      redisStatus = 'error';
    }

    // Get server info
    const serverInfo = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      database: 'connected',
      redis: redisStatus,
      environment: process.env.NODE_ENV || 'development',
      version: process.version,
      platform: process.platform,
      arch: process.arch
    };

    res.status(200).json(serverInfo);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      database: 'disconnected'
    });
  }
});

// Detailed health check
router.get('/health/detailed', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Database health check
    const dbStart = Date.now();
    await sequelize.authenticate();
    const dbResponseTime = Date.now() - dbStart;
    
    // Redis health check
    let redisResponseTime = 0;
    let redisStatus = 'unknown';
    try {
      const { checkRedisHealth } = await import('../config/redis.js');
      const redisStart = Date.now();
      redisStatus = await checkRedisHealth();
      redisResponseTime = Date.now() - redisStart;
    } catch (error) {
      redisStatus = 'error';
    }

    // System metrics
    const systemMetrics = {
      cpu: process.cpuUsage(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      pid: process.pid,
      title: process.title,
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      node_env: process.env.NODE_ENV || 'development'
    };

    const totalResponseTime = Date.now() - startTime;
    
    const detailedHealth = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      responseTime: totalResponseTime,
      services: {
        database: {
          status: 'connected',
          responseTime: dbResponseTime
        },
        redis: {
          status: redisStatus,
          responseTime: redisResponseTime
        }
      },
      system: systemMetrics
    };

    res.status(200).json(detailedHealth);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      responseTime: Date.now() - Date.now()
    });
  }
});

// Load test endpoint (for testing purposes)
router.post('/health/load-test', async (req, res) => {
  try {
    const { action, data } = req.body;
    
    switch (action) {
      case 'ping':
        res.json({ 
          status: 'success', 
          message: 'pong', 
          timestamp: new Date().toISOString(),
          data: data || null
        });
        break;
        
      case 'echo':
        res.json({ 
          status: 'success', 
          message: 'echo response', 
          timestamp: new Date().toISOString(),
          receivedData: data,
          echo: data
        });
        break;
        
      default:
        res.status(400).json({ 
          status: 'error', 
          message: 'Invalid action. Use "ping" or "echo"' 
        });
    }
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

export default router;
