import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  db: 0,
  connectTimeout: 10000,
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
  // Google Cloud Redis specific settings
  retryDelayOnFailover: 100,
  lazyConnect: true,
  // No password needed for VPC network
  // password: process.env.REDIS_PASSWORD, // Commented out for Google Cloud
  // SSL not needed for VPC network
  // tls: process.env.REDIS_SSL === 'true' ? {} : undefined
};

// Create Redis client
const redis = new Redis(redisConfig);

// Redis connection events
redis.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redis.on('ready', () => {
  console.log('🚀 Redis is ready to accept commands');
});

redis.on('error', (error) => {
  console.error('❌ Redis connection error:', error);
});

redis.on('close', () => {
  console.log('🔌 Redis connection closed');
});

redis.on('reconnecting', () => {
  console.log('🔄 Redis reconnecting...');
});

// Redis health check function
export const checkRedisHealth = async () => {
  try {
    const pingResult = await redis.ping();
    if (pingResult === 'PONG') {
      console.log('✅ Redis health check: PASSED');
      return true;
    } else {
      console.log('❌ Redis health check: FAILED');
      return false;
    }
  } catch (error) {
    console.error('❌ Redis health check error:', error);
    return false;
  }
};

// Redis utility functions
export const redisUtils = {
  // Cache with TTL
  async setWithTTL(key, value, ttl = 3600) {
    try {
      await redis.setex(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('Redis SET error:', error);
      return false;
    }
  },

  // Get cached data
  async get(key) {
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis GET error:', error);
      return null;
    }
  },

  // Delete cache
  async del(key) {
    try {
      await redis.del(key);
      return true;
    } catch (error) {
      console.error('Redis DEL error:', error);
      return false;
    }
  },

  // Set hash
  async hset(key, field, value) {
    try {
      await redis.hset(key, field, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('Redis HSET error:', error);
      return false;
    }
  },

  // Get hash field
  async hget(key, field) {
    try {
      const data = await redis.hget(key, field);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis HGET error:', error);
      return null;
    }
  },

  // Increment counter
  async incr(key) {
    try {
      return await redis.incr(key);
    } catch (error) {
      console.error('Redis INCR error:', error);
      return null;
    }
  },

  // Set with expiration
  async setex(key, seconds, value) {
    try {
      await redis.setex(key, seconds, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('Redis SETEX error:', error);
      return false;
    }
  },

  // Check if key exists
  async exists(key) {
    try {
      return await redis.exists(key);
    } catch (error) {
      console.error('Redis EXISTS error:', error);
      return false;
    }
  },

  // Get all keys matching pattern
  async keys(pattern) {
    try {
      return await redis.keys(pattern);
    } catch (error) {
      console.error('Redis KEYS error:', error);
      return [];
    }
  },

  // Flush all data (use with caution)
  async flushall() {
    try {
      await redis.flushall();
      return true;
    } catch (error) {
      console.error('Redis FLUSHALL error:', error);
      return false;
    }
  }
};

// Rate limiting with Redis
export const rateLimiter = {
  async checkLimit(key, limit, window) {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, window);
    }
    return current <= limit;
  },

  async getRemaining(key) {
    const current = await redis.get(key);
    return current ? parseInt(current) : 0;
  }
};

// Session management with Redis
export const sessionManager = {
  async setSession(sessionId, data, ttl = 86400) {
    return await redisUtils.setWithTTL(`session:${sessionId}`, data, ttl);
  },

  async getSession(sessionId) {
    return await redisUtils.get(`session:${sessionId}`);
  },

  async deleteSession(sessionId) {
    return await redisUtils.del(`session:${sessionId}`);
  }
};

// Cache middleware for Express
export const cacheMiddleware = (ttl = 300) => {
  return async (req, res, next) => {
    const key = `cache:${req.method}:${req.originalUrl}`;
    
    try {
      const cached = await redisUtils.get(key);
      if (cached) {
        return res.json(cached);
      }
      
      // Store original send method
      const originalSend = res.json;
      
      // Override send method to cache response
      res.json = function(data) {
        redisUtils.setWithTTL(key, data, ttl);
        return originalSend.call(this, data);
      };
      
      next();
    } catch (error) {
      console.error('Cache middleware error:', error);
      next();
    }
  };
};

