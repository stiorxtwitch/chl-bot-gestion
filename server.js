// server.js - Version Render.com (Bot Discord + API Express)
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const cors = require("cors");
const { createCode, verifyCode } = require("./codes");

// -------- CONFIG ---------
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = "1384283719933628416";
const LOG_CHANNEL = "1473699667010125986";
const PORT = process.env.PORT || 3000;
// -------------------------

// -------- Bot Discord --------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once("ready", () => {
  console.log(`✅ Bot Discord connecté : ${client.user.tag}`);
});

client.login(TOKEN);

// -------- Express --------
const app = express();
app.use(cors());
app.use(express.json());

// Health check pour Render
app.get("/", (req, res) => {
  res.json({ status: "CHL Bot API en ligne ✅" });
});

// ------------------ Envoi code DM ------------------
app.get("/api/send_code", async (req, res) => {
  const username = req.query.user;
  if (!username) return res.json({ success: false, error: "Pseudo manquant" });

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: username, limit: 1 });
    const member = members.first();
    if (!member) return res.json({ success: false, error: "Utilisateur introuvable sur le serveur Discord" });

    const code = createCode(username);
    await member.send(`🔐 **Code de connexion CHL :** \`${code}\`\n⏱️ Valide 10 minutes.\n\nSi tu n'as pas demandé ce code, ignore ce message.`);

    res.json({ success: true, discordId: member.id });
  } catch (err) {
    console.error("send_code error:", err);
    res.json({ success: false, error: "Impossible d'envoyer le code DM" });
  }
});

// ------------------ Vérification code ------------------
app.get("/api/verify", async (req, res) => {
  const { user, code } = req.query;
  if (!user || !code) return res.json({ success: false, error: "Paramètres manquants" });

  if (!verifyCode(user, code)) {
    return res.json({ success: false, error: "Code invalide ou expiré" });
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member = members.first();

    const channel = await client.channels.fetch(LOG_CHANNEL);

    const embed = new EmbedBuilder()
      .setTitle("🔓 Connexion au site")
      .setDescription(`<@${member.id}> vient de se connecter au site CHL.`)
      .setThumbnail("https://images.emojiterra.com/google/noto-emoji/unicode-16.0/color/1024px/1f4f2.png")
      .setColor("Blue")
      .setTimestamp();

    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });

    res.json({ success: true });
  } catch (err) {
    console.error("verify error:", err);
    res.json({ success: false, error: "Erreur lors du log de connexion" });
  }
});

// ------------------ Log stock ------------------
app.post("/api/log_stock", async (req, res) => {
  const { user, item, delta, location } = req.body;
  if (!user || !item || delta === undefined || !location) {
    return res.json({ success: false, error: "Paramètres manquants" });
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member = members.first();
    if (!member) return res.json({ success: false, error: "Membre introuvable" });

    const channel = await client.channels.fetch(LOG_CHANNEL);

    const action = delta > 0 ? "Ajout" : "Retrait";
    const image =
      delta > 0
        ? "https://images.emojiterra.com/google/noto-emoji/unicode-16.0/color/1024px/1f4e5.png"
        : "https://images.emojiterra.com/google/noto-emoji/unicode-15/color/512px/1f4e4.png";

    const embed = new EmbedBuilder()
      .setTitle(`📦 Log Stock — ${action}`)
      .setDescription(`<@${member.id}> a effectué une action sur le stock.`)
      .setThumbnail(image)
      .addFields(
        { name: "Utilisateur", value: `<@${member.id}>`, inline: true },
        { name: "Produit", value: item, inline: true },
        { name: "Quantité", value: `${Math.abs(delta)}`, inline: true },
        { name: "Action", value: action, inline: true },
        { name: "Lieu", value: location, inline: true }
      )
      .setColor(delta > 0 ? "Green" : "Red")
      .setTimestamp();

    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });

    res.json({ success: true });
  } catch (err) {
    console.error("log_stock error:", err);
    res.json({ success: false, error: "Erreur lors du log stock" });
  }
});

// --------- Start server ----------
app.listen(PORT, () => {
  console.log(`🚀 API démarrée sur le port ${PORT}`);
});
