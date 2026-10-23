/**
 * @fileoverview Migration des champs bilingues vers le format { fr, en }.
 *
 * CONTEXTE
 * Avant la bascule bilingue, les champs name/description/badge/title étaient
 * de simples chaînes de caractères. Les schémas actuels attendent un objet
 * { fr, en }. Quand Mongoose charge un ancien document (champ = chaîne), le
 * cast vers le sous-schéma { fr, en } échoue silencieusement et la valeur est
 * perdue → le nom s'affiche vide dans le backoffice et l'app mobile.
 *
 * Ce script lit et écrit DIRECTEMENT les collections (driver natif, sans cast
 * Mongoose) afin de récupérer la chaîne d'origine et de la convertir en
 * { fr, en } (la même valeur dans les deux langues — à retraduire ensuite si
 * besoin via le backoffice).
 *
 * Idempotent : un champ déjà au format { fr, en } valide est laissé intact.
 * On peut donc le relancer sans risque, sur n'importe quelle base.
 *
 * Usage : node scripts/migrate-i18n-names.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const URI = process.env.MONGO_URI;
if (!URI) {
  console.error("❌ MONGO_URI manquant dans les variables d'environnement.");
  process.exit(1);
}

/** Vrai si la valeur est déjà un objet { fr, en } exploitable. */
function isI18n(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const fr = typeof v.fr === 'string' ? v.fr.trim() : '';
  const en = typeof v.en === 'string' ? v.en.trim() : '';
  return Boolean(fr || en);
}

/** Convertit une chaîne (ou un objet partiel) en { fr, en }, ou null si vide. */
function toI18n(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s ? { fr: s, en: s } : null;
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const fr = (v.fr || '').toString().trim();
    const en = (v.en || '').toString().trim();
    if (fr || en) return { fr: fr || en, en: en || fr };
  }
  return null;
}

/** Normalise les champs `fields` de tous les documents d'une collection. */
async function migrate(db, collection, fields) {
  const col = db.collection(collection);
  const docs = await col.find({}).toArray();
  let fixed = 0;
  for (const doc of docs) {
    const $set = {};
    for (const field of fields) {
      if (!(field in doc)) continue;
      const value = doc[field];
      if (isI18n(value)) continue; // déjà au bon format
      const converted = toI18n(value);
      if (converted) $set[field] = converted;
    }
    if (Object.keys($set).length) {
      await col.updateOne({ _id: doc._id }, { $set });
      fixed += 1;
      console.log(`  ✓ ${collection}/${doc._id} → ${Object.keys($set).join(', ')}`);
    }
  }
  console.log(`${collection} : ${fixed}/${docs.length} document(s) normalisé(s)\n`);
}

(async () => {
  await mongoose.connect(URI);
  console.log(`✅ Connecté à MongoDB (base : ${mongoose.connection.name})\n`);
  const db = mongoose.connection.db;

  await migrate(db, 'categories', ['name', 'description']);
  await migrate(db, 'packages', ['name', 'description', 'badge']);
  await migrate(db, 'formations', ['title', 'description', 'htmlContent']);

  console.log('✅ Migration terminée.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('❌ Erreur migration :', e);
  process.exit(1);
});
