import express from 'express';
import { sequelize } from './models/index.js';
import videoRoutes from './routes/videoRoutes.js';
import authRoutes from './routes/authRoutes.js';
//import config from './config/index.js';
import rewardTaskRoutes from './routes/rewardTaskRoutes.js';
import miscRoutes from './routes/miscRoutes.js';
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
//app.use('/api', adminRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Database sync and server start
const PORT = process.env.PORT || 8080;

// Only create tables if they do not exist (no force, no alter)
sequelize.sync()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log('Database synced successfully');
    });
  })
  .catch(err => {
    console.error('Unable to sync database:', err);
  });

export default app;