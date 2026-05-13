// ticketSystem.js — Système de tickets entièrement configurable par serveur
// Commandes : /ticket setup | /ticket panel | /ticket fermer | /ticket supprimer
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionFlagsBits, ChannelType, AttachmentBuilder,
} = require("discord.js");

const cfg = require("./guildConfigs");

// ══════════════════════════════════════════════
//  Sessions de setup actives (guildId → { channelId, messageId })
// ══════════════════════════════════════════════
const sessions = new Map();

// ── Générateur d'ID court ──
const uid = () => Math.random().toString(36).slice(2, 7);

// ══════════════════════════════════════════════
//  HELPER — Vérifier si staff
// ══════════════════════════════════════════════
function isStaffOrAdmin(member, config) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return (config?.staffRoles || []).some(id => member.roles.cache.has(id));
}

// ══════════════════════════════════════════════
//  SETUP — Embed de configuration
// ══════════════════════════════════════════════
function setupEmbed(guild, config) {
  const typeList = config.ticketTypes.length
    ? config.ticketTypes
        .map((t, i) => `\`${i + 1}.\` ${t.emoji || "🎫"} **${t.label}** — cat. \`${t.categoryId}\``)
        .join("\n")
    : "*Aucun type de ticket configuré*";

  const staffList = config.staffRoles.length
    ? config.staffRoles.map(id => `<@&${id}>`).join(" ")
    : "*Aucun rôle staff*";

  return new EmbedBuilder()
    .setTitle(`⚙️ Configuration Tickets — ${guild.name}`)
    .setDescription(
      "Configurez votre système de tickets ci-dessous.\n" +
      "Chaque modification est **sauvegardée automatiquement**."
    )
    .addFields(
      {
        name  : "🎨 Type d'interface",
        value : config.interfaceType === "buttons" ? "🔘 Boutons" : "📋 Menu déroulant",
        inline: true,
      },
      { name: "👮 Rôles staff",        value: staffList,                                                                    inline: true },
      { name: "📋 Canal logs",         value: config.logChannelId        ? `<#${config.logChannelId}>`        : "*Non configuré*", inline: true },
      { name: "📄 Canal transcripts",  value: config.transcriptChannelId ? `<#${config.transcriptChannelId}>` : "*Non configuré*", inline: true },
      { name: `🎫 Types de tickets (${config.ticketTypes.length} / 25)`, value: typeList },
    )
    .setColor(0x004080)
    .setTimestamp()
    .setFooter({ text: "Utilisez /ticket panel pour déployer le panel dans un salon" });
}

// ── Boutons du wizard ──
function setupRows(config) {
  const noTypes  = config.ticketTypes.length === 0;
  const maxTypes = config.ticketTypes.length >= 25;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ts_itype")
        .setLabel(config.interfaceType === "buttons" ? "📋 Passer en Menu déroulant" : "🔘 Passer en Boutons")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ts_addtype")
        .setLabel("➕ Ajouter un type")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(maxTypes),
      new ButtonBuilder()
        .setCustomId("ts_deltype")
        .setLabel("🗑️ Supprimer un type")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(noTypes),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ts_staff")
        .setLabel("👮 Rôles Staff")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ts_channels")
        .setLabel("📋 Logs & Transcripts")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ts_preview")
        .setLabel("👁️ Aperçu du panel")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(noTypes),
    ),
  ];
}

// ── Met à jour le message de setup depuis une session ──
async function refreshSetup(client, guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  try {
    const guild  = await client.guilds.fetch(guildId);
    const ch     = await client.channels.fetch(session.channelId);
    const msg    = await ch.messages.fetch(session.messageId);
    const config = cfg.get(guildId) || cfg.defaults();
    await msg.edit({
      embeds    : [setupEmbed(guild, config)],
      components: setupRows(config),
    });
  } catch (err) {
    console.error("refreshSetup:", err.message);
  }
}

