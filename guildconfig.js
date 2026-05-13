// guildConfigs.js — Stockage des configurations de tickets par serveur
// Les données sont sauvegardées dans guildConfigs.json au même niveau
const fs   = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "guildConfigs.json");

let data = {};
try {
  if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, "utf-8"));
  console.log(`✅ guildConfigs : ${Object.keys(data).length} serveur(s) chargé(s)`);
} catch (e) {
  console.error("guildConfigs load:", e.message);
}

function persist() {
  try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("guildConfigs save:", e.message); }
}

/** Récupère la config d'un serveur (ou null si inexistante) */
function get(guildId) {
  return data[guildId] || null;
}

/** Sauvegarde la config d'un serveur */
function set(guildId, config) {
  data[guildId] = config;
  persist();
}

/** Supprime la config d'un serveur */
function del(guildId) {
  delete data[guildId];
  persist();
}

/** Config vierge par défaut */
function defaults() {
  return {
    interfaceType      : "dropdown", // "dropdown" | "buttons"
    staffRoles         : [],          // IDs des rôles staff
    ticketTypes        : [],          // Voir structure ci-dessous
    logChannelId       : null,
    transcriptChannelId: null,
    /*
    ticketTypes[n] = {
      id          : "abc12",          // ID interne unique (5 chars)
      label       : "Support",        // Nom affiché
      emoji       : "🎫",             // Emoji (Unicode)
      description : "Aide générale",  // Description (menu déroulant)
      categoryId  : "123456789",      // ID catégorie Discord
      pingRoles   : ["id1","id2"],    // Rôles mentionnés à l'ouverture
      welcomeMsg  : "Bonjour !",      // Message dans le ticket
    }
    */
  };
}

module.exports = { get, set, del, defaults };
