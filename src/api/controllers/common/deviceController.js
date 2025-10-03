// src/api/controllers/common/deviceController.js
const deviceService = require('../../services/common/deviceService');
const catchAsync = require('../../../utils/catchAsync');

class DeviceController {
  
  registerDevice = catchAsync(async (req, res) => {
    const { deviceId, playerId, platform, deviceInfo } = req.body;
    const userId = req.user ? req.user.id : null;
    
    const device = await deviceService.registerDevice({
      deviceId,
      playerId,
      platform,
      deviceInfo,
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