// ══════════════════════════════════════════════
//  HANDLER — Boutons du wizard
// ══════════════════════════════════════════════
async function onSetupButton(interaction, client) {
  const { customId, guild, member } = interaction;

  if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "❌ Administrateur uniquement.", ephemeral: true });
  }

  let config = cfg.get(guild.id) || cfg.defaults();

  // ── Basculer type d'interface ──
  if (customId === "ts_itype") {
    config.interfaceType = config.interfaceType === "dropdown" ? "buttons" : "dropdown";
    cfg.set(guild.id, config);
    return interaction.update({
      embeds    : [setupEmbed(guild, config)],
      components: setupRows(config),
    });
  }

  // ── Ajouter un type → modal ──
  if (customId === "ts_addtype") {
    const modal = new ModalBuilder()
      .setCustomId("ts_m_addtype")
      .setTitle("➕ Nouveau type de ticket");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("label")
          .setLabel("Nom du type de ticket")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("ex : Support, Recrutement, Plainte, Rendez-vous…")
          .setRequired(true)
          .setMaxLength(45)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("emoji")
          .setLabel("Emoji (Unicode uniquement)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("ex : 🎫  ❓  🔴  📅")
          .setRequired(false)
          .setMaxLength(2)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("categoryId")
          .setLabel("ID de la catégorie Discord")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("ex : 1234567890123456789")
          .setRequired(true)
          .setMaxLength(25)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("pingRoles")
          .setLabel("IDs des rôles à mentionner (séparés par ,)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("ex : 123456789,987654321   (vide = aucun)")
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("welcomeMsg")
          .setLabel("Message de bienvenue dans le ticket")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder(
            "ex : Bonjour ! Notre équipe vous répondra rapidement.\n" +
            "Merci de décrire votre problème ci-dessous."
          )
          .setRequired(true)
          .setMaxLength(500)
      ),
    );

    return interaction.showModal(modal);
  }

  // ── Supprimer un type → select éphémère ──
  if (customId === "ts_deltype") {
    if (config.ticketTypes.length === 0) {
      return interaction.reply({ content: "❌ Aucun type à supprimer.", ephemeral: true });
    }
    const options = config.ticketTypes.map(t => ({
      label      : t.label,
      value      : t.id,
      description: `Catégorie : ${t.categoryId}`,
      ...(t.emoji ? { emoji: t.emoji } : {}),
    }));
    return interaction.reply({
      content   : "⚠️ Quel type de ticket voulez-vous supprimer ?",
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("ts_deltype_sel")
            .setPlaceholder("Sélectionner le type à supprimer…")
            .addOptions(options)
        ),
      ],
      ephemeral: true,
    });
  }

  // ── Rôles staff → modal ──
  if (customId === "ts_staff") {
    const modal = new ModalBuilder()
      .setCustomId("ts_m_staff")
      .setTitle("👮 Rôles Staff");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("staffRoles")
          .setLabel("IDs des rôles staff (séparés par des virgules)")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("ex : 123456789,987654321")
          .setRequired(false)
          .setValue(config.staffRoles.join(","))
      ),
    );
    return interaction.showModal(modal);
  }

  // ── Logs & transcripts → modal ──
  if (customId === "ts_channels") {
    const modal = new ModalBuilder()
      .setCustomId("ts_m_channels")
      .setTitle("📋 Canaux de logs & transcripts");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("logChannelId")
          .setLabel("ID canal de logs (optionnel)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("ex : 1234567890123456789")
          .setRequired(false)
          .setValue(config.logChannelId || "")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("transcriptChannelId")
          .setLabel("ID canal transcripts (optionnel)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("ex : 1234567890123456789")
          .setRequired(false)
          .setValue(config.transcriptChannelId || "")
      ),
    );
    return interaction.showModal(modal);
  }

  // ── Aperçu du panel (éphémère) ──
  if (customId === "ts_preview") {
    if (config.ticketTypes.length === 0) {
      return interaction.reply({ content: "❌ Aucun type configuré.", ephemeral: true });
    }
    const { embed, components } = buildPanelMessage(config, guild);
    return interaction.reply({
      content   : "👁️ **Aperçu** (non fonctionnel, pour vérification) :",
      embeds    : [embed],
      components,
      ephemeral : true,
    });
  }
}

// ══════════════════════════════════════════════
//  HANDLER — Select menu suppression
// ══════════════════════════════════════════════
async function onSetupSelect(interaction, client) {
  if (interaction.customId !== "ts_deltype_sel") return;
  const { guild, member } = interaction;

  if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.update({ content: "❌ Administrateur uniquement.", components: [] });
  }

  let config  = cfg.get(guild.id) || cfg.defaults();
  const typeId = interaction.values[0];
  const removed = config.ticketTypes.find(t => t.id === typeId);

  config.ticketTypes = config.ticketTypes.filter(t => t.id !== typeId);
  cfg.set(guild.id, config);

  await refreshSetup(client, guild.id);

  return interaction.update({
    content   : `✅ Type **${removed?.label || typeId}** supprimé.`,
    components: [],
  });
}