// API-specific caching utilities
export const apiCache = {
  // Cache TTL configuration - all data cached for 2 hours
  TTL: {
    SERIES: 7200,        // 2 hours (series data + thumbnail/carousel URLs)
    WISHLIST: 7200,      // 2 hours (user preferences)
    BUNDLE_PRICES: 7200, // 2 hours (pricing data)
    USER_SESSIONS: 7200, // 2 hours (device-based sessions)
    EPISODES: 7200       // 2 hours (episode data)
  },

  // Series caching
  async getSeriesCache(page, limit, category) {
    const key = `series:${page}:${limit}:${category || 'all'}`;
    return await redisUtils.get(key);
  },

  async setSeriesCache(page, limit, category, data) {
    const key = `series:${page}:${limit}:${category || 'all'}`;
    return await redisUtils.setex(key, apiCache.TTL.SERIES, data);
  },

  // Series cache with URL refresh capability
  async getSeriesCacheWithUrlRefresh(page, limit, category) {
    const key = `series:${page}:${limit}:${category || 'all'}`;
    const cachedData = await redisUtils.get(key);
    
    if (cachedData) {
      // Check if URLs need refresh (expired or about to expire)
      const needsRefresh = this.checkUrlsNeedRefresh(cachedData);
      if (needsRefresh) {
        console.log('🔄 URLs need refresh, regenerating signed URLs');
        // Return cached data but mark for background refresh
        return { ...cachedData, _needsUrlRefresh: true };
      }
      return cachedData;
    }
    return null;
  },

  // Check if URLs in cached data need refresh
  checkUrlsNeedRefresh(cachedData) {
    if (!cachedData || !cachedData.series) return false;
    
    const now = Date.now();
    const urlExpiryBuffer = 5 * 60 * 1000; // 5 minutes buffer
    
    for (const series of cachedData.series) {
      if (series.thumbnail_url || series.carousel_image_url) {
        // Check if URLs are about to expire (within 5 minutes)
        if (this.isUrlExpiringSoon(series.thumbnail_url, urlExpiryBuffer) ||
            this.isUrlExpiringSoon(series.carousel_image_url, urlExpiryBuffer)) {
          return true;
        }
      }
    }
    return false;
  },

  // Check if a URL is expiring soon
  isUrlExpiringSoon(url, bufferMs) {
    if (!url) return false;
    
    try {
      // Extract expiry from signed URL
      const urlObj = new URL(url);
      const expiresParam = urlObj.searchParams.get('Expires');
      
      if (expiresParam) {
        const expiryTime = parseInt(expiresParam) * 1000; // Convert to milliseconds
        const timeUntilExpiry = expiryTime - Date.now();
        return timeUntilExpiry <= bufferMs;
      }
    } catch (error) {
      console.error('Error parsing URL expiry:', error);
    }
    return false;
  },

  async invalidateSeriesCache() {
    const keys = await redisUtils.keys('series:*');
    for (const key of keys) {
      await redisUtils.del(key);
    }
  },

  // Wishlist caching
  async getWishlistCache(userId, seriesId) {
    const key = `wishlist:${userId}:${seriesId}`;
    return await redisUtils.get(key);
  },

  async setWishlistCache(userId, seriesId, data) {
    const key = `wishlist:${userId}:${seriesId}`;
    return await redisUtils.setex(key, apiCache.TTL.WISHLIST, data);
  },

  async getUserWishlistSummaryCache(userId) {
    const key = `wishlist:summary:${userId}`;
    return await redisUtils.get(key);
  },

  async setUserWishlistSummaryCache(userId, data) {
    const key = `wishlist:summary:${userId}`;
    return await redisUtils.setex(key, apiCache.TTL.WISHLIST, data);
  },

  async invalidateUserWishlistCache(userId) {
    const keys = await redisUtils.keys(`wishlist:${userId}:*`);
    for (const key of keys) {
      await redisUtils.del(key);
    }
    await redisUtils.del(`wishlist:summary:${userId}`);
  },

  // Bundle prices caching
  async getBundleCache(platform) {
    const key = `bundles:${platform || 'all'}`;
    return await redisUtils.get(key);
  },

  async setBundleCache(platform, data) {
    const key = `bundles:${platform || 'all'}`;
    return await redisUtils.setex(key, apiCache.TTL.BUNDLE_PRICES, data);
  },

  async invalidateBundleCache() {
    const keys = await redisUtils.keys('bundles:*');
    for (const key of keys) {
      await redisUtils.del(key);
    }
  },

  // User session management (device-based, 2 hours)
  async setUserSession(deviceId, userData) {
    const key = `session:${deviceId}`;
    return await redisUtils.setex(key, apiCache.TTL.USER_SESSIONS, userData);
  },

  async getUserSession(deviceId) {
    const key = `session:${deviceId}`;
    return await redisUtils.get(key);
  },

  async invalidateUserSession(deviceId) {
    const key = `session:${deviceId}`;
    return await redisUtils.del(key);
  },

  // Note: Thumbnail and carousel URLs are now generated once and cached with series data
  // No separate caching needed since they're part of the series cache (2 hours)

  // Episode caching (with immediate invalidation for updates)
  async getEpisodeCache(episodeId) {
    const key = `episode:${episodeId}`;
    return await redisUtils.get(key);
  },

  async setEpisodeCache(episodeId, data) {
    const key = `episode:${episodeId}`;
    return await redisUtils.setex(key, apiCache.TTL.EPISODES, data);
  },

  async invalidateEpisodeCache(episodeId) {
    const key = `episode:${episodeId}`;
    return await redisUtils.del(key);
  },

  // User profile caching
  async getUserProfileCache(deviceId) {
    const key = `profile:${deviceId}`;
    return await redisUtils.get(key);
  },

  async setUserProfileCache(deviceId, data) {
    const key = `profile:${deviceId}`;
    return await redisUtils.setex(key, apiCache.TTL.USER_SESSIONS, data);
  },

  async invalidateUserProfileCache(deviceId) {
    const key = `profile:${deviceId}`;
    return await redisUtils.del(key);
  },

  // Search results caching
  async getSearchCache(query) {
    const key = `search:${Buffer.from(query).toString('base64')}`;
    return await redisUtils.get(key);
  },

  async setSearchCache(query, data) {
    const key = `search:${Buffer.from(query).toString('base64')}`;
    return await redisUtils.setex(key, apiCache.TTL.SERIES, data);
  },

  async invalidateSearchCache() {
    const keys = await redisUtils.keys('search:*');
    for (const key of keys) {
      await redisUtils.del(key);
    }
  },

  // Wishlist series episodes caching
  async getWishlistSeriesCache(userId) {
    const key = `wishlist_series:${userId}`;
    return await redisUtils.get(key);
  },

  async setWishlistSeriesCache(userId, data) {
    const key = `wishlist_series:${userId}`;
    return await redisUtils.setex(key, apiCache.TTL.WISHLIST, data);
  },

  async invalidateWishlistSeriesCache(userId) {
    const key = `wishlist_series:${userId}`;
    return await redisUtils.del(key);
  },

  // Static content caching
  async getStaticContentCache(type) {
    const key = `static:${type}`;
    return await redisUtils.get(key);
  },

  async setStaticContentCache(type, data) {
    const key = `static:${type}`;
    return await redisUtils.setex(key, apiCache.TTL.SERIES, data);
  },

  async invalidateStaticContentCache(type) {
    const key = `static:${type}`;
    return await redisUtils.del(key);
  },

  // Reward tasks caching
  async getRewardTasksCache() {
    const key = 'reward_tasks:all';
    return await redisUtils.get(key);
  },

  async setRewardTasksCache(data) {
    const key = 'reward_tasks:all';
    return await redisUtils.setex(key, apiCache.TTL.WISHLIST, data);
  },

  async invalidateRewardTasksCache() {
    const key = 'reward_tasks:all';
    return await redisUtils.del(key);
  },

  // User transactions caching
  async getUserTransactionsCache(deviceId) {
    const key = `transactions:${deviceId}`;
    return await redisUtils.get(key);
  },

  async setUserTransactionsCache(deviceId, data) {
    const key = `transactions:${deviceId}`;
    return await redisUtils.setex(key, apiCache.TTL.USER_SESSIONS, data);
  },

  async invalidateUserTransactionsCache(deviceId) {
    const key = `transactions:${deviceId}`;
    return await redisUtils.del(key);
  },

  // Episode access caching
  async getEpisodeAccessCache(userId, seriesId) {
    const key = `access:${userId}:${seriesId}`;
    return await redisUtils.get(key);
  },

  async setEpisodeAccessCache(userId, seriesId, data) {
    const key = `access:${userId}:${seriesId}`;
    return await redisUtils.setex(key, apiCache.TTL.USER_SESSIONS, data);
  },

  async invalidateEpisodeAccessCache(userId, seriesId) {
    const key = `access:${userId}:${seriesId}`;
    return await redisUtils.del(key);
  },

  // Invalidate all user-related caches when user data changes
  async invalidateAllUserCaches(userId, deviceId) {
    // Invalidate user session
    if (deviceId) {
      await this.invalidateUserSession(deviceId);
      await this.invalidateUserProfileCache(deviceId);
      await this.invalidateUserTransactionsCache(deviceId);
    }
    
    // Invalidate wishlist caches
    await this.invalidateUserWishlistCache(userId);
    await this.invalidateWishlistSeriesCache(userId);
    
    // Invalidate episode access caches for this user
    const accessKeys = await redisUtils.keys(`access:${userId}:*`);
    for (const key of accessKeys) {
      await redisUtils.del(key);
    }
  },

  // Invalidate all series-related caches when series data changes
  async invalidateAllSeriesCaches(seriesId) {
    // Invalidate series cache
    await this.invalidateSeriesCache();
    
    // Invalidate episodes cache for this series
    const episodeKeys = await redisUtils.keys(`episode:*`);
    for (const key of episodeKeys) {
      await redisUtils.del(key);
    }
    
    // Invalidate search cache
    await this.invalidateSearchCache();
    
    // Invalidate wishlist caches that might contain this series
    const wishlistKeys = await redisUtils.keys('wishlist:*');
    for (const key of wishlistKeys) {
      await redisUtils.del(key);
    }
  },

  // Cache warming utilities
  async warmSeriesCache() {
    try {
      console.log('🔥 Warming series cache...');
    } catch (error) {
      console.error('Cache warming error:', error);
    }
  },

  async warmBundleCache() {
    try {
      console.log('🔥 Warming bundle cache...');
    } catch (error) {
      console.error('Cache warming error:', error);
    }
  },

  // Scheduled URL refresh utilities
  async scheduleUrlRefresh() {
    try {
      // Check for URLs that need refresh every 30 minutes
      setInterval(async () => {
        await this.refreshExpiringUrls();
      }, 30 * 60 * 1000); // 30 minutes
      
      console.log('⏰ URL refresh scheduler started (every 30 minutes)');
    } catch (error) {
      console.error('URL refresh scheduler error:', error);
    }
  },

  async refreshExpiringUrls() {
    try {
      console.log('🔄 Checking for URLs that need refresh...');
      
      // Get all series cache keys
      const seriesKeys = await redisUtils.keys('series:*');
      let refreshedCount = 0;
      
      for (const key of seriesKeys) {
        const cachedData = await redisUtils.get(key);
        if (cachedData && this.checkUrlsNeedRefresh(cachedData)) {
          // Extract parameters from key
          const keyParts = key.split(':');
          if (keyParts.length >= 3) {
            const page = parseInt(keyParts[1]) || 1;
            const limit = parseInt(keyParts[2]) || 10;
            const category = keyParts[3] || null;
            
            // Trigger background refresh
            setImmediate(async () => {
              try {
                // Import the refresh function dynamically
                const { refreshSeriesUrlsInCache } = await import('../routes/videoRoutes.js');
                await refreshSeriesUrlsInCache(page, limit, category);
                console.log(`✅ Scheduled refresh completed for ${key}`);
              } catch (error) {
                console.error(`❌ Scheduled refresh failed for ${key}:`, error);
              }
            });
            
            refreshedCount++;
          }
        }
      }
      
      if (refreshedCount > 0) {
        console.log(`🔄 Scheduled refresh initiated for ${refreshedCount} cache entries`);
      }
      
    } catch (error) {
      console.error('Scheduled URL refresh error:', error);
    }
  }
};

export default redis; 