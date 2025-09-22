import express from 'express';
import { sequelize } from './models/index.js';
import videoRoutes from './routes/videoRoutes.js';
import authRoutes from './routes/authRoutes.js';
//import config from './config/index.js';
import rewardTaskRoutes from './routes/rewardTaskRoutes.js';
import miscRoutes from './routes/miscRoutes.js';
import smsRoutes from './routes/smsRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
//import adminRoutes from './routes/adminRoutes.js'//import dummyRoutes from './routes/dummy.js';
import cors from 'cors';

const app = express();
app.use(cors());  
// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Routes
app.use('/api', videoRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/task', rewardTaskRoutes);
app.use('/api', miscRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api', paymentRoutes);
//app.use('/api', adminRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Database connection check and server start
const PORT = process.env.PORT || 8080;

// Check both database and Redis connections
Promise.all([
  sequelize.authenticate(),
  import('./config/redis.js').then(redisModule => {
    console.log('📦 Redis module loaded successfully');
    return redisModule.checkRedisHealth();
  })
])
.then(async ([dbResult, redisResult]) => {
  console.log('✅ Database connection established successfully');
  console.log('✅ Redis connection established successfully');
  console.log('🌐 Both services are on VPC network - optimal performance');
  
  // Start URL refresh scheduler
  try {
    const redisModule = await import('./config/redis.js');
    await redisModule.apiCache.scheduleUrlRefresh();
    console.log('⏰ URL refresh scheduler started');
  } catch (error) {
    console.error('❌ Failed to start URL refresh scheduler:', error);
  }
  
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log('📊 Database and Redis connected and ready');
    console.log('⚡ Optimized caching system active (2-hour TTL)');
    console.log('🔄 Automatic URL refresh active (every 30 minutes)');
  });
})
.catch(err => {
  console.error('❌ Connection failed:', err.message);
  if (err.message.includes('Redis')) {
    console.log('🔧 Please check your Redis configuration');
  } else {
    console.log('🔧 Please check your database configuration');
  }
  process.exit(1); // Exit if connections fail
});

export default app;