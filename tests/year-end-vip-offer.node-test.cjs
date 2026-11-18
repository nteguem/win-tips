const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const Package = require('../src/api/models/common/Package');
const { YEAR_END_PACKAGE_ID, publicVipOffer } = require('../src/api/services/common/yearEndVipOffer');

function fixture() {
  return {
    _id: YEAR_END_PACKAGE_ID, isActive: true, paymentMode: 'money', duration: 1,
    categories: [{ _id: '691b1dd577e0912523aab901', isVip: true, isActive: true }],
    pricing: { XAF: 1000, USD: 10, EUR: 10.99, GHS: 20, CDF: 3902 },
    availableOnGooglePlay: true, googleProductId: 'com.wintips.essentiel_7days_v1',
    user: { email: 'must-not-leak@example.invalid' }, protectedPicks: ['must not leak'],
  };
}

test('quotes only the active target VIP package with its exact regional amount and duration', () => {
  const pkg = fixture();
  for (const currency of Object.keys(pkg.pricing)) {
    assert.deepEqual(publicVipOffer(pkg, currency), {
      packageId: YEAR_END_PACKAGE_ID, currency, price: pkg.pricing[currency], durationDays: 1,
    });
  }
  assert.equal(publicVipOffer(pkg, 'KES'), null);
  assert.equal(publicVipOffer(pkg), null);
});

test('never advertises inactive, non-VIP, ads, unrelated or invalid offers', () => {
  for (const mutation of [
    pkg => pkg.isActive = false,
    pkg => pkg._id = 'a'.repeat(24),
    pkg => pkg.paymentMode = 'ads',
    pkg => pkg.duration = 0,
    pkg => pkg.duration = 1.5,
    pkg => pkg.categories = [],
    pkg => pkg.categories[0].isVip = false,
    pkg => pkg.categories[0].isActive = false,
    pkg => pkg.pricing.XAF = 0,
    pkg => pkg.pricing.XAF = '1000',
    pkg => pkg.pricing.XAF = 1000.2,
    pkg => pkg.pricing.XAF = NaN,
  ]) {
    const pkg = fixture(); mutation(pkg); assert.equal(publicVipOffer(pkg, 'XAF'), null);
  }
  const pkg = fixture(); pkg.availableOnGooglePlay = false;
  assert.equal(publicVipOffer(pkg, 'USD'), null);
  assert.equal(publicVipOffer(pkg, 'EUR'), null);
  assert.equal(publicVipOffer(pkg, 'XAF').price, 1000);
});

test('a reference price requires an explicit valid same-currency saving', () => {
  const pkg = fixture();
  assert.equal('previousPrice' in publicVipOffer(pkg, 'XAF'), false);
  pkg.economy = { XAF: 4000, EUR: 0 };
  assert.equal(publicVipOffer(pkg, 'XAF').previousPrice, 5000);
  assert.equal('previousPrice' in publicVipOffer(pkg, 'USD'), false);
  assert.equal('previousPrice' in publicVipOffer(pkg, 'EUR'), false);
  for (const saving of [0, -1, '4000', NaN, Infinity, 4000.2]) {
    pkg.economy = { XAF: saving };
    assert.equal('previousPrice' in publicVipOffer(pkg, 'XAF'), false);
  }
  pkg.pricing = new Map([['XAF', 1000]]);
  pkg.economy = new Map([['XAF', 4000]]);
  assert.equal(publicVipOffer(pkg, 'XAF').previousPrice, 5000);
});

test('the public route works without login and does not leak picks, users or other prices', async () => {
  const original = Package.findOne;
  let actualFilter;
  let selectedFields;
  Package.findOne = filter => {
    actualFilter = filter;
    return { select: fields => {
      selectedFields = fields.split(/\s+/);
      return { populate: () => ({ lean: async () => {
        const pkg = fixture();
        return Object.fromEntries(selectedFields.map(key => [key, pkg[key]]));
      } }) };
    } };
  };
  try {
    const app = express();
    app.use('/api/public/catalog', require('../src/api/routes/common/publicCatalogRoutes'));
    app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false }));
    const result = await request(app).get('/api/public/catalog/vip-offer?currency=XAF');
    assert.equal(result.status, 200);
    assert.ok(selectedFields.includes('pricing'));
    assert.ok(selectedFields.includes('categories'));
    assert.deepEqual(actualFilter, { _id: YEAR_END_PACKAGE_ID, isActive: true, paymentMode: { $in: ['money', null] } });
    assert.deepEqual(result.body, { success: true, data: { offer: {
      packageId: YEAR_END_PACKAGE_ID, currency: 'XAF', price: 1000, durationDays: 1,
    } } });
    assert.equal(result.headers['cache-control'], 'no-store');
    for (const suffix of ['', '?currency=XYZ', '?currency=bad-code']) {
      const response = await request(app).get('/api/public/catalog/vip-offer' + suffix);
      assert.equal(response.status, suffix === '?currency=XYZ' ? 200 : 400);
      if (suffix === '?currency=XYZ') assert.equal(response.body.data.offer, null);
    }
  } finally {
    Package.findOne = original;
  }
});
