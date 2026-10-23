// Keep the production RapidAPI transport working while retaining main's
// API-Sports migration. An explicit selector never silently changes provider.
const HOSTS = Object.freeze({
  football: ['api-football-v1.p.rapidapi.com/v3', 'v3.football.api-sports.io'],
  basketball: ['api-basketball.p.rapidapi.com', 'v1.basketball.api-sports.io'],
  rugby: ['api-rugby.p.rapidapi.com', 'v1.rugby.api-sports.io'],
  handball: ['api-handball.p.rapidapi.com', 'v1.handball.api-sports.io'],
  volleyball: ['api-volleyball.p.rapidapi.com', 'v1.volleyball.api-sports.io'],
  baseball: ['api-baseball.p.rapidapi.com', 'v1.baseball.api-sports.io'],
  hockey: ['api-hockey.p.rapidapi.com', 'v1.hockey.api-sports.io'],
});
const configured = value => typeof value === 'string' && value.trim().length > 0;

function transportFor(sport, env = process.env) {
  if (!HOSTS[sport]) throw new Error('Unsupported sports API transport');
  const explicit = env.SPORTS_API_PROVIDER;
  if (explicit !== undefined && explicit !== '' && !['rapidapi', 'api-sports'].includes(explicit)) throw new Error('Invalid SPORTS_API_PROVIDER');
  // With both keys present keep current production behavior until the operator
  // explicitly opts in. Existing API-Sports-only deployments keep working too.
  const provider = explicit || (configured(env.RAPID_API_KEY) ? 'rapidapi' : configured(env.API_SPORTS_KEY) ? 'api-sports' : 'rapidapi');
  const baseUrl = 'https://' + HOSTS[sport][provider === 'rapidapi' ? 0 : 1];
  return { apiKey: provider === 'rapidapi' ? env.RAPID_API_KEY : env.API_SPORTS_KEY, baseUrl, host: new URL(baseUrl).hostname };
}

function headersFor(provider) {
  if (!configured(provider.apiKey)) throw new Error('Sports API credential missing for selected provider');
  const host = new URL(provider.baseUrl).hostname;
  if (host.endsWith('.p.rapidapi.com')) return { 'x-rapidapi-key': provider.apiKey, 'x-rapidapi-host': host };
  if (host.endsWith('.api-sports.io')) return { 'x-apisports-key': provider.apiKey };
  throw new Error('Unexpected sports API endpoint');
}

module.exports = { transportFor, headersFor, HOSTS };
