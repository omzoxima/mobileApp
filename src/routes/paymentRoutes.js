import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import dotenv from "dotenv";
import models from "../models/index.js";

dotenv.config();
const router = express.Router();

// Razorpay Instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * ==========================
 * 🔹 Subscription Creation
 * ==========================
 */
router.post("/subscription", async (req, res) => {
  try {
    const { planId, totalCount, customerNotify } = req.body;

    if (!planId) {
      return res.status(400).json({ error: "Missing required field: planId" });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: totalCount ?? 12, // default 12 cycles
      customer_notify: customerNotify ?? 1,
    });

    res.json(subscription);
  } catch (err) {
    console.error("Subscription creation failed:", err.message);
    res.status(400).json({
      error: "Not able to create subscription",
      details: err.message,
    });
  }
});

/**
 * ==========================
 * 🔹 One-time Payment (Order)
 * ==========================
 */
router.post("/order", async (req, res) => {
  try {
    // 1) Validate device-id header
    const deviceId = req.header("x-device-id") || req.header("x-Device-Id") || req.header("x-Device-ID");
    if (!deviceId) {
      return res.status(400).json({ error: "Missing required header: device-id" });
    }

    // 2) Verify user exists with this device
    const user = await models.User.findOne({ where: { device_id: deviceId, is_active: true } });
    if (!user) {
      return res.status(404).json({ error: "User not found for provided device-id" });
    }

    // 3) Read bundle id from body
    const bundleId = req.body.razorpay_episode_bundle_id || req.body.bundleId || req.body.bundle_id;
    if (!bundleId) {
      return res.status(400).json({ error: "Missing required field: razorpay_episode_bundle_id" });
    }

    // 4) Fetch bundle and price
    const bundle = await models.RazorpayEpisodeBundle.findByPk(bundleId);
    if (!bundle) {
      return res.status(404).json({ error: "Bundle not found" });
    }

    const amountPaise = Number(bundle.price);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return res.status(400).json({ error: "Invalid bundle price" });
    }

    // 5) Create order in Razorpay (currency fixed to INR)
    const options = {
      amount: 9900, // already in paise
      currency: "INR",
      receipt: `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      payment_capture: 1,
      
    };

    const response = await razorpay.orders.create(options);

    // Persist order in DB
    try {
      await models.RazorpayOrder.create({
        order_id: response.id,
        bundle_id: bundle.id,
        user_id: user.id
      });
    } catch (e) {
      console.error('Failed to persist Razorpay order:', e.message);
      // continue; not fatal for client order creation
    }

    return res.json({
      order_id: response.id,
      currency: response.currency,
      amount: response.amount,
      receipt: response.receipt,
      status: response.status,
      created_at: response.created_at,
      bundle: { id: bundle.id, plan_id: bundle.plan_id, price: bundle.price, name: bundle.name },
    });
  } catch (err) {
    console.error("Order creation failed:", err.message);
    return res.status(400).json({
      error: "Not able to create order. Please try again!",
      details: err.message,
    });
  }
});

/**
 * ==========================
 * 🔹 Verify Payment (Client → Server)
 * ==========================
 */
router.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const deviceId = req.header("x-device-id") || req.header("x-Device-Id") || req.header("x-Device-ID");

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    // Debug: log signature comparison details
    console.log("🔎 Signature verification:", {
      razorpay_order_id,
      razorpay_payment_id,
      provided_signature: razorpay_signature,
      expected_signature: expectedSignature,
      verified: expectedSignature === razorpay_signature
    });

    if (expectedSignature !== razorpay_signature) {
      console.log("❌ Payment Verification Failed!");
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    // Signature valid → find order
    const orderRecord = await models.RazorpayOrder.findOne({ where: { order_id: razorpay_order_id } });
    if (!orderRecord) {
      return res.status(200).json({ success: true, warning: true, message: 'Signature verified but order_id not found in database' });
    }

    // Find user (prefer record mapping; device header is ancillary)
    const user = await models.User.findByPk(orderRecord.user_id);
    if (!user) {
      return res.status(404).json({ error: "User not found for order" });
    }
    if (deviceId && user.device_id && user.device_id !== deviceId) {
      console.warn('Device mismatch for verified payment');
    }

    // Fetch bundle and credit
    const bundle = await models.RazorpayEpisodeBundle.findByPk(orderRecord.bundle_id);
    if (!bundle) {
      return res.status(404).json({ error: "Bundle not found for order" });
    }

    // Debug: log bundle info resolved from order
    console.log("📦 Bundle resolved:", {
      bundle_id: bundle.id,
      bundle_name: bundle.name,
      bundle_type: bundle.type,
      bundle_points: bundle.points
    });

    // Define pointsToCredit once to use across branches and in transaction record
    let pointsToCredit = Number(bundle.points || 0);

    if (bundle.type === 'monthly') {
      const now = new Date();
      const currentEnd = user.end_date ? new Date(user.end_date) : null;
      const base = currentEnd && currentEnd > now ? currentEnd : now;
      const end = new Date(base);
      const months = Math.max(Number.isFinite(pointsToCredit) ? pointsToCredit : 0, 0);
      end.setMonth(end.getMonth() + months);
      if (!user.start_date) user.start_date = now;
      user.end_date = end;
    }
    else{
        const newBalance = Number(user.current_reward_balance || 0) + (Number.isFinite(pointsToCredit) ? pointsToCredit : 0);
        user.current_reward_balance = newBalance;
    }

    await user.save();

    await models.RewardTransaction.create({
      user_id: user.id,
      type: 'payment_earn',
      points: pointsToCredit,
     // episode_bundle_id: orderRecord.bundle_id,
      product_id: bundle.plan_id || bundle.id,
      transaction_id: razorpay_payment_id,
      receipt: razorpay_order_id,
      source: 'razorpay'
    });

    console.log("✅ Payment Verified & Rewards Credited");
    return res.json({
      success: true,
      message: 'Payment verified, rewards credited',
      user: {
        id: user.id,
        current_reward_balance: user.current_reward_balance,
        start_date: user.start_date,
        end_date: user.end_date
      },
      bundle: { id: bundle.id, plan_id: bundle.plan_id, type: bundle.type, points: bundle.points }
    });
  } catch (err) {
    console.error("Payment verification failed:", err.message);
    return res.status(500).json({ error: "Payment verification error", details: err.message });
  }
});

/**
 * ==========================
 * 🔹 Webhook Handler
 * ==========================
 */
router.post(
  "/webhook",
  express.json({ type: "application/json" }),
  (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

      const shasum = crypto.createHmac("sha256", secret);
      shasum.update(JSON.stringify(req.body));
      const digest = shasum.digest("hex");

      if (digest !== req.headers["x-razorpay-signature"]) {
        return res.status(400).send("Invalid signature");
      }

      const event = req.body.event;
      console.log("🔔 Webhook received:", event);

      switch (event) {
        case "payment.captured":
          console.log("✅ Payment Captured:", req.body.payload.payment.entity);
          break;

        case "payment.failed":
          console.log("❌ Payment Failed:", req.body.payload.payment.entity);
          break;

        case "subscription.activated":
          console.log(
            "✅ Subscription Activated:",
            req.body.payload.subscription.entity
          );
          break;

        case "subscription.charged":
          console.log(
            "💰 Subscription Charged:",
            req.body.payload.subscription.entity
          );
          break;

        case "subscription.cancelled":
          console.log(
            "🛑 Subscription Cancelled:",
            req.body.payload.subscription.entity
          );
          break;

        default:
          console.log("ℹ️ Ignored Event:", event);
      }

      res.json({ status: "ok" });
    } catch (err) {
      console.error("Webhook Error:", err.message);
      res.status(500).json({ error: "Webhook handling failed" });
    }
  }
);

export default router;
