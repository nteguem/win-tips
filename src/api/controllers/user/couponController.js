const TicketService = require('../../services/common/ticketService');
const subscriptionService = require('../../services/user/subscriptionService');
const accessGateService = require('../../services/common/accessGateService');
const UserAccessUnlock = require('../../models/common/UserAccessUnlock');

class CouponController {
  
  // Récupérer la liste des coupons (tickets visibles)
  async getCoupons(req, res) {
    try {
      const { 
        page = 1, 
        limit = 150, 
        category = null, 
        date = null,
        isVip = null, // true, false ou null (tous)
        lang = 'fr' // Langue par défaut : français
      } = req.query;

      const offset = (page - 1) * parseInt(limit);

      // Récupérer les tickets visibles avec pagination
      const result = await TicketService.getTickets({
        offset,
        limit: parseInt(limit),
        category,
        date,
        isVisible: true
      });

      // Filtrer selon l'accès de l'utilisateur
      let filteredData = result.data;

      if (isVip === 'true') {
        // OPTIMISATION : Une seule requête pour récupérer toutes les catégories VIP accessibles
        const userVipCategories = await subscriptionService.getUserVipCategories(req.user._id);
        const accessibleVipCategoryIds = new Set(userVipCategories.map(cat => cat._id.toString()));

        // Filtrer les tickets selon les catégories VIP accessibles
        filteredData = result.data.filter(ticket => {
          const categoryId = ticket.category._id.toString();
          return ticket.category.isVip && accessibleVipCategoryIds.has(categoryId);
        });

      } else if (isVip === 'false') {
        // Pour les coupons gratuits : seulement les catégories non-VIP
        filteredData = result.data.filter(ticket => !ticket.category.isVip);
      }
      // Si isVip === null, on garde tous les tickets (comportement par défaut)

      // ===== AD-UNLOCK GATE : déterminer l'état pour les catégories free gatées =====
      // On évalue le gate UNIQUEMENT sur les catégories free gatées présentes
      // dans la réponse. `req.user` peut être absent (accès anonyme aux free).
      const userId = req.user && req.user._id ? req.user._id : null;

      // Compatibilité ascendante : les anciens builds Flutter (< feature gate)
      // n'envoient pas ce header et leur `Prediction.fromJson` exige `event`
      // non-null. On filtre donc complètement les coupons verrouillés pour eux
      // → la catégorie disparaît de leur feed (UX dégradée mais aucun crash).
      // Les nouveaux builds envoient `X-Feature-Gate: v1` et reçoivent les
      // coupons verrouillés avec `locked:true` + prédictions masquées.
      const supportsGate = (req.headers['x-feature-gate'] || '').toLowerCase() === 'v1';

      const gatedCategoryIds = [];
      const seenGatedIds = new Set();
      for (const ticket of filteredData) {
        if (ticket.category.isVip) continue;
        if (!accessGateService.categoryIsGated(ticket.category)) continue;
        const idStr = ticket.category._id.toString();
        if (seenGatedIds.has(idStr)) continue;
        seenGatedIds.add(idStr);
        gatedCategoryIds.push(ticket.category._id);
      }

      let unlockCountByCategory = new Map();
      const userActiveUnlocks = new Map(); // catId(string) -> doc
      if (gatedCategoryIds.length > 0) {
        unlockCountByCategory = await accessGateService.countCategoryUnlocks(gatedCategoryIds);
        if (userId) {
          const docs = await UserAccessUnlock.find({
            user: userId,
            resourceType: 'category',
            resource: { $in: gatedCategoryIds }
          });
          for (const doc of docs) {
            if (doc.isAccessActive()) {
              userActiveUnlocks.set(String(doc.resource), doc);
            }
          }
        }
      }

      // Filtrer les coupons verrouillés pour les anciens clients (compat).
      if (!supportsGate && gatedCategoryIds.length > 0) {
        filteredData = filteredData.filter(ticket => {
          if (ticket.category.isVip) return true;
          if (!accessGateService.categoryIsGated(ticket.category)) return true;
          // Catégorie gatée : on garde seulement si l'utilisateur a un unlock actif.
          return userActiveUnlocks.has(ticket.category._id.toString());
        });
      }

      // Grouper les tickets par catégorie
      const categoriesMap = new Map();

      filteredData.forEach(ticket => {
        const categoryId = ticket.category._id.toString();

        if (!categoriesMap.has(categoryId)) {
          categoriesMap.set(categoryId, {
            id: ticket.category._id,
            name: ticket.category.name,
            icon: ticket.category.icon,
            successRate: ticket.category.successRate,
            description: ticket.category.description || null,
            isVip: ticket.category.isVip,
            isActive: ticket.category.isActive,
            totalCoupons: 0,
            coupons: []
          });
        }

        const category = categoriesMap.get(categoryId);
        category.totalCoupons++;

        // Décider si ce coupon est verrouillé (porte active, pas d'unlock actif).
        const isGated = !ticket.category.isVip && accessGateService.categoryIsGated(ticket.category);
        const isUnlocked = isGated ? userActiveUnlocks.has(categoryId) : true;
        const locked = isGated && !isUnlocked;

        let gateInfo = null;
        if (isGated) {
          const offers = ticket.category.accessGate.options.map(accessGateService.publicOption);
          const userDoc = userActiveUnlocks.get(categoryId) || null;
          gateInfo = {
            type: 'ad_reward',
            offers,
            requiresAuth: !userId,
            unlockCount: unlockCountByCategory.get(categoryId) || 0,
            state: accessGateService.buildState(userDoc)
          };
        }

        // Formater le coupon. Si verrouillé : on masque les prédictions (event
        // nul) tout en gardant le compteur + cote totale pour l'aperçu UI.
        const totalOdds = ticket.predictions.reduce((total, pred) => total * pred.odds, 1).toFixed(2);
        const coupon = {
          id: ticket._id,
          title: ticket.title,
          date: ticket.date,
          closingAt: ticket.closingAt,
          status: ticket.status,
          totalPredictions: ticket.predictions.length,
          totalOdds,
          ...(isGated ? {
            locked,
            unlocked: !locked,
            unlockedUntil: !locked && userActiveUnlocks.get(categoryId) ? userActiveUnlocks.get(categoryId).expiresAt : null,
            gate: gateInfo
          } : {}),
          predictions: locked
            ? ticket.predictions.map(pred => ({
                id: pred._id,
                odds: pred.odds,
                status: pred.status,
                sport: pred?.sport,
                star: pred?.star || false,
                locked: true,
                event: null,
                match: {
                  id: pred.matchData?.id,
                  date: pred.matchData?.date,
                  status: pred.matchData?.status,
                  league: pred.matchData?.league ? {
                    name: pred.matchData.league.name,
                    country: pred.matchData.league.country,
                    logo: pred.matchData.league.logo,
                    countryFlag: pred.matchData.league.countryFlag,
                  } : null,
                  teams: {
                    home: {
                      id: pred.matchData?.teams?.home?.id,
                      name: pred.matchData?.teams?.home?.name,
                      logo: pred.matchData?.teams?.home?.logo
                    },
                    away: {
                      id: pred.matchData?.teams?.away?.id,
                      name: pred.matchData?.teams?.away?.name,
                      logo: pred.matchData?.teams?.away?.logo
                    }
                  },
                  score: pred.matchData?.score ? {
                    home: pred.matchData.score.home,
                    away: pred.matchData.score.away,
                    status: pred.matchData.status
                  } : null,
                  venue: pred.matchData?.venue ? {
                    name: pred.matchData.venue.name,
                    city: pred.matchData.venue.city
                  } : null
                }
              }))
            : ticket.predictions.map(pred => ({
                id: pred._id,
                odds: pred.odds,
                status: pred.status,
                sport: pred?.sport,
                reason: pred?.reason || null,
                star: pred?.star || false,
                event: {
                  id: pred.event.id,
                  label: pred.event.label[lang] || pred.event.label.fr || pred.event.label.current,
                  description: pred.event.description.current,
                  category: pred.event.category
                },
                match: {
                  id: pred.matchData.id,
                  date: pred.matchData.date,
                  status: pred.matchData.status,
                  league: {
                    name: pred.matchData.league.name,
                    country: pred.matchData.league.country,
                    logo: pred.matchData.league.logo,
                    countryFlag: pred.matchData.league.countryFlag,
                  },
                  teams: {
                    home: {
                      id: pred.matchData?.teams?.home?.id,
                      name: pred.matchData?.teams?.home?.name,
                      logo: pred.matchData?.teams?.home?.logo
                    },
                    away: {
                      id: pred.matchData?.teams?.away?.id,
                      name: pred.matchData?.teams?.away?.name,
                      logo: pred.matchData?.teams?.away?.logo
                    }
                  },
                  score: pred.matchData.score ? {
                    home: pred.matchData.score.home,
                    away: pred.matchData.score.away,
                    status: pred.matchData.status
                  } : null,
                  venue: pred.matchData.venue ? {
                    name: pred.matchData.venue.name,
                    city: pred.matchData.venue.city
                  } : null
                }
              })),
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt
        };

        category.coupons.push(coupon);
      });

      // Convertir la Map en array
      const categories = Array.from(categoriesMap.values());

      const typeMessage = isVip === 'true' ? 'VIP' : isVip === 'false' ? 'gratuits' : '';

      return res.status(200).json({
        success: true,
        message: `Liste des coupons ${typeMessage} récupérée avec succès`.trim(),
        data: {
          categories
        }
      });

    } catch (error) {
      console.error('Erreur lors de la récupération des coupons:', error);
      return res.status(500).json({
        success: false,
        message: 'Erreur interne du serveur',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  // Récupérer un coupon spécifique par ID
  async getCouponById(req, res) {
    try {
      const { id } = req.params;
      const { lang = 'fr' } = req.query;

      const ticket = await TicketService.getTicketById(id);

      if (!ticket) {
        return res.status(404).json({
          success: false,
          message: 'Coupon non trouvé'
        });
      }

      // Vérifier si le ticket est visible
      if (!ticket.isVisible) {
        return res.status(404).json({
          success: false,
          message: 'Coupon non disponible'
        });
      }

      // Vérifier l'accès si c'est une catégorie VIP
      if (ticket.category.isVip) {
        const hasAccess = await subscriptionService.hasAccessToCategory(req.user._id, ticket.category._id);
        
        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            message: 'Abonnement VIP requis pour accéder à ce coupon'
          });
        }
      }

      // Formater les données du coupon avec sa catégorie
      const couponWithCategory = {
        category: {
          id: ticket.category._id,
          name: ticket.category.name,
          icon: ticket.category.icon,
          successRate: ticket.category.successRate,
          description: ticket.category.description || null,
          isVip: ticket.category.isVip,
          isActive: ticket.category.isActive
        },
        coupon: {
          id: ticket._id,
          title: ticket.title,
          date: ticket.date,
          closingAt: ticket.closingAt,
          status: ticket.status,
          totalPredictions: ticket.predictions.length,
          totalOdds: ticket.predictions.reduce((total, pred) => total * pred.odds, 1).toFixed(2),
          predictions: ticket.predictions.map(pred => ({
            id: pred._id,
            odds: pred.odds,
            status: pred.status,
            sport: pred?.sport,
            event: {
              id: pred.event.id,
              label: pred.event.label[lang] || pred.event.label.fr || pred.event.label.current,
              description: pred.event.description.current,
              category: pred.event.category
            },
            match: {
              id: pred.matchData.id,
              date: pred.matchData.date,
              status: pred.matchData.status,
              league: {
                name: pred.matchData.league.name,
                country: pred.matchData.league.country,
                logo: pred.matchData.league.logo,
                countryFlag: pred.matchData.league.countryFlag,
              },
              teams: {
                home: {
                  id: pred.matchData?.teams?.home?.id,
                  name: pred.matchData?.teams?.home?.name,
                  logo: pred.matchData?.teams?.home?.logo
                },
                away: {
                  id: pred.matchData?.teams?.away?.id,
                  name: pred.matchData?.teams?.away?.name,
                  logo: pred.matchData?.teams?.away?.logo
                }
              },
              score: pred.matchData.score ? {
                home: pred.matchData.score.home,
                away: pred.matchData.score.away,
                status: pred.matchData.status
              } : null,
              venue: pred.matchData.venue ? {
                name: pred.matchData.venue.name,
                city: pred.matchData.venue.city
              } : null
            }
          })),
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt
        }
      };

      return res.status(200).json({
        success: true,
        message: `Coupon récupéré avec succès`,
        data: couponWithCategory
      });

    } catch (error) {
      console.error('Erreur lors de la récupération du coupon:', error);
      return res.status(500).json({
        success: false,
        message: 'Erreur interne du serveur',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * NOUVELLE VERSION OPTIMISÉE DE getTicketsHistory
   * Récupère les N dernières DATES RÉELLES où il y a eu des prédictions
   * (pas les N derniers jours du calendrier)
   */
  async getTicketsHistory(req, res) {
    try {
      const { 
        daysBack = 10, // Nombre de dates réelles à retourner
        isVip = null,
        category = null,
        lang = 'fr'
      } = req.query;

      // ===== ÉTAPE 1 : Scanner les 60 derniers jours (à partir d'HIER) =====
      const now = new Date();
      
      // Date de fin : HIER à 23:59:59.999
      const endDate = new Date(now);
      endDate.setDate(now.getDate() - 1); // Hier
      endDate.setHours(23, 59, 59, 999);
      
      // Date de début : Il y a 60 jours à 00:00:00.000
      const startDate = new Date(endDate);
      startDate.setDate(endDate.getDate() - 59); // 60 jours en tout
      startDate.setHours(0, 0, 0, 0);

      console.log('📅 Période de scan (60 jours max):', {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      });

      // ===== ÉTAPE 2 : Récupérer TOUS les tickets de la période en 1 seule requête =====
      const allTickets = await TicketService.getTicketsByDateRange({
        startDate,
        endDate,
        category,
        isVisible: true // ✅ TOUJOURS filtrer par isVisible: true pour l'historique
      });

      console.log('📦 Tickets récupérés (60 derniers jours):', allTickets.length);

      // ===== ÉTAPE 3 : Filtrer selon isVip =====
      let filteredTickets = allTickets;

      if (isVip === 'true') {
        // Pour VIP : récupérer les catégories accessibles par l'utilisateur
        const userVipCategories = await subscriptionService.getUserVipCategories(req.user._id);
        const accessibleVipCategoryIds = new Set(userVipCategories.map(cat => cat._id.toString()));

        console.log('🔑 Catégories VIP accessibles:', Array.from(accessibleVipCategoryIds));

        // Filtrer uniquement les tickets VIP accessibles
        filteredTickets = allTickets.filter(ticket => {
          const categoryId = ticket.category._id.toString();
          const isVipCategory = ticket.category.isVip === true;
          const hasAccess = accessibleVipCategoryIds.has(categoryId);
          
          return isVipCategory && hasAccess;
        });

        console.log('✅ Tickets VIP filtrés:', filteredTickets.length);

      } else if (isVip === 'false') {
        // Pour FREE : uniquement les catégories non-VIP
        filteredTickets = allTickets.filter(ticket => ticket.category.isVip === false);
        
        console.log('🆓 Tickets FREE filtrés:', filteredTickets.length);
      }

      // ===== ÉTAPE 4 : Extraire les dates UNIQUES où il y a des tickets =====
      const uniqueDatesSet = new Set();
      
      filteredTickets.forEach(ticket => {
        const ticketDate = new Date(ticket.date).toISOString().split('T')[0]; // Format YYYY-MM-DD
        uniqueDatesSet.add(ticketDate);
      });

      // Convertir en array et trier par date décroissante (plus récent → plus ancien)
      const sortedDates = Array.from(uniqueDatesSet).sort((a, b) => {
        return new Date(b) - new Date(a); // Ordre décroissant
      });

      console.log('📆 Dates uniques trouvées:', sortedDates.length);
      console.log('📆 Liste des dates:', sortedDates);

      // ===== ÉTAPE 5 : Prendre seulement les N premières dates (daysBack) =====
      const selectedDates = sortedDates.slice(0, parseInt(daysBack));

      console.log(`🎯 ${daysBack} dates sélectionnées:`, selectedDates);

      // ===== ÉTAPE 6 : Grouper les tickets par ces dates, puis par catégorie =====
      const historyByDate = [];

      selectedDates.forEach(dateString => {
        // Filtrer les tickets pour cette date spécifique
        const ticketsForDate = filteredTickets.filter(ticket => {
          const ticketDate = new Date(ticket.date).toISOString().split('T')[0];
          return ticketDate === dateString;
        });

        // Grouper les tickets par catégorie
        const categoriesMap = new Map();

        ticketsForDate.forEach(ticket => {
          const categoryId = ticket.category._id.toString();

          if (!categoriesMap.has(categoryId)) {
            categoriesMap.set(categoryId, {
              id: ticket.category._id,
              name: ticket.category.name,
              description: ticket.category.description || null,
              icon: ticket.category.icon,
              successRate: ticket.category.successRate,
              isVip: ticket.category.isVip,
              isActive: ticket.category.isActive,
              tickets: []
            });
          }

          const category = categoriesMap.get(categoryId);

          // Formater le ticket
          const formattedTicket = {
            id: ticket._id,
            title: ticket.title,
            date: ticket.date,
            closingAt: ticket.closingAt,
            status: ticket.status,
            isVisible: ticket.isVisible,
            totalPredictions: ticket.predictions.length,
            totalOdds: ticket.predictions.reduce((total, pred) => total * pred.odds, 1).toFixed(2),
            predictions: ticket.predictions.map(pred => ({
              id: pred._id,
              odds: pred.odds,
              status: pred.status,
              sport: pred?.sport,
              event: {
                id: pred.event.id,
                label: pred.event.label[lang] || pred.event.label.fr || pred.event.label.current,
                description: pred.event.description.current,
                category: pred.event.category
              },
              match: {
                id: pred.matchData.id,
                date: pred.matchData.date,
                status: pred.matchData.status,
                league: {
                  name: pred.matchData.league.name,
                  country: pred.matchData.league.country,
                  logo: pred.matchData.league.logo,
                  countryFlag: pred.matchData.league.countryFlag,
                },
                teams: {
                  home: {
                    id: pred.matchData?.teams?.home?.id,
                    name: pred.matchData?.teams?.home?.name,
                    logo: pred.matchData?.teams?.home?.logo
                  },
                  away: {
                    id: pred.matchData?.teams?.away?.id,
                    name: pred.matchData?.teams?.away?.name,
                    logo: pred.matchData?.teams?.away?.logo
                  }
                },
                score: pred.matchData.score ? {
                  home: pred.matchData.score.home,
                  away: pred.matchData.score.away,
                  status: pred.matchData.status
                } : null,
                venue: pred.matchData.venue ? {
                  name: pred.matchData.venue.name,
                  city: pred.matchData.venue.city
                } : null
              }
            })),
            createdAt: ticket.createdAt,
            updatedAt: ticket.updatedAt
          };

          category.tickets.push(formattedTicket);
        });

        // Convertir la Map en array et ajouter à l'historique
        const categories = Array.from(categoriesMap.values());
        
        historyByDate.push({
          date: dateString,
          categories
        });
      });

      console.log('📊 Résultat final:', {
        totalDates: historyByDate.length,
        datesWithData: historyByDate.map(h => h.date)
      });

      // ===== ÉTAPE 7 : Réponse finale =====
      const typeMessage = isVip === 'true' ? 'VIP' : isVip === 'false' ? 'gratuits' : '';

      return res.status(200).json({
        success: true,
        message: `Historique des tickets ${typeMessage} des ${daysBack} dernières dates récupéré avec succès`.trim(),
        data: {
          historyByDate
        }
      });

    } catch (error) {
      console.error('❌ Erreur lors de la récupération de l\'historique des tickets:', error);
      return res.status(500).json({
        success: false,
        message: 'Erreur interne du serveur',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
}

module.exports = new CouponController();