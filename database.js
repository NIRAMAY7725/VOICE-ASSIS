// ============================================
// config/database.js — MongoDB Connection
// ============================================
// WHY THIS FILE?
// Centralizes the database connection so every other file
// can just `require` Mongoose without worrying about setup.
//
// HOW IT WORKS:
// 1. Reads MONGODB_URI from .env
// 2. Connects with Mongoose (the MongoDB ODM for Node)
// 3. Logs success/failure so you know immediately if DB is down
// ============================================

const mongoose = require('mongoose');

const connectDatabase = async () => {
  try {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
      throw new Error(
        'MONGODB_URI is not defined in .env — copy .env.example to .env and fill it in!'
      );
    }

    const conn = await mongoose.connect(uri);

    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error(`❌ MongoDB connection failed: ${error.message}`);
    // Exit the process — no point running without a database
    process.exit(1);
  }
};

module.exports = connectDatabase;

