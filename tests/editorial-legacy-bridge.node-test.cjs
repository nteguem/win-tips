const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const bridge = require('../src/api/services/common/editorialLegacyBridge');
const mapping = [{ system: 'bigwin', appId: 'bigwin', categoryId: 'actual-source-category' }];
const category = (overrides = {}) => ({ _id: 'a'.repeat(24), isVip: false, isActive: true, name: { fr: 'Journal' }, description: { fr: 'Edition' },
  editorialSource: 'rdj_petit_journal', externalSources: mapping, ...overrides });
const request = (changes = {}) => ({ query: { isVip: 'false', lang: 'fr' }, params: { id: 'real-ticket' }, headers: {}, ...changes });
const response = () => ({ code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
async function withFlag(value, action) {
  const old = process.env.WINTIPS_EDITORIAL_LEGACY_BRIDGE;
  try { if (value === undefined) delete process.env.WINTIPS_EDITORIAL_LEGACY_BRIDGE; else process.env.WINTIPS_EDITORIAL_LEGACY_BRIDGE = value; return await action(); }
  finally { if (old === undefined) delete process.env.WINTIPS_EDITORIAL_LEGACY_BRIDGE; else process.env.WINTIPS_EDITORIAL_LEGACY_BRIDGE = old; }
}
function load(relative, mocks) {
  const module = { exports: {} }, file = path.join(__dirname, '..', relative);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, process, console: { log() {}, error() {} }, require: key => {
    if (!(key in mocks)) throw new Error('Unexpected dependency: ' + key); return mocks[key];
  } }, { filename: file }); return module.exports;
}
function coupons(cat) {
  const ticket = { _id: 'real-ticket', category: cat, isVisible: true, predictions: [], date: new Date('2026-10-22T12:00:00Z'), status: 'pending' };
  const state = { access: false };
  const controller = load('src/api/controllers/user/couponController.js', {
    '../../services/common/ticketService': { getTickets: async () => ({ data: [ticket], pagination: {} }), getTicketById: async () => ticket, getTicketsByDateRange: async () => [ticket] },
    '../../services/user/subscriptionService': { getUserVipCategories: async () => state.access ? [cat] : [], hasAccessToCategory: async () => state.access, getActiveSubscriptions: async () => [] },
    '../../services/common/accessGateService': { categoryIsGated: value => !!value.accessGate, countCategoryUnlocks: async () => new Map(), publicOption: value => value, buildState: () => null },
    '../../models/common/UserAccessUnlock': { find: async () => [] },
    '../../models/common/Category': { pickLang: value => typeof value === 'string' ? value : value && value.fr },
    '../../services/common/editorialLegacyBridge': bridge,
  }); return { controller, ticket, state };
}

