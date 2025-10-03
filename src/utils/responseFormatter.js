/**
 * Formate une réponse réussie
 * @param {Object} res - Objet de réponse Express
 * @param {Object} options
 * @param {Object} [options.data] - Données retournées
 * @param {string} [options.message] - Message de succès
 * @param {number} [options.statusCode=200] - Code HTTP
 * @param {Object} [options.pagination] - Pagination (facultatif)
 */
const formatSuccess = (res, { data, message, statusCode = 200, pagination }) => {
  const response = {
    success: true,
    ...(message && { message }),
    ...(data !== undefined && { data }),
    ...(pagination && { pagination })
  };

  res.status(statusCode).json(response);
};

/**
 * Formate une réponse d'erreur
 * @param {Object} res - Objet de réponse Express
 * @param {Object} options
 * @param {string} options.message - Message d'erreur
 * @param {number} [options.statusCode=500] - Code HTTP
 * @param {Object} [options.errors] - Détails supplémentaires (champ invalide, etc.)
 * @param {string} [options.stack] - Stack trace (affichée si NODE_ENV=development)
 */
const formatError = (res, { message, statusCode = 500, errors, stack }) => {
  const response = {
    success: false,
    error: message,
    ...(errors && { errors }),
    ...(stack && process.env.NODE_ENV === 'development' && { stack })
  };

  res.status(statusCode).json(response);
};

module.exports = {
  formatSuccess,
  formatError
};
