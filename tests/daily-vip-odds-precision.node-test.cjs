const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDailyVip, POLICY, SOURCE } = require('../src/api/services/common/dailyVipValidation');
const { validateBatch } = require('../src/api/services/common/editorialValidation');

const edition = '2026-11-19';
function fixture(odds = [1.625, 2], totalOdds = 3.25) {
  const legs = odds.map((odd, index) => {
    const id = 10001 + index, predictionUrl = `https://www.sportytrader.com/pronostics/test-${id}/`;
    return { source: SOURCE, sourceId: `sp${id}`, sourceUrl: predictionUrl,
      editionDate: edition, kind: 'match', status: 'upcoming',
      title: { fr: `Equipe ${index} A - Equipe ${index} B`, en: `Team ${index} A - Team ${index} B` },
      summary: { fr: '', en: '' }, analysis: { fr: [], en: [] },
      startsAtUtc: `${edition}T${19 + index}:00:00.000Z`, sport: { key: 'football', name: 'Football' },
      competition: { name: 'Competition' },
      teams: { home: { name: `Team ${index} A` }, away: { name: `Team ${index} B` } },
      selection: { betType: 'match_winner', label: { fr: 'Victoire domicile', en: 'Home win' }, odds: odd },
      provenance: { predictionUrl, oddsUrl: `https://www.sportytrader.com/cotes/test-${id}/`,
        observedAtUtc: `${edition}T10:50:00.000Z`, market: 'Home win', eventClockSourceUrl: predictionUrl } };
  });
  return { source: SOURCE, sourceId: `daily-vip-${edition}`, sourceUrl: 'https://www.sportytrader.com/pronostics/',
    editionDate: edition, kind: 'combine', status: 'upcoming',
    title: { fr: 'Combine du jour', en: 'Daily Accumulator' }, summary: { fr: '', en: '' }, analysis: { fr: [], en: [] },
    startsAtUtc: legs[0].startsAtUtc, sport: { key: 'multisport', name: 'Multisport' }, competition: {},
    selection: { betType: 'accumulator', label: { fr: 'Combine', en: 'Accumulator' }, totalOdds }, legs,
    dailyVip: { version: 1, publisher: 'SportyTrader', bookmaker: 'Unibet',
      observedAtUtc: `${edition}T10:50:00.000Z`, policy: { ...POLICY }, result: { status: 'pending' } } };
}
function normalize(input) { return normalizeDailyVip(input, edition); }

test('quoted three-decimal odds are preserved and multiplied before final display rounding', () => {
  const item = normalize(fixture());
  assert.deepEqual(item.legs.map(leg => leg.selection.odds), [1.625, 2]);
  assert.equal(item.selection.totalOdds, 3.25);
  assert.deepEqual(item.legs[0].provenance, fixture().legs[0].provenance);
  const batch = validateBatch({ source: SOURCE, editionDate: edition, items: [fixture()] },
    new Date(`${edition}T11:00:00.000Z`));
  assert.equal(batch.items[0].legs[0].selection.odds, 1.625);
  assert.equal(batch.items[0].selection.totalOdds, 3.25);
});

test('verified tennis correct-score picks retain their exact nonempty bilingual label and provenance', () => {
  const input = fixture([2.1, 1.6], 3.36), leg = input.legs[0];
  leg.sport = { key: 'tennis', name: 'Tennis' };
  leg.selection.betType = 'correct_score';
  leg.selection.label = { fr: 'Ben Shelton gagne 2-0', en: 'Ben Shelton wins 2-0' };
  leg.provenance.market = leg.selection.label.fr;
  const normalized = normalize(input).legs[0];
  assert.deepEqual(normalized.selection, leg.selection);
  assert.deepEqual(normalized.provenance, leg.provenance);
  for (const lang of ['fr', 'en']) {
    const empty = structuredClone(input); empty.legs[0].selection.label[lang] = '';
    assert.throws(() => normalize(empty), { statusCode: 400 });
  }
  leg.sport = { key: 'football', name: 'Football' };
  assert.throws(() => normalize(input), { statusCode: 400 });
});

