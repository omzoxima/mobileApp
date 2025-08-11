// services/cdnAuthService.js
import crypto from 'crypto';

const CDN_KEY_NAME = process.env.CDN_KEY_NAME; // e.g. "my-key"
const CDN_KEY_SECRET = process.env.CDN_KEY_SECRET; // Base64 encoded secret key
const CDN_DOMAIN = process.env.CDN_DOMAIN; // e.g. "https://cdn.example.com"

// Expiry in seconds
function getExpiryTime(secondsFromNow = 3600) {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

/**
 * Generates a signed CDN URL for Google Cloud CDN
 * @param {string} path - Path starting with "/" (relative to CDN domain)
 * @param {number} expiresInSeconds - Expiry time in seconds
 * @returns {string} Signed URL
 */
function generateCdnSignedUrl(path, expiresInSeconds = 3600) {
  if (!CDN_KEY_NAME || !CDN_KEY_SECRET || !CDN_DOMAIN) {
    throw new Error("CDN_KEY_NAME, CDN_KEY_SECRET, and CDN_DOMAIN must be set in environment variables");
  }

  const expiration = getExpiryTime(expiresInSeconds);
  const decodedKey = Buffer.from(CDN_KEY_SECRET, 'base64');

  // URL signature format: URLSignature = base64(hmac-sha1(url-path + expiration, key))
  const toSign = `${path}${expiration}`;
  const signature = crypto
    .createHmac('sha1', decodedKey)
    .update(toSign)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${CDN_DOMAIN}${path}?Expires=${expiration}&KeyName=${CDN_KEY_NAME}&Signature=${signature}`;
}

export default {
  generateCdnSignedUrl
};