// ══════════════════════════════════════════════
//  HANDLER — Modals du wizard
// ══════════════════════════════════════════════
async function onSetupModal(interaction, client) {
  const { customId, guild, member } = interaction;

  if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "❌ Administrateur uniquement.", ephemeral: true });
  }

  let config = cfg.get(guild.id) || cfg.defaults();

  // ── Ajout d'un type ──
  if (customId === "ts_m_addtype") {
    const label      = interaction.fields.getTextInputValue("label").trim();
    const emoji      = interaction.fields.getTextInputValue("emoji").trim() || "🎫";
    const categoryId = interaction.fields.getTextInputValue("categoryId").trim();
    const pingRaw    = interaction.fields.getTextInputValue("pingRoles").trim();
    const welcomeMsg = interaction.fields.getTextInputValue("welcomeMsg").trim();
    const pingRoles  = pingRaw ? pingRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    config.ticketTypes.push({
      id: uid(), label, emoji,
      description: label,
      categoryId, pingRoles, welcomeMsg,
    });
    cfg.set(guild.id, config);
    await refreshSetup(client, guild.id);
    return interaction.reply({ content: `✅ Type **${label}** ajouté !`, ephemeral: true });
  }

  // ── Rôles staff ──
  if (customId === "ts_m_staff") {
    const raw = interaction.fields.getTextInputValue("staffRoles").trim();
    config.staffRoles = raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
    cfg.set(guild.id, config);
    await refreshSetup(client, guild.id);
    return interaction.reply({ content: "✅ Rôles staff mis à jour !", ephemeral: true });
  }

  // ── Canaux ──
  if (customId === "ts_m_channels") {
    config.logChannelId        = interaction.fields.getTextInputValue("logChannelId").trim() || null;
    config.transcriptChannelId = interaction.fields.getTextInputValue("transcriptChannelId").trim() || null;
    cfg.set(guild.id, config);
    await refreshSetup(client, guild.id);
    return interaction.reply({ content: "✅ Canaux mis à jour !", ephemeral: true });
  }
}

// ══════════════════════════════════════════════
//  CONSTRUIRE LE MESSAGE DU PANEL PUBLIC
// ══════════════════════════════════════════════
function buildPanelMessage(config, guild) {
  const desc = config.ticketTypes
    .map(t => `${t.emoji || "🎫"} **${t.label}**`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🎫 Créer un ticket")
    .setDescription(`${desc}\n\nSélectionnez le type de ticket pour créer une demande.`)
    .setColor(0x004080)
    .setTimestamp()
    .setFooter({ text: guild.name });

  let components;

  if (config.interfaceType === "buttons") {
    // Boutons : max 5 par ligne, max 5 lignes
    const rows = [];
    for (let i = 0; i < config.ticketTypes.length; i += 5) {
      const row = new ActionRowBuilder();
      for (const t of config.ticketTypes.slice(i, i + 5)) {
        const btn = new ButtonBuilder()
          .setCustomId(`tpanel_${t.id}`)
          .setLabel(t.label)
          .setStyle(ButtonStyle.Primary);
        try { if (t.emoji) btn.setEmoji(t.emoji); } catch (_) {}
        row.addComponents(btn);
      }
      rows.push(row);
    }
    components = rows;
  } else {
    // Menu déroulant
    const options = config.ticketTypes.map(t => {
      const opt = { label: t.label, value: t.id, description: t.description || t.label };
      if (t.emoji) opt.emoji = t.emoji;
      return opt;
    });
    components = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("tpanel_sel")
          .setPlaceholder("📋 Sélectionner le type de ticket…")
          .addOptions(options)
      ),
    ];
  }

  return { embed, components };
}

// ══════════════════════════════════════════════
//  DÉPLOYER LE PANEL DANS UN SALON
// ══════════════════════════════════════════════
async function deployPanel(channel, config, guild) {
  const { embed, components } = buildPanelMessage(config, guild);
  await channel.send({ embeds: [embed], components });
}

