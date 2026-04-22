/**
 * @fileoverview Point d'entrée de l'application
 */
const dotenv = require('dotenv');
const app = require('./src/app');
const logger = require('./src/utils/logger');
const { connectDB } = require('./config/database');
const smobilpayVerificationJob = require('./src/core/jobs/smobilpayVerificationJob');
const korapayVerificationJob = require('./src/core/jobs/korapayVerificationJob');

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
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};


// Démarrer le serveur
startServer();
