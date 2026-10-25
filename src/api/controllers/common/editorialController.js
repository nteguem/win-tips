const { getEditorialService } = require('../../services/common/editorialService');

function handler(action, getService = getEditorialService) {
  return async (req, res) => {
    // Access, own reviews and rewarded-gate state vary by reader. Intermediary
    // caches must never reuse an entitled response for another installation.
    if (typeof res.set === 'function') res.set('Cache-Control', 'private, no-store');
    try { res.status(200).json({ success: true, data: await action(getService(), req) }); }
    catch (error) {
      const code = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      const codes = { 400: 'VALIDATION_ERROR', 401: 'AUTH_TOKEN_MISSING', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 503: 'SERVICE_UNAVAILABLE' };
      res.status(code).json({ success: false, error: {
        code: code < 500 && typeof error.errorCode === 'string' ? error.errorCode : (codes[code] || 'INTERNAL_ERROR'),
        message: code < 500 ? error.message : 'Contenu editorial indisponible',
      } });
    }
  };
}
function language(req) { return req.query.lang || req.headers['x-language'] || req.headers['accept-language']?.slice(0, 2) || 'fr'; }

function createEditorialController(service) {
  const getService = typeof service === 'function' ? service : () => service;
  return {
    catalog: handler(service => service.catalog(), getService),
    workerConfig: handler(service => service.workerConfig(), getService),
    importBatch: handler((service, req) => service.importBatch(req.body), getService),
    drainNotifications: handler((service, req) => service.drainNotifications(req.body), getService),
    feed: handler((service, req) => {
  if (req.query.isVip !== undefined && !['true', 'false'].includes(req.query.isVip)) {
    const error = new Error('isVip doit etre true ou false'); error.statusCode = 400; throw error;
  }
  return service.feed({ isVip: req.query.isVip === 'true', date: req.query.date, lang: language(req), user: req.user });
    }, getService),
    analysis: handler((service, req) => service.analysis(req.params.id, { lang: language(req), user: req.user }), getService),
    library: handler((service, req) => {
      if (req.query.isVip !== undefined && !['true', 'false'].includes(req.query.isVip)) {
        const error = new Error('isVip doit etre true ou false'); error.statusCode = 400; throw error;
      }
      return service.library({ isVip: req.query.isVip === 'true', date: req.query.date, lang: language(req), user: req.user });
    }, getService),
    edition: handler((service, req) => service.edition(req.params.categoryId, req.params.date, { lang: language(req), user: req.user }), getService),
    content: handler((service, req) => service.content(req.params.categoryId, req.params.date, { lang: language(req), user: req.user }), getService),
    reviews: handler((service, req) => service.reviews(req.params.categoryId, req.params.date, { page: req.query.page, limit: req.query.limit, user: req.user }), getService),
    putReview: handler((service, req) => service.putReview(req.params.categoryId, req.params.date, req.body, { lang: language(req), user: req.user }), getService),
  };
}
Object.assign(exports, createEditorialController(getEditorialService), { createEditorialController });
