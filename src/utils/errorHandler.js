/**
 * @fileoverview Gestionnaire d'erreurs centralisé
 */
const logger = require('./logger');
const { formatError } = require('./responseFormatter');

/**
 * Classe personnalisée pour les erreurs de l'application
 */
class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Middleware de gestion des erreurs
 */
const errorHandler = (err, req, res, next) => {
  // Log de l'erreur
  logger.error(`${err.name || 'Error'}: ${err.message}`, { 
    path: req.path,
    method: req.method,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
  
  // Déterminer le code d'état HTTP
  const statusCode = err.statusCode || 500;
  
  // Formater la réponse d'erreur
  formatError(res, {
    statusCode,
    message: err.message || 'Internal Server Error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
};

module.exports = {
  AppError,
  errorHandler
};