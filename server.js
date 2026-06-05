// server.js - Render.com — CHL Bot v3.2
// Préfixe de commandes : //
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits, Events,
  InteractionType, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} = require("discord.js");
const express      = require("express");
const { google }   = require("googleapis");
const { createCode, verifyCode } = require("./codes");
const ts  = require("./ticketSystem");
const cfg = require("./guildConfigs");
const { registerStockChannel, pushStockUpdate, generateAdminToken } = require("./stockApi");
const jwt = require("jsonwebtoken");

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const TOKEN       = process.env.DISCORD_TOKEN;
const GUILD_ID    = process.env.GUILD_ID    || "1384283719933628416";
const LOG_CHANNEL = process.env.LOG_CHANNEL || "1473699667010125986";
const SHEET_ID    = process.env.SHEET_ID    || "1jIhIbWQdbqgggYnr6gxtdAaBAlY-przeuNfb9z1UhmI";
const PORT        = process.env.PORT        || 3000;
const JWT_SECRET  = process.env.JWT_SECRET  || "hlx5+HluEY0mWwnVREQzS1d8jotGb42sFr5BguMHAyM=";
const ADMIN_URL   = process.env.ADMIN_URL   || "https://stiorxtwitch.github.io/xperthas-pharma/admin-stock.html";

const TRANSCRIPT_CHANNEL_ID = process.env.TRANSCRIPT_CHANNEL_ID || "1498338598917902507";

const TICKET_CATEGORIES = {
  recrutement      : process.env.CAT_RECRUTEMENT || "1481345886910025891",
  question         : process.env.CAT_QUESTION    || "1481345980640006356",
  plainte          : process.env.CAT_PLAINTE     || "1481346050513047556",
  rendezvous       : process.env.CAT_RENDEZVOUS  || "1481346494543040716",
  recrutement_form : process.env.CAT_RC_FORM     || "1481346111250628770",
};

const STAFF_ROLES        = (process.env.STAFF_ROLES || "").split(",").filter(Boolean);
const RH_ROLE            = process.env.RH_ROLE            || "1481345263510753432";
const ROLE_RECRUTEMENT   = "1481345263510753432";
const ROLE_TICKETS       = "1481345187958489139";
const ROLE_LOGISTIQUE    = "1508101151046897664"; // Rôle responsable logistique (accès admin stock)

const STOCK_CHANNEL_NAME = "stockage-chl";
const STOCK_CATEGORY_ID  = process.env.CAT_STOCK || null;

const SHEET_LOGS   = "Sheet1";
const SHEET_PHARMA = "Sheet2";
const SHEET_SOIN   = "Sheet3";

const PREFIX = "//";

// Items par défaut — peuvent être étendus via le panel admin
const DEFAULT_ITEMS = [
  "Tablette","Garrot","Pansement de terrain","Bandage élastique",
  "Pansement hémostatique","Kit chirurgical","Pansement compressif",
  "Injecteur d'épinéphrine","Injecteur de morphine","Propofol100ml",
  "Propofol 250ml","Poche de sang 250ml","Poche de sang 500ml",
  "Poche de sang 750ml","Poche de sang 1000ml","Kit de réanimation d'urgence",
  "Moniteur ECG","Fentanyl","Ampoulier médical","Collier cervical",
  "Accès intra-osseux(IO)","Accès intraveineux(IV)","Dispositif de massage cardiaque"
];

// ══════════════════════════════════════════════
//  ANTI-DOUBLONS — caches & verrous
// ══════════════════════════════════════════════
const handledInteractions = new Map();
function alreadyHandled(id) {
  const now = Date.now();
  for (const [k, t] of handledInteractions) if (now - t > 5 * 60_000) handledInteractions.delete(k);
  if (handledInteractions.has(id)) return true;
  handledInteractions.set(id, now);
  return false;
}

const locks = new Map();
async function withLock(key, fn) {
  while (locks.get(key)) await locks.get(key).catch(() => {});
  let resolve;
  const p = new Promise(r => (resolve = r));
  locks.set(key, p);
  try { return await fn(); } finally { locks.delete(key); resolve(); }
}

// ══════════════════════════════════════════════
//  GOOGLE SHEETS
// ══════════════════════════════════════════════
function loadGoogleCreds() {
  if (process.env.GOOGLE_CREDS_B64) {
    try {
      return JSON.parse(Buffer.from(process.env.GOOGLE_CREDS_B64, "base64").toString("utf-8"));
    } catch (e) { throw new Error("GOOGLE_CREDS_B64 invalide : " + e.message); }
  }
  if (process.env.GOOGLE_CREDS) {
    let raw = process.env.GOOGLE_CREDS;
    try {
      const obj = JSON.parse(raw);
      if (obj.private_key && obj.private_key.includes("\\n"))
        obj.private_key = obj.private_key.replace(/\\n/g, "\n");
      return obj;
    } catch (e) { throw new Error("GOOGLE_CREDS invalide : " + e.message); }
  }
  throw new Error("Aucune credential Google : définis GOOGLE_CREDS_B64 ou GOOGLE_CREDS");
}

let _sheetsClient = null;
async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const creds = loadGoogleCreds();
  const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  _sheetsClient = google.sheets({ version: "v4", auth });
  return _sheetsClient;
}

async function initSheets() {
  try {
    const sheets = await getSheetsClient();
    const r1 = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A1` });
    if (!r1.data.values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A1:G1`,
        valueInputOption: "RAW",
        requestBody: { values: [["Date","Heure","Utilisateur","Produit","Action","Quantité","Lieu"]] }
      });
    }
    for (const sheetName of [SHEET_PHARMA, SHEET_SOIN]) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A1` });
      if (!r.data.values) {
        const rows = [["Nom","Stock"], ...DEFAULT_ITEMS.map(i => [i, 0])];
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range: `${sheetName}!A1:B${rows.length}`,
          valueInputOption: "RAW", requestBody: { values: rows }
        });
      }
    }
    console.log("✅ Sheets initialisés");
  } catch (err) { console.error("initSheets:", err.message); }
}

async function readStock(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A2:B` });
  const stock = {};
  (res.data.values || []).forEach(row => { if (row[0]) stock[row[0]] = parseInt(row[1]) || 0; });
  return stock;
}

async function updateStock(sheetName, item, delta) {
  const sheets   = await getSheetsClient();
  const res      = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A2:B` });
  const rows     = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === item);
  if (rowIndex === -1) throw new Error(`Produit "${item}" introuvable dans ${sheetName}`);
  const currentQty = parseInt(rows[rowIndex][1]) || 0;
  const newQty     = Math.max(0, currentQty + delta);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${sheetName}!B${rowIndex + 2}`,
    valueInputOption: "RAW", requestBody: { values: [[newQty]] }
  });
  return { oldQty: currentQty, newQty };
}

async function addItemToSheet(sheetName, item) {
  const sheets = await getSheetsClient();
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A2:B` });
  const rows   = res.data.values || [];
  if (rows.find(r => r[0] === item)) throw new Error(`Produit "${item}" déjà existant.`);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${sheetName}!A:B`,
    valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[item, 0]] }
  });
}

