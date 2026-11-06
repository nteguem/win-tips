// Private durable receipt inbox, lazily configured after dotenv startup.
const { createInbox } = require('../../../core/rewardedSsvInbox');
const verifier = require('./admobSsvService');
const accessGate = require('./accessGateService');
const logger = require('../../../utils/logger');
let inbox;
function current() {
  if (!inbox) inbox = createInbox({
    directory: process.env.ADMOB_SSV_INBOX_DIR || '/var/lib/wintips-admob-ssv',
    verifyCallback: raw => verifier.verifyCallback(raw),
    recordReward: reward => accessGate.recordVerifiedReward(reward),
    logger,
  });
  return inbox;
}
module.exports = {
  receive: raw => current().receive(raw),
  start: () => current().start(),
  stop: () => { if (inbox) inbox.stop(); },
};
