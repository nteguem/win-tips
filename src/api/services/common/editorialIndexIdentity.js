// Pure, shared index-definition comparison. Server metadata such as v/ns is
// intentionally ignored; options changing coverage, equality or expiry are not.
const REVIEW_IDENTITY_INDEX = Object.freeze({
  key: Object.freeze({ categoryId: 1, editionDate: 1, userId: 1 }),
  name: 'editorial_review_reader_edition_unique', unique: true,
});
const OPENING_IDENTITY_INDEX = Object.freeze({
  key: Object.freeze({ categoryId: 1, editionDate: 1, openingId: 1 }),
  name: 'editorial_opening_edition_action_unique', unique: true,
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function matchesIndexDefinition(index, spec) {
  if (!index || !spec || index.name !== spec.name || !same(index.key, spec.key)) return false;
  for (const flag of ['unique', 'sparse', 'hidden']) {
    if (own(index, flag) && typeof index[flag] !== 'boolean') return false;
    if ((index[flag] === true) !== (spec[flag] === true)) return false;
  }
  for (const option of ['partialFilterExpression', 'collation', 'expireAfterSeconds', 'wildcardProjection']) {
    if (!same(index[option], spec[option])) return false;
  }
  return true;
}
module.exports = { REVIEW_IDENTITY_INDEX, OPENING_IDENTITY_INDEX, matchesIndexDefinition };