test('existing two-decimal odds and total contract remain unchanged', () => {
  for (const [odds, total] of [[[1.6, 2], 3.2], [[1.5, 2], 3], [[1.75, 2], 3.5]]) {
    const input = fixture(odds, total), item = normalize(input);
    assert.deepEqual(item.legs.map(leg => leg.selection.odds), odds);
    assert.deepEqual(item.selection, input.selection);
  }
});

test('half-cent final products use exact decimal half-up rounding', () => {
  assert.equal(normalize(fixture([1.202, 2.5], 3.01)).selection.totalOdds, 3.01);
  assert.throws(() => normalize(fixture([1.202, 2.5], 3)), { statusCode: 400 });
  assert.equal(normalize(fixture([1.399, 2.5], 3.5)).selection.totalOdds, 3.5);
});

test('three legs retain all quoted decimals until the final rounding', () => {
  const input = fixture([1.111, 1.5, 2], 3.33), item = normalize(input);
  assert.deepEqual(item.legs.map(leg => leg.selection.odds), [1.111, 1.5, 2]);
  assert.equal(item.selection.totalOdds, 3.33);
  assert.equal(normalize(fixture([1.001, 1.499, 2], 3)).selection.totalOdds, 3);
});

test('real products below three stay outside policy even when display would round to three', () => {
  for (const odds of [[1.5, 1.999], [1.001, 1.001, 2.994]]) {
    assert.throws(() => normalize(fixture(odds, 3)), { statusCode: 400 });
  }
});

test('real products above three point five stay outside policy despite display rounding', () => {
  assert.throws(() => normalize(fixture([1.75, 2.001], 3.5)), { statusCode: 400 });
  assert.throws(() => normalize(fixture([100, 100, 100], 3.5)), { statusCode: 400 });
});

test('invented extra precision, malformed values and non-source numeric types remain invalid', () => {
  for (const odd of [1.6251, 1.6250000000000002, 1.0001, 0, 1, -1, NaN, Infinity, -Infinity, 100.001,
    '1.625', null, undefined, {}, [], new Number(1.625)]) {
    const input = fixture(); input.legs[0].selection.odds = odd;
    assert.throws(() => normalize(input), { statusCode: 400 }, String(odd));
  }
});

test('the coupon total still requires at most two decimals and the exact rounded product', () => {
  for (const total of [3.251, 3.2500000000000004, 3.24, 3.26, '3.25', NaN, Infinity, 0]) {
    assert.throws(() => normalize(fixture([1.625, 2], total)), { statusCode: 400 }, String(total));
  }
});

test('unknown coupon, leg, selection and provenance fields remain rejected', () => {
  for (const mutate of [input => { input.extra = true; }, input => { input.legs[0].extra = true; },
    input => { input.selection.odds = 3.25; }, input => { input.legs[0].selection.totalOdds = 1.625; },
    input => { input.legs[0].provenance.extra = true; }, input => { input.dailyVip.extra = true; }]) {
    const input = fixture(); mutate(input);
    assert.throws(() => normalize(input), { statusCode: 400 });
  }
});

test('integer milli-odds validation agrees with an independent BigInt decimal oracle', () => {
  const values = [1001, 1125, 1202, 1250, 1333, 1499, 1500, 1501, 1599, 1625, 1750, 1999, 2000, 2001, 2500, 3500];
  const check = units => {
    const numerator = units.reduce((product, unit) => product * BigInt(unit), 1n);
    const denominator = 1000n ** BigInt(units.length);
    const hundredths = (numerator * 100n + denominator / 2n) / denominator;
    const input = fixture(units.map(unit => unit / 1000), Number(hundredths) / 100);
    if (numerator >= 3n * denominator && numerator <= 7n * denominator / 2n) {
      assert.equal(normalize(input).selection.totalOdds, Number(hundredths) / 100, units.join(' x '));
    } else {
      assert.throws(() => normalize(input), { statusCode: 400 }, units.join(' x '));
    }
  };
  for (const left of values) for (const right of values) check([left, right]);
  for (const left of values.slice(0, 8)) for (const middle of values.slice(0, 8))
    for (const right of values.slice(0, 8)) check([left, middle, right]);
});
