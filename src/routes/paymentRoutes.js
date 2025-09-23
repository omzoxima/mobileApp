import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import dotenv from 'dotenv';

const router = express.Router();
router.post('/order', async (req, res) => {
  console.log('POST /order');

  try {
      // Validate required fields
      if (!req.body.amount || !req.body.currency) {
          return res.status(400).json({
              error: 'Missing required fields: amount, currency, keyId, keySecret',
              received: req.body
          });
      }

      // initializing razorpay
      const razorpay = new Razorpay({
          key_id: process.env.RAZORPAY_KEY_ID,
          key_secret: process.env.RAZORPAY_KEY_SECRET,
      });

      // setting up options for razorpay order.
      const options = {
          amount: req.body.amount,
          currency: req.body.currency,
          receipt: `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          payment_capture: 1
          
      };

      const response = await razorpay.orders.create(options);
      console.log('Order created', response.id);
      
      res.json({
          order_id: response.id,
          currency: response.currency,
          amount: response.amount,
          receipt: response.receipt,
          status: response.status,
          created_at: response.created_at
      });

  } catch (err) {
      console.error('Order creation failed:', err.message);
      res.status(400).json({
          error: 'Not able to create order. Please try again!',
          details: err.message
      });
  }
});
router.post('/paymentCapture', (req, res) => {

  // do a validation

const data = crypto.createHmac('sha256', '123@Tuktuki')

  data.update(JSON.stringify(req.body))

  const digest = data.digest('hex')

if (digest === req.headers['x-razorpay-signature']) {

      console.log('request is legit')

      //We can send the response and store information in a database.

      res.json({

          status: 'ok'

      })

} else {

      res.status(400).send('Invalid signature');

  }

});

export default router;
