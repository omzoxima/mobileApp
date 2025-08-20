import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import models from '../models/index.js';
import jwt from 'jsonwebtoken';
import { generateUniqueReferralCode } from '../utils/referralCodeGenerator.js';

const { User, RewardTransaction, OTP } = models;
const router = express.Router();

// Helper function to get local time instead of GMT
function getLocalTime() {
  const now = new Date();
  const localTime = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
  return localTime;
}

// Configuration from environment variables
const PINNACLE_ACCESS_KEY = 'R9lJ0gfOh4w7';
const DEFAULT_SENDER = 'TKIENT';
const DEFAULT_DLT_ENTITY_ID = '1001186179422431539';
const DEFAULT_DLT_TEMPLATE_ID = '1007685518923891699';
function generateJwt(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
// Pinnacle SMS function based on working curl command
async function sendPinnacleSMS(accesskey, obj) {
  try {
    const data = JSON.stringify(obj);
    
        const config = {
      method: 'post',
      url: 'https://transapi.pinnacle.in/genericapi/JSONGenericReceiver',
      headers: { 
        'Content-Type': 'application/json'
      },
      data: data
    };
    
    // Print cURL command for debugging
    const curlCommand = `curl -X POST ${config.url} \\
      -H "Content-Type: application/json" \\
      -d '${data}'`;
    
    console.log('📱 Pinnacle SMS API cURL Command:');
    console.log(curlCommand);
    console.log('📱 Pinnacle SMS API Request Data:', data);
    
    const response = await axios(config);
    return response.data;
  } catch (error) {
    throw error;
  }
}

/**
 * Validate mobile number format
 * @param {string} mobileNumber - Mobile number to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validateMobileNumber(mobileNumber) {
  // Basic validation for Indian mobile numbers
  const indianMobileRegex = /^[6-9]\d{9}$/;
  const internationalMobileRegex = /^[1-9]\d{1,14}$/;
  
  // Remove country code if present
  const cleanNumber = mobileNumber.replace(/^91/, '');
  
  return indianMobileRegex.test(cleanNumber) || internationalMobileRegex.test(mobileNumber);
}

/**
 * Format mobile number with country code
 * @param {string} mobileNumber - Mobile number
 * @param {string} countryCode - Country code (default: '91')
 * @returns {string} - Formatted mobile number
 */
function formatMobileNumber(mobileNumber, countryCode = '91') {
  // Remove any existing country code
  const cleanNumber = mobileNumber.replace(/^91/, '');
  
  // Add country code if not present
  if (!cleanNumber.startsWith(countryCode)) {
    return `${countryCode}${cleanNumber}`;
  }
  
  return cleanNumber;
}

/**
 * Generate a 6-digit OTP
 * @returns {string} - 6-digit OTP
 */
function generateOTP() {
  //return Math.floor(100000 + Math.random() * 900000).toString();
  return '123456';
}



// POST /api/sms/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { mobile } = req.body;
    
    if (!mobile) {
      return res.status(400).json({ error: 'Mobile number is required' });
    }

    // Validate mobile number
    if (!validateMobileNumber(mobile)) {
      return res.status(400).json({ error: 'Invalid mobile number format' });
    }

    // Format mobile number (remove country code for API)
    const cleanNumber = mobile.replace(/^91/, '');

    // Generate OTP
    const otp = generateOTP();

    // Store OTP in database
    try {
      console.log('Attempting to store OTP in database:', { mobile: cleanNumber, otp: otp });
      await OTP.create({
        id: uuidv4(),
        mobile: cleanNumber,
        otp: otp,
        verified: false,
        expires_at: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        created_at: new Date(),
        updated_at: new Date()
      });
      //console.log('✅ OTP stored successfully in database');
    } catch (dbError) {
     // console.error('❌ Database error storing OTP:', dbError.message);
      // Continue with SMS sending even if database fails
    }

    // Send SMS via Pinnacle SMS API using working format
    const smsPayload = {
      version: "1.0",
      encrypt: "0",
      accesskey:PINNACLE_ACCESS_KEY,
      messages: [
        {
          dest: [cleanNumber],
          msg: `Your OTP for login is ${otp}. Do not share it with anyone. Valid for 10 minutes. - 7676TUKTUKI`,
          type: "UC",
          header: DEFAULT_SENDER,
          app_country: "1",
          country_cd: "91",
          dlt_entity_id: DEFAULT_DLT_ENTITY_ID,
          dlt_template_id: DEFAULT_DLT_TEMPLATE_ID
        }
      ]
    };

    const response = await sendPinnacleSMS(PINNACLE_ACCESS_KEY, smsPayload);

    //console.log('OTP SMS sent successfully:', response);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      mobile: cleanNumber,
      data: response
    });

  } catch (error) {
    //console.error('OTP SMS sending error:', error.message || error);
    res.status(500).json({ 
      error: 'Failed to send OTP',
      details: error.message || error
    });
  }
});

