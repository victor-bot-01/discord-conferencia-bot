require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionResponseFlags,
} = require('discord.js');

// ===== ENV =====
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

const SHEETS_WEBAPP_URL = process.env.SHEETS_WEBAPP_URL;
const BOT_SECRET = process.env.BOT_SECRET || '';

function must(v, name) {
  if (!v) throw new Error(`Faltando ${name} no .env`);
}
must(TOKEN, 'DISCORD_TOKEN');
must(CLIENT_ID, 'CLIENT_ID');
must(GUILD_ID, 'GUILD_ID');
must(CHANNEL_ID, 'CHANNEL_ID');

// ====== STATE ======
const STATE_PATH = path.join(__dirname, 'state.json');
function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) fs.writeFileSync(STATE_PATH, '{}', 'utf8');
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8') || '{}');
  } catch {
    return {};
  }
}
function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ====== CONFIG UI ======
const ITEMS_PER_PAGE = 4;
const GREEN = '✅';
const RED = '❌';
const EMPTY = '⬜';

// ====== Slash commands ======
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Teste rápido'),
  new SlashCommandBuilder().setName('pedido').setDescription('Cria um pedido de teste com botões'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Comando /pedido registrado');
}

// ====== Client ======
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`🤖 Bot online como: ${client.user.tag}`);
  await registerCommands();
});

// ===== Helpers UI =====
function buildPedidoKey(pedido) {
  return String(pedido).trim();
}

function calcTotalPages(nItems) {
  return Math.max(1, Math.ceil(nItems / ITEMS_PER_PAGE));
}

function getPageItems(items, page) {
  const start = (page - 1) * ITEMS_PER_PAGE;
  return items.slice(start, start + ITEMS_PER_PAGE);
}

function statusEmoji(status) {
  if (status === 'tenho') return GREEN;
  if (status === 'falta') return RED;
  return EMPTY;
}

function computePedidoStatus(allStatuses, nItems) {
  const vals = Object.values(allStatuses || {});
  if (!nItems) return 'PENDENTE';
  if (vals.some((v) => v === 'falta')) return 'INCOMPLETO';
  const filled = Object.keys(allStatuses || {}).length;
  if (filled === nItems && vals.every((v) => v === 'tenho')) return 'COMPLETO';
  return 'PENDENTE';
}

function buildMessageContent(state, pedidoKey) {
  const p = state[pedidoKey];
  const items = p.items;
  const page = p.page || 1;

  const totalPages = calcTotalPages(items.length);
  const safePage = Math.min(Math.max(page, 1), totalPages);

  const statusPedido = computePedidoStatus(p.statusByIndex, items.length);
  const statusLine =
    statusPedido === 'COMPLETO'
      ? `Status do pedido: **COMPLETO** ${GREEN}`
      : statusPedido === 'INCOMPLETO'
        ? `Status do pedido: **INCOMPLETO** ${RED}`
        : `Status do pedido: **PENDENTE** ${EMPTY}`;

  const linhas = items
    .map((it, idx) => {
      const st = (p.statusByIndex || {})[idx + 1] || '';
      return `${statusEmoji(st)} ${idx + 1}. ${it.nome} x${it.qtd}`;
    })
    .join('\n');

  return (
    `📦 **Pedido #${p.pedido}**\n` +
    `👤 **Cliente:** ${p.cliente}\n\n` +
    `**Produtos:**\n${linhas}\n\n` +
    `${statusLine}\n` +
    `📄 Página: **${safePage}/${totalPages}**\n` +
    `👇 Marque item por item ou use os botões de **Tudo desta página**.`
  );
}

function buildComponents(state, pedidoKey) {
  const p = state[pedidoKey];
  const items = p.items;
  const page = p.page || 1;

  const totalPages = calcTotalPages(items.length);
  const safePage = Math.min(Math.max(page, 1), totalPages);

  const pageItems = getPageItems(items, safePage);
  const startIndex = (safePage - 1) * ITEMS_PER_PAGE;

  const rows = [];

  pageItems.forEach((it, i) => {
    const itemIndex = startIndex + i + 1;
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`tenho:${pedidoKey}:${itemIndex}`)
          .setLabel(`Tenho (Prod ${itemIndex})`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`falta:${pedidoKey}:${itemIndex}`)
          .setLabel(`Falta (Prod ${itemIndex})`)
          .setStyle(ButtonStyle.Danger)
      )
    );
  });

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`tenho_all:${pedidoKey}:${safePage}`)
        .setLabel('Tenho todos (página)')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`falta_all:${pedidoKey}:${safePage}`)
        .setLabel('Falta todos (página)')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`prev:${pedidoKey}`)
        .setLabel('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 1),
      new ButtonBuilder()
        .setCustomId(`next:${pedidoKey}`)
        .setLabel('➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages)
    )
  );

  return rows;
}

async function updatePedidoMessage(interaction, pedidoKey) {
  const state = readState();
  const p = state[pedidoKey];
  if (!p) return;
  await interaction.message.edit({
    content: buildMessageContent(state, pedidoKey),
    components: buildComponents(state, pedidoKey),
  });
}

async function postToSheetsUpdate({ pedido, itemKey, itemIndex, status, user, messageId }) {
  if (!SHEETS_WEBAPP_URL) return;

  const payload = {
    secret: BOT_SECRET || '',
    pedido: String(pedido),
    itemKey: String(itemKey),
    itemIndex: Number(itemIndex),
    status: String(status).toUpperCase(),
    user: String(user || ''),
    messageId: String(messageId || ''),
  };

  try {
    const res = await fetch(SHEETS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.log('❌ Sheets update error:', res.status, txt);
    }
  } catch (e) {
    console.log('❌ Sheets fetch failed:', e);
  }
}

