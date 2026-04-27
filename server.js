// server.js - Render.com — CHL Bot v3 (Stock + Tickets + Recrutement + Rendez-vous)
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits, Events,
  InteractionType, SlashCommandBuilder, REST, Routes,
  AttachmentBuilder
} = require("discord.js");
const express = require("express");
const cors    = require("cors");
const { google } = require("googleapis");
const { createCode, verifyCode } = require("./codes");

// ══════════════════════════════════════════════
//  CONFIG — Toutes vos variables d'environnement
// ══════════════════════════════════════════════
const TOKEN       = process.env.DISCORD_TOKEN;
const CLIENT_ID   = process.env.CLIENT_ID;
const GUILD_ID    = process.env.GUILD_ID    || "1384283719933628416";
const LOG_CHANNEL = process.env.LOG_CHANNEL || "1473699667010125986";
const SHEET_ID    = process.env.SHEET_ID    || "1jIhIbWQdbqgggYnr6gxtdAaBAlY-przeuNfb9z1UhmI";
const PORT        = process.env.PORT        || 3000;

const TICKET_PANEL_CHANNEL  = process.env.TICKET_PANEL_CHANNEL  || "1473699660328734926";
const TRANSCRIPT_CHANNEL_ID = process.env.TRANSCRIPT_CHANNEL_ID || "1498338598917902507";

const TICKET_CATEGORIES = {
  recrutement      : process.env.CAT_RECRUTEMENT  || "1481345886910025891",
  question         : process.env.CAT_QUESTION     || "1481345980640006356",
  plainte          : process.env.CAT_PLAINTE      || "1481346050513047556",
  rendezvous       : process.env.CAT_RENDEZVOUS   || "1481346494543040716",
  recrutement_form : process.env.CAT_RC_FORM      || "1481346111250628770",
};

const STAFF_ROLES = (process.env.STAFF_ROLES || "").split(",").filter(Boolean);
const RH_ROLE     = process.env.RH_ROLE || "1481345263510753432";

// ── Rôles de ping selon le contexte ──
const ROLE_RECRUTEMENT = "1481345263510753432";
const ROLE_TICKETS     = "1481345187958489139";

// ── Sheets ──
const SHEET_LOGS   = "Sheet1";
const SHEET_PHARMA = "Sheet2";
const SHEET_SOIN   = "Sheet3";

const ITEMS = [
  "Tablette","Garrot","Pansement de terrain","Bandage élastique",
  "Pansement hémostatique","Kit chirurgical","Pansement compressif",
  "Injecteur d'épinéphrine","Injecteur de morphine","Propofol100ml",
  "Propofol 250ml","Poche de sang 250ml","Poche de sang 500ml",
  "Poche de sang 750ml","Poche de sang 1000ml","Kit de réanimation d'urgence",
  "Moniteur ECG","Fentanyl","Ampoulier médical","Collier cervical",
  "Accès intra-osseux(IO)","Accès intraveineux(IV)","Dispositif de massage cardiaque"
];

// ══════════════════════════════════════════════
//  GOOGLE SHEETS
// ══════════════════════════════════════════════
async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_CREDS);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
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
    for (const [sheetName] of [[SHEET_PHARMA], [SHEET_SOIN]]) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A1` });
      if (!r.data.values) {
        const rows = [["Nom","Stock"], ...ITEMS.map(i => [i, 0])];
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
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A2:B` });
  const rows = res.data.values || [];
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

