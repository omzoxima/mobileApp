import crypto from 'crypto';


export function generateCdnSignedUrlForThumbnail(thumbnailPath) {
  const CDN_HOST = process.env.CDN_DOMAIN || 'cdn.tuktuki.com';
  const KEY_NAME = process.env.CDN_KEY_NAME || 'key1';
  const KEY_B64URL = process.env.CDN_KEY_SECRET;
  const TTL_SECS = 60 * 60; 
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

// Utility function to check if a signed URL is expired
export function isSignedUrlExpired(url) {
  try {
    const urlObj = new URL(url);
    const expiresParam = urlObj.searchParams.get('Expires');
    
    if (expiresParam) {
      const expiryTime = parseInt(expiresParam) * 1000; // Convert to milliseconds
      const now = Date.now();
      return now >= expiryTime;
    }
    return false;
  } catch (error) {
    console.error('Error checking URL expiry:', error);
    return false;
  }
}

// Utility function to get time until URL expires (in milliseconds)
export function getTimeUntilUrlExpiry(url) {
  try {
    const urlObj = new URL(url);
    const expiresParam = urlObj.searchParams.get('Expires');
    
    if (expiresParam) {
      const expiryTime = parseInt(expiresParam) * 1000; // Convert to milliseconds
      const now = Date.now();
      return Math.max(0, expiryTime - now);
    }
    return 0;
  } catch (error) {
    console.error('Error getting URL expiry time:', error);
    return 0;
  }
}




/**
 * Generate CDN signed cookie for a given path or folder
 * @param {string} resourcePath - The path or folder prefix (e.g., "/hls_output/abc123/")
 * @returns {Object} - { cookieName, cookieValue, expiresAt }
 */
export function generateCdnSignedCookie(resourcePath) {
  const CDN_HOST = process.env.CDN_DOMAIN || 'cdn.tuktuki.com';
  const KEY_NAME = process.env.CDN_KEY_NAME || 'key1';
  const KEY_B64URL = process.env.CDN_KEY_SECRET;
  const TTL_SECS = 60 * 24; // 1 day (in seconds)

  if (!KEY_B64URL) {
    throw new Error('CDN_KEY_SECRET not set');
  }

  // Ensure path starts with "/"
  let pathPrefix = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;

  // Helpers
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

  // Signed Cookie Generator
  function generateSignedCookie(urlPrefix, keyName, keyBytes, expiresEpoch) {
    const stringToSign = `${urlPrefix}?Expires=${expiresEpoch}&KeyName=${keyName}`;
    const sig = crypto.createHmac('sha1', keyBytes)
      .update(stringToSign, 'utf8')
      .digest();
    const encodedSig = b64urlEncode(sig);
    return `Expires=${expiresEpoch}&KeyName=${keyName}&Signature=${encodedSig}`;
  }

  const expires = Math.floor(Date.now() / 1000) + TTL_SECS;
  const urlPrefix = `https://${CDN_HOST}${pathPrefix}`;
  const cookieValue = generateSignedCookie(urlPrefix, KEY_NAME, KEY_BYTES, expires);

  return {
    cookieName: 'Cloud-CDN-Cookie',
    cookieValue,
    expiresAt: new Date(expires * 1000).toISOString()
  };
}

export default {
  generateCdnSignedCookie,generateCdnSignedUrlForThumbnail
};