async function appendLog(user, item, delta, location) {
  const sheets = await getSheetsClient();
  const now    = new Date();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A:G`,
    valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[
      now.toLocaleDateString("fr-FR"),
      now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
      user, item, delta > 0 ? "Ajout" : "Retrait", Math.abs(delta), location
    ]] }
  });
}

// ══════════════════════════════════════════════
//  HELPER — Transcript
// ══════════════════════════════════════════════
async function generateTranscript(channel) {
  const lines = [];
  lines.push(`═══════════════════════════════════════════════`);
  lines.push(`  TRANSCRIPT — #${channel.name}`);
  lines.push(`  Serveur : ${channel.guild.name}`);
  lines.push(`  Généré le : ${new Date().toLocaleString("fr-FR")}`);
  lines.push(`═══════════════════════════════════════════════\n`);
  let lastMessage = null, allMessages = [];
  while (true) {
    const options = { limit: 100 };
    if (lastMessage) options.before = lastMessage;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;
    allMessages = allMessages.concat([...batch.values()]);
    lastMessage = batch.last().id;
    if (batch.size < 100) break;
  }
  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  for (const msg of allMessages) {
    lines.push(`[${msg.createdAt.toLocaleString("fr-FR")}] ${msg.author.tag}`);
    lines.push(`  ${msg.content || "(aucun contenu texte)"}`);
    msg.attachments.forEach(att => lines.push(`  📎 ${att.url}`));
    msg.embeds.forEach(e => { if (e.title) lines.push(`  📋 Embed : ${e.title}`); });
    lines.push("");
  }
  lines.push(`═══════════════════════════════════════════════`);
  lines.push(`  Fin du transcript — ${allMessages.length} message(s)`);
  lines.push(`═══════════════════════════════════════════════`);
  return lines.join("\n");
}

// ══════════════════════════════════════════════
//  HELPERS TICKETS
// ══════════════════════════════════════════════
function buildTicketPermissions(guild, userId) {
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: userId,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
  ];
  for (const roleId of STAFF_ROLES)
    overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] });
  return overwrites;
}

function isStaff(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return STAFF_ROLES.some(id => member.roles.cache.has(id));
}

function isLogistique(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.has(ROLE_LOGISTIQUE);
}

async function findChannelByName(guild, name, parentId) {
  const cached = guild.channels.cache.find(c => c.name === name && (!parentId || c.parentId === parentId));
  if (cached) return cached;
  try {
    const all = await guild.channels.fetch();
    return all.find(c => c && c.name === name && (!parentId || c.parentId === parentId)) || null;
  } catch { return null; }
}

async function sendTicketPanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle("🏥 Support — Centre Hospitalier de Liège")
    .setDescription(
      "Créez un ticket afin que notre équipe réponde à votre demande.\n\n" +
      "**Sélectionnez le type de demande** dans le menu ci-dessous.\n\n" +
      "🔴 **Problème recrutement** — Un souci avec votre candidature\n" +
      "❓ **Question** — Une question générale\n" +
      "📢 **Plainte interne** — Signaler un problème interne\n" +
      "📅 **Prise de rendez-vous** — Planifier un rendez-vous"
    )
    .setColor(0x004080)
    .setFooter({ text: "CHL — Un ticket = une réponse garantie" })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ticket_create")
      .setPlaceholder("📋 Sélectionner le type de ticket...")
      .addOptions([
        { label: "Problème recrutement", description: "Un problème lié à votre candidature",    value: "recrutement", emoji: "🔴" },
        { label: "Question générale",    description: "Une question sur le CHL",                value: "question",    emoji: "❓" },
        { label: "Plainte interne",      description: "Signaler un comportement problématique", value: "plainte",     emoji: "📢" },
        { label: "Prise de rendez-vous", description: "Planifier un rendez-vous",               value: "rendezvous",  emoji: "📅" },
      ])
  );
  await channel.send({ embeds: [embed], components: [row] });
}

function buildTicketButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("🔒 Fermer le ticket").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket_delete").setLabel("🗑️ Supprimer").setStyle(ButtonStyle.Danger),
  );
}

const TICKET_LABELS = {
  recrutement: "Problème Recrutement",
  question   : "Question",
  plainte    : "Plainte Interne",
  rendezvous : "Rendez-vous",
};

// ══════════════════════════════════════════════
//  STOCK — Helpers
// ══════════════════════════════════════════════

// Construit le message principal du channel stockage
async function buildStockPanelMessage(guild, channelId) {
  const pharmStock = await readStock(SHEET_PHARMA);
  const soinStock  = await readStock(SHEET_SOIN);
  const totalPharm = Object.values(pharmStock).reduce((s, v) => s + v, 0);
  const totalSoin  = Object.values(soinStock).reduce((s, v) => s + v, 0);
  const lowPharm   = Object.entries(pharmStock).filter(([, q]) => q < 5).map(([i]) => i);
  const lowSoin    = Object.entries(soinStock).filter(([, q]) => q < 5).map(([i]) => i);

  const embed = new EmbedBuilder()
    .setTitle("📦 Centre de Stockage — CHL")
    .setDescription(
      "Bienvenue dans le centre de gestion du stock hospitalier.\n" +
      "Sélectionnez un lieu et un article pour retirer du stock.\n\n" +
      `🏥 **Pharmacie** — ${totalPharm} unités totales\n` +
      `🩺 **Soins** — ${totalSoin} unités totales` +
      (lowPharm.length ? `\n\n⚠️ **Stock faible Pharmacie :** ${lowPharm.join(", ")}` : "") +
      (lowSoin.length  ? `\n⚠️ **Stock faible Soins :** ${lowSoin.join(", ")}`         : "")
    )
    .setColor(0x004080)
    .setFooter({ text: `CHL — Dernière mise à jour` })
    .setTimestamp();

  // Ligne 1 : choix du lieu
  const locationRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("stock_pick_location")
      .setPlaceholder("📍 1. Choisir un lieu de stockage...")
      .addOptions([
        { label: "Pharmacie", value: "Pharmacie", emoji: "🏥", description: "Médicaments et matériel médical" },
        { label: "Soins",     value: "Soin",      emoji: "🩺", description: "Matériel de soins" },
      ])
  );

  // Ligne 2 : boutons rapides
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("stock_refresh_panel").setLabel("🔄 Actualiser").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("stock_view_logs").setLabel("📋 Historique").setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [locationRow, actionRow] };
}