async function appendLog(user, item, delta, location, oldQty, newQty) {
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
//  HELPER — Génération de transcript
// ══════════════════════════════════════════════
async function generateTranscript(channel) {
  const lines = [];
  lines.push(`═══════════════════════════════════════════════`);
  lines.push(`  TRANSCRIPT — #${channel.name}`);
  lines.push(`  Serveur : ${channel.guild.name}`);
  lines.push(`  Généré le : ${new Date().toLocaleString("fr-FR")}`);
  lines.push(`═══════════════════════════════════════════════\n`);

  let lastMessage = null;
  let allMessages = [];

  // Récupération de tous les messages (max 5000)
  while (true) {
    const options = { limit: 100 };
    if (lastMessage) options.before = lastMessage;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;
    allMessages = allMessages.concat([...batch.values()]);
    lastMessage = batch.last().id;
    if (batch.size < 100) break;
  }

  // Tri chronologique
  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  for (const msg of allMessages) {
    const date    = msg.createdAt.toLocaleString("fr-FR");
    const author  = `${msg.author.tag}`;
    const content = msg.content || "(aucun contenu texte)";

    lines.push(`[${date}] ${author}`);
    lines.push(`  ${content}`);

    if (msg.attachments.size > 0) {
      msg.attachments.forEach(att => {
        lines.push(`  📎 Pièce jointe : ${att.url}`);
      });
    }
    if (msg.embeds.length > 0) {
      msg.embeds.forEach(e => {
        if (e.title) lines.push(`  📋 Embed : ${e.title}`);
      });
    }
    lines.push("");
  }

  lines.push(`═══════════════════════════════════════════════`);
  lines.push(`  Fin du transcript — ${allMessages.length} message(s)`);
  lines.push(`═══════════════════════════════════════════════`);

  return lines.join("\n");
}

// ══════════════════════════════════════════════
//  SLASH COMMANDS REGISTRATION
// ══════════════════════════════════════════════
const commands = [
  new SlashCommandBuilder()
    .setName("ticket_panel")
    .setDescription("Envoie le panneau de création de ticket dans ce salon")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("fermer")
    .setDescription("Ferme ce ticket (archivage)"),

  new SlashCommandBuilder()
    .setName("supprimer")
    .setDescription("Supprime définitivement ce ticket"),

  // ── NOUVELLE COMMANDE /delete ──
  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Supprime ce ticket avec une raison et un transcript optionnel")
    .addStringOption(opt =>
      opt.setName("raison")
        .setDescription("Raison de la suppression")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("transcript")
        .setDescription("Générer un transcript du ticket ?")
        .setRequired(true)
        .addChoices(
          { name: "Oui", value: "oui" },
          { name: "Non", value: "non" }
        )
    ),

  new SlashCommandBuilder()
    .setName("attente")
    .setDescription("Marque la candidature en attente de validation"),

  new SlashCommandBuilder()
    .setName("valider")
    .setDescription("Marque la candidature comme validée"),

  new SlashCommandBuilder()
    .setName("refuser")
    .setDescription("Marque la candidature comme refusée"),
].map(c => c.toJSON());

async function registerCommands() {
  if (!CLIENT_ID || !TOKEN) { console.warn("⚠️ CLIENT_ID ou TOKEN manquant — commandes non enregistrées"); return; }
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Slash commands enregistrées");
  } catch (err) { console.error("registerCommands:", err.message); }
}

// ══════════════════════════════════════════════
//  HELPERS TICKETS
// ══════════════════════════════════════════════
function buildTicketPermissions(guild, userId) {
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];
  for (const roleId of STAFF_ROLES) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AttachFiles,
      ],
    });
  }
  return overwrites;
}

function isStaff(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return STAFF_ROLES.some(id => member.roles.cache.has(id));
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
        { label: "Problème recrutement", description: "Un problème lié à votre candidature", value: "recrutement", emoji: "🔴" },
        { label: "Question générale",    description: "Une question sur le CHL",              value: "question",    emoji: "❓" },
        { label: "Plainte interne",      description: "Signaler un comportement problématique", value: "plainte",   emoji: "📢" },
        { label: "Prise de rendez-vous", description: "Planifier un rendez-vous",              value: "rendezvous", emoji: "📅" },
      ])
  );

  await channel.send({ embeds: [embed], components: [row] });
}

function buildTicketButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("🔒 Fermer le ticket")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ticket_delete")
      .setLabel("🗑️ Supprimer")
      .setStyle(ButtonStyle.Danger),
  );
}

const TICKET_LABELS = {
  recrutement : "Problème Recrutement",
  question    : "Question",
  plainte     : "Plainte Interne",
  rendezvous  : "Rendez-vous",
};

// ══════════════════════════════════════════════
//  DISCORD BOT
// ══════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once("ready", async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  await initSheets();
  await registerCommands();
});

