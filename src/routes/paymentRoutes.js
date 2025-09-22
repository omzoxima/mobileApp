import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const router = express.Router();


// POST /api/payment/create-order - Create Razorpay order
router.post('/create-order', async (req, res) => {
  console.log('🔄 [CREATE-ORDER] API Hit - Starting order creation');
  console.log('📥 [CREATE-ORDER] Request Body:', JSON.stringify(req.body, null, 2));
  
  try {
    // Validate required fields
    const { keyId, keySecret, amount, currency } = req.body;
    
    if (!keyId || !keySecret || !amount) {
      console.log('❌ [CREATE-ORDER] Missing required fields:', { keyId: !!keyId, keySecret: !!keySecret, amount: !!amount });
      return res.status(400).json({ 
        error: 'keyId, keySecret, and amount are required',
        received: { keyId: !!keyId, keySecret: !!keySecret, amount: !!amount }
      });
    }

    console.log('✅ [CREATE-ORDER] All required fields present');
    
    const razorpay = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });

    console.log('🔑 [CREATE-ORDER] Razorpay client initialized with key_id:', keyId);

    // setting up options for razorpay order.
    const options = {
      amount: Math.round(Number(amount) * 100), // Convert to paise
      currency: currency || 'INR',
      receipt: `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      payment_capture: 1
    };

    console.log('⚙️ [CREATE-ORDER] Order options:', JSON.stringify(options, null, 2));

    const response = await razorpay.orders.create(options);
    
    console.log('✅ [CREATE-ORDER] Order created successfully');
    console.log('📋 [CREATE-ORDER] Order details:', {
      order_id: response.id,
      currency: response.currency,
      amount: response.amount,
      status: response.status
    });

    res.json({
      order_id: response.id,
      currency: response.currency,
      amount: response.amount,
      status: response.status,
      receipt: response.receipt
    });

  } catch (err) {
    console.error('❌ [CREATE-ORDER] Error creating order:', err.message);
    console.error('🔍 [CREATE-ORDER] Error details:', err);
    
    res.status(400).json({ 
      error: 'Not able to create order. Please try again!',
      details: err.message 
    });
  }
});

// POST /api/payment/verify-payment - Verify Razorpay webhook signature
router.post('/verify-payment', (req, res) => {
  console.log('🔄 [VERIFY-PAYMENT] Webhook verification started');
  console.log('📥 [VERIFY-PAYMENT] Request Headers:', JSON.stringify(req.headers, null, 2));
  console.log('📥 [VERIFY-PAYMENT] Request Body:', JSON.stringify(req.body, null, 2));
  
  try {
    // Get the signature from headers
    const razorpaySignature = req.headers['x-razorpay-signature'];
    
    if (!razorpaySignature) {
      console.log('❌ [VERIFY-PAYMENT] Missing x-razorpay-signature header');
      return res.status(400).json({ 
        error: 'Missing x-razorpay-signature header',
        received_headers: Object.keys(req.headers)
      });
    }

    console.log('🔍 [VERIFY-PAYMENT] Received signature:', razorpaySignature);

    // Get webhook secret from environment or request body
    // Note: In production, use environment variable for security
    const webhookSecret = req.body.webhook_secret || process.env.RAZORPAY_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
      console.log('❌ [VERIFY-PAYMENT] Missing webhook secret');
      return res.status(400).json({ 
        error: 'Webhook secret not provided. Add webhook_secret in request body or set RAZORPAY_WEBHOOK_SECRET environment variable',
        hint: 'You can pass webhook_secret in request body for testing'
      });
    }

    console.log('🔑 [VERIFY-PAYMENT] Using webhook secret:', webhookSecret.substring(0, 8) + '...');

    // Create HMAC signature
    const bodyString = JSON.stringify(req.body);
    console.log('📝 [VERIFY-PAYMENT] Body string for signature:', bodyString);

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(bodyString)
      .digest('hex');

    console.log('🔐 [VERIFY-PAYMENT] Generated signature:', expectedSignature);
    console.log('🔍 [VERIFY-PAYMENT] Received signature:', razorpaySignature);
    console.log('✅ [VERIFY-PAYMENT] Signatures match:', expectedSignature === razorpaySignature);

    if (expectedSignature === razorpaySignature) {
      console.log('✅ [VERIFY-PAYMENT] Signature verification successful - Webhook is legitimate');
      console.log('📊 [VERIFY-PAYMENT] Payment event details:', {
        event: req.body.event,
        payment_id: req.body.payload?.payment?.entity?.id,
        order_id: req.body.payload?.payment?.entity?.order_id,
        amount: req.body.payload?.payment?.entity?.amount,
        status: req.body.payload?.payment?.entity?.status
      });

      // Here you can process the payment and store in database
      // Example: Update user subscription, grant access, etc.

      res.json({
        status: 'ok',
        message: 'Payment verification successful',
        event: req.body.event,
        payment_id: req.body.payload?.payment?.entity?.id,
        verified_at: new Date().toISOString()
      });

    } else {
      console.log('❌ [VERIFY-PAYMENT] Signature verification failed - Webhook is not legitimate');
      console.log('🔍 [VERIFY-PAYMENT] Signature comparison:', {
        expected: expectedSignature,
        received: razorpaySignature,
        match: false
      });

      res.status(400).json({
        error: 'Invalid signature',
        message: 'Webhook signature verification failed',
        expected_signature: expectedSignature,
        received_signature: razorpaySignature
      });
    }

  } catch (err) {
    console.error('❌ [VERIFY-PAYMENT] Error during verification:', err.message);
    console.error('🔍 [VERIFY-PAYMENT] Error details:', err);
    
    res.status(500).json({
      error: 'Verification failed',
      message: err.message
    });
  }
});

export default router;
