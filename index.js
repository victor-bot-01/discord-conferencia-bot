// index.js
// Discord bot (discord.js v14) + Render/HTTP keep-alive
// Comandos: /ping, /pedido
// Interface limpa: botões NÃO geram mensagens “ocultas” no chat (usa deferUpdate)

require("dotenv").config();
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
} = require("discord.js");

const express = require("express");

// =======================
// 0) ENV
// =======================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // opcional (recomendado p/ registrar rápido)

if (!TOKEN || !CLIENT_ID) {
  console.error(
    "❌ Faltam variáveis .env: DISCORD_TOKEN e/ou CLIENT_ID. (GUILD_ID é opcional)"
  );
  process.exit(1);
}

// =======================
// 1) HTTP server (Render)
// =======================
const app = express();
app.get("/", (req, res) => res.status(200).send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ HTTP OK em http://localhost:${PORT}`));

// =======================
// 2) Discord client
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// =======================
// 3) Estado em memória
// =======================
// messageId -> state
// state = { orderId, customerName, page, perPage, products: [{name, qty, status:null|'TENHO'|'FALTA'}] }
const ordersByMessageId = new Map();

// =======================
// 4) Slash commands
// =======================
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Testa o bot."),
  new SlashCommandBuilder()
    .setName("pedido")
    .setDescription("Cria uma mensagem de conferência de pedido (demo)."),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commands,
      });
      console.log("✅ Comandos /ping e /pedido registrados (GUILD).");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: commands,
      });
      console.log("✅ Comandos /ping e /pedido registrados (GLOBAL).");
    }
  } catch (err) {
    console.error("❌ Erro registrando comandos:", err);
  }
}

// =======================
// 5) Helpers de UI
// =======================
function computeOrderStatus(products) {
  const allMarked = products.every((p) => p.status === "TENHO" || p.status === "FALTA");
  return allMarked ? "COMPLETO" : "PENDENTE";
}

function statusEmoji(status) {
  if (status === "TENHO") return "✅";
  if (status === "FALTA") return "❌";
  return "⬜";
}

function buildEmbed(state) {
  const totalPages = Math.max(1, Math.ceil(state.products.length / state.perPage));
  const page = Math.min(Math.max(0, state.page), totalPages - 1);

  const start = page * state.perPage;
  const end = Math.min(start + state.perPage, state.products.length);
  const pageItems = state.products.slice(start, end);

  const lines = [];
  for (let i = start; i < end; i++) {
    const p = state.products[i];
    lines.push(`${statusEmoji(p.status)} **${i + 1}. ${p.name}** x${p.qty}`);
  }

  const orderStatus = computeOrderStatus(state.products);

  const embed = new EmbedBuilder()
    .setTitle("📦 Conferência de Pedido")
    .setDescription(
      [
        `**Pedido:** ${state.orderId}`,
        `**Cliente:** ${state.customerName}`,
        `**Status do pedido:** **${orderStatus}**`,
        "",
        "**Produtos:**",
        lines.join("\n"),
        "",
        `Página **${page + 1}/${totalPages}**`,
      ].join("\n")
    )
    .setFooter({ text: "Marque item por item ou use os botões da página." });

  return embed;
}

function buildComponents(messageId, state) {
  const totalPages = Math.max(1, Math.ceil(state.products.length / state.perPage));
  const page = Math.min(Math.max(0, state.page), totalPages - 1);

  const start = page * state.perPage;
  const end = Math.min(start + state.perPage, state.products.length);

  const rows = [];

  // 1 row por produto (2 botões por linha)
  for (let i = start; i < end; i++) {
    const p = state.products[i];

    const tenhoBtn = new ButtonBuilder()
      .setCustomId(`tenho:${i}`)
      .setLabel(`Tenho ${i + 1}`)
      .setStyle(ButtonStyle.Success);

    const faltaBtn = new ButtonBuilder()
      .setCustomId(`falta:${i}`)
      .setLabel(`Falta ${i + 1}`)
      .setStyle(ButtonStyle.Danger);

    // Se quiser “travar” quando já marcado:
    if (p.status === "TENHO") tenhoBtn.setDisabled(true);
    if (p.status === "FALTA") faltaBtn.setDisabled(true);

    rows.push(new ActionRowBuilder().addComponents(tenhoBtn, faltaBtn));
  }

  // Linha de navegação + ações por página
  const prevBtn = new ButtonBuilder()
    .setCustomId(`prev`)
    .setLabel("⬅️ Página anterior")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page <= 0);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`next`)
    .setLabel("Próxima página ➡️")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages - 1);

  const tenhoPageBtn = new ButtonBuilder()
    .setCustomId(`tenho_page`)
    .setLabel("Tenho todos desta página")
    .setStyle(ButtonStyle.Success);

  const faltaPageBtn = new ButtonBuilder()
    .setCustomId(`falta_page`)
    .setLabel("Falta todos desta página")
    .setStyle(ButtonStyle.Danger);

  rows.push(
    new ActionRowBuilder().addComponents(prevBtn, nextBtn, tenhoPageBtn, faltaPageBtn)
  );

  // Limite do Discord: 5 linhas no máximo.
  // Com perPage=4 => 4 linhas produtos + 1 navegação = 5 (ok).
  return rows.slice(0, 5);
}

