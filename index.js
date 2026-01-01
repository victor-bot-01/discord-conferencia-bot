require("dotenv").config();

console.log("ENV CHECK:", !!process.env.DISCORD_TOKEN, !!process.env.CLIENT_ID);

const fs = require("fs");
const path = require("path");
const http = require("http");

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

/* ===================== ENV ===================== */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const CHANNEL_ID = process.env.CHANNEL_ID;

const SHEETS_API_URL = process.env.SHEETS_API_URL;
const SHEETS_API_KEY = process.env.SHEETS_API_KEY;

if (!DISCORD_TOKEN || !CLIENT_ID || !CHANNEL_ID || !SHEETS_API_URL || !SHEETS_API_KEY) {
  console.error("❌ Variáveis de ambiente faltando");
  process.exit(1);
}

/* ===================== HTTP (opcional) ===================== */

const PORT = process.env.PORT || 10000;
http.createServer((_, res) => res.end("ok")).listen(PORT, () => {
  console.log("HTTP server listening on", PORT);
});

/* ===================== CLIENT ===================== */

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* ===================== HELPERS ===================== */

async function sheetsGet(action, timeoutMs = 15000) {
  const url = `${SHEETS_API_URL}?action=${encodeURIComponent(action)}&key=${encodeURIComponent(
    SHEETS_API_KEY
  )}`;

  console.log(`SHEETS GET → ${action}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    const data = JSON.parse(text);

    if (!res.ok || !data.ok) {
      throw new Error(`Sheets erro: ${JSON.stringify(data)}`);
    }

    return data;
  } catch (err) {
    console.error("SHEETS GET ERROR:", err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function sheetsPost(payload, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(SHEETS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, key: SHEETS_API_KEY }),
      signal: controller.signal,
    });

    const text = await res.text();
    const data = JSON.parse(text);

    if (!res.ok || !data.ok) {
      throw new Error(`Sheets POST erro: ${JSON.stringify(data)}`);
    }

    return data;
  } catch (err) {
    console.error("SHEETS POST ERROR:", err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ===================== CACHE ===================== */

const STATE_FILE = path.join(__dirname, "state.json");
const orderCache = new Map();

function loadCache() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    Object.entries(raw.orderCache || {}).forEach(([k, v]) => orderCache.set(k, v));
    console.log(`CACHE carregado: ${orderCache.size} pedidos`);
  } catch {
    console.log("CACHE inválido, ignorado");
  }
}

function saveCache() {
  const obj = {};
  for (const [k, v] of orderCache.entries()) obj[k] = v;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ orderCache: obj }, null, 2));
}

/* ===================== UI ===================== */

const PAGE_SIZE = 4;

function buildEmbed(order) {
  const lines = order.items.map((it, i) => {
    const s = (it.status || "").toUpperCase();
    const box = s.startsWith("TENHO") ? "🟩" : s.startsWith("FALTA") ? "🟥" : "⬜";
    return `${box} ${i + 1}. ${it.produto}${it.qtd ? ` x${it.qtd}` : ""}`;
  });

  return new EmbedBuilder()
    .setTitle("📦 Conferência de Pedido")
    .setDescription(
      `**Pedido:** #${order.pedido}\n` +
        `**Cliente:** ${order.cliente || "-"}\n\n` +
        lines.join("\n")
    );
}

/* ===================== COMMANDS ===================== */

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Testa o bot"),
  new SlashCommandBuilder().setName("sync").setDescription("Sincroniza pedidos pendentes"),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  }
  console.log("✅ Commands registrados");
}

/* ===================== READY ===================== */

client.once("ready", () => {
  console.log(`🤖 Bot online como ${client.user.tag}`);
  loadCache();
});

/* ===================== INTERACTIONS ===================== */

client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ping") {
      return interaction.reply({ content: "pong ✅", ephemeral: true });
    }

    if (interaction.commandName === "sync") {
      console.log("SYNC: iniciado");

      await interaction.deferReply({ ephemeral: true });

      let data;
      try {
        data = await sheetsGet("list_pending");
      } catch {
        return interaction.editReply(
          "❌ A planilha demorou para responder. Tente novamente."
        );
      }

      const orders = data.orders || [];
      if (!orders.length) {
        return interaction.editReply("Nenhum pedido pendente.");
      }

      const channel = await client.channels.fetch(CHANNEL_ID);
      let sent = 0;

      for (const order of orders) {
        orderCache.set(String(order.pedido), order);
        const msg = await channel.send({ embeds: [buildEmbed(order)] });

        await sheetsPost({
          action: "set_message_id",
          pedido: String(order.pedido),
          messageId: String(msg.id),
        });

        sent++;
      }

      saveCache();
      console.log("SYNC: concluído");

      return interaction.editReply(`✅ ${sent} pedido(s) enviados.`);
    }
  } catch (err) {
    console.error("INTERACTION ERROR:", err);
    if (interaction.deferred) {
      interaction.editReply("❌ Erro interno.");
    }
  }
});

/* ===================== BOOT ===================== */

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
