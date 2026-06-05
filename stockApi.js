// stockApi.js — Module de communication avec l'API Supabase (CHL Bot v3.2)
const STOCK_API_URL = process.env.STOCK_API_URL || "https://ton-site.com/api";

async function registerStockChannel(channelId, guildId, channelName) {
  try {
    const res = await fetch(`${STOCK_API_URL}/stock/register`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ channelId, guildId, channelName, registeredAt: new Date().toISOString() }),
    });
    return await res.json();
  } catch (err) {
    console.error("stockApi.registerStockChannel:", err.message);
    return { success: false, error: err.message };
  }
}

async function pushStockUpdate(payload) {
  try {
    const res = await fetch(`${STOCK_API_URL}/stock/update`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    console.error("stockApi.pushStockUpdate:", err.message);
    return { success: false, error: err.message };
  }
}

async function fetchStockFromApi(guildId, location) {
  try {
    const url = `${STOCK_API_URL}/stock?guildId=${encodeURIComponent(guildId)}&location=${encodeURIComponent(location)}`;
    const res  = await fetch(url);
    return await res.json();
  } catch (err) {
    console.error("stockApi.fetchStockFromApi:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { registerStockChannel, pushStockUpdate, fetchStockFromApi };