// Construit les options de retrait pour un lieu donné (max 25 options Discord)
async function buildItemSelectRow(location) {
  const sheetName = location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  const stock     = await readStock(sheetName);
  const available = Object.entries(stock).filter(([, q]) => q > 0);

  if (available.length === 0) return null;

  // Discord limite à 25 options max par menu
  const options = available.slice(0, 25).map(([item, qty]) => ({
    label      : item.substring(0, 25),
    value      : `${location}::${item}`,
    description: `Stock disponible : ${qty}`,
    emoji      : qty < 5 ? "🟠" : "🟢",
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("stock_pick_item")
      .setPlaceholder(`📦 2. Choisir un article (${location})...`)
      .addOptions(options)
  );
}

// ══════════════════════════════════════════════
//  BOT — Singleton
// ══════════════════════════════════════════════
if (global.__chl_bot_started) {
  console.warn("⚠️ Tentative de double-démarrage du bot ignorée.");
} else {
  global.__chl_bot_started = true;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  console.log(`📌 Préfixe actif : ${PREFIX}`);
  await initSheets();
});

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException",  (err) => console.error("uncaughtException :", err));

// ══════════════════════════════════════════════
//  COMMANDES PRÉFIXE "//"
// ══════════════════════════════════════════════
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;
  if (!message.content.startsWith(PREFIX)) return;

  const raw    = message.content.slice(PREFIX.length).trim();
  const args   = raw.split(/\s+/);
  const cmd    = args.shift().toLowerCase();
  const guild  = message.guild;
  const member = message.member;
  const channel = message.channel;

  try {

    // ── //stock ────────────────────────────────
    if (cmd === "stock") {
      if (!isStaff(member)) return message.reply("❌ Staff uniquement.");

      await message.reply("⏳ Vérification en cours...");

      return withLock("stock_channel_create", async () => {
        try {
          // Anti-doublon : vérifier si le channel existe déjà
          const existing = await findChannelByName(guild, STOCK_CHANNEL_NAME, STOCK_CATEGORY_ID);
          if (existing) {
            return message.reply(
              `⚠️ Le salon de stockage existe déjà : <#${existing.id}>\n` +
              `Utilisez \`//stock refresh\` pour rafraîchir le panel.`
            );
          }

          // Sous-commande refresh
          if ((args[0] || "").toLowerCase() === "refresh") {
            const ch = await findChannelByName(guild, STOCK_CHANNEL_NAME, STOCK_CATEGORY_ID);
            if (!ch) return message.reply("❌ Aucun salon stockage trouvé. Lancez `//stock` d'abord.");
            const panelMsg = await buildStockPanelMessage(guild, ch.id);
            await ch.bulkDelete(5).catch(() => {});
            await ch.send(panelMsg);
            return message.reply("✅ Panel stockage rafraîchi !");
          }

          // Créer le channel — lecture seule pour tout le monde, staff complet
          const overwrites = [
            {
              id   : guild.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
              deny : [PermissionFlagsBits.SendMessages],
            },
          ];
          for (const roleId of STAFF_ROLES) {
            overwrites.push({
              id   : roleId,
              allow: [
                PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages,
              ],
            });
          }
          // Le rôle logistique peut aussi voir et interagir
          overwrites.push({
            id   : ROLE_LOGISTIQUE,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny : [PermissionFlagsBits.SendMessages],
          });

          const stockChannel = await guild.channels.create({
            name                : STOCK_CHANNEL_NAME,
            type                : ChannelType.GuildText,
            parent              : STOCK_CATEGORY_ID || undefined,
            permissionOverwrites: overwrites,
            topic               : "📦 Gestion du stock — Centre Hospitalier de Liège",
          });

          // Enregistrer dans Supabase
          const apiResult = await registerStockChannel(stockChannel.id, guild.id, stockChannel.name);
          if (!apiResult.success) console.warn("⚠️ Supabase registerStockChannel :", apiResult.error);

          // Envoyer le panel interactif
          const panelMsg = await buildStockPanelMessage(guild, stockChannel.id);
          await stockChannel.send(panelMsg);

          // Message privé au staff avec lien admin (token JWT)
          const token = jwt.sign(
            { userId: member.user.id, guildId: guild.id, role: "logistique" },
            JWT_SECRET, { expiresIn: "1h" }
          );
          try {
            await member.send(
              `✅ **Salon stockage créé :** <#${stockChannel.id}>\n\n` +
              `🔐 **Lien panel admin logistique (valide 1h) :**\n` +
              `${ADMIN_URL}?token=${token}`
            );
          } catch (_) {}

          return message.reply(
            `✅ Salon <#${stockChannel.id}> créé avec succès !\n` +
            `📬 Le lien admin t'a été envoyé en DM.`
          );

        } catch (err) {
          console.error("//stock :", err);
          return message.reply(`❌ Erreur : ${err.message}`);
        }
      });
    }

    // ── //stock_admin (génère un lien admin pour un responsable logistique) ──
    if (cmd === "stock_admin") {
      if (!isStaff(member)) return message.reply("❌ Staff uniquement.");

      const targetMention = message.mentions.members.first();
      if (!targetMention) return message.reply("❌ Mention un membre : `//stock_admin @membre`");
      if (!isLogistique(targetMention) && !isStaff(targetMention))
        return message.reply("❌ Ce membre n'a pas le rôle Logistique.");

      const token = jwt.sign(
        { userId: targetMention.user.id, guildId: guild.id, role: "logistique" },
        JWT_SECRET, { expiresIn: "1h" }
      );
      try {
        await targetMention.send(
          `🔐 **Lien panel admin stock CHL (valide 1h) :**\n${ADMIN_URL}?token=${token}\n\n` +
          `Ce lien est personnel et ne doit pas être partagé.`
        );
        return message.reply(`✅ Lien admin envoyé en DM à ${targetMention.user.tag}.`);
      } catch (_) {
        return message.reply("❌ Impossible d'envoyer un DM à ce membre.");
      }
    }

    // ── //ticket_panel ──
    if (cmd === "ticket_panel") {
      if (!member.permissions.has(PermissionFlagsBits.Administrator))
        return message.reply("❌ Administrateur uniquement.");
      await sendTicketPanel(channel);
      await message.reply("✅ Panneau ticket CHL envoyé.");
      return;
    }

    // ── //fermer ──
    if (cmd === "fermer") {
      if (!isStaff(member)) return message.reply("❌ Staff uniquement.");
      await message.reply("🔒 Ticket fermé.");
      for (const [id] of channel.permissionOverwrites.cache) {
        if (!STAFF_ROLES.includes(id) && id !== guild.id)
          await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
      }
      await channel.setName("fermé-" + channel.name).catch(() => {});
      return;
    }

    // ── //supprimer ──
    if (cmd === "supprimer") {
      if (!isStaff(member)) return message.reply("❌ Staff uniquement.");
      await message.reply("🗑️ Suppression dans 5 secondes...");
      setTimeout(() => channel.delete().catch(() => {}), 5000);
      return;
    }

    // ── //delete <oui|non> <raison...> ──
    if (cmd === "delete") {
      if (!isStaff(member)) return message.reply("❌ Staff uniquement.");
      const doTranscript = (args[0] || "non").toLowerCase() === "oui";
      const raison       = args.slice(1).join(" ") || "Aucune raison fournie";
      const confirmEmbed = new EmbedBuilder()
        .setTitle("🗑️ Ticket en cours de suppression")
        .setDescription(
          `Ce ticket va être supprimé dans **5 secondes**.\n\n` +
          `**Raison :** ${raison}\n` +
          `**Transcript :** ${doTranscript ? "✅ Oui" : "❌ Non"}\n` +
          `**Fermé par :** ${member.user.tag}`
        )
        .setColor(0xe74c3c).setTimestamp().setFooter({ text: "CHL — Gestion des tickets" });
      await channel.send({ embeds: [confirmEmbed] });
      if (doTranscript) {
        try {
          const text       = await generateTranscript(channel);
          const fileName   = `transcript-${channel.name}-${Date.now()}.txt`;
          const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), { name: fileName });
          const tEmbed = new EmbedBuilder()
            .setTitle("📄 Transcript de ticket")
            .setDescription(`**Salon :** #${channel.name}\n**Raison :** ${raison}\n**Fermé par :** ${member.user.tag} (<@${member.user.id}>)\n**Date :** ${new Date().toLocaleString("fr-FR")}`)
            .setColor(0x004080).setTimestamp().setFooter({ text: "CHL — Transcripts" });
          const tCh = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
          await tCh.send({ embeds: [tEmbed], files: [attachment] });
        } catch (err) { console.error("Erreur transcript //delete :", err.message); }
      }
      setTimeout(() => channel.delete().catch(() => {}), 5000);
      return;
    }

    // ── //attente / valider / refuser ──
    if (cmd === "attente") {
      if (!isStaff(member) && !member.roles.cache.has(RH_ROLE)) return message.reply("❌ RH / Staff uniquement.");
      return channel.send({ embeds: [new EmbedBuilder().setTitle("⏳ Candidature en attente").setDescription("Votre candidature est actuellement **en cours d'examen** par notre équipe RH.\n\nNous reviendrons vers vous dans les plus brefs délais. Merci de votre patience.").setColor(0xf0a500).setTimestamp().setFooter({ text: `Traité par ${member.user.tag}` })] });
    }
    if (cmd === "valider") {
      if (!isStaff(member) && !member.roles.cache.has(RH_ROLE)) return message.reply("❌ RH / Staff uniquement.");
      return channel.send({ embeds: [new EmbedBuilder().setTitle("✅ Candidature validée !").setDescription("Félicitations ! Votre candidature a été **acceptée** par l'équipe du Centre Hospitalier de Liège.\n\nUn membre de notre équipe vous contactera prochainement pour la suite du processus d'intégration.\n\nBienvenue dans l'équipe ! 🏥").setColor(0x27ae60).setTimestamp().setFooter({ text: `Validé par ${member.user.tag}` })] });
    }
    if (cmd === "refuser") {
      if (!isStaff(member) && !member.roles.cache.has(RH_ROLE)) return message.reply("❌ RH / Staff uniquement.");
      return channel.send({ embeds: [new EmbedBuilder().setTitle("❌ Candidature refusée").setDescription("Nous avons bien examiné votre candidature, mais nous ne sommes pas en mesure de vous intégrer pour le moment.\n\nNous vous remercions de l'intérêt que vous portez au Centre Hospitalier de Liège et vous encourageons à repostuler dans le futur.\n\nCordialement, l'équipe RH 🏥").setColor(0xc0392b).setTimestamp().setFooter({ text: `Refusé par ${member.user.tag}` })] });
    }

    // ── //ticket <sous-commande> ──
    if (cmd === "ticket") {
      const sub = (args.shift() || "").toLowerCase();
      if (sub === "setup") {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply("❌ Administrateur uniquement.");
        const config = cfg.get(guild.id) || cfg.defaults();
        const msg = await channel.send({ embeds: [ts.setupEmbed(guild, config)], components: ts.setupRows(config) });
        ts.sessions.set(guild.id, { channelId: channel.id, messageId: msg.id });
        await message.delete().catch(() => {});
        return;
      }
      if (sub === "panel") {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply("❌ Administrateur uniquement.");
        const config = cfg.get(guild.id);
        if (!config || config.ticketTypes.length === 0) return message.reply("❌ Aucun type configuré. Lancez d'abord `//ticket setup`.");
        await ts.deployPanel(channel, config, guild);
        await message.delete().catch(() => {});
        return;
      }
      if (sub === "fermer") {
        const config = cfg.get(guild.id) || {};
        if (!ts.isStaffOrAdmin(member, config)) return message.reply("❌ Staff uniquement.");
        await message.reply("🔒 Ticket fermé.");
        for (const [id] of channel.permissionOverwrites.cache) {
          if (!(config.staffRoles || []).includes(id) && id !== guild.id)
            await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
        }
        await channel.setName(`fermé-${channel.name}`.substring(0, 100)).catch(() => {});
        return;
      }
      if (sub === "supprimer") {
        const config = cfg.get(guild.id) || {};
        if (!ts.isStaffOrAdmin(member, config)) return message.reply("❌ Staff uniquement.");
        const doTranscript = (args[0] || "non").toLowerCase() === "oui";
        const raison       = args.slice(1).join(" ") || "Aucune raison fournie";
        if (doTranscript) {
          try {
            const text = await ts.generateTranscript(channel);
            const att  = new AttachmentBuilder(Buffer.from(text, "utf-8"), { name: `transcript-${channel.name}-${Date.now()}.txt` });
            const tEmbed = new EmbedBuilder().setTitle("📄 Transcript de ticket").setDescription(`**Salon :** #${channel.name}\n**Raison :** ${raison}\n**Fermé par :** ${member.user.tag} (<@${member.user.id}>)\n**Date :** ${new Date().toLocaleString("fr-FR")}`).setColor(0x004080).setTimestamp();
            if (config.transcriptChannelId) { const tc = await client.channels.fetch(config.transcriptChannelId); await tc.send({ embeds: [tEmbed], files: [att] }); }
          } catch (err) { console.error("transcript //ticket supprimer:", err.message); }
        }
        await channel.send({ embeds: [new EmbedBuilder().setTitle("🗑️ Ticket en cours de suppression").setDescription(`Ce ticket sera supprimé dans **5 secondes**.\n\n**Raison :** ${raison}\n**Transcript :** ${doTranscript ? "✅ Oui" : "❌ Non"}\n**Par :** ${member.user.tag}`).setColor(0xe74c3c).setTimestamp()] });
        setTimeout(() => channel.delete().catch(() => {}), 5000);
        return;
      }
      return channel.send({ embeds: [new EmbedBuilder().setTitle("📖 Aide — //ticket").addFields({ name: "`//ticket setup`", value: "Configurer le système *(Admin)*" }, { name: "`//ticket panel`", value: "Déployer le panel *(Admin)*" }, { name: "`//ticket fermer`", value: "Fermer ce ticket" }, { name: "`//ticket supprimer [oui|non] [raison]`", value: "Supprimer avec ou sans transcript" }).setColor(0x004080).setTimestamp()] });
    }

    if (cmd === "aide" || cmd === "help") {
      return channel.send({ embeds: [
        new EmbedBuilder()
          .setTitle("📖 Aide — CHL Bot")
          .setDescription(`Préfixe : \`${PREFIX}\``)
          .addFields(
            { name: "🏥 Tickets CHL",          value: "`//ticket_panel`\n`//fermer`\n`//supprimer`\n`//delete <oui|non> <raison>`" },
            { name: "👔 Recrutement",           value: "`//attente`\n`//valider`\n`//refuser`" },
            { name: "🎫 Tickets configurables", value: "`//ticket setup`\n`//ticket panel`\n`//ticket fermer`\n`//ticket supprimer [oui|non] [raison]`" },
            { name: "📦 Stock",                 value: "`//stock` — Crée le salon stockage\n`//stock refresh` — Rafraîchit le panel\n`//stock_admin @membre` — Envoie un lien admin en DM" },
          )
          .setColor(0x004080).setTimestamp().setFooter({ text: "CHL Bot v3.2" })
      ]});
    }

  } catch (err) {
    console.error(`Commande //${cmd} :`, err);
    try { await message.reply(`❌ Erreur : ${err.message}`); } catch {}
  }
});

