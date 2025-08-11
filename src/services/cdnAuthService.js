// services/cdnAuthService.js
import crypto from 'crypto';

const CDN_KEY_NAME = process.env.CDN_KEY_NAME;         // e.g. "my-key"
const CDN_KEY_SECRET_B64 = process.env.CDN_KEY_SECRET; // base64 secret provided by GCP
const CDN_DOMAIN = process.env.CDN_DOMAIN;             // e.g. "https://cdn.example.com"

if (!CDN_KEY_NAME || !CDN_KEY_SECRET_B64 || !CDN_DOMAIN) {
  throw new Error('CDN_KEY_NAME, CDN_KEY_SECRET_B64 and CDN_DOMAIN must be set in env.');
}

const CDN_KEY_SECRET = Buffer.from(CDN_KEY_SECRET_B64, 'base64');

function urlSafeBase64(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate signed URL for Cloud CDN for a resource path (path must start with '/')
 * @param {string} resourcePath  e.g. "/hls_output/.../hd0000000000.ts"
 * @param {number} expiresInSec seconds until expiry
 * @returns {string} full signed URL
 */
function generateCdnSignedUrl(resourcePath, expiresInSec = 3600) {
  if (!resourcePath.startsWith('/')) resourcePath = `/${resourcePath}`;

  const expiry = Math.floor(Date.now() / 1000) + expiresInSec;

  // String to sign: resourcePath + "?Expires=" + expiry + "&KeyName=" + keyName
  const signedValue = `${resourcePath}?Expires=${expiry}&KeyName=${CDN_KEY_NAME}`;

  const hmac = crypto.createHmac('sha256', CDN_KEY_SECRET).update(signedValue).digest();
  const signature = urlSafeBase64(hmac);

  return `${CDN_DOMAIN}${signedValue}&Signature=${signature}`;
}
export default {
  generateCdnSignedUrl
};
