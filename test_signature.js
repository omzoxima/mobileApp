import crypto from "crypto";

const keySecret = "123@Tuktuki";

// Example data from Razorpay logs
const order_id = "order_RLzDRYQhmYOdI5"; // from webhook/response
const payment_id = "pay_RLzDadsFb5XTZM";
const provided_signature = "c05a71244c49a180463c61053e3a84e5cf1852981ab337b501bd1c1fb0001558";

// Generate signature locally
const data = order_id + "|" + payment_id;
const expected_signature = crypto
  .createHmac("sha256", keySecret)
  .update(data)
  .digest("hex");

console.log("Local test:");
console.log("Data string   :", data);
console.log("Provided      :", provided_signature);
console.log("Expected(local):", expected_signature);
console.log("Match?        :", provided_signature === expected_signature);
