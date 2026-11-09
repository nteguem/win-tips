'use strict';
const { VERSION, stableId, hash, idOf, verifyPlan } = require('./editorialCataloguePlan');
const LEGACY = 'basketusa_nba';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const SPECS = [
  { source: 'rdj_nba', old: LEGACY, id: stableId('category:' + LEGACY), key: VERSION + ':category:' + LEGACY,
    name: { fr: 'NBA du jour', en: 'NBA Today' }, icon: '\u{1f3c0}',
    description: { fr: 'Les rencontres NBA et leurs analyses pour composer tes coupons.', en: 'NBA matchups and analysis to build your own picks.' } },
  { source: 'rdj_tennis', id: stableId('category:rdj_tennis'), key: VERSION + ':category:rdj_tennis',
    name: { fr: 'Tennis du jour', en: 'Tennis Today' }, icon: '\u{1f3be}',
    description: { fr: 'Les rencontres de tennis et leurs analyses pour composer tes coupons.', en: 'Tennis matches and analysis to build your own picks.' } },
];
function createRdjSportsCategoryPlan(state, now = new Date().toISOString()) {
  const categories = state.categories || [], operations = [], targetCategoryIds = {};
  for (const spec of SPECS) {
    const current = categories.filter(row => [spec.source, spec.old].filter(Boolean).includes(row.editorialSource) || row.catalogueKey === spec.key);
    if (current.length > 1) fail('SPORT_CATEGORY_DUPLICATE');
    const before = current[0] || null;
    if (before && (before.isVip !== false || before.isActive !== true || before.catalogueArchived === true ||
        ![spec.source, spec.old].filter(Boolean).includes(before.editorialSource))) fail('SPORT_CATEGORY_REQUIRES_REVIEW');
    const id = before ? idOf(before._id) : spec.id;
    if (!before && categories.some(row => idOf(row._id) === id)) fail('SPORT_CATEGORY_ID_CONFLICT');
    targetCategoryIds[spec.source] = id;
    if (before?.editorialSource === spec.source) continue;
    // Migration changes one field only: preserve the existing category's ID,
    // name, access, BO configuration, reviews, openings and historical items.
    const after = before ? { ...before, editorialSource: spec.source } : {
      _id: { $oid: id }, catalogueKey: spec.key, name: spec.name, description: spec.description, icon: spec.icon,
      editorialSource: spec.source, isVip: false, isActive: true, accessGate: null, catalogueArchived: false,
      successRate: null, externalSources: [], createdAt: { $date: now }, updatedAt: { $date: now },
    };
    operations.push({ collection: 'categories', id, before, after, reason: before ? 'migrate_nba_publisher_preserve_category' : 'create_rdj_sport_category' });
  }
  const plan = { version: VERSION, appId: 'wintips', databaseName: state.databaseName || 'wintips', readOnly: true,
    purpose: 'rdj_sports_categories_v1', targetCategoryIds, targetCounts: { categories: 2, packages: 0 }, operations,
    notificationsSent: false, entitledUsersModified: false, legacyRightsPreserved: true, existingPricesModified: false };
  return { ...plan, planHash: hash(plan) };
}
function verifyRdjSportsCategoryPlan(plan, confirmHash) {
  verifyPlan(plan, confirmHash);
  if (plan.purpose !== 'rdj_sports_categories_v1' || plan.operations.length > 2 || plan.existingPricesModified !== false ||
      plan.operations.some(op => {
        const spec = SPECS.find(row => row.source === op.after?.editorialSource);
        if (!spec || op.collection !== 'categories' || op.id !== plan.targetCategoryIds[spec.source] || op.after.isVip !== false) return true;
        if (op.before) return spec.source !== 'rdj_nba' || op.before.editorialSource !== LEGACY ||
          op.reason !== 'migrate_nba_publisher_preserve_category' || hash(op.after) !== hash({ ...op.before, editorialSource: 'rdj_nba' });
        return op.id !== spec.id || op.reason !== 'create_rdj_sport_category' || op.after.catalogueKey !== spec.key ||
          op.after.isActive !== true || op.after.accessGate !== null || op.after.catalogueArchived !== false;
      })) fail('SPORT_PLAN_SCOPE_INVALID');
  return plan;
}
module.exports = { createRdjSportsCategoryPlan, verifyRdjSportsCategoryPlan };
