// server.js - Render.com (Bot Discord + API Express + Google Sheets)
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const { createCode, verifyCode } = require("./codes");

// ────────── CONFIG ──────────
const TOKEN         = process.env.DISCORD_TOKEN;
const GUILD_ID      = process.env.GUILD_ID      || "1384283719933628416";
const LOG_CHANNEL   = process.env.LOG_CHANNEL   || "1473699667010125986";
const SHEET_ID      = process.env.SHEET_ID      || "1jIhIbWQdbqgggYnr6gxtdAaBAlY-przeuNfb9z1UhmI";
const PORT          = process.env.PORT           || 3000;
// ────────────────────────────

// ── Google Sheets Auth (Service Account JSON dans env GOOGLE_CREDS) ──
async function getSheetsClient() {
  const credsJson = process.env.GOOGLE_CREDS;
  if (!credsJson) throw new Error("GOOGLE_CREDS manquant dans les variables d'environnement");
  const creds = JSON.parse(credsJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// Initialise la feuille avec les en-têtes si vide
async function initSheet() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A1:G1",
    });
    const rows = res.data.values;
    if (!rows || rows.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A1:G1",
        valueInputOption: "RAW",
        requestBody: {
          values: [["Date", "Heure", "Utilisateur", "Produit", "Action", "Quantité", "Lieu"]],
        },
      });
      console.log("✅ En-têtes Google Sheet initialisés");
    }
  } catch (err) {
    console.error("⚠️ Impossible d'initialiser le Sheet :", err.message);
  }
}

// Ajoute une ligne dans le Sheet
async function appendToSheet(user, item, delta, location) {
  try {
    const sheets = await getSheetsClient();
    const now = new Date();
    const date = now.toLocaleDateString("fr-FR");
    const heure = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    const action = delta > 0 ? "Ajout" : "Retrait";
    const qty = Math.abs(delta);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:G",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[date, heure, user, item, action, qty, location]],
      },
    });
  } catch (err) {
    console.error("⚠️ Erreur écriture Sheet :", err.message);
  }
}

// ── Discord Bot ──
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
  console.log(`✅ Bot Discord connecté : ${client.user.tag}`);
  await initSheet();
});

client.login(TOKEN);

// ── Express ──
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "CHL Bot API en ligne ✅" }));

// ── GET /api/stock — lecture du Sheet (pour les graphiques) ──
app.get("/api/stock", async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A2:G",
    });
    const rows = result.data.values || [];
    const data = rows.map(r => ({
      date:     r[0] || "",
      heure:    r[1] || "",
      user:     r[2] || "",
      item:     r[3] || "",
      action:   r[4] || "",
      quantite: parseInt(r[5]) || 0,
      lieu:     r[6] || "",
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

// ── POST /api/send_code ──
app.get("/api/send_code", async (req, res) => {
  const username = req.query.user;
  if (!username) return res.json({ success: false, error: "Pseudo manquant" });
  try {
    const guild  = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: username, limit: 1 });
    const member  = members.first();
    if (!member) return res.json({ success: false, error: "Utilisateur introuvable sur le serveur Discord" });

    const code = createCode(username);
    await member.send(`🔐 **Code de connexion CHL :** \`${code}\`\n⏱️ Valide 10 minutes.\n\nSi tu n'as pas demandé ce code, ignore ce message.`);
    res.json({ success: true, discordId: member.id });
  } catch (err) {
    console.error("send_code error:", err);
    res.json({ success: false, error: "Impossible d'envoyer le code DM" });
  }
});

// ── GET /api/verify ──
app.get("/api/verify", async (req, res) => {
  const { user, code } = req.query;
  if (!user || !code) return res.json({ success: false, error: "Paramètres manquants" });
  if (!verifyCode(user, code)) return res.json({ success: false, error: "Code invalide ou expiré" });

  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member  = members.first();
    const channel = await client.channels.fetch(LOG_CHANNEL);

    const embed = new EmbedBuilder()
      .setTitle("🔓 Connexion au site")
      .setDescription(`<@${member.id}> vient de se connecter au site CHL.`)
      .setThumbnail("https://images.emojiterra.com/google/noto-emoji/unicode-16.0/color/1024px/1f4f2.png")
      .setColor("Blue").setTimestamp();

    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
    res.json({ success: true });
  } catch (err) {
    console.error("verify error:", err);
    res.json({ success: false, error: "Erreur lors du log" });
  }
});

// ── POST /api/log_stock ──
app.post("/api/log_stock", async (req, res) => {
  const { user, item, delta, location } = req.body;
  if (!user || !item || delta === undefined || !location)
    return res.json({ success: false, error: "Paramètres manquants" });

  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member  = members.first();
    if (!member) return res.json({ success: false, error: "Membre introuvable" });

    const channel = await client.channels.fetch(LOG_CHANNEL);
    const action  = delta > 0 ? "Ajout" : "Retrait";
    const image   = delta > 0
      ? "https://images.emojiterra.com/google/noto-emoji/unicode-16.0/color/1024px/1f4e5.png"
      : "https://images.emojiterra.com/google/noto-emoji/unicode-15/color/512px/1f4e4.png";

    const embed = new EmbedBuilder()
      .setTitle(`📦 Log Stock — ${action}`)
      .setDescription(`<@${member.id}> a effectué une action sur le stock.`)
      .setThumbnail(image)
      .addFields(
        { name: "Utilisateur", value: `<@${member.id}>`, inline: true },
        { name: "Produit",     value: item,               inline: true },
        { name: "Quantité",    value: `${Math.abs(delta)}`, inline: true },
        { name: "Action",      value: action,             inline: true },
        { name: "Lieu",        value: location,           inline: true }
      )
      .setColor(delta > 0 ? "Green" : "Red").setTimestamp();

    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });

    // 🗂️ Écriture dans Google Sheets
    await appendToSheet(user, item, delta, location);

    res.json({ success: true });
  } catch (err) {
    console.error("log_stock error:", err);
    res.json({ success: false, error: "Erreur lors du log stock" });
  }
});

app.listen(PORT, () => console.log(`🚀 API démarrée sur le port ${PORT}`));