// ══════════════════════════════════════════════
//  CRÉER UN TICKET (déclenché depuis le panel)
// ══════════════════════════════════════════════
async function createTicket(interaction, typeId, client) {
  const { guild, member } = interaction;
  const config = cfg.get(guild.id);

  if (!config) {
    return interaction.reply({
      content : "❌ Ce serveur n'a pas encore configuré son système de tickets.\nUtilisez `/ticket setup` pour commencer.",
      ephemeral: true,
    });
  }

  const ticketType = config.ticketTypes.find(t => t.id === typeId);
  if (!ticketType) {
    return interaction.reply({ content: "❌ Type de ticket introuvable.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const safeTag = member.user.username.replace(/[^a-zA-Z0-9]/g, "").substring(0, 20) || "user";
  const chanName = `${ticketType.label.toLowerCase().replace(/\s+/g, "-")}-${safeTag}`.substring(0, 100);

  // Vérifier doublon
  const existing = guild.channels.cache.find(
    c => c.name === chanName && c.parentId === ticketType.categoryId
  );
  if (existing) {
    return interaction.editReply({ content: `❌ Vous avez déjà un ticket de ce type ouvert : <#${existing.id}>` });
  }

  // Permissions
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id   : member.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];
  for (const roleId of config.staffRoles) {
    overwrites.push({
      id   : roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    });
  }

  try {
    const channel = await guild.channels.create({
      name              : chanName,
      type              : ChannelType.GuildText,
      parent            : ticketType.categoryId || undefined,
      permissionOverwrites: overwrites,
      topic             : `Ticket ${ticketType.label} — ${member.user.tag}`,
    });

    const embed = new EmbedBuilder()
      .setTitle(`${ticketType.emoji || "🎫"} ${ticketType.label}`)
      .setDescription(
        `<@${member.user.id}>, votre ticket a été créé.\n\n` +
        `${ticketType.welcomeMsg}\n\n` +
        `**Type :** ${ticketType.label}\n**Créé par :** ${member.user.tag}`
      )
      .setColor(0x004080)
      .setTimestamp()
      .setFooter({ text: guild.name });

    const mentions = [
      `<@${member.user.id}>`,
      ...ticketType.pingRoles.map(id => `<@&${id}>`),
    ].join(" ");

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tticket_close")
        .setLabel("🔒 Fermer")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("tticket_delete")
        .setLabel("🗑️ Supprimer")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("tticket_transcript")
        .setLabel("📄 Transcript")
        .setStyle(ButtonStyle.Primary),
    );

    await channel.send({ content: mentions, embeds: [embed], components: [row] });
    await interaction.editReply({ content: `✅ Ticket créé : <#${channel.id}>` });

  } catch (err) {
    console.error("createTicket:", err.message);
    await interaction.editReply({ content: `❌ Erreur lors de la création : ${err.message}` });
  }
}

// ══════════════════════════════════════════════
//  GESTION DES TICKETS (boutons dans les tickets)
// ══════════════════════════════════════════════
async function onTicketButton(interaction, client) {
  const { customId, guild, member, channel } = interaction;
  const config = cfg.get(guild.id) || {};

  if (!isStaffOrAdmin(member, config)) {
    return interaction.reply({ content: "❌ Staff uniquement.", ephemeral: true });
  }

  // ── Fermer le ticket ──
  if (customId === "tticket_close") {
    await interaction.reply({ content: "🔒 Ticket fermé. Les utilisateurs ne peuvent plus écrire." });
    for (const [id] of channel.permissionOverwrites.cache) {
      if (!(config.staffRoles || []).includes(id) && id !== guild.id) {
        await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
      }
    }
    await channel.setName(`fermé-${channel.name}`.substring(0, 100)).catch(() => {});
    return;
  }

  // ── Supprimer le ticket ──
  if (customId === "tticket_delete") {
    await interaction.reply({ content: "🗑️ Suppression du ticket dans 5 secondes…" });
    setTimeout(() => channel.delete().catch(() => {}), 5000);
    return;
  }

  // ── Générer un transcript ──
  if (customId === "tticket_transcript") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const text = await generateTranscript(channel);
      const fileName = `transcript-${channel.name}-${Date.now()}.txt`;
      const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), { name: fileName });

      const embed = new EmbedBuilder()
        .setTitle("📄 Transcript de ticket")
        .setDescription(
          `**Salon :** #${channel.name}\n` +
          `**Généré par :** ${member.user.tag}\n` +
          `**Date :** ${new Date().toLocaleString("fr-FR")}`
        )
        .setColor(0x004080)
        .setTimestamp();

      // Envoyer dans le canal de transcripts configuré
      if (config.transcriptChannelId) {
        try {
          const tc = await client.channels.fetch(config.transcriptChannelId);
          await tc.send({ embeds: [embed], files: [attachment] });
        } catch (_) {}
      }

      return interaction.editReply({
        content : "✅ Transcript généré !",
        embeds  : [embed],
        files   : [new AttachmentBuilder(Buffer.from(text, "utf-8"), { name: fileName })],
      });
    } catch (err) {
      return interaction.editReply({ content: `❌ Erreur transcript : ${err.message}` });
    }
  }
}

// ══════════════════════════════════════════════
//  HELPER — Générer un transcript texte
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
//  EXPORTS
// ══════════════════════════════════════════════
module.exports = {
  sessions,
  setupEmbed,
  setupRows,
  isStaffOrAdmin,
  onSetupButton,
  onSetupSelect,
  onSetupModal,
  deployPanel,
  createTicket,
  onTicketButton,
  generateTranscript,
};
