const mongoose = require("mongoose");

const TicketSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: true
  },
  isVisible: {
    type: Boolean,
    default: false
  },
  closingAt: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'closed', 'draft'],
    default: 'active'
  },

  // Résultat consolidé dérivé des prédictions du ticket. Recalculé par le
  // cron de correction (juste après la correction des pronostics) et par la
  // correction manuelle. Règle :
  //   - won  : tous les pronostics décidés sont 'won' (au moins 1 décidé)
  //   - lost : au moins 1 pronostic 'lost'
  //   - pending : il reste des pronostics 'pending' et aucun 'lost'
  //   - void : uniquement des 'void' (cas marginal)
  // Champ distinct de `status` pour ne pas casser la logique métier existante.
  result: {
    type: String,
    enum: ['pending', 'won', 'lost', 'void'],
    default: 'pending'
  },

  // Dernière fois que le résultat a été recalculé.
  resultUpdatedAt: {
    type: Date,
    default: null
  },

  // Clé d'idempotence pour la synchro sortante (cette app → WinTips).
  // Quand un ticket est poussé à WinTips, on mémorise son ID distant pour
  // éviter de recréer le ticket en boucle aux publications suivantes.
  externalRefs: {
    wintips: { type: String, default: null }
  }
}, {
  timestamps: true
});

// Index composé pour les requêtes principales
TicketSchema.index({
  date: -1,
  category: 1,
  isVisible: 1
});

// Index simple sur la date pour les requêtes par plage de dates
TicketSchema.index({
  date: -1
});

// Index sur la catégorie pour les filtres par catégorie
TicketSchema.index({
  category: 1
});

// Index sur le status pour les requêtes filtrées par status
TicketSchema.index({
  status: 1
});

// Index sur le résultat (dashboard, stats)
TicketSchema.index({
  result: 1
});

// Index composé pour les requêtes fréquentes de tickets visibles par date
TicketSchema.index({
  isVisible: 1,
  date: -1
});

// 🔴 Bibliothèque de messages pour notifications LIVE (10 variétés)
// Format: Le message + nom catégorie = phrase complète
const LIVE_NOTIFICATIONS = [
  {
    headings: {
      en: "🔴 LIVE Bet!",
      fr: "🔴 Pari LIVE!"
    },
    contents: {
      en: "⚡ Live now: {category}",
      fr: "⚡ En direct: {category}"
    }
  },
  {
    headings: {
      en: "🎯 LIVE Tip!",
      fr: "🎯 Tip LIVE!"
    },
    contents: {
      en: "🔥 Playing live: {category}",
      fr: "🔥 En jeu: {category}"
    }
  },
  {
    headings: {
      en: "⚡ LIVE Alert!",
      fr: "⚡ Alerte LIVE!"
    },
    contents: {
      en: "💎 Check live: {category}",
      fr: "💎 Découvre: {category}"
    }
  },
  {
    headings: {
      en: "🚨 LIVE Action!",
      fr: "🚨 Action LIVE!"
    },
    contents: {
      en: "🎲 Active now: {category}",
      fr: "🎲 Actif maintenant: {category}"
    }
  },
  {
    headings: {
      en: "💥 LIVE Drop!",
      fr: "💥 Drop LIVE!"
    },
    contents: {
      en: "⭐ Just posted live: {category}",
      fr: "⭐ Posté en direct: {category}"
    }
  },
  {
    headings: {
      en: "🔔 LIVE Opportunity!",
      fr: "🔔 Opportunité LIVE!"
    },
    contents: {
      en: "💰 Don't miss: {category}",
      fr: "💰 Ne rate pas: {category}"
    }
  },
  {
    headings: {
      en: "⚡ LIVE Prono!",
      fr: "⚡ Prono LIVE!"
    },
    contents: {
      en: "🎁 Hot live: {category}",
      fr: "🎁 Chaud en direct: {category}"
    }
  },
  {
    headings: {
      en: "🎯 LIVE Pick!",
      fr: "🎯 Pick LIVE!"
    },
    contents: {
      en: "🔥 Catch it: {category}",
      fr: "🔥 Attrape-le: {category}"
    }
  },
  {
    headings: {
      en: "🌟 LIVE Coupon!",
      fr: "🌟 Coupon LIVE!"
    },
    contents: {
      en: "💎 In play: {category}",
      fr: "💎 En cours: {category}"
    }
  },
  {
    headings: {
      en: "⚡ LIVE Now!",
      fr: "⚡ LIVE Maintenant!"
    },
    contents: {
      en: "🎲 Happening: {category}",
      fr: "🎲 C'est parti: {category}"
    }
  }
];

