// Migration : passe les catégories au format bilingue { fr, en }.
//
// Avant : name: "LIVE"            description: "Matchs live"
// Après : name: { fr:"LIVE", en:"LIVE" }   description: { fr:"Matchs live", en:"Matchs live" }
//
// Les deux langues sont initialisées avec la MÊME valeur (l'existant). L'admin
// affinera ensuite la traduction anglaise depuis le backoffice.
//
// Supprime aussi l'ancien index unique `name_1` (impossible sur un sous-objet).
//
// Idempotent : une catégorie déjà au format { fr, en } est ignorée.
//
// Lance :
//   MONGO_URI='...' node scripts/migrate-categories-bilingual.js

require('dotenv').config();
const mongoose = require('mongoose');

const URI = process.env.MONGO_URI;
if (!URI) {
  console.error('MONGO_URI manquant.');
  process.exit(1);
}

async function run() {
  console.log('Connexion MongoDB...');
  await mongoose.connect(URI);
  console.log('Connecté à :', mongoose.connection.name);

  const coll = mongoose.connection.db.collection('categories');

  // 1. Drop l'ancien index unique name_1 s'il existe
  try {
    await coll.dropIndex('name_1');
    console.log('✓ Ancien index unique name_1 supprimé');
  } catch (e) {
    console.log('(name_1 absent — OK)');
  }

  // 2. Migration des documents
  const cursor = coll.find({});
  let migrated = 0, skipped = 0;
  for await (const cat of cursor) {
    const update = {};

    // name
    if (typeof cat.name === 'string') {
      update.name = { fr: cat.name, en: cat.name };
    } else if (cat.name && typeof cat.name === 'object') {
      // déjà partiellement bilingue → on complète les manques
      const fr = cat.name.fr || cat.name.en || '';
      const en = cat.name.en || cat.name.fr || '';
      if (fr !== cat.name.fr || en !== cat.name.en) {
        update.name = { fr, en };
      }
    }

    // description
    if (typeof cat.description === 'string') {
      update.description = { fr: cat.description, en: cat.description };
    } else if (cat.description == null) {
      update.description = { fr: '', en: '' };
    } else if (cat.description && typeof cat.description === 'object') {
      const fr = cat.description.fr || cat.description.en || '';
      const en = cat.description.en || cat.description.fr || '';
      if (fr !== cat.description.fr || en !== cat.description.en) {
        update.description = { fr, en };
      }
    }

    if (Object.keys(update).length > 0) {
      await coll.updateOne({ _id: cat._id }, { $set: update });
      const label = update.name?.fr || (cat.name && cat.name.fr) || cat.name || '?';
      console.log(`  [migré] ${label}`);
      migrated++;
    } else {
      skipped++;
    }
  }

  console.log(`\nFini. ${migrated} migrée(s), ${skipped} déjà au bon format.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Erreur migration:', err);
  process.exit(1);
});
