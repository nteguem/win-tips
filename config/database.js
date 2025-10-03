/**
 * @fileoverview Configuration de la base de données
 */
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');

/**
 * Configure et connecte à la base de données MongoDB
 * @returns {Promise<Object>} - Instance mongoose
 */
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/wintips';
    
    const conn = await mongoose.connect(mongoURI);
    
    logger.info(`MongoDB Connected: ${conn.connection.host}`);
    
    return mongoose;
  } catch (error) {
    logger.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

module.exports = {
  connectDB
};