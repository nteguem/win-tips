'use strict';
const mongoose = require('mongoose');
const { contract } = require('../../../core/adTelemetry');

// No identifiers, IPs, SSV data or free-form error messages. Diagnostic only.
const schema = new mongoose.Schema({
  appId: { type: String, required: true },
  eventId: { type: String, required: true },
  attemptId: { type: String, required: true },
  type: { type: String, enum: contract.types, required: true },
  format: { type: String, enum: contract.formats, required: true },
  placement: { type: String, required: true },
  occurredAt: { type: Date, required: true },
  platform: { type: String, enum: contract.platforms, required: true },
  appVersion: String, country: String, durationMs: Number,
  errorOrigin: { type: String, enum: contract.errorOrigins },
  errorCode: mongoose.Schema.Types.Mixed,
  errorDomain: String, adapterClassName: String,
  reason: { type: String, enum: contract.reasons },
  connectionType: { type: String, enum: contract.connectionTypes },
  revenueMicros: Number, currencyCode: String,
  precisionType: { type: String, enum: contract.precisionTypes },
  receivedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true }
}, { versionKey: false, strict: 'throw', bufferCommands: false });
schema.index({ appId: 1, eventId: 1 }, { unique: true });
schema.index({ appId: 1, occurredAt: -1 });
schema.index({ occurredAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('AdTelemetryEvent', schema);
