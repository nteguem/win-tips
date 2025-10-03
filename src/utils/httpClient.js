/**
 * @fileoverview Client HTTP basé sur les modules natifs http/https de Node.js
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const querystring = require('querystring');

/**
 * Client HTTP utilisant les modules natifs de Node.js
 */
class HttpClient {
  /**
   * Effectue une requête GET
   * @param {string} url - URL de la requête
   * @param {Object} options - Options de la requête
   * @param {Object} options.params - Paramètres de query string
   * @param {Object} options.headers - En-têtes HTTP
   * @returns {Promise<Object>} - Réponse parsée en JSON
   */
  async get(url, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        // Construire l'URL avec les paramètres
        const parsedUrl = new URL(url);
        if (options.params) {
          const qs = querystring.stringify(options.params);
          parsedUrl.search = qs;
        }

        // Choisir le protocole approprié
        const client = parsedUrl.protocol === 'https:' ? https : http;

        // Configurer les options de la requête
        const requestOptions = {
          method: 'GET',
          headers: options.headers || {},
          timeout: 30000 // 30 secondes de timeout
        };

        // Effectuer la requête
        const req = client.request(parsedUrl, requestOptions, (res) => {
          let data = '';

          // Collecter les données
          res.on('data', (chunk) => {
            data += chunk;
          });

          // Finaliser la requête
          res.on('end', () => {
            // Gérer les codes d'erreur HTTP
            if (res.statusCode >= 400) {
              let errorData;
              try {
                errorData = JSON.parse(data);
              } catch (e) {
                errorData = { message: data || 'Unknown error' };
              }

              const error = new Error(errorData.message || `HTTP error ${res.statusCode}`);
              error.response = {
                status: res.statusCode,
                data: errorData
              };
              reject(error);
              return;
            }

            try {
              // Tenter de parser la réponse JSON
              const parsedData = JSON.parse(data);
              resolve(parsedData);
            } catch (e) {
              reject(new Error(`Failed to parse JSON response: ${e.message}`));
            }
          });
        });

        // Gérer les erreurs de connexion
        req.on('error', (error) => {
          error.request = true; // Pour compatibilité avec l'API d'erreur existante
          reject(error);
        });

        // Gérer les timeouts
        req.on('timeout', () => {
          req.destroy();
          const error = new Error('Request timeout');
          error.request = true;
          reject(error);
        });

        // Finaliser la requête
        req.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}

module.exports = HttpClient;