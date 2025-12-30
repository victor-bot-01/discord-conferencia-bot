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
  MessageFlags,
} = require("discord.js");

// ======= ENV =======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // opcional
const CHANNEL_ID = process.env.CHANNEL_ID; // canal fixo para postar

const AUTO_SYNC_MINUTES = Number(process.env.AUTO_SYNC_MINUTES || "0"); // 0 = desliga
const AUTO_CLEANUP_MINUTES = Number(process.env.AUTO_CLEANUP_MINUTES || "0"); // 0 = desliga

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

// ======= CLIENT (CRIA PRIMEIRO!) =======
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ======= Helpers (Sheets API) =======
async function sheetsGet(action) {
  const url = `${SHEETS_API_URL}?action=${encodeURIComponent(
    action
  )}&key=${encodeURIComponent(SHEETS_API_KEY)}`;

  const res = await fetch(url, { method: "GET" });

  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok || !data.ok) {
    throw new Error(`Sheets GET failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function sheetsPost(payload) {
  const res = await fetch(SHEETS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, key: SHEETS_API_KEY }),
  });

  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok || !data.ok) {
    throw new Error(`Sheets POST failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// ======= Helpers (Discord delete via REST) =======
async function deleteDiscordMessageById(messageId) {
  const url = `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${messageId}`;

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
  });

  if (res.status === 204) return { ok: true, status: 204 };
  if (res.status === 404) return { ok: true, status: 404 };

  const body = await res.text().catch(() => "");
  return { ok: false, status: res.status, body };
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

    const st = String(it.status || "").toUpperCase().trim();
    const box = st === "TENHO" ? "🟩" : st === "FALTA" ? "🟥" : "⬜";

    return `${box} ${n}. ${it.produto}${qtd}`;
  });

  return new EmbedBuilder()
    .setTitle("📦 Conferência de Pedido")
    .setDescription(
      `**Pedido:** #${order.pedido}\n` +
        `**Marketplace:** ${order.marketplace || "-"}\n` +
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
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

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
      .setStyle(ButtonStyle.Danger)
  );

  rows.push(nav);
  return rows;
}

const orderCache = new Map(); // pedido -> orderObject

// ======= Commands =======
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Testa o bot"),

  new SlashCommandBuilder()
    .setName("sync")
    .setDescription(
      "Envia para o Discord os pedidos PENDENTES da planilha (não postados ainda)."
    ),

  new SlashCommandBuilder()
    .setName("limpar_confirmados")
    .setDescription("Apaga no Discord e remove da planilha os pedidos com Confirmado = SIM."),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("✅ Commands registered (guild).");
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Commands registered (global).");
  }
}