// 💰 Bibliothèque de messages pour notifications normales (10 variétés)
// Format: Le message + nom catégorie = phrase complète
const NORMAL_NOTIFICATIONS = [
  {
    headings: {
      en: "💰 New Coupon!",
      fr: "💰 Nouveau Coupon!"
    },
    contents: {
      en: "🎯 Available: {category}",
      fr: "🎯 Dispo maintenant: {category}"
    }
  },
  {
    headings: {
      en: "🎁 Fresh Tip!",
      fr: "🎁 Nouveau Tip!"
    },
    contents: {
      en: "⭐ Just posted: {category}",
      fr: "⭐ Tout juste posté: {category}"
    }
  },
  {
    headings: {
      en: "⚡ New Prono!",
      fr: "⚡ Nouveau Prono!"
    },
    contents: {
      en: "💎 Check it out: {category}",
      fr: "💎 Découvre: {category}"
    }
  },
  {
    headings: {
      en: "🌟 Tip Ready!",
      fr: "🌟 Tip Prêt!"
    },
    contents: {
      en: "🔥 Don't miss: {category}",
      fr: "🔥 Ne rate pas: {category}"
    }
  },
  {
    headings: {
      en: "🎯 New Pick!",
      fr: "🎯 Nouveau Pick!"
    },
    contents: {
      en: "⚡ Fresh drop: {category}",
      fr: "⚡ Nouveau: {category}"
    }
  },
  {
    headings: {
      en: "💎 Bet Alert!",
      fr: "💎 Alerte Pari!"
    },
    contents: {
      en: "⚡ Ready to play: {category}",
      fr: "⚡ Prêt à jouer: {category}"
    }
  },
  {
    headings: {
      en: "🔔 Prono Alert!",
      fr: "🔔 Alerte Prono!"
    },
    contents: {
      en: "🎁 Published: {category}",
      fr: "🎁 Publié: {category}"
    }
  },
  {
    headings: {
      en: "⭐ Hot Tip!",
      fr: "⭐ Tip Chaud!"
    },
    contents: {
      en: "💰 Check now: {category}",
      fr: "💰 Regarde: {category}"
    }
  },
  {
    headings: {
      en: "🎲 Prono Drop!",
      fr: "🎲 Drop Prono!"
    },
    contents: {
      en: "🔥 New drop: {category}",
      fr: "🔥 Nouveau drop: {category}"
    }
  },
  {
    headings: {
      en: "💥 New Opportunity!",
      fr: "💥 Nouvelle Opportunité!"
    },
    contents: {
      en: "🎯 Opportunity: {category}",
      fr: "🎯 Opportunité: {category}"
    }
  }
];

// 🎲 Fonction pour sélectionner un message aléatoire
function getRandomNotification(notificationArray, categoryName) {
  const randomIndex = Math.floor(Math.random() * notificationArray.length);
  const template = notificationArray[randomIndex];
  
  return {
    headings: template.headings,
    contents: {
      en: template.contents.en.replace('{category}', categoryName),
      fr: template.contents.fr.replace('{category}', categoryName)
    }
  };
}

// Hook pour findByIdAndUpdate / findOneAndUpdate
TicketSchema.post('findOneAndUpdate', async function (doc) {
  if (doc) {
    const update = this.getUpdate();
    const wasVisibilityChanged = update.isVisible === true || update.$set?.isVisible === true;
    
    if (wasVisibilityChanged && doc.isVisible) {
      try {
        // Récupérer le nom de la catégorie
        const Category = mongoose.model('Category');
        const category = await Category.findById(doc.category);
        const categoryName = category ? category.description : 'Catégorie inconnue';
        
        // Vérifier si c'est un LIVE
        const isLive = categoryName.toUpperCase().includes('LIVE');
        
        // Import du service de notification
        const notificationService = require("../../services/common/notificationService");
        
        // 🎯 Sélection aléatoire du message approprié
        const randomMessage = isLive 
          ? getRandomNotification(LIVE_NOTIFICATIONS, categoryName)
          : getRandomNotification(NORMAL_NOTIFICATIONS, categoryName);
        
        // Construction de la notification
        const notification = {
          headings: randomMessage.headings,
          contents: randomMessage.contents,
          data: {
            type: isLive ? "live" : "ticket",
            ticket_id: doc._id.toString(),
            category_name: categoryName,
            action: isLive ? "view_live" : "view_ticket"
          },
          options: {
            android_accent_color: isLive ? "FF0000" : "FF6B35",
            small_icon: "ic_notification",
            large_icon: "ic_launcher"
          }
        };

        // Envoyer la notification à tous les utilisateurs
        const result = await notificationService.sendToAll(notification);
    
      } catch (error) {
        console.error('❌ Erreur envoi notification:', error.message);
        
        // Log détaillé pour le debug en cas d'erreur
        console.error('Détails erreur:', {
          ticketId: doc._id,
          categoryId: doc.category,
          error: error.stack
        });
      }
    }
  }
});

module.exports = mongoose.model("Ticket", TicketSchema);