function buildMessagePayload(messageId, state) {
  return {
    embeds: [buildEmbed(state)],
    components: buildComponents(messageId, state),
  };
}

// =======================
// 6) Criar pedido demo
// =======================
function makeDemoOrder() {
  // Ajuste aqui para puxar dados reais depois
  const products = Array.from({ length: 12 }).map((_, idx) => ({
    name: `Produto ${idx + 1}`,
    qty: (idx % 2) + 1,
    status: null,
  }));

  return {
    orderId: `#${Math.floor(100000 + Math.random() * 900000)}`,
    customerName: "Cliente João",
    page: 0,
    perPage: 4,
    products,
  };
}

// =======================
// 7) Interactions
// =======================
client.on("interactionCreate", async (interaction) => {
  try {
    // -------------------
    // SLASH COMMANDS
    // -------------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ping") {
        // Para evitar timeout em cold start: sempre defer
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply("🏓 Pong! Bot online.");
        return;
      }

      if (interaction.commandName === "pedido") {
        // Mensagem no canal (não ephemeral)
        await interaction.deferReply();

        const state = makeDemoOrder();

        // Envia a mensagem “principal” via editReply (vira a própria mensagem do comando)
        const tempPayload = buildMessagePayload("temp", state);
        const msg = await interaction.editReply(tempPayload);

        // Agora temos messageId real
        ordersByMessageId.set(msg.id, state);

        // Re-edita com customIds já ok (não precisa, mas mantém consistente)
        const realPayload = buildMessagePayload(msg.id, state);
        await msg.edit(realPayload);

        return;
      }
    }

    // -------------------
    // BUTTONS
    // -------------------
    if (interaction.isButton()) {
      const messageId = interaction.message?.id;
      const state = ordersByMessageId.get(messageId);

      // IMPORTANTÍSSIMO: não poluir chat.
      // Isso confirma o clique sem mandar mensagens.
      await interaction.deferUpdate();

      if (!state) {
        // Caso a mensagem seja antiga e o bot tenha reiniciado (memória perdeu)
        // Envia só para quem clicou (não polui)
        await interaction.followUp({
          content:
            "⚠️ Não encontrei esse pedido na memória (o bot pode ter reiniciado). Rode /pedido novamente.",
          ephemeral: true,
        });
        return;
      }

      const id = interaction.customId;

      // Navegação
      if (id === "prev") state.page = Math.max(0, state.page - 1);
      if (id === "next") {
        const totalPages = Math.max(1, Math.ceil(state.products.length / state.perPage));
        state.page = Math.min(totalPages - 1, state.page + 1);
      }

      // Ações por item
      if (id.startsWith("tenho:")) {
        const idx = Number(id.split(":")[1]);
        if (!Number.isNaN(idx) && state.products[idx]) state.products[idx].status = "TENHO";
      }

      if (id.startsWith("falta:")) {
        const idx = Number(id.split(":")[1]);
        if (!Number.isNaN(idx) && state.products[idx]) state.products[idx].status = "FALTA";
      }

      // Ações por página
      if (id === "tenho_page" || id === "falta_page") {
        const totalPages = Math.max(1, Math.ceil(state.products.length / state.perPage));
        const page = Math.min(Math.max(0, state.page), totalPages - 1);
        const start = page * state.perPage;
        const end = Math.min(start + state.perPage, state.products.length);

        for (let i = start; i < end; i++) {
          state.products[i].status = id === "tenho_page" ? "TENHO" : "FALTA";
        }
      }

      // Salva estado
      ordersByMessageId.set(messageId, state);

      // Atualiza só a mensagem principal (sem spam)
      const payload = buildMessagePayload(messageId, state);
      await interaction.message.edit(payload);

      return;
    }
  } catch (err) {
    console.error("❌ Erro em interactionCreate:", err);

    // Tenta não deixar “interação falhou”
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred) {
          await interaction.followUp({
            content: "❌ Ocorreu um erro interno. Veja os logs no Render.",
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: "❌ Ocorreu um erro interno. Veja os logs no Render.",
            ephemeral: true,
          });
        }
      }
    } catch (_) {}
  }
});

// =======================
// 8) Ready
// =======================
client.once("ready", () => {
  console.log(`✅ Bot online como: ${client.user.tag}`);
});

// Start
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();