// ======= AUTO SYNC =======
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
      orderCache.set(String(order.pedido), order);

      const embed = buildOrderEmbed(order, 0);
      const components = buildOrderComponents(order, 0);

      const msg = await channel.send({ embeds: [embed], components });

      await sheetsPost({
        action: "set_message_id",
        pedido: String(order.pedido),
        messageId: String(msg.id),
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
  autoSyncOnce();
  setInterval(autoSyncOnce, ms);
}

// ======= CLEANUP CONFIRMADOS =======
let isCleanupRunning = false;

async function cleanupConfirmedOnce() {
  if (isCleanupRunning) return;
  isCleanupRunning = true;

  try {
    const data = await sheetsGet("list_confirmed");
    const orders = data.orders || [];

    if (!orders.length) {
      console.log("CLEANUP: no confirmed orders to delete.");
      return { deletedDiscord: 0, deletedRows: 0, total: 0 };
    }

    let deletedDiscord = 0;
    let deletedRows = 0;

    for (const o of orders) {
      const messageId = String(o.discordMessageId || o.messageId || "").trim();
      if (!messageId) continue;

      const del = await deleteDiscordMessageById(messageId);
      if (!del.ok) {
        console.error("CLEANUP: failed to delete discord message", messageId, del);
        continue;
      }

      deletedDiscord++;

      const r = await sheetsPost({ action: "delete_order_by_message_id", messageId });
      deletedRows += Number(r.deletedRows || 0);
    }

    console.log(
      `CLEANUP: done. Discord=${deletedDiscord}, rows=${deletedRows}, totalOrders=${orders.length}`
    );
    return { deletedDiscord, deletedRows, total: orders.length };
  } catch (err) {
    console.error("CLEANUP error:", err);
    return { error: String(err?.message || err) };
  } finally {
    isCleanupRunning = false;
  }
}

function startAutoCleanup() {
  if (!AUTO_CLEANUP_MINUTES || AUTO_CLEANUP_MINUTES <= 0) {
    console.log("CLEANUP: disabled (AUTO_CLEANUP_MINUTES <= 0).");
    return;
  }
  const ms = AUTO_CLEANUP_MINUTES * 60 * 1000;
  console.log(`CLEANUP: enabled every ${AUTO_CLEANUP_MINUTES} minute(s).`);
  cleanupConfirmedOnce();
  setInterval(cleanupConfirmedOnce, ms);
}

// ======= READY =======
let commandsRegistered = false;

client.once("ready", async () => {
  console.log(`🤖 Bot online como: ${client.user.tag}`);

  try {
    if (!commandsRegistered) {
      commandsRegistered = true;
      await registerCommands();
    }
  } catch (e) {
    console.error("❌ Failed to register commands:", e);
  }

  startAutoSync();
  startAutoCleanup();
});

// ======= Interaction Handler =======
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ping") {
        return interaction.reply({ content: "pong ✅", flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "sync") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const data = await sheetsGet("list_pending");
        const orders = data.orders || [];

        if (!orders.length) {
          return interaction.editReply(
            "Nada para sincronizar: nenhum pedido PENDENTE sem DiscordMessageId."
          );
        }

        let sent = 0;
        for (const order of orders) {
          orderCache.set(String(order.pedido), order);

          const embed = buildOrderEmbed(order, 0);
          const components = buildOrderComponents(order, 0);

          const msg = await interaction.channel.send({ embeds: [embed], components });

          await sheetsPost({
            action: "set_message_id",
            pedido: String(order.pedido),
            messageId: String(msg.id),
          });

          sent++;
        }

        return interaction.editReply(
          `✅ Sincronizado! Enviei **${sent}** pedido(s) PENDENTE(s) para este canal.`
        );
      }

      if (interaction.commandName === "limpar_confirmados") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const result = await cleanupConfirmedOnce();
        if (result?.error) {
          return interaction.editReply(`❌ Erro: ${result.error}`);
        }
        return interaction.editReply(
          `✅ Limpeza concluída.\n` +
            `• Pedidos processados: ${result.total}\n` +
            `• Mensagens apagadas no Discord: ${result.deletedDiscord}\n` +
            `• Linhas removidas da planilha: ${result.deletedRows}`
        );
      }
    }

    if (interaction.isButton()) {
      await interaction.deferUpdate();

      const id = interaction.customId || "";
      const parts = id.split(":");
      const type = parts[0];

      if (type === "pg") {
        const action = parts[1];
        const pedido = parts[2];
        const page = parseInt(parts[3] || "0", 10) || 0;

        const order = orderCache.get(String(pedido));
        if (!order) return;

        if (action === "prev" || action === "next") {
          const nextPage = action === "prev" ? page - 1 : page + 1;
          const embed = buildOrderEmbed(order, nextPage);
          const components = buildOrderComponents(order, nextPage);
          return interaction.message.edit({ embeds: [embed], components });
        }

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
            conferidoEmISO: nowISO,
          });
          it.status = status;
        }

        const embed = buildOrderEmbed(order, page);
        const components = buildOrderComponents(order, page);
        return interaction.message.edit({ embeds: [embed], components });
      }

      if (type === "it") {
        const status = parts[1] === "tenho" ? "TENHO" : "FALTA";
        const pedido = parts[2];
        const page = parseInt(parts[3] || "0", 10) || 0;
        const itemKey = parts.slice(4).join(":");

        const order = orderCache.get(String(pedido));
        if (!order) return;

        const who = interaction.user?.username || "usuario";
        const nowISO = new Date().toISOString();

        await sheetsPost({
          action: "set_item_status",
          itemKey: String(itemKey),
          status,
          conferidoPor: who,
          conferidoEmISO: nowISO,
        });

        const it = order.items.find((x) => String(x.itemKey) === String(itemKey));
        if (it) it.status = status;

        const embed = buildOrderEmbed(order, page);
        const components = buildOrderComponents(order, page);
        return interaction.message.edit({ embeds: [embed], components });
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred) {
          await interaction.editReply({
            content: "❌ Erro interno. Veja logs do Render.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: "❌ Erro interno. Veja logs do Render.",
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    } catch (_) {}
  }
});

// ======= BOOT (RETRY + DIAG SEM DERRUBAR O SERVIÇO) =======
async function diagDiscord() {
  try {
    const r = await fetch("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "User-Agent": "DiscordBot (https://example.com, 1.0)",
        Accept: "application/json",
      },
    });
    const txt = await r.text();
    console.log("DIAG /users/@me status =", r.status, "body head =", txt.slice(0, 120));
  } catch (e) {
    console.error("DIAG Falha de rede/TLS:", e);
  }
}

async function loginWithRetry() {
  console.log("BOOT: chamando client.login...");

  const loginPromise = client.login(DISCORD_TOKEN);
  const timeoutPromise = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("LOGIN TIMEOUT em 25s")), 25000)
  );

  try {
    await Promise.race([loginPromise, timeoutPromise]);
    console.log("✅ Login OK (promise resolveu)");
  } catch (err) {
    console.error("❌ Login falhou/timeout:", err?.message || err);
    await diagDiscord();

    console.log("⏳ Aguardando 5 minutos para tentar login novamente...");
    setTimeout(loginWithRetry, 5 * 60 * 1000);
  }
}

client.on("error", (e) => console.error("CLIENT ERROR:", e));
client.on("warn", (w) => console.warn("CLIENT WARN:", w));

loginWithRetry();