// ══════════════════════════════════════════════
//  INTERACTIONS
// ══════════════════════════════════════════════
client.on(Events.InteractionCreate, async (interaction) => {
  if (alreadyHandled(interaction.id)) {
    console.warn("⚠️ Interaction dupliquée ignorée :", interaction.id);
    return;
  }
  const guild = interaction.guild;

  try {
    // ── Wizard ts_ ──
    if (interaction.isButton() && interaction.customId.startsWith("ts_"))
      return ts.onSetupButton(interaction, client);
    if (interaction.isStringSelectMenu() && interaction.customId === "ts_deltype_sel")
      return ts.onSetupSelect(interaction, client);
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("ts_m_"))
      return ts.onSetupModal(interaction, client);

    // ── Panel public TS ──
    if (interaction.isStringSelectMenu() && interaction.customId === "tpanel_sel")
      return ts.createTicket(interaction, interaction.values[0], client);
    if (interaction.isButton() && interaction.customId.startsWith("tpanel_"))
      return ts.createTicket(interaction, interaction.customId.replace("tpanel_", ""), client);
    if (interaction.isButton() && interaction.customId.startsWith("tticket_"))
      return ts.onTicketButton(interaction, client);

    // ════════════════════════════════════════════
    //  STOCK — Étape 1 : choix du lieu
    // ════════════════════════════════════════════
    if (interaction.isStringSelectMenu() && interaction.customId === "stock_pick_location") {
      const location = interaction.values[0]; // "Pharmacie" | "Soin"
      await interaction.deferReply({ ephemeral: true });

      const itemRow = await buildItemSelectRow(location);
      if (!itemRow) {
        return interaction.editReply({ content: `❌ Aucun article disponible en **${location}** pour le moment.` });
      }

      const stockEmbed = new EmbedBuilder()
        .setTitle(`📦 ${location} — Sélection d'article`)
        .setDescription("Choisissez un article à retirer du stock.\nUne confirmation vous sera demandée.")
        .setColor(location === "Pharmacie" ? 0x004080 : 0x27ae60)
        .setFooter({ text: "CHL — Les articles en 🟠 sont en stock faible" });

      return interaction.editReply({ embeds: [stockEmbed], components: [itemRow] });
    }

    // ════════════════════════════════════════════
    //  STOCK — Étape 2 : choix de l'article
    //  → ouvre une modale pour la quantité
    // ════════════════════════════════════════════
    if (interaction.isStringSelectMenu() && interaction.customId === "stock_pick_item") {
      const [location, ...itemParts] = interaction.values[0].split("::");
      const item = itemParts.join("::");

      const modal = new ModalBuilder()
        .setCustomId(`stock_confirm::${location}::${item}`)
        .setTitle(`Retrait — ${item.substring(0, 30)}`);

      const qtyInput = new TextInputBuilder()
        .setCustomId("qty")
        .setLabel(`Quantité à retirer (stock : ${await getItemQty(location, item)})`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Ex: 2")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(4);

      modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
      return interaction.showModal(modal);
    }

    // ════════════════════════════════════════════
    //  STOCK — Étape 3 : confirmation modale
    // ════════════════════════════════════════════
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("stock_confirm::")) {
      const parts    = interaction.customId.split("::");
      const location = parts[1];
      const item     = parts.slice(2).join("::");
      const qtyRaw   = interaction.fields.getTextInputValue("qty");
      const qty      = parseInt(qtyRaw);

      if (isNaN(qty) || qty <= 0)
        return interaction.reply({ content: "❌ Quantité invalide (doit être un entier positif).", ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      return withLock(`stock_update:${location}:${item}`, async () => {
        try {
          const sheetName = location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
          const { oldQty, newQty } = await updateStock(sheetName, item, -qty);

          if (oldQty < qty) {
            return interaction.editReply({ content: `❌ Stock insuffisant. Disponible : **${oldQty}**.` });
          }

          await appendLog(interaction.user.tag, item, -qty, location);

          // Log dans le channel de logs Discord
          try {
            const logChannel = await client.channels.fetch(LOG_CHANNEL);
            const logEmbed = new EmbedBuilder()
              .setTitle("📦 Retrait de Stock")
              .setDescription(`<@${interaction.user.id}> a retiré du stock.`)
              .addFields(
                { name: "Produit",   value: item,         inline: true },
                { name: "Quantité",  value: `${qty}`,     inline: true },
                { name: "Lieu",      value: location,     inline: true },
                { name: "Avant",     value: `${oldQty}`,  inline: true },
                { name: "Après",     value: `${newQty}`,  inline: true },
              )
              .setColor(0xe74c3c).setTimestamp()
              .setFooter({ text: `CHL Stock — ${interaction.user.tag}` });
            await logChannel.send({ content: `<@${interaction.user.id}>`, embeds: [logEmbed] });
          } catch (_) {}

          // Notifier Supabase
          await pushStockUpdate({
            channelId: interaction.channelId, guildId: guild.id,
            user: interaction.user.tag, item, delta: -qty, location, newQty,
          }).catch(() => {});

          // Mettre à jour le panel stockage (rafraîchir l'embed du channel)
          try {
            const stockCh = await findChannelByName(guild, STOCK_CHANNEL_NAME, STOCK_CATEGORY_ID);
            if (stockCh) {
              const messages  = await stockCh.messages.fetch({ limit: 5 });
              const panelMsg  = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
              if (panelMsg) {
                const newPanel = await buildStockPanelMessage(guild, stockCh.id);
                await panelMsg.edit(newPanel);
              }
            }
          } catch (_) {}

          const confirmEmbed = new EmbedBuilder()
            .setTitle("✅ Retrait confirmé")
            .addFields(
              { name: "Article",     value: item,        inline: true },
              { name: "Quantité",    value: `${qty}`,    inline: true },
              { name: "Lieu",        value: location,    inline: true },
              { name: "Nouveau stock", value: `${newQty}`, inline: true },
            )
            .setColor(0x27ae60).setTimestamp()
            .setFooter({ text: `Retiré par ${interaction.user.tag}` });

          return interaction.editReply({ embeds: [confirmEmbed] });

        } catch (err) {
          console.error("stock_confirm:", err);
          return interaction.editReply({ content: `❌ Erreur : ${err.message}` });
        }
      });
    }

    // ── Stock — Bouton Actualiser panel ──
    if (interaction.isButton() && interaction.customId === "stock_refresh_panel") {
      await interaction.deferReply({ ephemeral: true });
      try {
        const stockCh = await findChannelByName(guild, STOCK_CHANNEL_NAME, STOCK_CATEGORY_ID);
        if (stockCh) {
          const messages = await stockCh.messages.fetch({ limit: 5 });
          const panelMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
          if (panelMsg) {
            const newPanel = await buildStockPanelMessage(guild, stockCh.id);
            await panelMsg.edit(newPanel);
          }
        }
        return interaction.editReply({ content: "✅ Panel actualisé." });
      } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
      }
    }

    // ── Stock — Bouton Historique ──
    if (interaction.isButton() && interaction.customId === "stock_view_logs") {
      await interaction.deferReply({ ephemeral: true });
      try {
        const sheets = await getSheetsClient();
        const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A2:G` });
        const rows   = (result.data.values || []).slice(-10).reverse();
        if (!rows.length) return interaction.editReply({ content: "📋 Aucun log trouvé." });
        const lines  = rows.map(r => `\`${r[0]} ${r[1]}\` — **${r[2]}** | ${r[4]} **${r[3]}** × ${r[5]} (${r[6]})`);
        const embed  = new EmbedBuilder()
          .setTitle("📋 10 dernières opérations de stock")
          .setDescription(lines.join("\n"))
          .setColor(0x004080).setTimestamp().setFooter({ text: "CHL — Google Sheets Logs" });
        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
      }
    }

    // ── Système CHL — Select menu (création de ticket) ──
    if (interaction.isStringSelectMenu() && interaction.customId === "ticket_create") {
      const type   = interaction.values[0];
      const member = interaction.member;
      const label  = TICKET_LABELS[type] || type;
      const catId  = TICKET_CATEGORIES[type];
      const tag    = member.user.tag.replace(/[^a-zA-Z0-9_]/g, "");
      const channelName = `${type}-${tag}`.toLowerCase().substring(0, 100);

      await interaction.deferReply({ ephemeral: true });

      return withLock(`ticket_create:${member.user.id}:${type}`, async () => {
        try {
          const existing = await findChannelByName(guild, channelName, catId);
          if (existing)
            return interaction.editReply({ content: `❌ Vous avez déjà un ticket de ce type ouvert : <#${existing.id}>` });

          const channel = await guild.channels.create({
            name: channelName, type: ChannelType.GuildText,
            parent: catId || undefined,
            permissionOverwrites: buildTicketPermissions(guild, member.user.id),
            topic: `Ticket ${label} — ${member.user.tag}`,
          });
          const embed = new EmbedBuilder()
            .setTitle(`🎫 ${label}`)
            .setDescription(`Bonjour <@${member.user.id}>, votre ticket a été créé.\n\nNotre équipe vous répondra dans les plus brefs délais.\n\n**Type :** ${label}\n**Créé par :** ${member.user.tag}`)
            .setColor(0x004080).setTimestamp()
            .setFooter({ text: "CHL — Utilisez les boutons ci-dessous pour gérer ce ticket" });
          await channel.send({ content: `<@${member.user.id}> <@&${ROLE_TICKETS}>`, embeds: [embed], components: [buildTicketButtons()] });
          return interaction.editReply({ content: `✅ Votre ticket a été créé : <#${channel.id}>` });
        } catch (err) {
          console.error("ticket_create:", err);
          return interaction.editReply({ content: `❌ Erreur : ${err.message}` });
        }
      });
    }

    if (interaction.isButton() && interaction.customId === "ticket_close") {
      if (!isStaff(interaction.member))
        return interaction.reply({ content: "❌ Seul le staff peut fermer les tickets.", ephemeral: true });
      await interaction.reply({ content: "🔒 Ticket fermé." });
      const channel = interaction.channel;
      for (const [id] of channel.permissionOverwrites.cache) {
        if (!STAFF_ROLES.includes(id) && id !== guild.id)
          await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
      }
      await channel.setName("fermé-" + channel.name).catch(() => {});
      return;
    }

    if (interaction.isButton() && interaction.customId === "ticket_delete") {
      if (!isStaff(interaction.member))
        return interaction.reply({ content: "❌ Seul le staff peut supprimer les tickets.", ephemeral: true });
      await interaction.reply({ content: "🗑️ Suppression du ticket dans 5 secondes..." });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
      return;
    }

  } catch (err) {
    console.error("InteractionCreate :", err);
    try {
      if (interaction.deferred || interaction.replied)
        await interaction.followUp({ content: `❌ Erreur : ${err.message}`, ephemeral: true });
      else
        await interaction.reply({ content: `❌ Erreur : ${err.message}`, ephemeral: true });
    } catch {}
  }
});

