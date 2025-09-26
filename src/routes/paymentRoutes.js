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

    const { planId, totalCount, customerNotify, bundle_id } = req.body;
    const platform = req.header("platform") || req.header("Platform") || "android";

    if (!planId && !bundle_id) {
      return res.status(400).json({ error: "Missing required field: planId or bundle_id" });
    }

    let finalPlanId = planId;
    let bundle = null;

    // If bundle_id is provided, get price and plan_id from bundle
    if (bundle_id) {
      bundle = await models.EpisodeBundlePrice.findByPk(bundle_id);
      if (!bundle) {
        return res.status(404).json({ error: "Bundle not found" });
      }

      // Get plan_id based on platform
      if (platform.toLowerCase() === 'ios') {
        finalPlanId = bundle.plan_id_ios || bundle.plan_id;
      } else {
        finalPlanId = bundle.plan_id;
      }

      if (!finalPlanId) {
        return res.status(400).json({ error: "Plan ID not found for this bundle" });
      }
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: finalPlanId,
      total_count: totalCount ?? 12, // default 12 cycles
      customer_notify: customerNotify ?? 1,
    });

    // 3) Create RazorpayOrder record with subscription_id in order column
    try {
      await models.RazorpayOrder.create({
        order_id: subscription.id, // subscription ID goes in order_id column
        bundle_id: bundle ? bundle.id : null, // Bundle ID if provided
        user_id: user.id,
        subscription_id: subscription.id // Add subscription_id field if exists
      });
      console.log("✅ Subscription order record created:", subscription.id);
    } catch (e) {
      console.error('Failed to persist subscription order:', e.message);
      // Continue - not fatal for subscription creation
    }

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

    // 4) Get platform header
    const platform = req.header("platform") || req.header("Platform") || "android";

    // 5) Fetch bundle and price
    const bundle = await models.EpisodeBundlePrice.findByPk(bundleId);
    if (!bundle) {
      return res.status(404).json({ error: "Bundle not found" });
    }

    // 6) Calculate price based on platform
    let amountPaise;
    if (platform.toLowerCase() === 'ios') {
      // For iOS, use appleprice and multiply by 100 (convert to paise)
      amountPaise = Number(bundle.appleprice) * 100;
      console.log("🍎 iOS Price Calculation:", {
        appleprice: bundle.appleprice,
        amountPaise: amountPaise,
        platform: platform
      });
    } else {
      // For Android, use price_points and multiply by 100 (convert to paise)
      amountPaise = Number(bundle.price_points) * 100;
      console.log("🤖 Android Price Calculation:", {
        price_points: bundle.price_points,
        amountPaise: amountPaise,
        platform: platform
      });
    }

    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return res.status(400).json({ error: "Invalid bundle price" });
    }

    // 7) Create order in Razorpay (currency fixed to INR)
    const options = {
      amount: amountPaise, // already in paise
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
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, razorpay_subscription_id } = req.body;
    const deviceId = req.header("x-device-id") || req.header("x-Device-Id") || req.header("x-Device-ID");

    if ((!razorpay_order_id && !razorpay_subscription_id) || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    let generatedSignature;
    let idForDB = null;

    if (razorpay_order_id) {
      // ✅ Order payment verification
      generatedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");
      idForDB = razorpay_order_id;
    } else if (razorpay_subscription_id) {
      // ✅ Subscription payment verification
      generatedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(razorpay_payment_id + "|" + razorpay_subscription_id) // notice payment_id first
        .digest("hex");
      idForDB = razorpay_subscription_id;
    }

    console.log("🔎 Signature verification:", {
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      provided_signature: razorpay_signature,
      expected_signature: generatedSignature,
      verified: generatedSignature === razorpay_signature
    });

    if (generatedSignature !== razorpay_signature) {
      console.log("❌ Payment Verification Failed!");
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    // ✅ Signature matched → check database
    let orderRecord = await models.RazorpayOrder.findOne({ where: { order_id: idForDB } });

    if (!orderRecord) {
      return res.status(400).json({
        success: false,
        error: "Order/Subscription not found in database",
        order_id: idForDB,
        message: "This order/subscription was not created through our system"
      });
    }

    console.log("✅ Order/Subscription record found:", orderRecord.id);

    const user = await models.User.findByPk(orderRecord.user_id);
    if (!user) {
      return res.status(404).json({ error: "User not found for order" });
    }

    if (deviceId && user.device_id && user.device_id !== deviceId) {
      console.warn("⚠️ Device mismatch for verified payment");
    }

    // ✅ Handle bundles for orders only (subscriptions may not credit points directly)
    let bundle = null;
    let pointsToCredit = 0;

    if (orderRecord.bundle_id) {
      bundle = await models.EpisodeBundlePrice.findByPk(orderRecord.bundle_id);
      if (!bundle) {
        return res.status(404).json({ error: "Bundle not found for order" });
      }

      pointsToCredit = Number(bundle.bundle_count || 0);

      if (bundle.productName && bundle.productName.toLowerCase().includes("package")) {
        const now = new Date();
        const currentEnd = user.end_date ? new Date(user.end_date) : null;
        const base = currentEnd && currentEnd > now ? currentEnd : now;
        const end = new Date(base);
        const months = Math.max(Number.isFinite(pointsToCredit) ? pointsToCredit : 0, 0);
        end.setMonth(end.getMonth() + months);
        if (!user.start_date) user.start_date = now;
        user.end_date = end;
      } else {
        user.current_reward_balance = Number(user.current_reward_balance || 0) + pointsToCredit;
      }
      await user.save();

      if (pointsToCredit > 0) {
        await models.RewardTransaction.create({
          user_id: user.id,
          type: "payment_earn",
          points: pointsToCredit,
          episode_bundle_id: orderRecord.bundle_id,
          product_id: bundle ? (bundle.plan_id || bundle.id) : orderRecord.order_id,
          transaction_id: razorpay_payment_id,
          receipt: razorpay_order_id || razorpay_subscription_id,
          source: "razorpay"
        });
      }
    }

    console.log("✅ Payment Verified & Rewards Credited (if applicable)");

    return res.json({
      success: true,
      message: "Payment verified successfully",
      user: {
        id: user.id,
        current_reward_balance: user.current_reward_balance,
        start_date: user.start_date,
        end_date: user.end_date
      },
      bundle: bundle ? {
        id: bundle.id,
        plan_id: bundle.plan_id,
        type: bundle.type,
        points: bundle.points
      } : null,
      subscription: razorpay_subscription_id ? {
        id: razorpay_subscription_id,
        type: "subscription"
      } : null
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
