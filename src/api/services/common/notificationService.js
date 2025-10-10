// src/api/services/common/notificationService.js
const axios = require('axios');
const logger = require('../../../utils/logger');
const { AppError } = require('../../../utils/AppError');

class NotificationService {
  constructor() {
    this._initialized = false;
    this.apiUrl = 'https://onesignal.com/api/v1';
    this.appId = null;
    this.restApiKey = null;
  }

  // Initialisation lazy
  _init() {
    if (this._initialized) return;
    
    this.appId = process.env.ONESIGNAL_APP_ID;
    this.restApiKey = process.env.ONESIGNAL_REST_API_KEY;
    
    if (!this.appId || !this.restApiKey) {
      throw new Error('OneSignal configuration missing in environment variables. Please set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY');
    }
    
    this._initialized = true;
  }

  /**
   * Envoyer une notification à des utilisateurs spécifiques via playerIds
   */
  async sendToUsers(playerIds, notification) {
    this._init();
    
    try {
      const payload = {
        app_id: this.appId,
        include_player_ids: Array.isArray(playerIds) ? playerIds : [playerIds],
        headings: notification.headings || { en: "BigWin", fr: "BigWin" },
        contents: notification.contents,
        data: notification.data || {},
        ...notification.options
      };

      const response = await this._makeRequest('notifications', 'POST', payload);
      
      logger.info(`Notification envoyée à ${playerIds.length} utilisateur(s)`, {
        notificationId: response.id,
        recipients: response.recipients
      });

      return response;
    } catch (error) {
      logger.error('Erreur envoi notification utilisateurs:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
      
      // Retourner l'erreur détaillée
      const errorMessage = error.response?.data?.errors 
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      
      throw new AppError(`Échec envoi notification: ${errorMessage}`, 500);
    }
  }

  /**
   * Envoyer une notification à tous les utilisateurs
   */
  async sendToAll(notification) {
    this._init();
    
    try {
      const payload = {
        app_id: this.appId,
        included_segments: ['All'],
        headings: notification.headings || { en: "BigWin", fr: "BigWin" },
        contents: notification.contents,
        data: notification.data || {},
        ...notification.options
      };

      logger.info('Tentative d\'envoi broadcast avec payload:', payload);

      const response = await this._makeRequest('notifications', 'POST', payload);
      
      logger.info(`Notification broadcast envoyée`, {
        notificationId: response.id,
        recipients: response.recipients
      });

      return response;
    } catch (error) {
      logger.error('Erreur envoi notification broadcast:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
      
      // Retourner l'erreur détaillée de OneSignal
      const errorMessage = error.response?.data?.errors 
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      
      throw new AppError(`Échec envoi notification broadcast: ${errorMessage}`, 500);
    }
  }

  /**
   * Envoyer une notification avec des filtres personnalisés
   */
  async sendWithFilters(filters, notification) {
    this._init();
    
    try {
      const payload = {
        app_id: this.appId,
        filters: filters,
        headings: notification.headings || { en: "BigWin", fr: "BigWin" },
        contents: notification.contents,
        data: notification.data || {},
        ...notification.options
      };

      const response = await this._makeRequest('notifications', 'POST', payload);
      
      logger.info(`Notification avec filtres envoyée`, {
        notificationId: response.id,
        recipients: response.recipients,
        filters: filters
      });

      return response;
    } catch (error) {
      logger.error('Erreur envoi notification avec filtres:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
      
      const errorMessage = error.response?.data?.errors 
        ? JSON.stringify(error.response.data.errors)
        : error.message;
      
      throw new AppError(`Échec envoi notification avec filtres: ${errorMessage}`, 500);
    }
  }

  /**
   * Récupérer les statistiques de l'app OneSignal
   */
  async getAppStats() {
    this._init();
    
    try {
      const response = await this._makeRequest(`apps/${this.appId}`, 'GET');
      
      return {
        totalUsers: response.players,
        messagableUsers: response.messagable_players,
        name: response.name,
        updatedAt: response.updated_at
      };
    } catch (error) {
      logger.error('Erreur récupération stats OneSignal:', error);
      throw new AppError('Échec récupération statistiques', 500);
    }
  }

  /**
   * Récupérer l'historique des notifications
   */
  async getNotificationHistory(limit = 50, offset = 0) {
    this._init();
    
    try {
      const response = await this._makeRequest(
        `notifications?app_id=${this.appId}&limit=${limit}&offset=${offset}`, 
        'GET'
      );
      
      return response.notifications.map(notif => ({
        id: notif.id,
        contents: notif.contents,
        headings: notif.headings,
        recipients: notif.recipients,
        successful: notif.successful,
        failed: notif.failed,
        createdAt: notif.queued_at,
        completedAt: notif.completed_at
      }));
    } catch (error) {
      logger.error('Erreur récupération historique notifications:', error);
      throw new AppError('Échec récupération historique', 500);
    }
  }

  /**
   * Méthode privée pour faire les requêtes à l'API OneSignal
   */
  async _makeRequest(endpoint, method = 'GET', data = null) {
    try {
      const config = {
        method,
        url: `${this.apiUrl}/${endpoint}`,
        headers: {
          'Authorization': `Basic ${this.restApiKey}`,
          'Content-Type': 'application/json'
        }
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        config.data = data;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      logger.error('Erreur requête OneSignal API:', {
        endpoint,
        method,
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
      throw error;
    }
  }

  /**
   * Vérifier si des player_ids sont valides/actifs
   */
  async checkPlayerIds(playerIds) {
    this._init();
    
    try {
      const playerArray = Array.isArray(playerIds) ? playerIds : [playerIds];
      const results = [];
      
      for (const playerId of playerArray) {
        try {
          const response = await this._makeRequest(`players/${playerId}?app_id=${this.appId}`, 'GET');
          results.push({
            playerId,
            valid: true,
            subscribed: response.notification_types > 0,
            lastActive: response.last_active,
            createdAt: response.created_at,
            deviceType: response.device_type,
            appVersion: response.app_version
          });
        } catch (error) {
          results.push({
            playerId,
            valid: false,
            error: error.response?.data?.errors || error.message
          });
        }
      }
      
      return results;
    } catch (error) {
      logger.error('Erreur vérification player IDs:', error);
      throw new AppError('Échec vérification player IDs', 500);
    }
  }

  /**
   * Récupérer la liste des utilisateurs actifs
   */
  async getActivePlayers(limit = 300, offset = 0) {
    this._init();
    
    try {
      const response = await this._makeRequest(
        `players?app_id=${this.appId}&limit=${limit}&offset=${offset}`, 
        'GET'
      );
      
      return response.players.map(player => ({
        id: player.id,
        subscribed: player.notification_types > 0,
        lastActive: player.last_active,
        createdAt: player.created_at,
        deviceType: player.device_type,
        appVersion: player.app_version
      }));
    } catch (error) {
      logger.error('Erreur récupération players actifs:', error);
      throw new AppError('Échec récupération players actifs', 500);
    }
  }

  // Méthodes d'alias pour la compatibilité avec votre controller
  async send(playerIds, notification) {
    return this.sendToUsers(playerIds, notification);
  }

  async broadcast(notification) {
    return this.sendToAll(notification);
  }
}

module.exports = new NotificationService();