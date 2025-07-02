import express from 'express';
import jwt from 'jsonwebtoken';
import models from '../models/index.js';
import twilio from 'twilio';
import nodemailer from 'nodemailer';
import fetch from 'node-fetch';

const { User } = models;

const router = express.Router();

// In-memory OTP store (for demo; use Redis or DB in production)
const otpStore = {};

// Twilio setup
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Replace with your actual values
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;
const FACEBOOK_REDIRECT_URI = 'http://localhost:3000/api/auth/facebook/callback'; // Must match your Facebook app settings

// POST /api/auth/request_otp
router.post('/request_otp', async (req, res) => {
  try {
    const { phoneOrEmail } = req.body;
    if (!phoneOrEmail) return res.status(400).json({ error: 'phoneOrEmail is required' });

    // Validate phone or email
    const phoneRegex = /^\d{10}$/;
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    let isPhone = false, isEmail = false;
    if (phoneRegex.test(phoneOrEmail)) {
      isPhone = true;
    } else if (emailRegex.test(phoneOrEmail)) {
      isEmail = true;
    } else {
      return res.status(400).json({ error: 'Enter a valid 10-digit phone number or email address' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneOrEmail] = otp;
    console.log('OTP sent to', phoneOrEmail, 'with OTP:', otp);

    if (isPhone) {
      // Send OTP via Twilio SMS
      await twilioClient.messages.create({
        body: `Your OTP is: ${otp}`,
        from: twilioFrom,
        to: `+91${phoneOrEmail}` // assuming India country code, change as needed
      });
    } else if (isEmail) {
      // Send OTP via email
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: phoneOrEmail,
        subject: 'Your OTP Code',
        text: `Your OTP is: ${otp}`
      });
    }

    res.json({ message: 'OTP sent successfully' });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({ error: error.message || 'Failed to send OTP' });
  }
});

// POST /api/auth/verify_otp
router.post('/verify_otp', async (req, res) => {
  const { phoneOrEmail, otp, deviceId } = req.body;
  if (!phoneOrEmail || !otp || !deviceId) return res.status(400).json({ error: 'phoneOrEmail, otp, and deviceId are required' });
  if (otpStore[phoneOrEmail] !== otp) return res.status(400).json({ error: 'Invalid OTP' });

  let user = await User.findOne({ where: { phone_or_email: phoneOrEmail } });
  let isNew = false;
  if (!user) {
    user = await User.create({ phone_or_email: phoneOrEmail, login_type: 'otp', device_id: deviceId, current_reward_balance: 100 });
    isNew = true;
  } else if (user.device_id !== deviceId) {
    user.device_id = deviceId;
    user.device_change_count = (user.device_change_count || 0) + 1;
    await user.save();
  }
  delete otpStore[phoneOrEmail];
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, isNew });
});

// POST /api/auth/device-lock-login
router.post('/device-lock-login', async (req, res) => {
  const { login, device_id } = req.body;
  if (!login || !device_id) {
    return res.status(400).json({ error: 'login and device_id are required' });
  }
  try {
    const user = await models.User.findOne({ where: { phone_or_email: login } });
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    if (user.device_id && user.device_id !== device_id) {
      return res.status(403).json({ error: 'Device lock: login not allowed from this device.' });
    }
    // If device_id is not set, set it now (first login)
    if (!user.device_id) {
      user.device_id = device_id;
      await user.save();
    }
    // Continue with login (e.g., generate JWT, etc.)
    return res.json({ message: 'Login allowed', userId: user.id });
  } catch (error) {
    console.error('Device lock login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/guest-start
router.post('/guest-start', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }
  try {
    let user = await models.User.findOne({ where: { device_id, phone_or_email: '' } });
    if (!user) {
      user = await models.User.create({
        device_id,
        phone_or_email: '',
        current_reward_balance: 10,
        login_type: 'guest',
        is_active: true
      });
    }
    return res.json({ message: 'Guest user started', userId: user.id, reward_points: user.current_reward_balance });
  } catch (error) {
    console.error('Guest start error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Step 1: Redirect user to Facebook login (frontend should do this, but you can provide the URL)
router.get('/facebook', (req, res) => {
  const fbAuthUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${FACEBOOK_CLIENT_ID}&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}&scope=email,public_profile`;
  res.redirect(fbAuthUrl);
});

// Step 2: Facebook redirects here with ?code=...
router.get('/facebook/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  try {
    // Exchange code for access token
    const tokenRes = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?client_id=${FACEBOOK_CLIENT_ID}&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}&client_secret=${FACEBOOK_CLIENT_SECRET}&code=${code}`);
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).json({ error: 'Failed to get access token', details: tokenData });

    // Fetch user info
    const userRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${tokenData.access_token}`);
    const fbUser = await userRes.json();
    if (!fbUser.id) return res.status(400).json({ error: 'Failed to get user info', details: fbUser });

    // Find or create user in your DB
    let user = await User.findOne({ where: { facebook_id: fbUser.id } });
    if (!user) {
      user = await User.create({
        facebook_id: fbUser.id,
        Name: fbUser.name,
        phone_or_email: fbUser.email || '',
        login_type: 'facebook',
        is_active: true
      });
    }

    // Generate JWT
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

    // You can redirect to your frontend with the token, or just return it
    // res.redirect(`http://your-frontend-url.com?token=${token}`);
    res.json({ token, user });
  } catch (error) {
    console.error('Facebook OAuth error:', error);
    res.status(500).json({ error: error.message || 'Facebook OAuth failed' });
  }
});

// POST /api/auth/facebook-login
router.post('/facebook-login', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) {
    return res.status(400).json({ error: 'access_token is required' });
  }
  try {
    // Get user profile from Facebook
    const fbRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${access_token}`);
    const fbData = await fbRes.json();
    if (!fbData.id) {
      return res.status(400).json({ error: 'Invalid Facebook access token', details: fbData });
    }
    let user = await User.findOne({ where: { facebook_id: fbData.id } });
    let isNew = false;
    if (!user) {
      user = await User.create({
        facebook_id: fbData.id,
        Name: fbData.name,
        phone_or_email: fbData.email || '',
        login_type: 'facebook',
        is_active: true,
        current_reward_balance: 5
      });
      isNew = true;
    }
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user, isNew });
  } catch (error) {
    console.error('Facebook login error:', error);
    res.status(500).json({ error: error.message || 'Failed to login with Facebook' });
  }
});

export default router;
