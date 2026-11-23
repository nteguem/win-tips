const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CURRENCY_TO_XAF, toXAF } = require('../src/utils/currency');
const reference = require('../src/utils/currency-reference.json');

test('Swiss Google Play sale is included alongside a Mobile Money sale', () => {
  assert.equal(toXAF(2.1, 'CHF'), 1493);
  assert.equal(toXAF(1000, 'XOF') + toXAF(2.1, 'CHF'), 2493);
});

test('all checkout currencies configured for the current VIP offer are convertible', () => {
  const currencies = 'XAF XOF EUR USD CDF GHS GMD GNF KES LSL MWK MZN NGN RWF SLE TZS UGX ZAR ZMW AED ARS AUD AZN BDT BOB BRL CAD CHF CLP COP CRC CZK DKK DZD EGP ETB GBP GEL HKD HUF IDR ILS INR IQD JOD JPY KRW KZT LKR MAD MMK MNT MOP MXN MYR NOK NZD PEN PHP PKR PLN PYG QAR RON RSD RUB SAR SEK SGD THB TRY TWD UAH UZS VND'.split(' ');
  for (const currency of currencies) {
    assert.ok(Number.isFinite(CURRENCY_TO_XAF[currency]) && CURRENCY_TO_XAF[currency] > 0, currency);
    assert.ok(toXAF(1000, currency) > 0, currency);
  }
});

test('legacy conversion rates, CFA parity and null amounts stay unchanged', () => {
  assert.equal(toXAF(1000, 'XAF'), 1000);
  assert.equal(toXAF(1000, 'XOF'), 1000);
  assert.equal(toXAF(10, 'USD'), 6150);
  assert.equal(toXAF(10, 'EUR'), 6560);
  assert.equal(toXAF(100, 'ngn'), 38);
  assert.equal(toXAF(0, 'CHF'), 0);
  assert.equal(toXAF(null, 'CHF'), 0);
});

test('reference data is finite, dated and attributed; all configured schema currencies have a rate', () => {
  assert.equal(reference.source, 'https://www.exchangerate-api.com');
  assert.equal(reference.base, 'USD');
  assert.ok(Number.isFinite(Date.parse(reference.asOf)));
  for (const [currency, rate] of Object.entries(reference.rates)) {
    assert.match(currency, /^[A-Z]{3}$/);
    assert.ok(Number.isFinite(rate) && rate > 0, currency);
  }
  const schema = fs.readFileSync(path.join(__dirname, '../src/api/models/common/Subscription.js'), 'utf8');
  const block = schema.match(/currency:\s*\{[\s\S]*?\n\s*\}/)[0];
  for (const [, currency] of block.matchAll(/'([A-Z]{3})'/g)) {
    assert.ok(CURRENCY_TO_XAF[currency] > 0, currency);
  }
});
