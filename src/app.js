/**
 * @fileoverview Configuration de l'application Express
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const logger = require('./utils/logger');
const errorHandler = require('./api/middlewares/errorMiddleware');
const routes = require('./api/routes');


// Initialisation de l'application Express
const app = express();

// Middleware essentiels
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(helmet());
app.use(cors());
app.use(cookieParser());

// Middleware de logging des requêtes
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});


// Routes de l'API
app.use('/api', routes);
app.use(errorHandler);
// Middleware pour les routes non trouvées
app.use((req, res, next) => {
  const error = new Error(`Route ${req.originalUrl} not found`);
  error.statusCode = 404;
  next(error);
});

// Gestion des signaux d'arrêt
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Export compatible avec votre structure
module.exports = app;
