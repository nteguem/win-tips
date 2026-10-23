/**
 * @fileoverview Contrôleur admin de santé système (observabilité).
 *
 * Expose une vue temps réel de l'état du serveur : ressources, base de
 * données, activité applicative récente, providers de paiement configurés,
 * jobs planifiés et dernières erreurs journalisées.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Subscription = require('../../models/common/Subscription');
const User = require('../../models/user/User');
const Prediction = require('../../models/common/Prediction');
const Ticket = require('../../models/common/Ticket');
const catchAsync = require('../../../utils/catchAsync');

const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/** Indique si au moins une variable d'environnement commence par un préfixe donné. */
function envConfigured(prefixes) {
  const keys = Object.keys(process.env);
  return prefixes.some((p) => keys.some((k) => k.toUpperCase().startsWith(p)));
}

/** Lit et parse les N dernières lignes du fichier `logs/error.log`. */
function readRecentErrors(limit = 40) {
  try {
    const file = path.join(process.cwd(), 'logs', 'error.log');
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        const m = line.match(/^(.+?)\s+(error|warn|info|fatal|debug|http):\s*([\s\S]*)$/i);
        if (m) {
          return { timestamp: m[1].trim(), level: m[2].toLowerCase(), message: m[3].slice(0, 300) };
        }
        return { timestamp: null, level: 'error', message: line.slice(0, 300) };
      });
  } catch {
    return [];
  }
}

/**
 * GET /api/admin/health
 */
exports.getSystemHealth = catchAsync(async (req, res) => {
  const now = new Date();
  const last24 = new Date(now.getTime() - 24 * 3600 * 1000);

  // ===== RESSOURCES SERVEUR =====
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();

  // ===== BASE DE DONNÉES =====
  const dbState = mongoose.connection.readyState;
  let pingMs = null;
  if (dbState === 1) {
    try {
      const t0 = Date.now();
      await mongoose.connection.db.admin().ping();
      pingMs = Date.now() - t0;
    } catch {
      pingMs = null;
    }
  }

  // ===== ACTIVITÉ APPLICATIVE =====
  const [
    usersTotal,
    users24h,
    subsTotal,
    subs24h,
    activeSubs,
    predictionsPending,
    ticketsActive,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: last24 } }),
    Subscription.countDocuments({}),
    Subscription.countDocuments({ createdAt: { $gte: last24 } }),
    Subscription.countDocuments({ status: 'active', endDate: { $gt: now } }),
    Prediction.countDocuments({ status: 'pending' }),
    Ticket.countDocuments({ status: 'active' }),
  ]);

  const recentErrors = readRecentErrors(40);
  const errorCount = recentErrors.filter((e) => e.level === 'error' || e.level === 'fatal').length;

  res.status(200).json({
    success: true,
    data: {
      generatedAt: now,
      server: {
        status: 'up',
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        env: process.env.NODE_ENV || 'development',
        platform: `${os.type()} ${os.release()}`,
        hostname: os.hostname(),
        pid: process.pid,
      },
      memory: {
        processRssMB: Math.round(mem.rss / 1048576),
        processHeapUsedMB: Math.round(mem.heapUsed / 1048576),
        processHeapTotalMB: Math.round(mem.heapTotal / 1048576),
        systemTotalMB: Math.round(totalMem / 1048576),
        systemFreeMB: Math.round(freeMem / 1048576),
        systemUsedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
      },
      cpu: {
        cores: os.cpus().length,
        model: os.cpus()[0]?.model?.trim() || 'N/A',
        load1: load[0] ? Number(load[0].toFixed(2)) : 0,
        load5: load[1] ? Number(load[1].toFixed(2)) : 0,
        load15: load[2] ? Number(load[2].toFixed(2)) : 0,
      },
      database: {
        status: MONGO_STATES[dbState] || 'unknown',
        connected: dbState === 1,
        name: mongoose.connection.name || null,
        host: mongoose.connection.host || null,
        pingMs,
      },
      activity: {
        usersTotal,
        users24h,
        subscriptionsTotal: subsTotal,
        subscriptions24h: subs24h,
        activeSubscriptions: activeSubs,
        predictionsPending,
        ticketsActive,
      },
      providers: [
        { name: 'AfribaPay', configured: envConfigured(['AFRIBAPAY']) },
        { name: 'CinetPay', configured: envConfigured(['CINETPAY']) },
        { name: 'Smobilpay', configured: envConfigured(['SMOBILPAY', 'S3P']) },
        { name: 'KoraPay', configured: envConfigured(['KORAPAY']) },
        { name: 'Google Play', configured: envConfigured(['GOOGLE_PLAY', 'GOOGLE_SERVICE', 'GOOGLE_APPLICATION']) },
        { name: 'OneSignal', configured: envConfigured(['ONESIGNAL']) },
      ],
      jobs: [
        {
          name: 'Synchronisation Google Play',
          schedule: 'Périodique',
          description: 'Synchronise les abonnements et acquitte les achats Google Play',
        },
        {
          name: 'Vérification Smobilpay',
          schedule: 'Périodique',
          description: 'Contrôle les transactions Smobilpay en attente',
        },
        {
          name: 'Vérification KoraPay',
          schedule: 'Périodique',
          description: 'Contrôle les transactions KoraPay en attente',
        },
      ],
      errors: { recentCount: errorCount, recent: recentErrors.slice(0, 20) },
    },
  });
});
