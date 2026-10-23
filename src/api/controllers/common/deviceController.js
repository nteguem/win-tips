// src/api/controllers/common/deviceController.js
const deviceService = require('../../services/common/deviceService');
const catchAsync = require('../../../utils/catchAsync');

class DeviceController {
  
  /**
   * Accuse de reception d'une notification, envoye par l'app.
   *
   * C'est le SEUL moyen de mesurer la livraison reelle : FCM renvoie un succes
   * des qu'il a accepte le message, pas quand l'appareil l'a affiche. Sur un
   * parc ou Transsion et Xiaomi pesent l'essentiel, l'ecart entre « accepte »
   * et « recu » est precisement ce qu'on cherche a mesurer.
   *
   * Route publique et volontairement tolerante : jamais d'erreur renvoyee a
   * l'app, ce n'est pas un chemin critique cote client.
   */
  ackNotification = catchAsync(async (req, res) => {
    const { msgId, deviceId } = req.body;
    await deviceService.ackDelivery({ msgId, deviceId }).catch(() => null);
    res.status(204).send();
  });

  registerDevice = catchAsync(async (req, res) => {
    // fcmToken et manufacturer sont optionnels : une app non mise a jour
    // continue de n'envoyer que playerId, le contrat reste retrocompatible.
    const { deviceId, playerId, platform, deviceInfo, fcmToken, manufacturer,
      language, appLanguage, deviceLanguage, notificationsEnabled, editorialSchemaVersion } = req.body;
    const userId = req.user ? req.user.id : null;

    const device = await deviceService.registerDevice({
      deviceId,
      playerId,
      platform,
      deviceInfo,
      fcmToken,
      manufacturer,
      language,
      appLanguage,
      deviceLanguage,
      notificationsEnabled,
      editorialSchemaVersion,
      user: userId
    });
    
    res.status(200).json({
      success: true,
      data: device
    });
  });
  
  linkDevice = catchAsync(async (req, res) => {
    const { deviceId } = req.body;
    const userId = req.user.id;
    
    const device = await deviceService.linkDeviceToUser(deviceId, userId);
    
    res.status(200).json(formatResponse(device));
  });
  
  unlinkDevice = catchAsync(async (req, res) => {
    const { deviceId } = req.body;
    
    const device = await deviceService.unlinkDeviceFromUser(deviceId);
    
    res.status(200).json(formatResponse(device));
  });
  
  updateDevice = catchAsync(async (req, res) => {
    const { deviceId } = req.params;
    const updateData = req.body;
    
    const device = await deviceService.updateDevice(deviceId, updateData);
    
    res.status(200).json(formatResponse(device));
  });
  
  deactivateDevice = catchAsync(async (req, res) => {
    const { deviceId } = req.params;
    
    const device = await deviceService.deactivateDevice(deviceId);
    
    res.status(200).json(formatResponse(device));
  });
}

module.exports = new DeviceController();
