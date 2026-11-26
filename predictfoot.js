'use strict';

// Load configuration before any service captures an API URL or credentials.
require('dotenv').config();
require('node:dns').setDefaultResultOrder('ipv4first');

const app = require('./src/app');
const logger = require('./src/utils/logger');
const { connectDB } = require('./config/database');
const paymentJobs = [
  require('./src/core/jobs/smobilpayVerificationJob'),
  require('./src/core/jobs/korapayVerificationJob'),
  require('./src/core/jobs/pawapayVerificationJob'),
  require('./src/core/jobs/cinetpayVerificationJob')
];
const fcmTokenHygieneJob = require('./src/jobs/fcmTokenHygieneJob');

async function startServer() {
  await connectDB();
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(process.env.PORT || 4501, '0.0.0.0', () => resolve(listening));
    listening.once('error', reject);
  });
  for (const job of paymentJobs) job.start();
  fcmTokenHygieneJob.start();
  logger.info('Predictfoot HTTP and payment recovery jobs started');
  return server;
}

if (require.main === module) {
  startServer().catch(() => {
    logger.error('Predictfoot startup failed; payment recovery was not fully started');
    process.exit(1);
  });
}

module.exports = { startServer };
