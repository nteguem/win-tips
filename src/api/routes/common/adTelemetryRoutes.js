'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { contract, TelemetryValidationError } = require('../../../core/adTelemetry');
const { createTelemetryService } = require('../../services/common/adTelemetryService');

function failure(error, res) {
  if (error instanceof TelemetryValidationError) {
    return res.status(error.statusCode).json({ success: false, code: error.code });
  }
  // Never log/echo raw SDK data, request bodies or storage exception details.
  res.set('Retry-After', '60');
  return res.status(503).json({ success: false, code: 'AD_TELEMETRY_UNAVAILABLE' });
}

function createPublicRouter({ identifyApp, fixedAppId, service = createTelemetryService(), limiter } = {}) {
  const router = express.Router();
  router.use(limiter || rateLimit({
    windowMs: 60000, limit: contract.rateLimitBatchesPerIpPerMinute,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, code: 'AD_TELEMETRY_RATE_LIMIT' }
  }));
  // Limit before tenant/database work. The app-level parser may already exist.
  router.use((req, res, next) => {
    const declared = Number(req.get('Content-Length'));
    if (Number.isFinite(declared) && declared > contract.maxBodyBytes) return failure(new TelemetryValidationError(413), res);
    next();
  });
  router.use(express.json({ limit: contract.maxBodyBytes }));
  if (identifyApp) router.use(identifyApp);
  router.post('/batch', async (req, res) => {
    const appId = fixedAppId || req.appId;
    if (!appId) return res.status(400).json({ success: false, code: 'AD_TELEMETRY_APP_REQUIRED' });
    try {
      const rawBytes = typeof req.rawBody === 'string' ? Buffer.byteLength(req.rawBody, 'utf8') : undefined;
      const data = await service.ingest({ appId, body: req.body, rawBytes });
      res.set('Cache-Control', 'no-store');
      return res.status(202).json({ success: true, data });
    } catch (error) { return failure(error, res); }
  });
  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') return failure(new TelemetryValidationError(413), res);
    if (error instanceof SyntaxError && error.status === 400) return failure(new TelemetryValidationError(), res);
    return next(error);
  });
  return router;
}

// Authentication/authorization is mounted in routes/index.js, never public.
function createAdminRouter({ fixedAppId, service = createTelemetryService() } = {}) {
  const router = express.Router();
  router.get('/summary', async (req, res) => {
    try {
      const data = await service.summary({ query: req.query, appId: req.appId, fixedAppId });
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({ success: true, data });
    } catch (error) { return failure(error, res); }
  });
  return router;
}
module.exports = { createPublicRouter, createAdminRouter };
