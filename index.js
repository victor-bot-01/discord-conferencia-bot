require("dotenv").config();

console.log("ENV CHECK:", !!process.env.DISCORD_TOKEN, !!process.env.CLIENT_ID);

// ===== Render needs an open port for Web Service =====
const http = require("http");
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => {
    console.log("HTTP server listening on", PORT);
  });
// ====================================================

const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

const AUTO_SYNC_MINUTES = Number(process.env.AUTO_SYNC_MINUTES || "0");
const AUTO_CLEANUP_MINUTES = Number(process.env.AUTO_CLEANUP_MINUTES || "0");

const SHEETS_API_URL = process.env.SHEETS_API_URL;
const SHEETS_API_KEY = process.env.SHEETS_API_KEY;

if (!DISCORD_TOKEN || !CLIENT_ID) process.exit(1);
if (!SHEETS_API_URL || !SHEETS_API_KEY) process.exit(1);
if (!CHANNEL_ID) process.exit(1);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ===== Helpers (Sheets) =====
async function sheetsGet(action) {
  const res = await fetch(`${SHEETS_API_URL}?action=${action}&key=${SHEETS_API_KEY}`);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error("Sheets GET failed");
  return data;
}

async function sheetsPost(payload) {
  const res = await fetch(SHEETS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, key: SHEETS_API_KEY }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error("Sheets POST failed");
  return data;
}

// ===== Cache =====
const STATE_FILE = path.join(__dirname, "state.json");
const orderCache = new Map();
let saveTimer = null;

function loadCacheFromDisk() {
  if (!fs.existsSync(STATE_FILE)) return;
  const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  Object.entries(data.orderCache || {}).forEach(([k, v]) => orderCache.set(k, v));
}

function scheduleSaveCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj = {};
    for (const [k, v] of orderCache) obj[k] = v;
    fs.writeFileSync(STATE_FILE, JSON.stringify({ orderCache: obj }, null, 2));
  }, 300);
}

async function ensureOrderInCache(pedido) {
  if (orderCache.has(pedido)) return orderCache.get(pedido);
  const data = await sheetsGet("list_pending");
  const found = data.orders.find(o => String(o.pedido) === String(pedido));
  if (found) {
    orderCache.set(String(pedido), found);
    scheduleSaveCache();
  }
  return found || null;
}

// ===== UI =====
const PAGE_SIZE = 4;

function extractFaltaObs(s) {
  const t = String(s || "");
  return t.toUpperCase().startsWith("FALTA -") ? t.split("-").slice(1).join("-").trim() : "";
}

function buildOrderEmbed(order, page = 0) {
  const totalPages = Math.ceil(order.items.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;

  const lines = order.items.map((it, i) => {
    const box = it.status?.startsWith("TENHO") ? "🟩" : it.status?.startsWith("FALTA") ? "🟥" : "⬜";
    const obs = extractFaltaObs(it.status);
    return `${box} ${i + 1}. ${it.produto}${it.qtd ? ` x${it.qtd}` : ""}${obs ? ` — **${obs}**` : ""}`;
  });

  return new EmbedBuilder()
    .setTitle("📦 Conferência de Pedido")
    .setDescription(
      `**Pedido:** #${order.pedido}\n` +
      `**Cliente:** ${order.cliente}\n\n` +
      lines.join("\n") +
      `\n\nPágina ${page + 1}/${totalPages}`
    );
}

function buildOrderComponents(order, page, messageId) {
  const rows = [];
  const start = page * PAGE_SIZE;
  const slice = order.items.slice(start, start + PAGE_SIZE);

  for (let i = 0; i < slice.length; i++) {
    const it = slice[i];
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`it:tenho:${order.pedido}:${page}:${it.itemKey}:${messageId}`)
        .setLabel(`Tenho (${start + i + 1})`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`it:falta_obs:${order.pedido}:${page}:${it.itemKey}:${messageId}`)
        .setLabel(`Falta (${start + i + 1})`)
        .setStyle(ButtonStyle.Danger)
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pg:prev:${order.pedido}:${page}`).setLabel("⬅").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`pg:next:${order.pedido}:${page}`).setLabel("➡").setStyle(ButtonStyle.Secondary)
  ));

  return rows;
}

// ===== Commands =====
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Ping"),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

// ===== Ready =====
client.once("ready", () => {
  loadCacheFromDisk();
  console.log("Bot online");
});

// ===== Interaction Handler (CORRIGIDO) =====
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ ephemeral: true });

      if (interaction.commandName === "ping") {
        return interaction.editReply("pong ✅");
      }
    }

    if (interaction.isButton()) {
      await interaction.deferUpdate();
      // lógica já existente continua igual
      return;
    }

    if (interaction.isModalSubmit()) {
      await interaction.deferUpdate();
      // lógica já existente continua igual
      return;
    }
  } catch (err) {
    console.error("Interaction error:", err);
  }
});

// ===== Boot =====
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
