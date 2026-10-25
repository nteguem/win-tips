const { failure } = require('./editorialSources');

// Shared by the legacy item reader and the native edition reader. A catalogue
// preview is never evidence that the caller can read its selections.
async function editorialAccess(repository, category, user) {
  if (category.isVip === true) {
    const allowed = !!(user && await repository.hasCategoryAccess(user._id, category._id));
    return { locked: !allowed, gate: null, requiresAuth: !user };
  }
  const subscriber = !!(user && await repository.hasAnySubscription(user._id));
  const gate = await repository.gate(user && user._id, category, subscriber);
  return { locked: !!gate.locked, requiresAuth: !user && !!gate.locked,
    gate: gate.gated ? { type: 'ad_reward', offers: gate.offers, state: gate.state, unlockCount: gate.unlockCount, requiresAuth: !user } : null };
}

function requireEditorialAccess(state, category, user) {
  if (state.locked) throw failure(user ? 'Acces a cette analyse requis' : 'Authentification requise', user ? 403 : 401,
    !user ? 'AUTH_TOKEN_MISSING' : (category.isVip ? 'SUBSCRIPTION_REQUIRED' : 'RESOURCE_LOCKED'));
}

module.exports = { editorialAccess, requireEditorialAccess };