// POST /api/sms/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { mobile, otp } = req.body;
    const deviceId = req.headers['x-device-id'];
    
    // Check for mandatory x-device-id header
    if (!deviceId) {
      return res.status(400).json({ error: 'x-device-id header is mandatory' });
    }
    
    if (!mobile || !otp) {
      return res.status(400).json({ error: 'Mobile number and OTP are required' });
    }

    // Validate mobile number
    if (!validateMobileNumber(mobile)) {
      return res.status(400).json({ error: 'Invalid mobile number format' });
    }

    // Format mobile number (remove country code for API)
    const cleanNumber = mobile.replace(/^91/, '');

    // Find the OTP record
    const otpRecord = await OTP.findOne({
      where: {
        mobile: cleanNumber,
        otp: otp,
        verified: false,
        expires_at: {
          [Op.gt]: new Date() // Not expired
        }
      },
      order: [['created_at', 'DESC']] // Get the latest OTP
    });

   // console.log('📋 OTP record found:', otpRecord ? 'Yes' : 'No');

    if (!otpRecord) {
      // Let's check what OTPs exist for this mobile number
      const allOtps = await OTP.findAll({
        where: { mobile: cleanNumber },
        order: [['created_at', 'DESC']],
        limit: 5
      });
      //console.log('📊 All OTPs for this mobile:', allOtps.map(o => ({ otp: o.otp, verified: o.verified, created_at: o.created_at })));
      
      return res.status(400).json({ 
        error: 'Invalid OTP or OTP expired',
        message: 'Please request a new OTP'
      });
    }

    // Mark OTP as verified
    await otpRecord.update({
      verified: true,
      updated_at: new Date()
    });
    
    let user;
    if (deviceId) {
      // Try to get user session from cache first
      const { apiCache } = await import('../config/redis.js');
      let userSession = await apiCache.getUserSession(deviceId);
      
      if (userSession) {
        user = userSession;
        console.log('👤 SMS: User session served from cache');
        
        // Update user with provider info
        if (cleanNumber) user.phone_or_email = cleanNumber;
        user.login_type = 'mobile';
        user.is_active = true;
        user.updated_at = getLocalTime();
        await user.save();
        
        // Update cached session
        await apiCache.setUserSession(deviceId, user);
      } else {
        // Fetch user from database
        user = await User.findOne({ where: { device_id: deviceId } });
        if (user) {
          // Update user with provider info
          if (cleanNumber) user.phone_or_email = cleanNumber;
          user.login_type = 'mobile';
          user.is_active = true;
          user.updated_at = getLocalTime();
          await user.save();
          
          // Cache user session for 2 hours
          await apiCache.setUserSession(deviceId, user);
          console.log('💾 SMS: User session cached for 2 hours');
        }
      }
    }
    
    if (!user) {
      // Find by provider id
      let where = {};
      where['phone_or_email'] = cleanNumber;
      user = await User.findOne({ where });
      if(user){
        if (cleanNumber) user.phone_or_email = cleanNumber;
        user.login_type = 'mobile';
        user.is_active = true;
        user.updated_at = getLocalTime();
        user.device_id = deviceId;
        await user.save();
      }
      if (!user) {
        // Generate unique referral code
        const referralCode = await generateUniqueReferralCode(User);
        
        user = await User.create({
          phone_or_email: cleanNumber || '',
          Name: 'Mobile login User',
          login_type: 'mobile',
          is_active: true,
          current_reward_balance: 0,
          device_id: deviceId || null,
          referral_code: referralCode,
          created_at: getLocalTime(),
          updated_at: getLocalTime()
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
          user.updated_at = getLocalTime();
          await user.save();
          await RewardTransaction.create({
            user_id: user.id,
            type: 'login',
            points: loginReward.points,
            created_at: getLocalTime(),
            updated_at: getLocalTime(),
            task_id: loginReward.id
          });
        }
      }
    }
    
    // Invalidate user caches after OTP verification
    try {
      const { apiCache } = await import('../config/redis.js');
      if (deviceId) {
        await apiCache.invalidateUserSession(deviceId);
        await apiCache.invalidateUserProfileCache(deviceId);
        console.log('🗑️ User caches invalidated due to OTP verification');
      }
    } catch (cacheError) {
      console.error('Cache invalidation error:', cacheError);
    }
  
    res.json({
      success: true,
      message: 'OTP verified successfully',
      mobile: cleanNumber,
      user:user,
      token:jwtToken
    });

  } catch (error) {
    //console.error('OTP verification error:', error.message || error);
    res.status(500).json({ 
      error: 'Failed to verify OTP',
      details: error.message || error
    });
  }
});



export default router; 