test('bridge is opt-in, requires a retained mapping and never affects legacy-only categories', async () => {
  await withFlag(undefined, () => { assert.equal(bridge.pauseLegacyImports(category()), true); assert.equal(bridge.showLegacyTicket(category(), request()), false); });
  await withFlag('false', () => assert.equal(bridge.applies(category()), false));
  await withFlag('true', () => {
    assert.equal(bridge.applies(category()), true); assert.equal(bridge.pauseLegacyImports(category()), false);
    assert.equal(bridge.applies(category({ externalSources: [] })), false);
    assert.equal(bridge.showLegacyTicket(category({ externalSources: [] }), request()), false);
    assert.equal(bridge.pauseLegacyImports(category({ editorialSource: null })), false);
    assert.equal(bridge.showLegacyTicket(category({ editorialSource: null }), request()), true);
  });
});
test('capability changes presentation only and cannot grant bridged VIP access', async () => {
  await withFlag('true', () => {
    const free = category(), vip = category({ isVip: true, editorialSource: 'rdj_football_analysis' });
    assert.equal(bridge.showLegacyTicket(free, request()), true);
    assert.equal(bridge.showLegacyTicket(free, request({ headers: { 'x-wintips-editorial': '1' } })), false);
    assert.equal(bridge.showLegacyTicket(vip, request({ query: {} })), false);
    assert.equal(bridge.showLegacyTicket(vip, request({ query: { isVip: 'true' } })), false);
    assert.equal(bridge.showLegacyTicket(vip, request({ user: { _id: 'reader' }, query: { isVip: 'true' } })), true);
    assert.equal(bridge.showLegacyTicket(vip, request({ user: { _id: 'reader' }, query: { isVip: 'true' }, headers: { 'x-wintips-editorial': '1' } })), false);
  });
});
test('old free client receives the real legacy coupon; capable client receives no duplicate', async () => {
  await withFlag('true', async () => {
    const { controller } = coupons(category()); let res = response(); await controller.getCoupons(request(), res);
    assert.equal(res.code, 200); assert.equal(res.body.data.categories[0].coupons[0].id, 'real-ticket');
    res = response(); await controller.getCoupons(request({ headers: { 'x-wintips-editorial': '1' } }), res);
    assert.equal(res.body.data.categories.length, 0);
  });
});
test('bridged list/detail VIP checks remain server-side, including omitted-isVip protection', async () => {
  await withFlag('true', async () => {
    const pair = coupons(category({ isVip: true, editorialSource: 'rdj_football_analysis' })); const req = request({ user: { _id: 'reader' }, query: { isVip: 'true' } });
    let res = response(); await pair.controller.getCoupons(req, res); assert.equal(res.body.data.categories.length, 0);
    res = response(); await pair.controller.getCouponById(req, res); assert.equal(res.code, 403);
    pair.state.access = true; res = response(); await pair.controller.getCoupons(req, res); assert.equal(res.body.data.categories.length, 1);
    res = response(); await pair.controller.getCouponById(req, res); assert.equal(res.code, 200);
    res = response(); await pair.controller.getCoupons(request({ query: {} }), res); assert.equal(res.body.data.categories.length, 0);
  });
});
test('free rewarded gate stays locked for an old reader while the bridge is active', async () => {
  await withFlag('true', async () => {
    const pair = coupons(category({ accessGate: { options: [{ adsRequired: 1, durationMinutes: 60 }] } }));
    pair.ticket.predictions = [{ _id: 'real-prediction', odds: 1.5, status: 'pending', sport: 'football', event: { label: { fr: 'Protected pick' } }, matchData: {} }];
    const res = response(); await pair.controller.getCoupons(request(), res);
    const coupon = res.body.data.categories[0].coupons[0]; assert.equal(coupon.locked, true); assert.equal(coupon.predictions[0].event, null);
    assert.equal(JSON.stringify(coupon).includes('Protected pick'), false);
  });
});
test('old history remains readable; capability header continues to mask editorial legacy history', async () => {
  await withFlag('true', async () => {
    const pair = coupons(category()); let res = response(); await pair.controller.getTicketsHistory(request(), res);
    assert.equal(res.code, 200); assert.ok(JSON.stringify(res.body).includes('real-ticket'));
    res = response(); await pair.controller.getTicketsHistory(request({ headers: { 'x-wintips-editorial': '1' } }), res);
    assert.equal(JSON.stringify(res.body).includes('real-ticket'), false);
  });
});
test('three mapped sync operations resume only when bridge is enabled; bridged publication is silent', async () => {
  let writes = 0, quiet = 0, normalPublish = 0;
  const doc = { _id: 'real-ticket', category: 'real-category', editorialSource: 'rdj_petit_journal', externalSources: mapping };
  const query = () => ({ select() { return this; }, lean: async () => doc, then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject) });
  const controller = load('src/api/controllers/common/internalSyncController.js', {
    '../../services/common/ticketService': { createTicket: async () => { writes++; return doc; }, updateTicket: async () => { normalPublish++; return doc; } },
    '../../services/common/predictionService': { addPredictionsToTicket: async () => { writes++; return []; } },
    '../../models/common/Category': { findOne: query, findById: query },
    '../../models/common/Ticket': { findById: query, updateOne: async (filter, update) => { assert.equal(filter._id, 'real-ticket'); assert.equal(update.$set.isVisible, true); quiet++; } },
    '../../services/common/editorialLegacyBridge': bridge,
    '../../../utils/responseFormatter': { formatSuccess: (res, body) => res.json(body), formatError: () => { throw new Error('Unexpected sync failure'); } },
  });
  const req = { params: { id: 'real-ticket' }, body: { sourceAppId: 'bigwin', sourceCategoryId: 'actual-source-category', title: 'Legacy', date: '2026-10-23', predictions: [{}] } };
  await withFlag('true', async () => {
    for (const method of ['createTicket', 'bulkPredictions', 'publishTicket']) await controller[method](req, response());
    assert.equal(writes, 2); assert.equal(quiet, 1); assert.equal(normalPublish, 0);
  });
  await withFlag(undefined, async () => {
    for (const method of ['createTicket', 'bulkPredictions', 'publishTicket']) { const res = response(); await controller[method](req, res); assert.equal(res.body.data.ignored, true); }
    assert.equal(writes, 2); assert.equal(quiet, 1);
  });
});
