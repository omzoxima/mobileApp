// Artillery processor for generating realistic test data
// This file provides functions that can be used in Artillery test scenarios

/**
 * Generate a realistic Indian mobile number
 * @returns {string} Mobile number
 */
function generateMobileNumber() {
  const prefixes = ['6', '7', '8', '9'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const remaining = Math.floor(Math.random() * 90000000) + 10000000;
  return `${prefix}${remaining}`;
}

/**
 * Generate a unique device ID
 * @returns {string} Device ID
 */
function generateDeviceId() {
  return `device_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`;
}

/**
 * Generate a random user name
 * @returns {string} User name
 */
function generateUserName() {
  const names = [
    'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Vivaan', 'Aditya', 'Vihaan',
    'Arjun', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Vivaan', 'Aditya', 'Vihaan',
    'Priya', 'Ananya', 'Diya', 'Zara', 'Aisha', 'Ananya', 'Diya', 'Zara',
    'Aisha', 'Ananya', 'Diya', 'Zara', 'Aisha', 'Ananya', 'Diya', 'Zara'
  ];
  return names[Math.floor(Math.random() * names.length)];
}

/**
 * Generate a random email
 * @returns {string} Email address
 */
function generateEmail() {
  const domains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
  const domain = domains[Math.floor(Math.random() * domains.length)];
  const username = Math.random().toString(36).substr(2, 8);
  return `${username}@${domain}`;
}

/**
 * Generate a random video category
 * @returns {string} Video category
 */
function generateVideoCategory() {
  const categories = ['action', 'comedy', 'drama', 'thriller', 'romance', 'horror', 'sci-fi'];
  return categories[Math.floor(Math.random() * categories.length)];
}

/**
 * Generate a random video title
 * @returns {string} Video title
 */
function generateVideoTitle() {
  const titles = [
    'The Lost City', 'Mystery Island', 'Golden Sunset', 'Silver Moon', 'Red Dawn',
    'Blue Ocean', 'Green Forest', 'Purple Mountain', 'Orange Sky', 'Yellow Desert',
    'Black Night', 'White Day', 'Pink Flower', 'Brown Earth', 'Gray Stone'
  ];
  return titles[Math.floor(Math.random() * titles.length)];
}

/**
 * Generate a random reward task type
 * @returns {string} Task type
 */
function generateTaskType() {
  const types = ['login', 'watch_video', 'share_video', 'like_video', 'comment_video'];
  return types[Math.floor(Math.random() * types.length)];
}

/**
 * Generate a random OTP (for testing purposes)
 * @returns {string} 6-digit OTP
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Generate a random referral code
 * @returns {string} Referral code
 */
function generateReferralCode() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

/**
 * Generate a random user agent string
 * @returns {string} User agent
 */
function generateUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 10; SM-A505FN) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

/**
 * Generate a random IP address
 * @returns {string} IP address
 */
function generateIPAddress() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

/**
 * Generate a random timestamp within the last 30 days
 * @returns {string} ISO timestamp
 */
function generateRecentTimestamp() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
  const randomTime = new Date(thirtyDaysAgo.getTime() + Math.random() * (now.getTime() - thirtyDaysAgo.getTime()));
  return randomTime.toISOString();
}

/**
 * Generate a random duration in seconds
 * @returns {number} Duration in seconds
 */
function generateDuration() {
  return Math.floor(Math.random() * 1800) + 300; // 5 minutes to 35 minutes
}

/**
 * Generate a random view count
 * @returns {number} View count
 */
function generateViewCount() {
  return Math.floor(Math.random() * 1000000) + 100;
}

/**
 * Generate a random like count
 * @returns {number} Like count
 */
function generateLikeCount() {
  return Math.floor(Math.random() * 10000) + 10;
}

/**
 * Generate a random comment count
 * @returns {number} Comment count
 */
function generateCommentCount() {
  return Math.floor(Math.random() * 1000) + 1;
}

/**
 * Generate a random reward points
 * @returns {number} Reward points
 */
function generateRewardPoints() {
  const pointValues = [5, 10, 15, 20, 25, 50, 100];
  return pointValues[Math.floor(Math.random() * pointValues.length)];
}

/**
 * Generate a random user profile data
 * @returns {object} User profile data
 */
function generateUserProfile() {
  return {
    name: generateUserName(),
    email: generateEmail(),
    mobile: generateMobileNumber(),
    device_id: generateDeviceId(),
    referral_code: generateReferralCode(),
    user_agent: generateUserAgent(),
    ip_address: generateIPAddress(),
    created_at: generateRecentTimestamp(),
    updated_at: generateRecentTimestamp()
  };
}

/**
 * Generate a random video data
 * @returns {object} Video data
 */
function generateVideoData() {
  return {
    title: generateVideoTitle(),
    category: generateVideoCategory(),
    duration: generateDuration(),
    view_count: generateViewCount(),
    like_count: generateLikeCount(),
    comment_count: generateCommentCount(),
    created_at: generateRecentTimestamp(),
    updated_at: generateRecentTimestamp()
  };
}

/**
 * Generate a random reward task data
 * @returns {object} Reward task data
 */
function generateRewardTaskData() {
  return {
    type: generateTaskType(),
    points: generateRewardPoints(),
    description: `Complete ${generateTaskType().replace('_', ' ')} task`,
    created_at: generateRecentTimestamp(),
    updated_at: generateRecentTimestamp()
  };
}

// Export functions for use in Artillery
module.exports = {
  generateMobileNumber,
  generateDeviceId,
  generateUserName,
  generateEmail,
  generateVideoCategory,
  generateVideoTitle,
  generateTaskType,
  generateOTP,
  generateReferralCode,
  generateUserAgent,
  generateIPAddress,
  generateRecentTimestamp,
  generateDuration,
  generateViewCount,
  generateLikeCount,
  generateCommentCount,
  generateRewardPoints,
  generateUserProfile,
  generateVideoData,
  generateRewardTaskData
};
