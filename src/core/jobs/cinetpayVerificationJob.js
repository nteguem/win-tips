const cron = require('node-cron');
const verificationService = require('../../api/services/user/cinetpayVerificationService');

let task = null;

function start() {
  if (!task) {
    task = cron.schedule('*/2 * * * *', async () => {
      try {
        await verificationService.verifyAllPendingTransactions();
      } catch (error) {
        console.error('[CinetpayVerificationJob] Recovery failed:', error.code || error.name || 'ERROR');
      }
    });
  }
  return task;
}

function stop() {
  if (task) task.stop();
  task = null;
}

module.exports = { start, stop };
