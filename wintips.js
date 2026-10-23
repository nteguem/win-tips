/**
 * @fileoverview Point d'entrée de l'application
 */

// Force Node à résoudre l'IPv4 en premier pour les requêtes HTTP sortantes.
// Sans ça, sur les VPS dual-stack, Node 17+ part en IPv6 par défaut et les
// PSP qui whitelistent l'IPv4 nous refusent (CinetPay 2011 NOT_ALLOWED).
require('dns').setDefaultResultOrder('ipv4first');

const dotenv = require('dotenv');
const app = require('./src/app');
const logger = require('./src/utils/logger');
const { connectDB } = require('./config/database');
const smobilpayVerificationJob = require('./src/core/jobs/smobilpayVerificationJob');
const korapayVerificationJob = require('./src/core/jobs/korapayVerificationJob');
const pawapayVerificationJob = require('./src/core/jobs/pawapayVerificationJob');
const googlePlaySyncJob = require('./src/jobs/googlePlaySyncJob');
const PredictionCronService = require('./src/api/services/common/predictionCorrectionService');
// Migration FCM : purge les tokens que FCM ne signale jamais comme morts —
// il renvoie un succes apparent sur une registration « stale », ce qui gonfle
// artificiellement le taux de livraison.
const fcmTokenHygieneJob = require('./src/jobs/fcmTokenHygieneJob');

// Instance du cron de correction des pronostics. Chaque cycle corrige les
// pronostics encore 'pending' puis recalcule en cascade le résultat consolidé
// des tickets concernés (via ticketCorrectionService).
const predictionCronService = new PredictionCronService();

// Chargement des variables d'environnement
dotenv.config();

const PORT = process.env.PORT || 4501;

/**
 * Démarre le serveur après initialisation
 */
const startServer = async () => {
  try {
    // Connexion à la base de données
    await connectDB();

    // Démarrer le serveur HTTP
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server started and listening on port ${PORT}`);
    });

    // Démarrer les jobs de fond (après DB et HTTP prêts)
    smobilpayVerificationJob.start();
    korapayVerificationJob.start();
    pawapayVerificationJob.start();
    // Jobs Google Play : synchro des abonnements, nettoyage des abonnements
    // expirés (Mobile Money + Google Play) et acknowledge d'urgence des achats
    // non confirmés (sinon Google rembourse automatiquement après 3 jours).
    googlePlaySyncJob.start();
    fcmTokenHygieneJob.start();

    // Cron de correction des pronostics (et cascade sur les tickets).
    // Tourne une seule fois par jour à 5h UTC.
    await predictionCronService.start();
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};


// Démarrer le serveur
startServer();