// Helper pour récupérer la quantité d'un item
async function getItemQty(location, item) {
  try {
    const stock = await readStock(location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN);
    return stock[item] ?? 0;
  } catch { return "?"; }
}

if (TOKEN) {
  client.login(TOKEN).catch(err => console.error("client.login:", err));
} else {
  console.error("❌ DISCORD_TOKEN manquant");
}

// ══════════════════════════════════════════════
//  EXPRESS API
// ══════════════════════════════════════════════
const app = express();

const ALLOWED_ORIGINS = [
  "https://stiorxtwitch.github.io",
  "https://stiorxtwitch.github.io/",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", (origin && ALLOWED_ORIGINS.includes(origin)) ? origin : "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// Middleware JWT — vérifie le token pour les routes /admin/*
function requireAdminToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token      = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ success: false, error: "Token manquant" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "logistique" && payload.role !== "admin")
      return res.status(403).json({ success: false, error: "Rôle insuffisant" });
    req.jwtPayload = payload;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: "Token invalide ou expiré" });
  }
}

app.get("/", (_, res) => res.json({ status: "CHL Bot API v3.2 ✅ — Préfixe : //" }));

// ── Vérification du token JWT (page admin) ──
app.get("/api/admin/verify", requireAdminToken, (req, res) => {
  res.json({ success: true, userId: req.jwtPayload.userId, guildId: req.jwtPayload.guildId });
});

