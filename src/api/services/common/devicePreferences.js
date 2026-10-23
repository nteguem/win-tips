const { AppError, ErrorCodes } = require('../../../utils/AppError');

function locale(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 35) throw new AppError('Langue appareil invalide', 400, ErrorCodes.VALIDATION_ERROR);
  const result = value.trim().toLowerCase().split(/[-_]/)[0];
  if (!['fr', 'en'].includes(result)) throw new AppError('Langue appareil non prise en charge', 400, ErrorCodes.VALIDATION_ERROR);
  return result;
}

function preferences(data) {
  const out = {};
  const language = locale(data.appLanguage ?? data.language);
  const deviceLanguage = locale(data.deviceLanguage);
  if (language) out.language = language;
  if (deviceLanguage) out.deviceLanguage = deviceLanguage;
  if (data.notificationsEnabled !== undefined) {
    if (typeof data.notificationsEnabled !== 'boolean') throw new AppError('Preference de notification invalide', 400, ErrorCodes.VALIDATION_ERROR);
    out.notificationsEnabled = data.notificationsEnabled;
  }
  if (data.editorialSchemaVersion !== undefined) {
    if (data.editorialSchemaVersion !== 1) throw new AppError('Capacite editoriale invalide', 400, ErrorCodes.VALIDATION_ERROR);
    out.editorialSchemaVersion = 1;
  }
  return out;
}

const safeLocale = value => { try { return locale(value); } catch (_) { return undefined; } };
const preferredLanguage = device => safeLocale(device.language) || safeLocale(device.deviceLanguage) || 'fr';
module.exports = { locale, preferences, preferredLanguage };
