// src/api/controllers/common/topicController.js
const topicService = require('../../services/common/topicService');
const catchAsync = require('../../../utils/catchAsync');

class TopicController {
  
  createTopic = catchAsync(async (req, res) => {
    const { name, city } = req.body;
    
    const topic = await topicService.createTopic(name, city);
    
    res.status(201).json({
      success: true,
      data: topic
    });
  });
  
  getTopics = catchAsync(async (req, res) => {
    const filters = {};
    
    if (req.query.city) {
      filters.city = req.query.city;
    }
    
    const topics = await topicService.getTopics(filters);
    
    res.status(200).json({
      success: true,
      data: topics
    });
  });
  
  getTopicById = catchAsync(async (req, res) => {
    const { id } = req.params;
    
    const topic = await topicService.getTopicById(id);
    
    res.status(200).json({
      success: true,
      data: topic
    });
  });
  
  updateTopic = catchAsync(async (req, res) => {
    const { id } = req.params;
    const updateData = req.body;
    
    const topic = await topicService.updateTopic(id, updateData);
    
    res.status(200).json({
      success: true,
      data: topic
    });
  });
  
  deactivateTopic = catchAsync(async (req, res) => {
    const { id } = req.params;
    
    const topic = await topicService.deactivateTopic(id);
    
    res.status(200).json({
      success: true,
      data: topic
    });
  });
}

module.exports = new TopicController();