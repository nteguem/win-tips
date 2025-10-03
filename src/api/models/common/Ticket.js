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

// Index composé pour les requêtes fréquentes de tickets visibles par date
TicketSchema.index({
  isVisible: 1,
  date: -1
});

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
        
        let notification;
        
        if (isLive) {
          // Notification pour les LIVE - Messages optimisés
          notification = {
            headings: {
              en: "🔴 LIVE NOW - Wintips!",
              fr: "🔴 EN DIRECT - Wintips!"
            },
            contents: {
              en: `⚡ Live coupon available! Don't miss out - ${categoryName}`,
              fr: `⚡ Coupon live disponible ! Ne ratez pas - ${categoryName}`
            },
            data: {
              type: "live",
              ticket_id: doc._id.toString(),
              category_name: categoryName,
              action: "view_live"
            },
            options: {
              android_accent_color: "FF0000", // Rouge pour LIVE
              small_icon: "ic_notification",
              large_icon: "ic_launcher"
            }
          };
        } else {
          // Notification normale - Messages optimisés
          notification = {
            headings: {
              en: "💰 New Wintips Coupon!",
              fr: "💰 Nouveau Coupon Wintips!"
            },
            contents: {
              en: `🎯 Fresh coupon just dropped in ${categoryName} - Check it now!`,
              fr: `🎯 Nouveau coupon disponible dans ${categoryName} - Découvrez-le !`
            },
            data: {
              type: "ticket",
              ticket_id: doc._id.toString(),
              category_name: categoryName,
              action: "view_ticket"
            },
            options: {
              android_accent_color: "FF6B35",
              small_icon: "ic_notification",
              large_icon: "ic_launcher"
            }
          };
        }

        // Envoyer la notification à tous les utilisateurs
        const result = await notificationService.sendToAll(notification);
        
        console.log("✅ Notification envoyée avec succès");
        console.log("📊 Statistiques:", {
          notificationId: result.id,
          recipients: result.recipients,
          type: isLive ? 'LIVE' : 'NORMAL',
          category: categoryName
        });
        
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