// ──── INTERACTIONS ────
client.on(Events.InteractionCreate, async (interaction) => {

  const guild = interaction.guild;

  // ═══ SELECT MENU — Créer un ticket ═══
  if (interaction.isStringSelectMenu() && interaction.customId === "ticket_create") {
    const type   = interaction.values[0];
    const member = interaction.member;
    const tag    = member.user.tag.replace(/[^a-zA-Z0-9_]/g, "");
    const label  = TICKET_LABELS[type] || type;
    const catId  = TICKET_CATEGORIES[type];

    const channelName = `${type}-${tag}`.toLowerCase().substring(0, 100);

    await interaction.deferReply({ ephemeral: true });

    try {
      const existing = guild.channels.cache.find(
        c => c.name === channelName && c.parentId === catId
      );
      if (existing) {
        return interaction.editReply({ content: `❌ Vous avez déjà un ticket de ce type ouvert : <#${existing.id}>` });
      }

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: catId || undefined,
        permissionOverwrites: buildTicketPermissions(guild, member.user.id),
        topic: `Ticket ${label} — ${member.user.tag}`,
      });

      const embed = new EmbedBuilder()
        .setTitle(`🎫 ${label}`)
        .setDescription(
          `Bonjour <@${member.user.id}>, votre ticket a été créé.\n\n` +
          `Notre équipe vous répondra dans les plus brefs délais.\n\n` +
          `**Type :** ${label}\n**Créé par :** ${member.user.tag}`
        )
        .setColor(0x004080)
        .setTimestamp()
        .setFooter({ text: "CHL — Utilisez les boutons ci-dessous pour gérer ce ticket" });

      await channel.send({
        content: `<@${member.user.id}> <@&${ROLE_TICKETS}>`,
        embeds: [embed],
        components: [buildTicketButtons()],
      });

      await interaction.editReply({ content: `✅ Votre ticket a été créé : <#${channel.id}>` });

    } catch (err) {
      console.error("ticket_create:", err);
      await interaction.editReply({ content: `❌ Erreur lors de la création du ticket : ${err.message}` });
    }
    return;
  }

  // ═══ BOUTON — Fermer ticket ═══
  if (interaction.isButton() && interaction.customId === "ticket_close") {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "❌ Seul le staff peut fermer les tickets.", ephemeral: true });
    }
    await interaction.reply({ content: "🔒 Ticket fermé. Le salon sera archivé." });
    const channel = interaction.channel;
    for (const [id, overwrite] of channel.permissionOverwrites.cache) {
      const isStaffRole = STAFF_ROLES.includes(id) || id === guild.id;
      if (!isStaffRole) {
        await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
      }
    }
    await channel.setName("fermé-" + channel.name).catch(() => {});
    return;
  }

  // ═══ BOUTON — Supprimer ticket ═══
  if (interaction.isButton() && interaction.customId === "ticket_delete") {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "❌ Seul le staff peut supprimer les tickets.", ephemeral: true });
    }
    await interaction.reply({ content: "🗑️ Suppression du ticket dans 5 secondes..." });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    return;
  }

  // ═══ SLASH COMMANDS ═══
  if (!interaction.isChatInputCommand()) return;
  const { commandName, member, channel } = interaction;

  if (commandName === "ticket_panel") {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "❌ Administrateur uniquement.", ephemeral: true });
    }
    await sendTicketPanel(channel);
    return interaction.reply({ content: "✅ Panneau ticket envoyé.", ephemeral: true });
  }

  if (commandName === "fermer") {
    if (!isStaff(member)) {
      return interaction.reply({ content: "❌ Staff uniquement.", ephemeral: true });
    }
    await interaction.reply({ content: "🔒 Ticket fermé." });
    for (const [id] of channel.permissionOverwrites.cache) {
      if (!STAFF_ROLES.includes(id) && id !== guild.id) {
        await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
      }
    }
    await channel.setName("fermé-" + channel.name).catch(() => {});
    return;
  }

  if (commandName === "supprimer") {
    if (!isStaff(member)) {
      return interaction.reply({ content: "❌ Staff uniquement.", ephemeral: true });
    }
    await interaction.reply({ content: "🗑️ Suppression dans 5 secondes..." });
    setTimeout(() => channel.delete().catch(() => {}), 5000);
    return;
  }

  // ═══════════════════════════════════════════
  //  /delete <raison> <transcript oui|non>
  // ═══════════════════════════════════════════
  if (commandName === "delete") {
    if (!isStaff(member)) {
      return interaction.reply({ content: "❌ Staff uniquement.", ephemeral: true });
    }

    const raison     = interaction.options.getString("raison");
    const doTranscript = interaction.options.getString("transcript") === "oui";

    await interaction.deferReply();

    try {
      // ── Embed de confirmation dans le ticket ──
      const confirmEmbed = new EmbedBuilder()
        .setTitle("🗑️ Ticket en cours de suppression")
        .setDescription(
          `Ce ticket va être supprimé dans **5 secondes**.\n\n` +
          `**Raison :** ${raison}\n` +
          `**Transcript :** ${doTranscript ? "✅ Oui — envoyé dans le salon dédié" : "❌ Non"}\n\n` +
          `**Fermé par :** ${member.user.tag}`
        )
        .setColor(0xe74c3c)
        .setTimestamp()
        .setFooter({ text: "CHL — Gestion des tickets" });

      await interaction.editReply({ embeds: [confirmEmbed] });

      // ── Génération du transcript si demandé ──
      if (doTranscript) {
        try {
          const transcriptText = await generateTranscript(channel);
          const fileName       = `transcript-${channel.name}-${Date.now()}.txt`;
          const attachment     = new AttachmentBuilder(
            Buffer.from(transcriptText, "utf-8"),
            { name: fileName }
          );

          const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);

          const transcriptEmbed = new EmbedBuilder()
            .setTitle("📄 Transcript de ticket")
            .setDescription(
              `**Salon :** #${channel.name}\n` +
              `**Raison de fermeture :** ${raison}\n` +
              `**Fermé par :** ${member.user.tag} (<@${member.user.id}>)\n` +
              `**Date :** ${new Date().toLocaleString("fr-FR")}`
            )
            .setColor(0x004080)
            .setTimestamp()
            .setFooter({ text: "CHL — Transcripts" });

          await transcriptChannel.send({
            embeds: [transcriptEmbed],
            files: [attachment],
          });

        } catch (err) {
          console.error("Erreur transcript /delete :", err.message);
        }
      }

      // ── Suppression du salon après 5 secondes ──
      setTimeout(() => channel.delete().catch(() => {}), 5000);

    } catch (err) {
      console.error("/delete:", err.message);
      await interaction.editReply({ content: `❌ Erreur : ${err.message}` });
    }
    return;
  }

  if (commandName === "attente") {
    if (!isStaff(member) && !member.roles.cache.has(RH_ROLE)) {
      return interaction.reply({ content: "❌ RH / Staff uniquement.", ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle("⏳ Candidature en attente")
      .setDescription(
        "Votre candidature est actuellement **en cours d'examen** par notre équipe RH.\n\n" +
        "Nous reviendrons vers vous dans les plus brefs délais. Merci de votre patience."
      )
      .setColor(0xf0a500)
      .setTimestamp()
      .setFooter({ text: `Traité par ${member.user.tag}` });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === "valider") {
    if (!isStaff(member) && !member.roles.cache.has(RH_ROLE)) {
      return interaction.reply({ content: "❌ RH / Staff uniquement.", ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle("✅ Candidature validée !")
      .setDescription(
        "Félicitations ! Votre candidature a été **acceptée** par l'équipe du Centre Hospitalier de Liège.\n\n" +
        "Un membre de notre équipe vous contactera prochainement pour la suite du processus d'intégration.\n\n" +
        "Bienvenue dans l'équipe ! 🏥"
      )
      .setColor(0x27ae60)
      .setTimestamp()
      .setFooter({ text: `Validé par ${member.user.tag}` });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === "refuser") {
    if (!isStaff(member) && !member.roles.cache.has(RH_ROLE)) {
      return interaction.reply({ content: "❌ RH / Staff uniquement.", ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle("❌ Candidature refusée")
      .setDescription(
        "Nous avons bien examiné votre candidature, mais nous ne sommes pas en mesure de vous intégrer pour le moment.\n\n" +
        "Nous vous remercions de l'intérêt que vous portez au Centre Hospitalier de Liège et vous encourageons à repostuler dans le futur.\n\n" +
        "Cordialement, l'équipe RH 🏥"
      )
      .setColor(0xc0392b)
      .setTimestamp()
      .setFooter({ text: `Refusé par ${member.user.tag}` });
    return interaction.reply({ embeds: [embed] });
  }
});

client.login(TOKEN);

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
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

app.get("/", (req, res) => res.json({ status: "CHL Bot API v3 ✅ — Stock + Tickets + Recrutement + RDV" }));

app.get("/api/stock", async (req, res) => {
  const lieu = req.query.lieu;
  if (!lieu) return res.json({ success: false, error: "Paramètre lieu manquant" });
  const sheetName = lieu === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  try {
    const stock = await readStock(sheetName);
    res.json({ success: true, stock });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A2:G`
    });
    const data = (result.data.values || []).map(r => ({
      date: r[0]||"", heure: r[1]||"", user: r[2]||"",
      item: r[3]||"", action: r[4]||"",
      quantite: parseInt(r[5])||0, lieu: r[6]||""
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
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
  } catch (err) {
    res.json({ success: false, error: "Impossible d'envoyer le code DM" });
  }
});

app.get("/api/verify", async (req, res) => {
  const { user, code } = req.query;
  if (!verifyCode(user, code)) return res.json({ success: false, error: "Code invalide ou expiré" });
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member  = members.first();
    const channel = await client.channels.fetch(LOG_CHANNEL);
    const embed = new EmbedBuilder()
      .setTitle("🔓 Connexion au site")
      .setDescription(`<@${member.id}> vient de se connecter.`)
      .setColor("Blue").setTimestamp();
    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: "Erreur log connexion" });
  }
});

app.post("/api/log_stock", async (req, res) => {
  const { user, item, delta, location } = req.body;
  if (!user || !item || delta === undefined || !location)
    return res.json({ success: false, error: "Paramètres manquants" });
  const sheetName = location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  try {
    const { oldQty, newQty } = await updateStock(sheetName, item, delta);
    await appendLog(user, item, delta, location, oldQty, newQty);
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member  = members.first();
    const channel = await client.channels.fetch(LOG_CHANNEL);
    const action  = delta > 0 ? "Ajout" : "Retrait";
    const embed = new EmbedBuilder()
      .setTitle(`📦 Log Stock — ${action}`)
      .setDescription(`<@${member.id}> a modifié le stock.`)
      .addFields(
        { name: "Produit",  value: item,              inline: true },
        { name: "Quantité", value: `${Math.abs(delta)}`, inline: true },
        { name: "Action",   value: action,            inline: true },
        { name: "Lieu",     value: location,          inline: true },
        { name: "Avant",    value: `${oldQty}`,       inline: true },
        { name: "Après",    value: `${newQty}`,       inline: true }
      )
      .setColor(delta > 0 ? "Green" : "Red").setTimestamp();
    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
    res.json({ success: true, newQty });
  } catch (err) {
    console.error("log_stock:", err.message);
    res.json({ success: false, error: err.message });
  }
});

app.get("/api/check-discord", async (req, res) => {
  const username = (req.query.username || "").trim();
  if (!username) return res.json({ found: false });
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: username, limit: 10 });
    const found   = members.some(m =>
      m.user.username.toLowerCase() === username.toLowerCase()
    );
    res.json({ found });
  } catch (err) {
    console.error("check-discord:", err.message);
    res.json({ found: false });
  }
});

app.post("/api/candidature", async (req, res) => {
  const data = req.body;
  if (!data || !data.discord) {
    return res.json({ success: false, error: "Données manquantes ou pseudo Discord absent" });
  }

  const hopitalSuffix = (data.hopitalCible === "sud") ? "sud" : "nord";
  const safeTag  = (data.discord || "inconnu").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
  const chanName = `rc-${safeTag}-${hopitalSuffix}`.substring(0, 100);
  const catId    = TICKET_CATEGORIES.recrutement_form;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    let memberId = null;
    try {
      const members = await guild.members.search({ query: data.discord.replace(/^\./, ""), limit: 5 });
      const found   = members.find(m =>
        m.user.username.toLowerCase() === data.discord.replace(/^\./, "").toLowerCase() ||
        m.user.tag.toLowerCase() === data.discord.toLowerCase()
      );
      if (found) memberId = found.user.id;
    } catch(_) {}

    const perms = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }];
    if (memberId) {
      perms.push({
        id: memberId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }
    for (const roleId of STAFF_ROLES) {
      perms.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: chanName,
      type: ChannelType.GuildText,
      parent: catId || undefined,
      permissionOverwrites: perms,
      topic: `Candidature de ${data.discord} — Hôpital ${hopitalSuffix.toUpperCase()}`,
    });

    const hopitalLabel = hopitalSuffix === "sud" ? "🏥 Hôpital Sud" : "🏥 Hôpital Nord";

    const fields = [
      { name: "🎮 Discord",       value: data.discord      || "—", inline: true },
      { name: "📱 Téléphone",     value: data.telephone    || "—", inline: true },
      { name: "🏥 Hôpital visé", value: hopitalLabel,              inline: true },
      { name: "👤 Nom",           value: data.nom          || "—", inline: true },
      { name: "👤 Prénom",        value: data.prenom       || "—", inline: true },
      { name: "🎂 Âge",           value: data.age          || "—", inline: true },
      { name: "⚖️ Casier jud.",   value: data.casier       || "—", inline: true },
    ];

    if (data.experiencePasse === "oui") {
      fields.push(
        { name: "💼 Ancien métier",  value: data.ancienMetier  || "—", inline: true },
        { name: "🏅 Ancien grade",   value: data.ancienGrade   || "—", inline: true },
        { name: "🔄 Raison du chgt", value: data.raisonChgt    || "—", inline: false },
        { name: "🤝 Inter-équipe",   value: data.interEquipe   || "—", inline: false },
      );
    }

    fields.push(
      { name: "🧠 Description perso.",  value: data.description  || "—", inline: false },
      { name: "⚠️ Plus gros défaut",   value: data.defaut        || "—", inline: false },
      { name: "🏥 Expérience médicale", value: data.expMedicale  || "—", inline: true },
    );

    if (data.metierMedical) {
      fields.push({ name: "👨‍⚕️ Métier IRL", value: data.metierMedical, inline: true });
      if (data.specialisation) fields.push({ name: "🔬 Spécialisation",  value: data.specialisation, inline: true });
      if (data.hopital)        fields.push({ name: "🏢 Hôpital",         value: data.hopital,        inline: true });
      if (data.expDetail)      fields.push({ name: "📋 Détail expérience", value: data.expDetail,    inline: false });
    }

    fields.push(
      { name: "💬 Motivation",            value: data.motivation || "—", inline: false },
      { name: "✨ Citation fav.",         value: data.citation   || "—", inline: true },
      { name: "🏷️ Mot qui me représente", value: data.mot        || "—", inline: true },
      { name: "📚 Formation acceptée",    value: data.formation  || "—", inline: true },
    );

    const embed = new EmbedBuilder()
      .setTitle(`📋 Candidature — ${data.discord} [${hopitalSuffix.toUpperCase()}]`)
      .setDescription(
        `Nouvelle candidature reçue via le formulaire web.\n` +
        `${memberId ? `\nMembre identifié : <@${memberId}>` : "\n⚠️ Membre Discord non trouvé sur le serveur"}`
      )
      .addFields(fields)
      .setColor(hopitalSuffix === "sud" ? 0x004080 : 0x005c2e)
      .setTimestamp()
      .setFooter({ text: `CHL Recrutement — ${hopitalLabel}` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket_close")
        .setLabel("🔒 Fermer")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ticket_delete")
        .setLabel("🗑️ Supprimer")
        .setStyle(ButtonStyle.Danger),
    );

    const mentionUser = memberId ? `<@${memberId}>` : `(${data.discord})`;
    await channel.send({
      content: `📬 Nouvelle candidature de ${mentionUser} <@&${ROLE_RECRUTEMENT}>`,
      embeds: [embed],
      components: [row],
    });

    res.json({ success: true, channel: channel.id, channelName: channel.name });
  } catch (err) {
    console.error("candidature:", err);
    res.json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
//  POST /api/rendezvous — Formulaire site → Discord ticket RDV
// ══════════════════════════════════════════════
app.post("/api/rendezvous", async (req, res) => {
  const { discord, prenom, date, heure, motif, doctorId, doctorName, doctorSpecialty, doctorDiscordId } = req.body;

  if (!discord || !prenom || !date || !heure || !motif || !doctorName || !doctorDiscordId) {
    return res.json({ success: false, error: "Paramètres manquants" });
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    let patientId = null;
    try {
      const members = await guild.members.search({ query: discord.replace(/^\./, ""), limit: 5 });
      const found   = members.find(m =>
        m.user.username.toLowerCase() === discord.replace(/^\./, "").toLowerCase() ||
        m.user.tag.toLowerCase()      === discord.toLowerCase()
      );
      if (found) patientId = found.user.id;
    } catch (_) {}

    let doctorMember = null;
    try {
      doctorMember = await guild.members.fetch(doctorDiscordId);
    } catch (_) {
      console.warn(`⚠️ Médecin introuvable sur le serveur : ${doctorDiscordId}`);
    }

    const safePatient = discord.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    const safeDoctor  = doctorName.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase().substring(0, 20);
    const chanName    = `rdv-${safePatient}-${safeDoctor}`.substring(0, 100);

    const catId = TICKET_CATEGORIES.rendezvous;

    const perms = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];

    if (patientId) {
      perms.push({
        id: patientId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      });
    }

    if (doctorMember) {
      perms.push({
        id: doctorDiscordId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ManageChannels,
        ],
      });
    }

    for (const roleId of STAFF_ROLES) {
      perms.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: chanName,
      type: ChannelType.GuildText,
      parent: catId || undefined,
      permissionOverwrites: perms,
      topic: `Rendez-vous — ${discord} avec ${doctorName} le ${date} à ${heure}`,
    });

    const embed = new EmbedBuilder()
      .setTitle("📅 Demande de Rendez-vous — CHL")
      .setDescription(
        `Une demande de rendez-vous a été créée via le site web.\n\n` +
        (patientId ? `👤 **Patient :** <@${patientId}>` : `👤 **Patient :** ${discord} *(non trouvé sur le serveur)*`) + `\n` +
        (doctorMember ? `👨‍⚕️ **Médecin :** <@${doctorDiscordId}> — ${doctorName}` : `👨‍⚕️ **Médecin :** ${doctorName} *(non trouvé sur le serveur)*`)
      )
      .addFields(
        { name: "👤 Prénom du patient",    value: prenom,               inline: true },
        { name: "🎮 Discord",              value: discord,              inline: true },
        { name: "👨‍⚕️ Médecin",              value: doctorName,           inline: true },
        { name: "🔬 Spécialité",           value: doctorSpecialty || "—", inline: true },
        { name: "📅 Date souhaitée",       value: date,                 inline: true },
        { name: "🕐 Heure souhaitée",      value: heure,                inline: true },
        { name: "💬 Motif de consultation", value: motif,               inline: false },
      )
      .setColor(0x004080)
      .setTimestamp()
      .setFooter({ text: "CHL — Rendez-vous via site web" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket_close")
        .setLabel("🔒 Fermer le ticket")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ticket_delete")
        .setLabel("🗑️ Supprimer")
        .setStyle(ButtonStyle.Danger),
    );

    const mentionPatient = patientId   ? `<@${patientId}>`      : `(${discord})`;
    const mentionDoctor  = doctorMember ? `<@${doctorDiscordId}>` : `(${doctorName})`;
    await channel.send({
      content: `📬 Nouveau rendez-vous — ${mentionPatient} avec ${mentionDoctor}`,
      embeds: [embed],
      components: [row],
    });

    res.json({ success: true, channel: channel.id, channelName: channel.name });

  } catch (err) {
    console.error("rendezvous:", err);
    res.json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 API démarrée sur le port ${PORT}`));
