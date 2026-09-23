const Device = require('../../models/common/Device');
const { AppError, ErrorCodes } = require('../../../utils/AppError');


/**
 * Etat de joignabilite d'un device, derive de ce qu'il porte.
 *
 * `both` n'est pas une hesitation : c'est l'etat normal pendant la
 * cohabitation. providerRouter tranche ensuite par device, selon le palier.
 */
function resoudreProvider(device) {
  const aFcm = Boolean(device.fcmToken);
  const aOs = Boolean(device.playerId);
  if (aFcm && aOs) return 'both';
  if (aFcm) return 'fcm';
  if (aOs) return 'onesignal';
  return 'unreachable';
}

class DeviceService {
  
  /**
   * Marque une notification comme reellement recue par l'appareil.
   * FCM ne le dit jamais : il confirme l'acceptation, pas l'affichage.
   */
  async ackDelivery({ msgId, deviceId }) {
    if (!msgId) return null;
    const PushDelivery = require('../../models/common/PushDelivery');
    return PushDelivery.findOneAndUpdate(
      { msgId },
      { $set: { status: 'acked', ackAt: new Date() } },
      { new: true }
    );
  }

  async registerDevice(deviceData) {
    const { deviceId, playerId, platform, deviceInfo, user = null,
            fcmToken = null, manufacturer = null } = deviceData;

    let device = await Device.findOne({ deviceId });

    if (device) {
      // Ne jamais ECRASER un playerId existant par null : une app qui migre
      // vers FCM cesse d'envoyer playerId, et on perdrait le filet OneSignal
      // avant meme d'avoir confirme que FCM fonctionne pour ce device.
      if (playerId) device.playerId = playerId;
      device.platform = platform;
      device.deviceInfo = deviceInfo || device.deviceInfo;
      device.isActive = true;
      device.lastActiveAt = new Date();
      if (manufacturer) device.manufacturer = manufacturer;

      if (fcmToken && fcmToken !== device.fcmToken) {
        // Le meme token ne doit jamais vivre sur deux devices, sinon double
        // notification. Un reinstall genere un nouveau deviceId mais peut
        // reprendre le token : on le detache de son ancien porteur.
        await Device.updateMany(
          { fcmToken, deviceId: { $ne: deviceId } },
          { $unset: { fcmToken: '', fcmTokenSource: '' } }
        );
        device.fcmToken = fcmToken;
        device.fcmTokenSource = 'sdk';
        device.fcmTokenUpdatedAt = new Date();
      }

      device.pushProvider = resoudreProvider(device);

      if (user) {
        device.user = user;
        device.userType = 'registered';
      }

      return await device.save();
    }

    device = new Device({
      deviceId,
      playerId: playerId || null,
      platform,
      deviceInfo,
      manufacturer,
      user,
      userType: user ? 'registered' : 'guest',
      ...(fcmToken ? {
        fcmToken,
        fcmTokenSource: 'sdk',
        fcmTokenUpdatedAt: new Date(),
      } : {}),
    });
    device.pushProvider = resoudreProvider(device);

    return await device.save();
  }
  
  async linkDeviceToUser(deviceId, userId) {
    const device = await Device.findOne({ deviceId, isActive: true });
    
    if (!device) {
      throw new AppError('Device non trouvé', 404, ErrorCodes.NOT_FOUND);
    }
    
    return await device.linkToUser(userId);
  }
  
  async unlinkDeviceFromUser(deviceId) {
    const device = await Device.findOne({ deviceId, isActive: true });
    
    if (device) {
      return await device.unlinkFromUser();
    }
    
    return null;
  }
  
  async getDevicesByUserType(userType) {
    return await Device.getByUserType(userType);
  }
  
  async deactivateDevice(deviceId) {
    return await Device.findOneAndUpdate(
      { deviceId },
      { isActive: false, lastActiveAt: new Date() },
      { new: true }
    );
  }
  
  async updateDevice(deviceId, updateData) {
    return await Device.findOneAndUpdate(
      { deviceId, isActive: true },
      { ...updateData, lastActiveAt: new Date() },
      { new: true }
    );
  }
}

module.exports = new DeviceService();