// ── Stock — Lire ──
app.get("/api/admin/stock", requireAdminToken, async (req, res) => {
  const { location } = req.query;
  if (!location) return res.json({ success: false, error: "Paramètre location manquant" });
  const sheetName = location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  try { res.json({ success: true, stock: await readStock(sheetName) }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Stock — Ajouter / modifier quantité ──
app.post("/api/admin/stock/update", requireAdminToken, async (req, res) => {
  const { location, item, delta } = req.body;
  if (!location || !item || delta === undefined)
    return res.json({ success: false, error: "Paramètres manquants" });
  const sheetName = location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  try {
    const { oldQty, newQty } = await updateStock(sheetName, item, delta);
    await appendLog(`Admin [${req.jwtPayload.userId}]`, item, delta, location);
    // Log Discord
    try {
      const logChannel = await client.channels.fetch(LOG_CHANNEL);
      const embed = new EmbedBuilder()
        .setTitle(`📦 Mise à jour Stock — ${delta > 0 ? "Ajout" : "Retrait"} (Admin)`)
        .addFields(
          { name: "Produit",   value: item,                 inline: true },
          { name: "Quantité",  value: `${Math.abs(delta)}`, inline: true },
          { name: "Lieu",      value: location,             inline: true },
          { name: "Avant",     value: `${oldQty}`,          inline: true },
          { name: "Après",     value: `${newQty}`,          inline: true },
        )
        .setColor(delta > 0 ? 0x27ae60 : 0xe74c3c).setTimestamp()
        .setFooter({ text: `Par le panel admin — UID Discord : ${req.jwtPayload.userId}` });
      await logChannel.send({ embeds: [embed] });
    } catch (_) {}
    // Rafraîchir le panel Discord
    try {
      const guild    = await client.guilds.fetch(req.jwtPayload.guildId);
      const stockCh  = await findChannelByName(guild, STOCK_CHANNEL_NAME, STOCK_CATEGORY_ID);
      if (stockCh) {
        const messages = await stockCh.messages.fetch({ limit: 5 });
        const panelMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
        if (panelMsg) await panelMsg.edit(await buildStockPanelMessage(guild, stockCh.id));
      }
    } catch (_) {}
    res.json({ success: true, oldQty, newQty });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Stock — Ajouter un nouvel article ──
app.post("/api/admin/stock/add-item", requireAdminToken, async (req, res) => {
  const { location, item } = req.body;
  if (!location || !item) return res.json({ success: false, error: "location et item requis" });
  const sheetName = location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  try {
    await addItemToSheet(sheetName, item.trim());
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Stock — Logs ──
app.get("/api/admin/stock/logs", requireAdminToken, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A2:G` });
    const data   = (result.data.values || []).map(r => ({
      date: r[0]||"", heure: r[1]||"", user: r[2]||"",
      item: r[3]||"", action: r[4]||"", quantite: parseInt(r[5])||0, lieu: r[6]||""
    }));
    res.json({ success: true, data });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Routes publiques (existantes) ──
app.get("/api/stock", async (req, res) => {
  const lieu = req.query.lieu;
  if (!lieu) return res.json({ success: false, error: "Paramètre lieu manquant" });
  const sheetName = lieu === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  try { res.json({ success: true, stock: await readStock(sheetName) }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

app.get("/api/logs", async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A2:G` });
    const data   = (result.data.values || []).map(r => ({
      date: r[0]||"", heure: r[1]||"", user: r[2]||"",
      item: r[3]||"", action: r[4]||"", quantite: parseInt(r[5])||0, lieu: r[6]||""
    }));
    res.json({ success: true, data });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.get("/api/send_code", async (req, res) => {
  const username = req.query.user;
  if (!username) return res.json({ success: false, error: "Pseudo manquant" });
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: username, limit: 1 });
    const member  = members.first();
    if (!member) return res.json({ success: false, error: "Utilisateur introuvable" });
    const code = createCode(username);
    await member.send(`🔐 **Code de connexion CHL :** \`${code}\`\n⏱️ Valide 10 minutes.\n\nSi vous n'avez pas demandé ce code, ignorez ce message.`);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: "Impossible d'envoyer le code DM" }); }
});

app.get("/api/verify", async (req, res) => {
  const { user, code } = req.query;
  if (!verifyCode(user, code)) return res.json({ success: false, error: "Code invalide ou expiré" });
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member  = members.first();
    const channel = await client.channels.fetch(LOG_CHANNEL);
    const embed   = new EmbedBuilder().setTitle("🔓 Connexion au site").setDescription(`<@${member.id}> vient de se connecter.`).setColor("Blue").setTimestamp();
    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: "Erreur log connexion" }); }
});

const recentLogStock = new Map();
app.post("/api/log_stock", async (req, res) => {
  const { user, item, delta, location } = req.body;
  if (!user || !item || delta === undefined || !location)
    return res.json({ success: false, error: "Paramètres manquants" });
  const key = `${user}|${item}|${delta}|${location}`;
  const now = Date.now();
  const last = recentLogStock.get(key);
  if (last && now - last < 3000) return res.json({ success: false, error: "Requête dupliquée ignorée (moins de 3s)" });
  recentLogStock.set(key, now);
  for (const [k, t] of recentLogStock) if (now - t > 60_000) recentLogStock.delete(k);
  const sheetName = location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  try {
    const { oldQty, newQty } = await updateStock(sheetName, item, delta);
    await appendLog(user, item, delta, location);
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member  = members.first();
    const channel = await client.channels.fetch(LOG_CHANNEL);
    const action  = delta > 0 ? "Ajout" : "Retrait";
    const embed   = new EmbedBuilder()
      .setTitle(`📦 Log Stock — ${action}`)
      .setDescription(`<@${member.id}> a modifié le stock.`)
      .addFields(
        { name: "Produit",  value: item,                 inline: true },
        { name: "Quantité", value: `${Math.abs(delta)}`, inline: true },
        { name: "Action",   value: action,               inline: true },
        { name: "Lieu",     value: location,             inline: true },
        { name: "Avant",    value: `${oldQty}`,          inline: true },
        { name: "Après",    value: `${newQty}`,          inline: true }
      )
      .setColor(delta > 0 ? "Green" : "Red").setTimestamp();
    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
    res.json({ success: true, newQty });
  } catch (err) { console.error("log_stock:", err.message); res.json({ success: false, error: err.message }); }
});

app.get("/api/check-discord", async (req, res) => {
  const username = (req.query.username || "").trim();
  if (!username) return res.json({ found: false });
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: username, limit: 10 });
    res.json({ found: members.some(m => m.user.username.toLowerCase() === username.toLowerCase()) });
  } catch (err) { res.json({ found: false }); }
});

