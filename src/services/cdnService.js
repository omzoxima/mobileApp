import crypto from 'crypto';

/**
 * Common method to generate CDN signed URL for thumbnails
 * @param {string} thumbnailPath - The thumbnail path (e.g., "images/series/123/thumbnail.jpg")
 * @returns {string} - Signed CDN URL or original path if CDN not configured
 */
export function generateCdnSignedUrlForThumbnail(thumbnailPath) {
  const CDN_HOST = process.env.CDN_DOMAIN || 'cdn.tuktuki.com';
  const KEY_NAME = process.env.CDN_KEY_NAME || 'key1';
  const KEY_B64URL = process.env.CDN_KEY_SECRET;
  const TTL_SECS = 60 * 24; // 1 day (24 hours)
  const p = `/${thumbnailPath}`;

  if (!KEY_B64URL) {
    return p; // Return original path if CDN not configured
  }

  // Base64url helpers
  function b64urlDecode(b64url) {
    let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return Buffer.from(b64, 'base64');
  }

  function b64urlEncode(buf) {
    return Buffer.from(buf)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  const KEY_BYTES = b64urlDecode(KEY_B64URL);

  // Sign a FULL URL
  function signFullUrl(fullUrl, keyName, keyBytes, expiresEpoch) {
    const sep = fullUrl.includes('?') ? '&' : '?';
    const urlToSign = `${fullUrl}${sep}Expires=${expiresEpoch}&KeyName=${encodeURIComponent(keyName)}`;

    const hmac = crypto.createHmac('sha1', keyBytes);
    hmac.update(urlToSign, 'utf8');
    const sig = b64urlEncode(hmac.digest());

    return `${urlToSign}&Signature=${sig}`;
  }

  // Build the upstream URL and sign it
  const upstream = new URL(`https://${CDN_HOST}${p}`);
  const expires = Math.floor(Date.now() / 1000) + TTL_SECS;
  return signFullUrl(upstream.toString(), KEY_NAME, KEY_BYTES, expires);
}

export default {
  generateCdnSignedUrlForThumbnail
};
