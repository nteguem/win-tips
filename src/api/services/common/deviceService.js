const Device = require('../../models/common/Device');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

class DeviceService {
  
  async registerDevice(deviceData) {
    const { deviceId, playerId, platform, deviceInfo, user = null } = deviceData;
    
    let device = await Device.findOne({ deviceId });
    
    if (device) {
      device.playerId = playerId;
      device.platform = platform;
      device.deviceInfo = deviceInfo || device.deviceInfo;
      device.isActive = true;
      device.lastActiveAt = new Date();
      
      if (user) {
        device.user = user;
        device.userType = 'registered';
      }
      
      return await device.save();
    }
    
    device = new Device({
      deviceId,
      playerId,
      platform,
      deviceInfo,
      user,
      userType: user ? 'registered' : 'guest'
    });
    
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