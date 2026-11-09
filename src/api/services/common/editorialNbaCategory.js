'use strict';
// Dedicated NBA editions belong to the five BigWin-family apps, not WinTips.
// Keep stable identifiers for historical receipts; activation is disabled.
const { stableId } = require('./editorialCataloguePlan');
const SOURCE = 'rdj_nba';
const ID = stableId('category:basketusa_nba');
function disabled() {
  throw Object.assign(new Error('Dedicated sport journals are outside WinTips scope'), { code: 'SPORT_SOURCES_DISABLED_FOR_WINTIPS' });
}
module.exports = { SOURCE, ID, createNbaCategoryPlan: disabled, verifyNbaCategoryPlan: disabled };
