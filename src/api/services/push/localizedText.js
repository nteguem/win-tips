'use strict';

const { preferredLanguage } = require('../common/devicePreferences');

function localizedText(value, language, fallback = '') {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  for (const key of [language, 'fr', 'en']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key];
  }
  return fallback;
}

function notificationText(notification, languageOrDevice = 'fr') {
  const device = languageOrDevice && typeof languageOrDevice === 'object'
    ? languageOrDevice : { language: languageOrDevice };
  const language = preferredLanguage(device);
  return {
    title: localizedText(notification.title, language, 'Notification'),
    body: localizedText(notification.body, language),
  };
}

function oneSignalTexts(value, fallback = '') {
  return { fr: localizedText(value, 'fr', fallback), en: localizedText(value, 'en', fallback) };
}

module.exports = { localizedText, notificationText, oneSignalTexts };
