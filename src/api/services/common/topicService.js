// src/api/services/common/topicService.js
const Topic = require('../../models/common/Topic');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

class TopicService {
  
  async createTopic(name, city) {
    const topic = await Topic.findOrCreate(name, city);
    return topic;
  }
  
  async getTopics(filters = {}) {
    const query = { isActive: true };
    
    if (filters.city) {
      query.city = filters.city;
    }
    
    return await Topic.find(query).sort({ createdAt: -1 });
  }
  
  async getTopicById(id) {
    const topic = await Topic.findById(id);
    
    if (!topic) {
      throw new AppError('Topic non trouvé', 404, ErrorCodes.NOT_FOUND);
    }
    
    return topic;
  }
  
  async getTopicByName(name) {
    return await Topic.findOne({ name, isActive: true });
  }
  
  async getTopicByCity(city) {
    return await Topic.findOne({ city, isActive: true });
  }
  
  async updateTopic(id, updateData) {
    const topic = await Topic.findByIdAndUpdate(
      id, 
      updateData, 
      { new: true }
    );
    
    if (!topic) {
      throw new AppError('Topic non trouvé', 404, ErrorCodes.NOT_FOUND);
    }
    
    return topic;
  }
  
  async deactivateTopic(id) {
    return await this.updateTopic(id, { isActive: false });
  }
}

module.exports = new TopicService();