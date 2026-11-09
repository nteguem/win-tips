'use strict';
// Old activation commands must also refuse previously saved plans.
function disabled() {
  throw Object.assign(new Error('Dedicated sport journals are outside WinTips scope'), { code: 'SPORT_SOURCES_DISABLED_FOR_WINTIPS' });
}
module.exports = { createRdjSportsCategoryPlan: disabled, verifyRdjSportsCategoryPlan: disabled };
