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

// index.js — Discord bot + Google Sheets sync (PENDENTE)
// Node 18+
// discord.js v14+

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
  MessageFlags
} = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // opcional
const CHANNEL_ID = process.env.CHANNEL_ID; // canal fixo para postar
const AUTO_SYNC_MINUTES = Number(process.env.AUTO_SYNC_MINUTES || "0"); // 0 = desliga

const SHEETS_API_URL = process.env.SHEETS_API_URL;
const SHEETS_API_KEY = process.env.SHEETS_API_KEY;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN or CLIENT_ID");
  process.exit(1);
}
if (!SHEETS_API_URL || !SHEETS_API_KEY) {
  console.error("Missing SHEETS_API_URL or SHEETS_API_KEY");
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error("Missing CHANNEL_ID");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ======= Helpers (Sheets API) =======
async function sheetsGet(action) {
  const url = `${SHEETS_API_URL}?action=${encodeURIComponent(action)}&key=${encodeURIComponent(SHEETS_API_KEY)}`;
  const res = await fetch(url, { method: "GET" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Sheets GET failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function sheetsPost(payload) {
  const res = await fetch(SHEETS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, key: SHEETS_API_KEY })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Sheets POST failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// ======= UI (Pedido) =======
const PAGE_SIZE = 4;

function buildOrderEmbed(order, page = 0) {
  const totalPages = Math.max(1, Math.ceil(order.items.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PAGE_SIZE;
  const slice = order.items.slice(start, start + PAGE_SIZE);

  const lines = slice.map((it, idx) => {
    const n = start + idx + 1;
    const qtd = it.qtd ? ` x${it.qtd}` : "";

    // Quadradinho por status
    const st = String(it.status || "").toUpperCase().trim();
    const box = st === "TENHO" ? "🟩" : st === "FALTA" ? "🟥" : "⬜";

    return `${box} ${n}. ${it.produto}${qtd}`;
  });

  return new EmbedBuilder()
    .setTitle("📦 Conferência de Pedido")
    .setDescription(
      `**Pedido:** #${order.pedido}\n` +
      `**Cliente:** ${order.cliente || "-"}\n\n` +
      `**Produtos:**\n${lines.join("\n")}\n\n` +
      `**Status do pedido:** **PENDENTE**\n` +
      `**Página:** ${safePage + 1}/${totalPages}\n` +
      `Marque item por item ou use os botões desta página.`
    );
}

function buildOrderComponents(order, page = 0) {
  const totalPages = Math.max(1, Math.ceil(order.items.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PAGE_SIZE;
  const slice = order.items.slice(start, start + PAGE_SIZE);

  // Linha de botões por item (TENHO / FALTA)
  const rows = [];

  for (let i = 0; i < slice.length; i++) {
    const it = slice[i];
    const labelN = start + i + 1;

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`it:tenho:${order.pedido}:${safePage}:${it.itemKey}`)
          .setLabel(`Tenho (Prod ${labelN})`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`it:falta:${order.pedido}:${safePage}:${it.itemKey}`)
          .setLabel(`Falta (Prod ${labelN})`)
          .setStyle(ButtonStyle.Danger),
      )
    );
  }

  // Linha de navegação + "todos desta página"
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pg:prev:${order.pedido}:${safePage}`)
      .setLabel("⬅ Página anterior")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),

    new ButtonBuilder()
      .setCustomId(`pg:next:${order.pedido}:${safePage}`)
      .setLabel("Próxima página ➡")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),

    new ButtonBuilder()
      .setCustomId(`pg:tenho_all:${order.pedido}:${safePage}`)
      .setLabel("Tenho todos desta página")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`pg:falta_all:${order.pedido}:${safePage}`)
      .setLabel("Falta todos desta página")
      .setStyle(ButtonStyle.Danger),
  );

  rows.push(nav);
  return rows;
}

// Estado mínimo em memória (pra paginação sem reconsultar planilha a cada clique)
const orderCache = new Map(); // key: pedido -> orderObject

// ======= Commands =======
const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Testa o bot"),
  new SlashCommandBuilder()
    .setName("sync")
    .setDescription("Envia para o Discord os pedidos PENDENTES da planilha (não postados ainda)."),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered (guild).");
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Commands registered (global).");
  }
}

// Evita duplicar se o loop rodar de novo enquanto ainda está postando
let isAutoSyncRunning = false;

async function autoSyncOnce() {
  if (isAutoSyncRunning) return;
  isAutoSyncRunning = true;

  try {
    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.error("AUTO_SYNC: Channel not found or not text-based:", CHANNEL_ID);
      return;
    }

    const data = await sheetsGet("list_pending");
    const orders = data.orders || [];

    if (!orders.length) {
      console.log("AUTO_SYNC: no pending orders.");
      return;
    }

    let sent = 0;

    for (const order of orders) {
      // Cache para paginação e botões
      orderCache.set(String(order.pedido), order);

      const embed = buildOrderEmbed(order, 0);
      const components = buildOrderComponents(order, 0);

      // Posta no canal fixo
      const msg = await channel.send({ embeds: [embed], components });

      // Salva MessageId na planilha (para não duplicar no próximo ciclo)
      await sheetsPost({
        action: "set_message_id",
        pedido: String(order.pedido),
        messageId: String(msg.id)
      });

      sent++;
    }

    console.log(`AUTO_SYNC: sent ${sent} order(s).`);
  } catch (err) {
    console.error("AUTO_SYNC error:", err);
  } finally {
    isAutoSyncRunning = false;
  }
}

function startAutoSync() {
  if (!AUTO_SYNC_MINUTES || AUTO_SYNC_MINUTES <= 0) {
    console.log("AUTO_SYNC: disabled (AUTO_SYNC_MINUTES <= 0).");
    return;
  }

  const ms = AUTO_SYNC_MINUTES * 60 * 1000;
  console.log(`AUTO_SYNC: enabled every ${AUTO_SYNC_MINUTES} minute(s). Channel: ${CHANNEL_ID}`);

  // roda uma vez ao subir
  autoSyncOnce();

  // roda continuamente
  setInterval(autoSyncOnce, ms);
}

client.once("ready", () => {
  console.log(`🤖 Bot online como: ${client.user.tag}`);
  startAutoSync();
});

// ======= Interaction Handler =======
client.on("interactionCreate", async (interaction) => {
  console.log(
  "INTERACTION:",
  interaction.isChatInputCommand() ? `slash:${interaction.commandName}` :
  interaction.isButton() ? `button:${interaction.customId}` :
  interaction.type
);
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ping") {
        return interaction.reply({ content: "pong ✅", flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "sync") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Busca pendentes
        const data = await sheetsGet("list_pending");
        const orders = data.orders || [];

        if (!orders.length) {
          return interaction.editReply("Nada para sincronizar: nenhum pedido PENDENTE sem DiscordMessageId.");
        }

        let sent = 0;
        for (const order of orders) {
          // Cache para paginação e botões
          orderCache.set(String(order.pedido), order);

          const embed = buildOrderEmbed(order, 0);
          const components = buildOrderComponents(order, 0);

          // Posta no canal onde o comando foi usado
          const msg = await interaction.channel.send({ embeds: [embed], components });

          // Grava MessageId na planilha (pra não duplicar)
          await sheetsPost({
            action: "set_message_id",
            pedido: String(order.pedido),
            messageId: String(msg.id)
          });

          sent++;
        }

        return interaction.editReply(`✅ Sincronizado! Enviei **${sent}** pedido(s) PENDENTE(s) da planilha para este canal.`);
      }
    }

    // Buttons
    if (interaction.isButton()) {
      const id = interaction.customId || "";

      // Sempre responder rápido
      await interaction.deferUpdate();

      const parts = id.split(":");
      const type = parts[0];

      // Paginação
      if (type === "pg") {
        const action = parts[1]; // prev | next | tenho_all | falta_all
        const pedido = parts[2];
        const page = parseInt(parts[3] || "0", 10) || 0;

        const order = orderCache.get(String(pedido));
        if (!order) return; // se reiniciou o bot, cache some; nesse caso você pode rodar /sync de novo

        if (action === "prev" || action === "next") {
          const nextPage = action === "prev" ? page - 1 : page + 1;
          const embed = buildOrderEmbed(order, nextPage);
          const components = buildOrderComponents(order, nextPage);
          return interaction.message.edit({ embeds: [embed], components });
        }

        // Marcar todos da página
        const status = action === "tenho_all" ? "TENHO" : "FALTA";
        const start = page * PAGE_SIZE;
        const slice = order.items.slice(start, start + PAGE_SIZE);

        const who = interaction.user?.username || "usuario";
        const nowISO = new Date().toISOString();

        for (const it of slice) {
          if (!it.itemKey) continue;
          await sheetsPost({
            action: "set_item_status",
            itemKey: String(it.itemKey),
            status,
            conferidoPor: who,
            conferidoEmISO: nowISO
          });
          it.status = status;
        }

        // Atualiza só a mensagem (visual pode continuar igual; se você quiser, posso colocar ✅/❌ no texto)
        const embed = buildOrderEmbed(order, page);
        const components = buildOrderComponents(order, page);
        return interaction.message.edit({ embeds: [embed], components });
      }

      // Item individual
      if (type === "it") {
        const status = parts[1] === "tenho" ? "TENHO" : "FALTA";
        const pedido = parts[2];
        const page = parseInt(parts[3] || "0", 10) || 0;
        const itemKey = parts.slice(4).join(":"); // caso tenha ":" no key

        const order = orderCache.get(String(pedido));
        if (!order) return;

        const who = interaction.user?.username || "usuario";
        const nowISO = new Date().toISOString();

        await sheetsPost({
          action: "set_item_status",
          itemKey: String(itemKey),
          status,
          conferidoPor: who,
          conferidoEmISO: nowISO
        });

        // Atualiza no cache
        const it = order.items.find(x => String(x.itemKey) === String(itemKey));
        if (it) it.status = status;

        const embed = buildOrderEmbed(order, page);
        const components = buildOrderComponents(order, page);
        return interaction.message.edit({ embeds: [embed], components });
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);

    // Tenta responder sem quebrar (evita "Unknown interaction")
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred) {
          await interaction.editReply({ content: "❌ Erro interno. Veja logs do Render.", flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: "❌ Erro interno. Veja logs do Render.", flags: MessageFlags.Ephemeral });
        }
      }
    } catch (_) {}
  }
});

// ======= Boot =======
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();