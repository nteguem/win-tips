'use strict';
// Add one optional NBA family. Existing categories/packages are never rewritten.
const { VERSION, stableId, hash, idOf, verifyPlan } = require('./editorialCataloguePlan');
const SOURCE = 'rdj_nba';
const ID = stableId('category:basketusa_nba');
const KEY = VERSION + ':category:basketusa_nba';
const fail = code => { throw Object.assign(new Error(code), { code }); };

function createNbaCategoryPlan(state, now = new Date().toISOString()) {
  const categories = state.categories || [];
  const current = categories.filter(row => row.editorialSource === SOURCE || row.catalogueKey === KEY);
  if (current.length > 1) fail('NBA_CATEGORY_DUPLICATE');
  if (current.length && (current[0].editorialSource !== SOURCE || current[0].isVip !== false ||
      current[0].isActive !== true || current[0].catalogueArchived === true)) fail('NBA_CATEGORY_REQUIRES_REVIEW');
  const operations = [];
  if (!current.length) {
    if (categories.some(row => idOf(row._id) === ID)) fail('NBA_CATEGORY_ID_CONFLICT');
    operations.push({ collection: 'categories', id: ID, before: null, after: {
      _id: { $oid: ID }, catalogueKey: KEY, name: { fr: 'NBA du jour', en: 'NBA Today' },
      description: { fr: 'Les rencontres NBA et leurs analyses pour composer tes coupons.',
        en: 'NBA matchups and analysis to build your own picks.' }, icon: '\u{1f3c0}',
      isVip: false, isActive: true, editorialSource: SOURCE, accessGate: null, catalogueArchived: false,
      successRate: null, externalSources: [], createdAt: { $date: now }, updatedAt: { $date: now },
    }, reason: 'create_optional_nba_category' });
  }
  const plan = { version: VERSION, appId: 'wintips', databaseName: state.databaseName || 'wintips', readOnly: true,
    purpose: 'add_optional_nba_only', targetCategoryIds: { [SOURCE]: current.length ? idOf(current[0]._id) : ID },
    targetCounts: { categories: 1, packages: 0 }, operations, notificationsSent: false,
    entitledUsersModified: false, legacyRightsPreserved: true, existingPricesModified: false };
  return { ...plan, planHash: hash(plan) };
}

function verifyNbaCategoryPlan(plan, confirmHash) {
  verifyPlan(plan, confirmHash);
  if (plan.purpose !== 'add_optional_nba_only' || plan.operations.length > 1 || plan.existingPricesModified !== false ||
      plan.operations.some(op => op.collection !== 'categories' || op.id !== ID || op.before !== null ||
        op.reason !== 'create_optional_nba_category' || op.after.editorialSource !== SOURCE || op.after.isVip !== false ||
        op.after.isActive !== true || op.after.accessGate !== null || op.after.catalogueKey !== KEY)) fail('NBA_PLAN_SCOPE_INVALID');
  return plan;
}

module.exports = { SOURCE, ID, createNbaCategoryPlan, verifyNbaCategoryPlan };
