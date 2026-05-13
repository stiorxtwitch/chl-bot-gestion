// ════════════════════════════════════════════════════════════════
//  AJOUTS À COLLER DANS server.js — Système de tickets v2
//  Ce fichier montre exactement QUOI ajouter et OÙ dans server.js
// ════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────
//  1) IMPORTS — Coller tout en haut de server.js, après les imports existants
// ─────────────────────────────────────────────────────────────────

const ts  = require("./ticketSystem");
const cfg = require("./guildConfigs");

// (Vous pouvez supprimer l'import de AttachmentBuilder si déjà présent)


// ─────────────────────────────────────────────────────────────────
//  2) NOUVELLE COMMANDE — Ajouter dans le tableau `commands = [...]`
//     (à la suite des commandes existantes, avant le .map(c => c.toJSON()))
// ─────────────────────────────────────────────────────────────────

new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Gestion du système de tickets configurable")
  .addSubcommand(sub =>
    sub.setName("setup")
       .setDescription("🛠️ Configurer le système de tickets de ce serveur (Admin)")
  )
  .addSubcommand(sub =>
    sub.setName("panel")
       .setDescription("📤 Déployer le panel de tickets dans ce salon (Admin)")
  )
  .addSubcommand(sub =>
    sub.setName("fermer")
       .setDescription("🔒 Fermer ce ticket")
  )
  .addSubcommand(sub =>
    sub.setName("supprimer")
       .setDescription("🗑️ Supprimer ce ticket")
       .addStringOption(opt =>
         opt.setName("raison")
            .setDescription("Raison de la suppression")
            .setRequired(false)
       )
       .addBooleanOption(opt =>
         opt.setName("transcript")
            .setDescription("Générer un transcript avant suppression ?")
            .setRequired(false)
       )
  ),


// ─────────────────────────────────────────────────────────────────
//  3) INTERACTION HANDLER — Coller dans client.on(Events.InteractionCreate, ...)
//     AVANT le bloc "if (interaction.isStringSelectMenu() && ... ticket_create)"
//     et AVANT le "if (!interaction.isChatInputCommand()) return;"
// ─────────────────────────────────────────────────────────────────

// ══ WIZARD DE SETUP (boutons ts_*) ══
if (interaction.isButton() && interaction.customId.startsWith("ts_")) {
  return ts.onSetupButton(interaction, client);
}

// ══ SUPPRESSION DE TYPE (select ts_deltype_sel) ══
if (interaction.isStringSelectMenu() && interaction.customId === "ts_deltype_sel") {
  return ts.onSetupSelect(interaction, client);
}

// ══ MODALS DU WIZARD (ts_m_*) ══
if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("ts_m_")) {
  return ts.onSetupModal(interaction, client);
}

// ══ PANEL PUBLIC — Menu déroulant ══
if (interaction.isStringSelectMenu() && interaction.customId === "tpanel_sel") {
  return ts.createTicket(interaction, interaction.values[0], client);
}

// ══ PANEL PUBLIC — Boutons ══
if (interaction.isButton() && interaction.customId.startsWith("tpanel_")) {
  const typeId = interaction.customId.replace("tpanel_", "");
  return ts.createTicket(interaction, typeId, client);
}

// ══ BOUTONS DANS LES TICKETS (fermer / supprimer / transcript) ══
if (interaction.isButton() && interaction.customId.startsWith("tticket_")) {
  return ts.onTicketButton(interaction, client);
}


// ─────────────────────────────────────────────────────────────────
//  4) COMMANDE /ticket — Coller dans le bloc des slash commands
//     (là où sont /fermer, /supprimer, /attente, etc.)
// ─────────────────────────────────────────────────────────────────

if (commandName === "ticket") {
  const sub = interaction.options.getSubcommand();

  // ── /ticket setup ──
  if (sub === "setup") {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "❌ Administrateur uniquement.", ephemeral: true });
    }
    const config = cfg.get(guild.id) || cfg.defaults();
    const msg = await interaction.reply({
      embeds    : [ts.setupEmbed(guild, config)],
      components: ts.setupRows(config),
      fetchReply: true,
    });
    // Stocker la session pour que les modals puissent mettre à jour l'embed
    ts.sessions.set(guild.id, { channelId: channel.id, messageId: msg.id });
    return;
  }

  // ── /ticket panel ──
  if (sub === "panel") {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "❌ Administrateur uniquement.", ephemeral: true });
    }
    const config = cfg.get(guild.id);
    if (!config || config.ticketTypes.length === 0) {
      return interaction.reply({
        content : "❌ Aucun type de ticket configuré.\nLancez d'abord `/ticket setup` pour configurer le système.",
        ephemeral: true,
      });
    }
    await interaction.deferReply({ ephemeral: true });
    await ts.deployPanel(channel, config, guild);
    return interaction.editReply({ content: `✅ Panel déployé dans <#${channel.id}> !` });
  }

  // ── /ticket fermer ──
  if (sub === "fermer") {
    const config = cfg.get(guild.id) || {};
    if (!ts.isStaffOrAdmin(member, config)) {
      return interaction.reply({ content: "❌ Staff uniquement.", ephemeral: true });
    }
    await interaction.reply({ content: "🔒 Ticket fermé. Les utilisateurs ne peuvent plus écrire." });
    for (const [id] of channel.permissionOverwrites.cache) {
      if (!(config.staffRoles || []).includes(id) && id !== guild.id) {
        await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
      }
    }
    await channel.setName(`fermé-${channel.name}`.substring(0, 100)).catch(() => {});
    return;
  }

  // ── /ticket supprimer ──
  if (sub === "supprimer") {
    const config = cfg.get(guild.id) || {};
    if (!ts.isStaffOrAdmin(member, config)) {
      return interaction.reply({ content: "❌ Staff uniquement.", ephemeral: true });
    }

    const raison       = interaction.options.getString("raison") || "Aucune raison fournie";
    const doTranscript = interaction.options.getBoolean("transcript") ?? false;

    await interaction.deferReply();

    // Transcript si demandé
    if (doTranscript) {
      try {
        const text = await ts.generateTranscript(channel);
        const att  = new AttachmentBuilder(
          Buffer.from(text, "utf-8"),
          { name: `transcript-${channel.name}-${Date.now()}.txt` }
        );
        const tEmbed = new EmbedBuilder()
          .setTitle("📄 Transcript de ticket")
          .setDescription(
            `**Salon :** #${channel.name}\n` +
            `**Raison :** ${raison}\n` +
            `**Fermé par :** ${member.user.tag} (<@${member.user.id}>)\n` +
            `**Date :** ${new Date().toLocaleString("fr-FR")}`
          )
          .setColor(0x004080)
          .setTimestamp();

        if (config.transcriptChannelId) {
          try {
            const tc = await client.channels.fetch(config.transcriptChannelId);
            await tc.send({ embeds: [tEmbed], files: [att] });
          } catch (_) {}
        }
      } catch (err) {
        console.error("transcript /ticket supprimer:", err.message);
      }
    }

    const closeEmbed = new EmbedBuilder()
      .setTitle("🗑️ Ticket en cours de suppression")
      .setDescription(
        `Ce ticket sera supprimé dans **5 secondes**.\n\n` +
        `**Raison :** ${raison}\n` +
        `**Transcript :** ${doTranscript ? "✅ Oui" : "❌ Non"}\n` +
        `**Par :** ${member.user.tag}`
      )
      .setColor(0xe74c3c)
      .setTimestamp();

    await interaction.editReply({ embeds: [closeEmbed] });
    setTimeout(() => channel.delete().catch(() => {}), 5000);
    return;
  }
}
