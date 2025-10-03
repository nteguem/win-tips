import fs from 'fs';
import path from 'path';

/**
 * Fonction pour générer une représentation en arborescence d'un répertoire
 * @param {string} dirPath - Chemin du répertoire à explorer
 * @param {string} prefix - Préfixe pour l'indentation (utilisé dans la récursion)
 */
function generateDirectoryTree(dirPath, prefix = '') {
  // Dossiers et fichiers à ignorer
  const ignoredItems = [
    'node_modules',
    '.git',
    '.DS_Store',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '.nyc_output',
    '.cache',
    'tmp',
    'temp'
  ];

  try {
    // Lire le contenu du répertoire
    const items = fs.readdirSync(dirPath);
    
    // Filtrer les éléments à ignorer
    const filteredItems = items.filter(item => !ignoredItems.includes(item));
    
    // Trier les éléments : d'abord les dossiers, puis les fichiers
    const sortedItems = filteredItems.sort((a, b) => {
      const aIsDir = fs.statSync(path.join(dirPath, a)).isDirectory();
      const bIsDir = fs.statSync(path.join(dirPath, b)).isDirectory();
      
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });
    
    // Parcourir chaque élément
    sortedItems.forEach((item, index) => {
      const itemPath = path.join(dirPath, item);
      const isLastItem = index === sortedItems.length - 1;
      const isDirectory = fs.statSync(itemPath).isDirectory();
      
      // Symboles pour l'arborescence
      const connector = isLastItem ? '└── ' : '├── ';
      const newPrefix = prefix + (isLastItem ? '    ' : '│   ');
      
      // Afficher l'élément courant
      console.log(`${prefix}${connector}${item}${isDirectory ? '/' : ''}`);
      
      // Si c'est un répertoire, explorer récursivement
      if (isDirectory) {
        generateDirectoryTree(itemPath, newPrefix);
      }
    });
  } catch (error) {
    console.error(`Erreur lors de la lecture du répertoire ${dirPath}:`, error.message);
  }
}

// Récupérer le chemin du répertoire depuis les arguments de ligne de commande
// Si aucun argument n'est fourni, utiliser le répertoire courant
const directoryToExplore = process.argv[2] || '.';

console.log(`${path.resolve(directoryToExplore)}/`);
generateDirectoryTree(directoryToExplore);