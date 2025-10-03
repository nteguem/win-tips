const { AppError, ErrorCodes } = require('../../utils/AppError');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    if (field === 'email') {
      error = new AppError('Cet email est déjà utilisé', 400, ErrorCodes.AUTH_EMAIL_EXISTS);
    } else {
      error = new AppError(`Ce ${field} existe déjà`, 400, ErrorCodes.VALIDATION_ERROR);
    }
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map(e => e.message).join(', ');
    error = new AppError(message, 400, ErrorCodes.VALIDATION_ERROR);
  }

  res.status(error.statusCode || 500).json({
    success: false,
    error: {
      code: error.errorCode || ErrorCodes.INTERNAL_ERROR,
      message: error.message || 'Erreur serveur',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
};

module.exports = errorHandler;