app.post("/api/candidature", async (req, res) => {
  const data = req.body;
  if (!data || !data.discord) return res.json({ success: false, error: "Données manquantes ou pseudo Discord absent" });
  const hopitalSuffix = (data.hopitalCible === "sud") ? "sud" : "nord";
  const safeTag  = (data.discord || "inconnu").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
  const chanName = `rc-${safeTag}-${hopitalSuffix}`.substring(0, 100);
  const catId    = TICKET_CATEGORIES.recrutement_form;
  return withLock(`candidature:${safeTag}:${hopitalSuffix}`, async () => {
    try {
      const guild    = await client.guilds.fetch(GUILD_ID);
      const existing = await findChannelByName(guild, chanName, catId);
      if (existing) return res.json({ success: true, channel: existing.id, channelName: existing.name, duplicate: true });
      let memberId = null;
      try {
        const members = await guild.members.search({ query: data.discord.replace(/^\./, ""), limit: 5 });
        const found   = members.find(m => m.user.username.toLowerCase() === data.discord.replace(/^\./, "").toLowerCase() || m.user.tag.toLowerCase() === data.discord.toLowerCase());
        if (found) memberId = found.user.id;
      } catch(_) {}
      const perms = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }];
      if (memberId) perms.push({ id: memberId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      for (const roleId of STAFF_ROLES) perms.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] });
      const channel = await guild.channels.create({ name: chanName, type: ChannelType.GuildText, parent: catId || undefined, permissionOverwrites: perms, topic: `Candidature de ${data.discord} — Hôpital ${hopitalSuffix.toUpperCase()}` });
      const hopitalLabel = hopitalSuffix === "sud" ? "🏥 Hôpital Sud" : "🏥 Hôpital Nord";
      const fields = [
        { name: "🎮 Discord", value: data.discord||"—", inline: true }, { name: "📱 Téléphone", value: data.telephone||"—", inline: true },
        { name: "🏥 Hôpital visé", value: hopitalLabel, inline: true }, { name: "👤 Nom", value: data.nom||"—", inline: true },
        { name: "👤 Prénom", value: data.prenom||"—", inline: true }, { name: "🎂 Âge", value: data.age||"—", inline: true },
        { name: "⚖️ Casier jud.", value: data.casier||"—", inline: true },
      ];
      if (data.experiencePasse === "oui") {
        fields.push({ name: "💼 Ancien métier", value: data.ancienMetier||"—", inline: true }, { name: "🏅 Ancien grade", value: data.ancienGrade||"—", inline: true }, { name: "🔄 Raison du chgt", value: data.raisonChgt||"—", inline: false }, { name: "🤝 Inter-équipe", value: data.interEquipe||"—", inline: false });
      }
      fields.push({ name: "🧠 Description perso.", value: data.description||"—", inline: false }, { name: "⚠️ Plus gros défaut", value: data.defaut||"—", inline: false }, { name: "🏥 Expérience médicale", value: data.expMedicale||"—", inline: true });
      if (data.metierMedical) { fields.push({ name: "👨‍⚕️ Métier IRL", value: data.metierMedical, inline: true }); if (data.specialisation) fields.push({ name: "🔬 Spécialisation", value: data.specialisation, inline: true }); if (data.hopital) fields.push({ name: "🏢 Hôpital", value: data.hopital, inline: true }); if (data.expDetail) fields.push({ name: "📋 Détail expérience", value: data.expDetail, inline: false }); }
      fields.push({ name: "💬 Motivation", value: data.motivation||"—", inline: false }, { name: "✨ Citation fav.", value: data.citation||"—", inline: true }, { name: "🏷️ Mot qui me représente", value: data.mot||"—", inline: true }, { name: "📚 Formation acceptée", value: data.formation||"—", inline: true });
      const embed = new EmbedBuilder().setTitle(`📋 Candidature — ${data.discord} [${hopitalSuffix.toUpperCase()}]`).setDescription(`Nouvelle candidature reçue via le formulaire web.\n${memberId ? `\nMembre identifié : <@${memberId}>` : "\n⚠️ Membre Discord non trouvé sur le serveur"}`).addFields(fields).setColor(hopitalSuffix === "sud" ? 0x004080 : 0x005c2e).setTimestamp().setFooter({ text: `CHL Recrutement — ${hopitalLabel}` });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ticket_close").setLabel("🔒 Fermer").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId("ticket_delete").setLabel("🗑️ Supprimer").setStyle(ButtonStyle.Danger));
      await channel.send({ content: `📬 Nouvelle candidature de ${memberId ? `<@${memberId}>` : `(${data.discord})`} <@&${ROLE_RECRUTEMENT}>`, embeds: [embed], components: [row] });
      res.json({ success: true, channel: channel.id, channelName: channel.name });
    } catch (err) { console.error("candidature:", err); res.json({ success: false, error: err.message }); }
  });
});

