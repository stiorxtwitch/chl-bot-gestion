// server.js - Render.com
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const cors    = require("cors");
const { google } = require("googleapis");
const { createCode, verifyCode } = require("./codes");

// ────────── CONFIG ──────────
const TOKEN       = process.env.DISCORD_TOKEN;
const GUILD_ID    = process.env.GUILD_ID    || "1384283719933628416";
const LOG_CHANNEL = process.env.LOG_CHANNEL || "1473699667010125986";
const SHEET_ID    = process.env.SHEET_ID    || "1jIhIbWQdbqgggYnr6gxtdAaBAlY-przeuNfb9z1UhmI";
const PORT        = process.env.PORT        || 3000;

// Noms des feuilles
const SHEET_LOGS   = "Sheet1"; // Historique logs
const SHEET_PHARMA = "Sheet2"; // Stock Pharmacie
const SHEET_SOIN   = "Sheet3"; // Stock Salle de soin

const ITEMS = [
  "Tablette","Garrot","Pansement de terrain","Bandage élastique",
  "Pansement hémostatique","Kit chirurgical","Pansement compressif",
  "Injecteur d'épinéphrine","Injecteur de morphine","Propofol100ml",
  "Propofol 250ml","Poche de sang 250ml","Poche de sang 500ml",
  "Poche de sang 750ml","Poche de sang 1000ml","Kit de réanimation d'urgence",
  "Moniteur ECG","Fentanyl","Ampoulier médical","Collier cervical",
  "Accès intra-osseux(IO)","Accès intraveineux(IV)","Dispositif de massage cardiaque"
];
// ────────────────────────────

async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_CREDS);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ── Initialise les 3 feuilles au démarrage ──
async function initSheets() {
  try {
    const sheets = await getSheetsClient();

    // ── Sheet1 : logs ──
    const r1 = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A1` });
    if (!r1.data.values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_LOGS}!A1:G1`,
        valueInputOption: "RAW",
        requestBody: { values: [["Date","Heure","Utilisateur","Produit","Action","Quantité","Lieu"]] }
      });
      console.log("✅ Sheet1 (logs) initialisé");
    }

    // ── Sheet2 : stock Pharmacie ──
    const r2 = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_PHARMA}!A1` });
    if (!r2.data.values) {
      const rows = [["Nom","Stock"], ...ITEMS.map(i => [i, 0])];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_PHARMA}!A1:B${rows.length}`,
        valueInputOption: "RAW",
        requestBody: { values: rows }
      });
      console.log("✅ Sheet2 (Pharmacie) initialisé avec 0 partout");
    }

    // ── Sheet3 : stock Salle de soin ──
    const r3 = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_SOIN}!A1` });
    if (!r3.data.values) {
      const rows = [["Nom","Stock"], ...ITEMS.map(i => [i, 0])];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_SOIN}!A1:B${rows.length}`,
        valueInputOption: "RAW",
        requestBody: { values: rows }
      });
      console.log("✅ Sheet3 (Salle de soin) initialisé avec 0 partout");
    }

  } catch (err) {
    console.error("⚠️ initSheets:", err.message);
  }
}

// ── Lire tout le stock d'une feuille → { "Produit": quantité } ──
async function readStock(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A2:B`
  });
  const stock = {};
  (res.data.values || []).forEach(row => {
    if (row[0]) stock[row[0]] = parseInt(row[1]) || 0;
  });
  return stock;
}

// ── Mettre à jour la quantité d'un produit dans une feuille ──
async function updateStock(sheetName, item, delta) {
  const sheets = await getSheetsClient();

  // Trouver la ligne du produit
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A2:B`
  });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === item);
  if (rowIndex === -1) throw new Error(`Produit "${item}" introuvable dans ${sheetName}`);

  const currentQty = parseInt(rows[rowIndex][1]) || 0;
  const newQty     = Math.max(0, currentQty + delta);
  const cellRow    = rowIndex + 2; // +2 car on commence à A2

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!B${cellRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [[newQty]] }
  });

  return { oldQty: currentQty, newQty };
}

