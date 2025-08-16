/**
 * Generate a unique referral code for users
 * @returns {string} A unique 8-character referral code
 */
export function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  
  // Generate 8-character code
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
}

/**
 * Generate a unique referral code that doesn't exist in the database
 * @param {Object} User - Sequelize User model
 * @returns {Promise<string>} A unique referral code
 */
export async function generateUniqueReferralCode(User) {
  let referralCode;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;
  
  while (!isUnique && attempts < maxAttempts) {
    referralCode = generateReferralCode();
    
    // Check if this code already exists
    const existingUser = await User.findOne({ 
      where: { referral_code: referralCode } 
    });
    
    if (!existingUser) {
      isUnique = true;
    }
    
    attempts++;
  }
  
  if (!isUnique) {
    // Fallback: add timestamp to make it unique
    referralCode = generateReferralCode() + Date.now().toString().slice(-4);
  }
  
  return referralCode;
}