app.post("/api/rendezvous", async (req, res) => {
  const { discord, prenom, date, heure, motif, doctorName, doctorSpecialty, doctorDiscordId } = req.body;
  if (!discord || !prenom || !date || !heure || !motif || !doctorName || !doctorDiscordId)
    return res.json({ success: false, error: "Paramètres manquants" });
  const chanName = `rdv-${discord.replace(/[^a-zA-Z0-9_]/g,"").toLowerCase()}-${doctorName.replace(/[^a-zA-Z0-9_]/g,"").toLowerCase().substring(0,20)}`.substring(0, 100);
  const catId    = TICKET_CATEGORIES.rendezvous;
  return withLock(`rdv:${chanName}`, async () => {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const existing = await findChannelByName(guild, chanName, catId);
      if (existing) return res.json({ success: true, channel: existing.id, channelName: existing.name, duplicate: true });
      let patientId = null;
      try { const members = await guild.members.search({ query: discord.replace(/^\./, ""), limit: 5 }); const found = members.find(m => m.user.username.toLowerCase() === discord.replace(/^\./, "").toLowerCase() || m.user.tag.toLowerCase() === discord.toLowerCase()); if (found) patientId = found.user.id; } catch(_) {}
      let doctorMember = null;
      try { doctorMember = await guild.members.fetch(doctorDiscordId); } catch(_) {}
      const perms = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }];
      if (patientId)    perms.push({ id: patientId,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });
      if (doctorMember) perms.push({ id: doctorDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageChannels] });
      for (const roleId of STAFF_ROLES) perms.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] });
      const channel = await guild.channels.create({ name: chanName, type: ChannelType.GuildText, parent: catId || undefined, permissionOverwrites: perms, topic: `Rendez-vous — ${discord} avec ${doctorName} le ${date} à ${heure}` });
      const embed = new EmbedBuilder().setTitle("📅 Demande de Rendez-vous — CHL").setDescription(`Une demande de rendez-vous a été créée via le site web.\n\n${patientId ? `👤 **Patient :** <@${patientId}>` : `👤 **Patient :** ${discord} *(non trouvé)*`}\n${doctorMember ? `👨‍⚕️ **Médecin :** <@${doctorDiscordId}> — ${doctorName}` : `👨‍⚕️ **Médecin :** ${doctorName} *(non trouvé)*`}`).addFields({ name: "👤 Prénom", value: prenom, inline: true }, { name: "🎮 Discord", value: discord, inline: true }, { name: "👨‍⚕️ Médecin", value: doctorName, inline: true }, { name: "🔬 Spécialité", value: doctorSpecialty||"—", inline: true }, { name: "📅 Date souhaitée", value: date, inline: true }, { name: "🕐 Heure souhaitée", value: heure, inline: true }, { name: "💬 Motif", value: motif, inline: false }).setColor(0x004080).setTimestamp().setFooter({ text: "CHL — Rendez-vous via site web" });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ticket_close").setLabel("🔒 Fermer").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId("ticket_delete").setLabel("🗑️ Supprimer").setStyle(ButtonStyle.Danger));
      await channel.send({ content: `📬 Nouveau rendez-vous — ${patientId ? `<@${patientId}>` : `(${discord})`} avec ${doctorMember ? `<@${doctorDiscordId}>` : `(${doctorName})`}`, embeds: [embed], components: [row] });
      res.json({ success: true, channel: channel.id, channelName: channel.name });
    } catch (err) { console.error("rendezvous:", err); res.json({ success: false, error: err.message }); }
  });
});

app.listen(PORT, () => console.log(`🚀 API démarrée sur le port ${PORT}`));
