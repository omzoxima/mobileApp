import jwt from 'jsonwebtoken';
import models from '../models/index.js';

export default async function userContext(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const deviceId = req.headers['x-device-id'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const user = await models.User.findByPk(payload.userId);
        if (user) {
          req.user = user;
          return next();
        }
      } catch (err) {
        // Invalid token, fall through to guest
      }
    }
    if (deviceId) {
      req.guestDeviceId = deviceId;
      return next();
    }
    // If neither, treat as guest but require deviceId
    return res.status(401).json({ error: 'Authentication required: provide JWT or x-device-id header' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to process user context' });
  }
} 