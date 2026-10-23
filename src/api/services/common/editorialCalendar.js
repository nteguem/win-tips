// Publisher edition dates use the same calendar as the RDJ collectors.
// Kickoff values remain verified UTC timestamps, never publication dates.
const EDITION_TIMEZONE = 'Europe/Paris';
const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: EDITION_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
function editionDateFor(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid editorial clock');
  const fields = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
module.exports = { EDITION_TIMEZONE, editionDateFor };
