/**
 * @fileoverview Service de journalisation
 */
const winston = require('winston');
const fs = require('fs');
const path = require('path');

// Assurez-vous que le dossier logs existe
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
  console.log(`Created logs directory: ${logsDir}`);
}

// Format personnalisé pour les logs
const logFormat = winston.format.printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

// Configuration du logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        logFormat
      )
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log')
    })
  ]
});

// Ajouter une méthode pour les logs de requêtes HTTP
logger.http = (message) => {
  logger.info(`[HTTP] ${message}`);
};

// Ajouter une méthode pour les logs de base de données
logger.db = (message) => {
  logger.info(`[DB] ${message}`);
};

// Ajouter une méthode pour les logs d'API
logger.api = (message) => {
  logger.info(`[API] ${message}`);
};

// Exporter le logger
module.exports = logger;