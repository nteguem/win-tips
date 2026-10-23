const crypto = require('crypto');

// The token is read per request: unset configuration must always fail closed.
module.exports = function editorialWorkerAuth(req, res, next) {
  const expected = process.env.WINTIPS_EDITORIAL_WORKER_TOKEN;
  if (typeof expected !== 'string' || expected.length < 32) return res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Canal editorial non configure' } });
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  if (!provided || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID_TOKEN', message: 'Acces worker refuse' } });
  return next();
};