// ── Ajouter une ligne dans Sheet1 (logs) ──
async function appendLog(user, item, delta, location, oldQty, newQty) {
  const sheets = await getSheetsClient();
  const now    = new Date();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_LOGS}!A:G`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        now.toLocaleDateString("fr-FR"),
        now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
        user, item,
        delta > 0 ? "Ajout" : "Retrait",
        Math.abs(delta),
        location
      ]]
    }
  });
}

// ── Discord Bot ──
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once("ready", async () => {
  console.log(`✅ Bot Discord connecté : ${client.user.tag}`);
  await initSheets();
});

client.login(TOKEN);

// ── Express ──
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "CHL Bot API v2 ✅" }));

// ── GET /api/stock?lieu=Pharmacie ──
// Retourne le stock actuel d'une zone
app.get("/api/stock", async (req, res) => {
  const lieu = req.query.lieu;
  if (!lieu) return res.json({ success: false, error: "Paramètre lieu manquant" });
  const sheetName = lieu === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;
  try {
    const stock = await readStock(sheetName);
    res.json({ success: true, stock });
  } catch (err) {
    console.error("GET /api/stock:", err.message);
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/logs ──
// Retourne l'historique pour les graphiques
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

// ── GET /api/send_code ──
app.get("/api/send_code", async (req, res) => {
  const username = req.query.user;
  if (!username) return res.json({ success: false, error: "Pseudo manquant" });
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: username, limit: 1 });
    const member  = members.first();
    if (!member) return res.json({ success: false, error: "Utilisateur introuvable" });
    const code = createCode(username);
    await member.send(`🔐 **Code de connexion CHL :** \`${code}\`\n⏱️ Valide 10 minutes.\n\nSi tu n'as pas demandé ce code, ignore ce message.`);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: "Impossible d'envoyer le code DM" });
  }
});

// ── GET /api/verify ──
app.get("/api/verify", async (req, res) => {
  const { user, code } = req.query;
  if (!verifyCode(user, code)) return res.json({ success: false, error: "Code invalide ou expiré" });
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member  = members.first();
    const channel = await client.channels.fetch(LOG_CHANNEL);
    const embed = new EmbedBuilder()
      .setTitle("🔓 Connexion au site").setDescription(`<@${member.id}> vient de se connecter.`)
      .setColor("Blue").setTimestamp();
    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: "Erreur log connexion" });
  }
});

// ── POST /api/log_stock ──
app.post("/api/log_stock", async (req, res) => {
  const { user, item, delta, location } = req.body;
  if (!user || !item || delta === undefined || !location)
    return res.json({ success: false, error: "Paramètres manquants" });

  const sheetName = location === "Pharmacie" ? SHEET_PHARMA : SHEET_SOIN;

  try {
    // 1. Mettre à jour le stock dans Sheet2 ou Sheet3
    const { oldQty, newQty } = await updateStock(sheetName, item, delta);

    // 2. Logger dans Sheet1
    await appendLog(user, item, delta, location, oldQty, newQty);

    // 3. Log Discord
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.search({ query: user, limit: 1 });
    const member  = members.first();
    const channel = await client.channels.fetch(LOG_CHANNEL);
    const action  = delta > 0 ? "Ajout" : "Retrait";
    const embed = new EmbedBuilder()
      .setTitle(`📦 Log Stock — ${action}`)
      .setDescription(`<@${member.id}> a modifié le stock.`)
      .addFields(
        { name: "Produit",   value: item,                    inline: true },
        { name: "Quantité",  value: `${Math.abs(delta)}`,   inline: true },
        { name: "Action",    value: action,                  inline: true },
        { name: "Lieu",      value: location,                inline: true },
        { name: "Avant",     value: `${oldQty}`,             inline: true },
        { name: "Après",     value: `${newQty}`,             inline: true }
      )
      .setColor(delta > 0 ? "Green" : "Red").setTimestamp();
    await channel.send({ content: `<@${member.id}>`, embeds: [embed] });

    res.json({ success: true, newQty });
  } catch (err) {
    console.error("log_stock:", err.message);
    res.json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 API démarrée sur le port ${PORT}`));
