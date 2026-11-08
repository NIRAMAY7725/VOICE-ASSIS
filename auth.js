// ============================================
// middleware/auth.js — JWT Authentication
// ============================================
// WHY THIS FILE?
// Protects routes so only logged-in users can access them.
//
// HOW JWT WORKS (simplified):
// 1. User logs in → server creates a "token" (encrypted ID card)
// 2. Frontend stores the token and sends it with every request
// 3. This middleware checks: "is this token valid? who is it?"
// 4. If valid → attaches the user to req.user and continues
// 5. If invalid → sends 401 Unauthorized
//
// The token is sent in the Authorization header:
//   Authorization: Bearer eyJhbG...
// ============================================

const jwt = require('jsonwebtoken');
const User = require('../models/User');

// SECURITY: never run production with a published default secret — anyone
// could forge tokens for any user. Fail fast at startup instead.
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error(
    'JWT_SECRET must be set in production. Refusing to start with a default secret. Set it in backend/.env.'
  );
}

const JWT_SECRET = process.env.JWT_SECRET || 'maya-dev-secret-change-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET is not set; falling back to a development-only default. Set it before deploying.');
}

// -------------------------------------------------
// protect — Middleware to require authentication
// -------------------------------------------------
// Usage in routes:  router.get('/tasks', protect, getTasksHandler);
const protect = async (req, res, next) => {
  try {
    let token;

    // 1. Extract the token from the Authorization header
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    // 2. No token? → Not authenticated
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized — please log in first.',
      });
    }

    // 3. Verify the token (checks signature + expiry)
    const decoded = jwt.verify(token, JWT_SECRET);

    // 4. Find the user in the database (make sure they still exist)
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User no longer exists.',
      });
    }

    // 5. Attach user to the request object for downstream routes
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token.',
    });
  }
};

// -------------------------------------------------
// generateToken — Create a JWT for a user
// -------------------------------------------------
// Called during login/register. Encodes the user's ID.
function generateToken(userId) {
  return jwt.sign(
    { id: userId },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

module.exports = {
  protect,
  generateToken,
};

