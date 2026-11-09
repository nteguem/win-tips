'use strict';
const { VERSION, hash, idOf, verifyPlan } = require('./editorialCataloguePlan');
const SOURCES = Object.freeze(['basketusa_nba', 'rdj_nba', 'rdj_tennis']);
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Withdraw only dedicated sport categories. Keep every document and all its
// references: edition content, review/opening ledgers and package rights.
function createSportWithdrawalPlan(state) {
  const categories = state.categories || [];
  const targets = categories.filter(row => SOURCES.includes(row.editorialSource));
  const operations = targets.filter(row => row.isActive !== false || row.catalogueArchived !== true).map(before => ({
    collection: 'categories', id: idOf(before._id), before,
    after: { ...before, isActive: false, catalogueArchived: true },
    reason: 'withdraw_dedicated_sports_preserve_all_documents',
  }));
  const plan = { version: VERSION, appId: 'wintips', databaseName: state.databaseName || 'wintips', readOnly: true,
    purpose: 'withdraw_dedicated_sports_from_wintips_v1',
    targetCategoryIds: Object.fromEntries(targets.map(row => [idOf(row._id), row.editorialSource])),
    targetCounts: { categories: targets.length, packages: 0 }, operations,
    notificationsSent: false, entitledUsersModified: false, legacyRightsPreserved: true,
    existingPricesModified: false, deletedDocuments: 0 };
  return { ...plan, planHash: hash(plan) };
}

function verifySportWithdrawalPlan(plan, confirmHash) {
  verifyPlan(plan, confirmHash);
  if (plan.purpose !== 'withdraw_dedicated_sports_from_wintips_v1' || plan.existingPricesModified !== false ||
      plan.deletedDocuments !== 0 || plan.operations.some(op =>
        op.collection !== 'categories' || !op.before || !SOURCES.includes(op.before.editorialSource) ||
        op.reason !== 'withdraw_dedicated_sports_preserve_all_documents' ||
        op.id !== idOf(op.before._id) || plan.targetCategoryIds[op.id] !== op.before.editorialSource ||
        hash(op.after) !== hash({ ...op.before, isActive: false, catalogueArchived: true }))) fail('SPORT_WITHDRAWAL_SCOPE_INVALID');
  return plan;
}

module.exports = { SOURCES, createSportWithdrawalPlan, verifySportWithdrawalPlan };
