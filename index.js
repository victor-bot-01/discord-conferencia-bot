require("dotenv").config();

/* =========================
   BOOT / ENV
========================= */

console.log(
  "ENV CHECK:",
  !!process.env.DISCORD_TOKEN,
  !!process.env.CLIENT_ID
);

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const http = require("http");

/* =========================
   HTTP SERVER (Render)
========================= */

const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  })
  .listen(PORT, () =>
    console.log("HTTP server listening on", PORT)
  );

/* =========================
   ENV VARS
========================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const CHANNEL_ID = process.env.CHANNEL_ID;

const SHEETS_API_URL = process.env.SHEETS_API_URL;
const SHEETS_API_KEY = process.env.SHEETS_API_KEY;

if (!DISCORD_TOKEN || !CLIENT_ID || !CHANNEL_ID) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

/* =========================
   CLIENT
========================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* =========================
   HELPERS
========================= */

async function sheetsGet(action) {
  const url = `${SHEETS_API_URL}?action=${action}&key=${SHEETS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error("Sheets GET failed");
  }
  return data;
}

async function sheetsPost(payload) {
  const res = await fetch(SHEETS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      key: SHEETS_API_KEY,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error("Sheets POST failed");
  }
  return data;
}

/* =========================
   SAFE INTERACTION EDIT
========================= */

async function safeEdit(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
    }
  } catch {
    console.log("⚠️ Interaction expirou — resposta ignorada");
  }
}

/* =========================
   COMMANDS
========================= */

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Testa o bot"),

  new SlashCommandBuilder()
    .setName("sync")
    .setDescription("Sincroniza pedidos pendentes"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(
    DISCORD_TOKEN
  );

  if (GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(
        CLIENT_ID,
        GUILD_ID
      ),
      { body: commands }
    );
  } else {
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
  }

  console.log("✅ Commands registrados");
}

/* =========================
   READY
========================= */

client.once("ready", () => {
  console.log(
    `🤖 Bot online como ${client.user.tag}`
  );
});

/* =========================
   INTERACTIONS
========================= */

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    /* ---------- PING ---------- */
    if (interaction.commandName === "ping") {
      return interaction.reply({
        content: "pong ✅",
        ephemeral: true,
      });
    }

    /* ---------- SYNC ---------- */
    if (interaction.commandName === "sync") {
      console.log("SYNC: iniciado");

      await interaction.deferReply({ ephemeral: true });

      let data;
      try {
        data = await sheetsGet("list_pending");
      } catch (err) {
        console.error("Sheets error:", err);
        return safeEdit(
          interaction,
          "❌ Erro ao acessar a planilha."
        );
      }

      const orders = data.orders || [];
      if (!orders.length) {
        return safeEdit(
          interaction,
          "Nenhum pedido pendente."
        );
      }

      const channel =
        await client.channels.fetch(CHANNEL_ID);

      let sent = 0;

      try {
        for (const order of orders) {
          const msg = await channel.send(
            `📦 Pedido #${order.pedido}`
          );

          await sheetsPost({
            action: "set_message_id",
            pedido: String(order.pedido),
            messageId: String(msg.id),
          });

          sent++;
        }
      } catch (err) {
        console.error("SYNC LOOP ERROR:", err);
        return safeEdit(
          interaction,
          "❌ Erro durante o envio dos pedidos."
        );
      }

      return safeEdit(
        interaction,
        `✅ ${sent} pedido(s) enviados.`
      );
    }
  } catch (err) {
    console.error("INTERACTION ERROR:", err);
  }
});

/* =========================
   GLOBAL SAFETY
========================= */

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

/* =========================
   BOOT
========================= */

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
