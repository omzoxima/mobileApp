import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

// Razorpay Instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * ==========================
 * 🔹 Create Plan (API-based)
 * ==========================
 */
router.post("/plan", async (req, res) => {
  try {
    const { period, interval, name, amount, currency } = req.body;

    if (!period || !interval || !name || !amount || !currency) {
      return res.status(400).json({
        error:
          "Missing required fields: period, interval, name, amount, currency",
      });
    }

    const plan = await razorpay.plans.create({
      period, // "monthly" | "weekly" | "yearly" etc.
      interval, // e.g. 1
      item: {
        name,
        amount: amount * 100, // paise
        currency,
      },
    });

    res.json(plan);
  } catch (err) {
    console.error("Plan creation failed:", err.message);
    res.status(400).json({
      error: "Not able to create plan",
      details: err.message,
    });
  }
});

/**
 * ==========================
 * 🔹 Create Subscription
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
    if (!req.body.amount || !req.body.currency) {
      return res.status(400).json({
        error: "Missing required fields: amount, currency",
        received: req.body,
      });
    }

    const options = {
      amount: req.body.amount * 100, // amount in paise
      currency: req.body.currency,
      receipt: `receipt_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`,
      payment_capture: 1,
    };

    const response = await razorpay.orders.create(options);
    res.json({
      order_id: response.id,
      currency: response.currency,
      amount: response.amount,
      receipt: response.receipt,
      status: response.status,
      created_at: response.created_at,
    });
  } catch (err) {
    console.error("Order creation failed:", err.message);
    res.status(400).json({
      error: "Not able to create order. Please try again!",
      details: err.message,
    });
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
