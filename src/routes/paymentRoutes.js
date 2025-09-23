import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const router = express.Router();
router.post('/order', async (req, res) => {
  // initializing razorpay
  const razorpay = new Razorpay({
      key_id: req.body.keyId,
      key_secret: req.body.keySecret,
  });

  // setting up options for razorpay order.
  const options = {
      amount: req.body.amount,
      currency: req.body.currency,
      receipt: "any unique id for every order",
      payment_capture: 1
  };
  try {
      const response = await razorpay.orders.create(options)
      res.json({
          order_id: response.id,
          currency: response.currency,
          amount: response.amount,
      })
  } catch (err) {
     res.status(400).send('Not able to create order. Please try again!');
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
