const { google } = require('googleapis');
const GooglePlayTransaction = require('../../models/user/GooglePlayTransaction');
const Subscription = require('../../models/common/Subscription');
const Package = require('../../models/common/Package');

class GooglePlayService {
  constructor() {
    this.androidPublisher = null;
    this.initializeClient();
  }

  // Initialiser le client Google API
  initializeClient() {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
      scopes: ['https://www.googleapis.com/auth/androidpublisher']
    });

    this.androidPublisher = google.androidpublisher({
      version: 'v3',
      auth
    });
  }

  // Valider un achat depuis Flutter
  async validatePurchase(purchaseToken, productId, userId, packageId) {
    try {
      console.log('[GooglePlay] Début validation:', { purchaseToken, productId, packageId });
      
      // 1. Vérifier avec l'API Google
      const { data } = await this.androidPublisher.purchases.subscriptionsv2.get({
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        token: purchaseToken
      });

      console.log('[GooglePlay] Réponse API Google:', JSON.stringify(data, null, 2));

      if (!data) {
        throw new Error('Réponse invalide de Google Play');
      }

      // 2. Vérifier si déjà traité
      const existingTx = await GooglePlayTransaction.findOne({ purchaseToken });
      if (existingTx) {
        console.log('[GooglePlay] Transaction déjà traitée:', existingTx._id);
        const subscription = await Subscription.findById(existingTx.subscription)
          .populate('package');
        
        return { 
          success: true, 
          message: 'Achat déjà traité',
          data: {
            subscription,
            message: 'Abonnement déjà actif'
          }
        };
      }

      // 3. Récupérer le package
      const packageItem = await Package.findById(packageId);
      if (!packageItem) {
        throw new Error('Package non trouvé: ' + packageId);
      }

      // 4. Parser les dates CORRECTEMENT
      let startDate, endDate;
      
      // Les timestamps Google sont en MILLISECONDES depuis epoch
      if (data.startTime) {
        // Convertir la string en nombre et créer la date
        const startTimestamp = parseInt(data.startTime);
        startDate = new Date(startTimestamp);
        
        // Vérifier si la date est trop ancienne (1970)
        if (startDate.getFullYear() < 2020) {
          console.log('[GooglePlay] Date invalide détectée, utilisation de la date actuelle');
          startDate = new Date();
        }
      } else {
        startDate = new Date();
      }

      if (data.lineItems && data.lineItems[0] && data.lineItems[0].expiryTime) {
        endDate = new Date(data.lineItems[0].expiryTime);
      } else if (data.expiryTime) {
        const expiryTimestamp = parseInt(data.expiryTime);
        endDate = new Date(expiryTimestamp);
        
        // Vérifier si la date est trop ancienne (1970)
        if (endDate.getFullYear() < 2020) {
          console.log('[GooglePlay] Date expiration invalide, calcul depuis durée package');
          endDate = new Date(startDate.getTime() + (packageItem.duration * 24 * 60 * 60 * 1000));
        }
      } else {
        // Utiliser la durée du package (en jours)
        endDate = new Date(startDate.getTime() + (packageItem.duration * 24 * 60 * 60 * 1000));
      }

      console.log('[GooglePlay] Dates calculées:', { 
        startDate: startDate.toISOString(), 
        endDate: endDate.toISOString() 
      });

      // 5. Extraire le prix et la devise DEPUIS GOOGLE
      let priceAmountMicros = null;
      let priceCurrencyCode = null;
      
      // Essayer d'extraire le prix depuis la réponse Google
      try {
        if (data.lineItems && Array.isArray(data.lineItems) && data.lineItems.length > 0) {
          const lineItem = data.lineItems[0];
          console.log('[GooglePlay] LineItem trouvé:', JSON.stringify(lineItem, null, 2));
          
          // Différentes structures possibles selon la version de l'API
          if (lineItem.offerDetails) {
            priceAmountMicros = lineItem.offerDetails.priceAmountMicros;
            priceCurrencyCode = lineItem.offerDetails.priceCurrencyCode;
          } else if (lineItem.productDetails) {
            if (lineItem.productDetails.basePlanDetails) {
              priceAmountMicros = lineItem.productDetails.basePlanDetails.priceAmountMicros;
              priceCurrencyCode = lineItem.productDetails.basePlanDetails.priceCurrencyCode;
            } else if (lineItem.productDetails.priceAmountMicros) {
              priceAmountMicros = lineItem.productDetails.priceAmountMicros;
              priceCurrencyCode = lineItem.productDetails.priceCurrencyCode;
            }
          } else if (lineItem.priceAmountMicros) {
            priceAmountMicros = lineItem.priceAmountMicros;
            priceCurrencyCode = lineItem.priceCurrencyCode;
          }
        }
      } catch (priceError) {
        console.error('[GooglePlay] Erreur extraction prix:', priceError);
      }
      
      // Si Google envoie le prix, on l'utilise tel quel
      // Sinon, on prend le prix du package
      if (!priceAmountMicros) {
        console.log('[GooglePlay] Pas de prix Google, utilisation du prix package');
        
        // Prendre le prix du package dans n'importe quelle devise disponible
        let packagePrice = null;
        let currency = null;
        
        // Ordre de préférence des devises
        const currencyPreference = ['EUR', 'USD', 'XAF', 'XOF', 'GMD', 'CDF', 'GNF'];
        
        for (const curr of currencyPreference) {
          if (packageItem.pricing.has(curr)) {
            packagePrice = packageItem.pricing.get(curr);
            currency = curr;
            break;
          }
        }
        
        // Si aucune devise préférée, prendre la première disponible
        if (!packagePrice && packageItem.pricing.size > 0) {
          const firstCurrency = Array.from(packageItem.pricing.keys())[0];
          packagePrice = packageItem.pricing.get(firstCurrency);
          currency = firstCurrency;
        }
        
        if (packagePrice) {
          // NE PAS convertir en micros si c'est notre prix
          priceAmountMicros = packagePrice;
          priceCurrencyCode = currency;
        } else {
          // Prix par défaut si vraiment rien n'est trouvé
          priceAmountMicros = 10;
          priceCurrencyCode = 'EUR';
        }
      }

      console.log('[GooglePlay] Prix final:', { 
        priceAmountMicros, 
        priceCurrencyCode,
        isFromGoogle: !!data.lineItems
      });

      // 6. Déterminer l'état de l'abonnement
      let subscriptionState = 'ACTIVE';
      let autoRenewing = false;
      
      if (data.subscriptionState) {
        const stateMap = {
          'SUBSCRIPTION_STATE_ACTIVE': 'ACTIVE',
          'SUBSCRIPTION_STATE_CANCELED': 'CANCELED',
          'SUBSCRIPTION_STATE_IN_GRACE_PERIOD': 'ACTIVE',
          'SUBSCRIPTION_STATE_ON_HOLD': 'ON_HOLD',
          'SUBSCRIPTION_STATE_PAUSED': 'PAUSED',
          'SUBSCRIPTION_STATE_EXPIRED': 'EXPIRED'
        };
        subscriptionState = stateMap[data.subscriptionState] || 'ACTIVE';
      }

      // Vérifier l'auto-renouvellement
      if (data.lineItems && data.lineItems[0]) {
        autoRenewing = data.lineItems[0].autoRenewingPlan?.autoRenewEnabled || false;
      } else {
        autoRenewing = data.autoRenewing || false;
      }

      // 7. Créer la transaction Google Play
      const googleTx = await GooglePlayTransaction.create({
        purchaseToken,
        orderId: data.latestOrderId || data.orderId || `GP_${Date.now()}`,
        productId,
        user: userId,
        package: packageId,
        status: subscriptionState,
        startTime: startDate,
        expiryTime: endDate,
        priceAmountMicros,
        priceCurrencyCode,
        autoRenewing,
        acknowledged: false,
        purchaseTime: startDate
      });

      console.log('[GooglePlay] Transaction créée:', googleTx._id);

      // 8. Créer la subscription
      // Pour le montant dans Subscription, on utilise le prix normal (pas en micros)
      let subscriptionAmount;
      
      // Si le prix vient de Google (en micros), on convertit
      if (data.lineItems && priceAmountMicros > 1000000) {
        subscriptionAmount = Math.round(priceAmountMicros / 1000000);
      } else {
        // Sinon c'est déjà le bon montant
        subscriptionAmount = priceAmountMicros;
      }
      
      const subscription = await Subscription.create({
        user: userId,
        package: packageId,
        startDate,
        endDate,
        pricing: {
          amount: subscriptionAmount,
          currency: priceCurrencyCode
        },
        status: 'active',
        paymentProvider: 'GOOGLE_PLAY',
        paymentReference: googleTx.orderId,
        googlePlayTransaction: googleTx._id,
        autoRenewing
      });

      console.log('[GooglePlay] Subscription créée:', subscription._id);

      // 9. Mettre à jour la transaction avec l'ID de subscription
      googleTx.subscription = subscription._id;
      await googleTx.save();

      // 10. Acknowledge l'achat (non bloquant)
      this.acknowledgePurchase(purchaseToken).catch(error => {
        console.error('[GooglePlay] Erreur acknowledge (non bloquant):', error.message);
      });

      // 11. Retourner le résultat avec populate
      const populatedSubscription = await Subscription.findById(subscription._id)
        .populate('package');

      return {
        success: true,
        data: {
          subscription: populatedSubscription,
          message: 'Abonnement activé avec succès'
        }
      };

    } catch (error) {
      console.error('[GooglePlay] Erreur validation complète:', error);
      
      // Retourner une erreur plus descriptive
      let errorMessage = 'Erreur de validation: ';
      if (error.response && error.response.data) {
        errorMessage += JSON.stringify(error.response.data);
      } else if (error.message) {
        errorMessage += error.message;
      } else {
        errorMessage += 'Erreur inconnue';
      }
      
      throw new Error(errorMessage);
    }
  }

  // Acknowledge un achat (obligatoire sous 3 jours)
  async acknowledgePurchase(purchaseToken) {
    try {
      await this.androidPublisher.purchases.subscriptions.acknowledge({
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        subscriptionId: purchaseToken,
        token: purchaseToken
      });

      // Mettre à jour le flag
      await GooglePlayTransaction.findOneAndUpdate(
        { purchaseToken },
        { acknowledged: true }
      );

      return true;
    } catch (error) {
      console.error('Erreur acknowledge:', error);
      return false;
    }
  }

  // Traiter une notification RTDN
  async processNotification(notification) {
    try {
      const { purchaseToken, subscriptionId } = notification.subscriptionNotification;
      const notificationType = notification.subscriptionNotification.notificationType;

      console.log(`[NOTIFICATION] Type: ${notificationType}, Token: ${purchaseToken.substring(0, 20)}...`);

      // Récupérer la transaction
      const googleTx = await GooglePlayTransaction.findOne({ purchaseToken });
      if (!googleTx) {
        console.log('Transaction non trouvée:', purchaseToken);
        return;
      }

      // Enregistrer la notification
      googleTx.lastNotificationType = notificationType;
      googleTx.lastNotificationTime = new Date();

      // Traiter selon le type
      switch (notificationType) {
        case 1: // SUBSCRIPTION_RECOVERED
          console.log('[NOTIFICATION] → SUBSCRIPTION_RECOVERED');
          await this.handleRecovery(googleTx);
          break;
        case 2: // SUBSCRIPTION_RENEWED
          console.log('[NOTIFICATION] → SUBSCRIPTION_RENEWED');
          await this.handleRenewal(googleTx);
          break;
        case 3: // SUBSCRIPTION_CANCELED
          console.log('[NOTIFICATION] → SUBSCRIPTION_CANCELED');
          await this.handleCancellation(googleTx);
          break;
        case 4: // SUBSCRIPTION_PURCHASED
          console.log('[NOTIFICATION] → SUBSCRIPTION_PURCHASED');
          // Généralement déjà traité par validatePurchase
          break;
        case 5: // SUBSCRIPTION_ON_HOLD (ancienne version)
          console.log('[NOTIFICATION] → SUBSCRIPTION_ON_HOLD (type 5)');
          await this.handleOnHold(googleTx);
          break;
        case 11: // SUBSCRIPTION_ON_HOLD (nouvelle version)
          console.log('[NOTIFICATION] → SUBSCRIPTION_ON_HOLD (type 11)');
          await this.handleOnHold(googleTx);
          break;
        case 13: // SUBSCRIPTION_EXPIRED
          console.log('[NOTIFICATION] → SUBSCRIPTION_EXPIRED');
          await this.handleExpiration(googleTx);
          break;
        default:
          console.log(`[NOTIFICATION] Type ${notificationType} non géré`);
      }

      await googleTx.save();
    } catch (error) {
      console.error('Erreur traitement notification:', error);
    }
  }

  // Gérer la récupération d'une suspension
  async handleRecovery(googleTx) {
    try {
      console.log('[RECOVERY] Début récupération pour:', googleTx.purchaseToken);
      
      // Récupérer les infos actuelles depuis Google
      const { data } = await this.androidPublisher.purchases.subscriptionsv2.get({
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        token: googleTx.purchaseToken
      });

      console.log('[RECOVERY] Réponse API Google:', JSON.stringify(data, null, 2));

      // Extraire la nouvelle date d'expiration
      let newExpiryTime;
      
      if (data.lineItems && data.lineItems[0] && data.lineItems[0].expiryTime) {
        newExpiryTime = new Date(data.lineItems[0].expiryTime);
        console.log('[RECOVERY] Date trouvée dans lineItems[0].expiryTime');
      } else if (data.expiryTime) {
        const expiryTimestamp = parseInt(data.expiryTime);
        newExpiryTime = new Date(expiryTimestamp);
        console.log('[RECOVERY] Date trouvée dans data.expiryTime');
      } else {
        // Garder la date actuelle + durée normale
        const Package = require('../../models/common/Package');
        const packageData = await Package.findById(googleTx.package);
        if (packageData) {
          newExpiryTime = new Date(Date.now() + (packageData.duration * 24 * 60 * 60 * 1000));
        } else {
          newExpiryTime = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000));
        }
        console.log('[RECOVERY] Date calculée avec durée package');
      }

      console.log('[RECOVERY] Nouvelle date expiration:', newExpiryTime.toISOString());

      // Mettre à jour la transaction Google Play
      googleTx.status = 'ACTIVE';
      googleTx.expiryTime = newExpiryTime;
      await googleTx.save();

      // Réactiver la subscription
      await Subscription.findByIdAndUpdate(
        googleTx.subscription,
        { 
          status: 'active',
          endDate: newExpiryTime
        }
      );

      console.log('[RECOVERY] Abonnement récupéré avec succès');
      
    } catch (error) {
      console.error('[RECOVERY] Erreur handleRecovery:', error);
      throw error;
    }
  }

  // Gérer le renouvellement
  async handleRenewal(googleTx) {
    try {
      console.log('[RENEWAL] Début handleRenewal pour:', googleTx.purchaseToken);
      
      // Récupérer les nouvelles infos depuis Google
      const { data } = await this.androidPublisher.purchases.subscriptionsv2.get({
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        token: googleTx.purchaseToken
      });

      console.log('[RENEWAL] Réponse API Google:', JSON.stringify(data, null, 2));

      // Calculer la nouvelle date d'expiration - CORRIGÉ
      let newExpiryTime;
      
      // Chercher d'abord dans lineItems (nouveau format)
      if (data.lineItems && data.lineItems.length > 0 && data.lineItems[0].expiryTime) {
        newExpiryTime = new Date(data.lineItems[0].expiryTime);
        console.log('[RENEWAL] Date trouvée dans lineItems[0].expiryTime');
      }
      // Fallback: ancien format
      else if (data.expiryTime) {
        const expiryTimestamp = parseInt(data.expiryTime);
        newExpiryTime = new Date(expiryTimestamp);
        console.log('[RENEWAL] Date trouvée dans data.expiryTime');
      }
      // Dernier fallback: durée du package
      else {
        console.log('[RENEWAL] Aucune date Google, calcul avec durée package');
        const Package = require('../../models/common/Package');
        const packageData = await Package.findById(googleTx.package);
        if (packageData) {
          newExpiryTime = new Date(Date.now() + (packageData.duration * 24 * 60 * 60 * 1000));
        } else {
          newExpiryTime = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000));
        }
      }

      // Vérifier si la date est valide
      if (isNaN(newExpiryTime.getTime()) || newExpiryTime.getFullYear() < 2020) {
        console.log('[RENEWAL] Date invalide, fallback sur durée package');
        const Package = require('../../models/common/Package');
        const packageData = await Package.findById(googleTx.package);
        if (packageData) {
          newExpiryTime = new Date(Date.now() + (packageData.duration * 24 * 60 * 60 * 1000));
        } else {
          newExpiryTime = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000));
        }
      }

      console.log('[RENEWAL] Nouvelle date expiration:', newExpiryTime.toISOString());

      // Extraire l'auto-renewal
      let autoRenewing = false;
      if (data.lineItems && data.lineItems[0] && data.lineItems[0].autoRenewingPlan) {
        autoRenewing = data.lineItems[0].autoRenewingPlan.autoRenewEnabled;
      }

      // Mettre à jour la transaction Google Play
      googleTx.expiryTime = newExpiryTime;
      googleTx.status = 'ACTIVE';
      googleTx.autoRenewing = autoRenewing;
      await googleTx.save();

      // Mettre à jour la subscription
      await Subscription.findByIdAndUpdate(
        googleTx.subscription,
        { 
          endDate: newExpiryTime,
          status: 'active',
          autoRenewing: autoRenewing
        }
      );

      console.log('[RENEWAL] Renouvellement traité avec succès');
      
    } catch (error) {
      console.error('[RENEWAL] Erreur handleRenewal:', error);
      throw error;
    }
  }

  // Gérer l'annulation
  async handleCancellation(googleTx) {
    try {
      console.log('[CANCELLATION] Début annulation pour:', googleTx.purchaseToken);
      
      googleTx.status = 'CANCELED';
      await googleTx.save();
      
      // L'abonnement reste actif jusqu'à expiration
      // Pas de changement sur la Subscription pour l'instant
      // L'utilisateur garde l'accès jusqu'à la fin de sa période payée
      
      console.log('[CANCELLATION] Annulation traitée - abonnement reste actif jusqu\'à expiration');
      
    } catch (error) {
      console.error('[CANCELLATION] Erreur handleCancellation:', error);
      throw error;
    }
  }

  // Gérer la suspension
  async handleOnHold(googleTx) {
    try {
      console.log('[ON_HOLD] Début suspension pour:', googleTx.purchaseToken);
      
      googleTx.status = 'ON_HOLD';
      await googleTx.save();
      
      await Subscription.findByIdAndUpdate(
        googleTx.subscription,
        { status: 'expired' } // Plus d'accès pendant la suspension
      );

      console.log('[ON_HOLD] Suspension traitée - accès suspendu');
      
    } catch (error) {
      console.error('[ON_HOLD] Erreur handleOnHold:', error);
      throw error;
    }
  }

  // Gérer l'expiration
  async handleExpiration(googleTx) {
    try {
      console.log('[EXPIRATION] Début expiration pour:', googleTx.purchaseToken);
      
      googleTx.status = 'EXPIRED';
      await googleTx.save();
      
      await Subscription.findByIdAndUpdate(
        googleTx.subscription,
        { status: 'expired' }
      );

      console.log('[EXPIRATION] Expiration traitée');
      
    } catch (error) {
      console.error('[EXPIRATION] Erreur handleExpiration:', error);
      throw error;
    }
  }

  // Vérifier le statut d'un abonnement
  async checkSubscriptionStatus(userId) {
    try {
      // Chercher une transaction active
      const googleTx = await GooglePlayTransaction.findOne({
        user: userId,
        status: { $in: ['ACTIVE', 'CANCELED'] },
        expiryTime: { $gt: new Date() }
      }).populate('subscription');

      if (!googleTx) {
        return {
          hasActiveSubscription: false,
          message: 'Aucun abonnement Google Play actif'
        };
      }

      // Vérifier avec Google pour être sûr
      const { data } = await this.androidPublisher.purchases.subscriptionsv2.get({
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        token: googleTx.purchaseToken
      });

      const isActive = data.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';

      return {
        hasActiveSubscription: isActive,
        subscription: googleTx.subscription,
        expiryDate: googleTx.expiryTime,
        autoRenewing: googleTx.autoRenewing
      };

    } catch (error) {
      console.error('Erreur vérification statut:', error);
      return {
        hasActiveSubscription: false,
        error: error.message
      };
    }
  }

  // Synchroniser un abonnement avec Google
  async syncSubscription(purchaseToken) {
    try {
      const { data } = await this.androidPublisher.purchases.subscriptionsv2.get({
        packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
        token: purchaseToken
      });

      const googleTx = await GooglePlayTransaction.findOne({ purchaseToken });
      if (!googleTx) return;

      // Mettre à jour les infos
      if (data.lineItems && data.lineItems[0] && data.lineItems[0].expiryTime) {
        googleTx.expiryTime = new Date(data.lineItems[0].expiryTime);
        googleTx.autoRenewing = data.lineItems[0].autoRenewingPlan?.autoRenewEnabled || false;
      } else if (data.expiryTime) {
        googleTx.expiryTime = new Date(parseInt(data.expiryTime));
        googleTx.autoRenewing = data.autoRenewing || false;
      }
      
      // Mapper l'état Google vers notre état
      const stateMap = {
        'SUBSCRIPTION_STATE_ACTIVE': 'ACTIVE',
        'SUBSCRIPTION_STATE_CANCELED': 'CANCELED',
        'SUBSCRIPTION_STATE_IN_GRACE_PERIOD': 'ACTIVE',
        'SUBSCRIPTION_STATE_ON_HOLD': 'ON_HOLD',
        'SUBSCRIPTION_STATE_PAUSED': 'PAUSED',
        'SUBSCRIPTION_STATE_EXPIRED': 'EXPIRED'
      };

      googleTx.status = stateMap[data.subscriptionState] || 'EXPIRED';
      await googleTx.save();

      // Synchroniser la Subscription
      const subStatus = ['ACTIVE', 'CANCELED'].includes(googleTx.status) ? 'active' : 'expired';
      await Subscription.findByIdAndUpdate(
        googleTx.subscription,
        { 
          status: subStatus,
          endDate: googleTx.expiryTime
        }
      );

      return googleTx;
    } catch (error) {
      console.error('Erreur sync:', error);
      throw error;
    }
  }
}

module.exports = new GooglePlayService();