async function ephemeralAck(interaction, text) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: InteractionResponseFlags.Ephemeral });
  }
  await interaction.editReply({ content: text });
}

// ====== Interactions ======
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ping') {
        await interaction.reply({ content: '🏓 Pong!', flags: InteractionResponseFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'pedido') {
        const state = readState();

        // pedido demo
        const pedido = '5905';
        const cliente = 'João';
        const items = Array.from({ length: 12 }, (_, i) => ({
          nome: `Produto ${i + 1}`,
          qtd: i % 2 ? 2 : 1,
        }));

        const pedidoKey = buildPedidoKey(pedido);
        state[pedidoKey] = { pedido, cliente, items, page: 1, statusByIndex: {} };
        writeState(state);

        await interaction.reply({
          content: buildMessageContent(state, pedidoKey),
          components: buildComponents(state, pedidoKey),
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const [action, pedidoKey, extra] = interaction.customId.split(':');
      const state = readState();
      const p = state[pedidoKey];

      if (!p) {
        await interaction.reply({
          content: 'Pedido não encontrado na memória.',
          flags: InteractionResponseFlags.Ephemeral,
        });
        return;
      }

      const userTag = interaction.user?.tag || interaction.user?.username || 'user';
      const messageId = interaction.message?.id || '';

      if (action === 'prev') {
        p.page = Math.max(1, (p.page || 1) - 1);
        state[pedidoKey] = p;
        writeState(state);
        await updatePedidoMessage(interaction, pedidoKey);
        await ephemeralAck(interaction, `Página: ${p.page}`);
        return;
      }

      if (action === 'next') {
        const totalPages = calcTotalPages(p.items.length);
        p.page = Math.min(totalPages, (p.page || 1) + 1);
        state[pedidoKey] = p;
        writeState(state);
        await updatePedidoMessage(interaction, pedidoKey);
        await ephemeralAck(interaction, `Página: ${p.page}`);
        return;
      }

      if (action === 'tenho' || action === 'falta') {
        const idx = Number(extra);
        p.statusByIndex = p.statusByIndex || {};
        p.statusByIndex[idx] = action;
        state[pedidoKey] = p;
        writeState(state);

        const itemKey = `${p.pedido}#${String(idx).padStart(2, '0')}`;
        await postToSheetsUpdate({
          pedido: p.pedido,
          itemKey,
          itemIndex: idx,
          status: action === 'tenho' ? 'TENHO' : 'FALTA',
          user: userTag,
          messageId,
        });

        await updatePedidoMessage(interaction, pedidoKey);
        await ephemeralAck(interaction, `✅ Atualizado (oculto): ${itemKey} = ${action.toUpperCase()}`);
        return;
      }

      if (action === 'tenho_all' || action === 'falta_all') {
        const page = Number(extra);
        const pageItems = getPageItems(p.items, page);
        const startIndex = (page - 1) * ITEMS_PER_PAGE;
        p.statusByIndex = p.statusByIndex || {};

        const isTenho = action === 'tenho_all';
        for (let i = 0; i < pageItems.length; i++) {
          const idx = startIndex + i + 1;
          p.statusByIndex[idx] = isTenho ? 'tenho' : 'falta';

          const itemKey = `${p.pedido}#${String(idx).padStart(2, '0')}`;
          await postToSheetsUpdate({
            pedido: p.pedido,
            itemKey,
            itemIndex: idx,
            status: isTenho ? 'TENHO' : 'FALTA',
            user: userTag,
            messageId,
          });
        }

        state[pedidoKey] = p;
        writeState(state);

        await updatePedidoMessage(interaction, pedidoKey);
        await ephemeralAck(
          interaction,
          `✅ Página ${page} aplicada (oculto): ${isTenho ? 'TENHO TODOS' : 'FALTA TODOS'}`
        );
        return;
      }

      await ephemeralAck(interaction, 'Ação não reconhecida.');
    }
  } catch (e) {
    console.log('❌ Erro:', e);
    try {
      if (interaction.isRepliable() && !interaction.replied) {
        await interaction.reply({ content: 'Erro interno (veja o console).', flags: InteractionResponseFlags.Ephemeral });
      }
    } catch {}
  }
});

// ====== HTTP endpoint: Apps Script -> Bot -> Discord ======
const app = express();
app.use(express.json());

app.post('/push-order', async (req, res) => {
  try {
    const body = req.body || {};
    if (BOT_SECRET && body.secret !== BOT_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const pedido = String(body.pedido || '').trim();
    const cliente = String(body.cliente || '').trim();
    const items = Array.isArray(body.items) ? body.items : [];

    if (!pedido || !cliente || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const pedidoKey = buildPedidoKey(pedido);
    const state = readState();

    state[pedidoKey] = {
      pedido,
      cliente,
      items: items
        .map((it) => ({
          nome: String(it?.nome || it?.produto || '').trim(),
          qtd: Number(it?.qtd || it?.quantidade || 1) || 1,
        }))
        .filter((it) => it.nome),
      page: 1,
      statusByIndex: {},
    };

    writeState(state);

    const ch = await client.channels.fetch(CHANNEL_ID);
    const msg = await ch.send({
      content: buildMessageContent(state, pedidoKey),
      components: buildComponents(state, pedidoKey),
    });

    return res.json({ ok: true, messageId: msg.id });
  } catch (e) {
    console.log('❌ push-order error:', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP OK em http://localhost:${PORT}`));

client.login(TOKEN);