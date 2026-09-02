/**
 * ============================================================================
 * Edenred Portugal Multi-User Discord Bot
 * ============================================================================
 *
 * Interactive Discord Bot allowing multiple coworkers/users to:
 *   - Securely connect their MyEdenred Portugal account via private Discord Modals
 *   - Check balance (/saldo) and recent transactions (/movimentos) privately
 *   - Receive instant push notifications in DM for deposits and purchases
 *   - Automatic 2FA challenge resolution via Gmail IMAP or interactive Discord UI
 *
 * @author Bruno Patuleia
 * @license MIT
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import Database from "better-sqlite3";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const CONFIG_FILE = ".env";

function loadEnv() {
  const env = {};
  if (existsSync(CONFIG_FILE)) {
    const lines = readFileSync(CONFIG_FILE, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      env[key] = value;
    }
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = env.DISCORD_CLIENT_ID;
const DB_PATH = "./data/bot.sqlite";
const POLL_INTERVAL_MS = (parseInt(env.POLL_INTERVAL_MINUTES, 10) || 15) * 60 * 1000;

const EDENRED_BASE = "https://www.myedenred.pt/edenred-customer/v2";
const EDENRED_PARAMS = "appVersion=1.0&appType=PORTAL&channel=WEB";

// Temporary in-memory pending logins awaiting 2FA code: discordUserId -> { email, password, challengeId, timestamp }
const pendingLogins = new Map();

// ============================================================================
// SQLite Database Setup
// ============================================================================

if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_user_id TEXT PRIMARY KEY,
    edenred_email TEXT,
    edenred_password TEXT,
    edenred_token TEXT,
    edenred_card_id TEXT,
    edenred_card_last4 TEXT,
    edenred_owner_name TEXT,
    edenred_balance REAL,
    gmail_app_password TEXT,
    seen_transactions TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
`);

const stmtGetUser = db.prepare("SELECT * FROM users WHERE discord_user_id = ?");
const stmtGetAllUsers = db.prepare("SELECT * FROM users");
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (
    discord_user_id, edenred_email, edenred_password, edenred_token,
    edenred_card_id, edenred_card_last4, edenred_owner_name,
    edenred_balance, gmail_app_password, seen_transactions, created_at, updated_at
  ) VALUES (
    @discord_user_id, @edenred_email, @edenred_password, @edenred_token,
    @edenred_card_id, @edenred_card_last4, @edenred_owner_name,
    @edenred_balance, @gmail_app_password, @seen_transactions, @created_at, @updated_at
  )
  ON CONFLICT(discord_user_id) DO UPDATE SET
    edenred_email = excluded.edenred_email,
    edenred_password = excluded.edenred_password,
    edenred_token = excluded.edenred_token,
    edenred_card_id = excluded.edenred_card_id,
    edenred_card_last4 = excluded.edenred_card_last4,
    edenred_owner_name = excluded.edenred_owner_name,
    edenred_balance = excluded.edenred_balance,
    gmail_app_password = excluded.gmail_app_password,
    seen_transactions = excluded.seen_transactions,
    updated_at = excluded.updated_at;
`);
const stmtUpdateTokenAndBalance = db.prepare(`
  UPDATE users SET
    edenred_token = ?,
    edenred_balance = ?,
    seen_transactions = ?,
    updated_at = ?
  WHERE discord_user_id = ?
`);
const stmtDeleteUser = db.prepare("DELETE FROM users WHERE discord_user_id = ?");

// ============================================================================
// Edenred API Functions
// ============================================================================

async function edenredLogin(email, password) {
  const res = await fetch(`${EDENRED_BASE}/authenticate/default?${EDENRED_PARAMS}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Login falhou: ${body?.internalCode || res.status}`);
  if (body?.data?.token) return { token: body.data.token, challengeId: null };
  if (body?.data?.challengeId) return { token: null, challengeId: body.data.challengeId };
  throw new Error("Resposta inesperada da Edenred");
}

async function edenredSubmitChallenge(email, password, challengeId, code) {
  const res = await fetch(`${EDENRED_BASE}/authenticate/default/challenge?${EDENRED_PARAMS}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: email,
      password,
      authenticationMfaProcessId: challengeId,
      token: code,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body?.data?.token) {
    throw new Error(`Código 2FA inválido ou expirado: ${body?.internalCode || res.status}`);
  }
  return body.data.token;
}

async function edenredGetCards(token) {
  const res = await fetch(`${EDENRED_BASE}/protected/card/list?${EDENRED_PARAMS}`, {
    headers: { "Content-Type": "application/json", Authorization: token },
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`Erro ao obter cartões: ${res.status}`);
  const body = await res.json();
  return body?.data || [];
}

async function edenredGetTransactions(token, cardId) {
  const res = await fetch(`${EDENRED_BASE}/protected/card/${cardId}/accountmovement?${EDENRED_PARAMS}`, {
    headers: { "Content-Type": "application/json", Authorization: token },
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`Erro ao obter movimentos: ${res.status}`);
  const body = await res.json();
  return {
    balance: body?.data?.account?.availableBalance || 0,
    transactions: body?.data?.movementList || [],
  };
}

// ============================================================================
// Automated 2FA Email Fetcher (Gmail IMAP)
// ============================================================================

async function fetchEmail2FACode(email, appPassword, maxWaitSeconds = 45) {
  const startTime = Date.now();
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: email, pass: appPassword.replace(/\s+/g, "") },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  try {
    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      const uids = await client.search({ from: "appmyedenred.pt" }, { uid: true });
      if (uids && uids.length > 0) {
        const latestUid = uids[uids.length - 1];
        const msg = await client.fetchOne(latestUid, { envelope: true, source: true }, { uid: true });
        const emailTime = new Date(msg.envelope.date).getTime();

        if (emailTime >= startTime - 30000) {
          const parsed = await simpleParser(msg.source);
          const body = parsed.html || parsed.text || "";
          const match = body.match(/<b>\s*(\d{5})\s*<\/b>/i) || body.match(/\b\d{5}\b/);
          if (match) {
            return match[1] || match[0];
          }
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("Tempo limite excedido a aguardar pelo email da Edenred");
  } finally {
    lock.release();
    await client.logout();
  }
}

function getTxId(t) {
  return `edenred-${t.transactionDate}-${t.transactionName}-${t.amount}`;
}

// ============================================================================
// Discord Client & Slash Commands Registration
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("login")
    .setDescription("Associar ou renovar a tua conta do MyEdenred Portugal de forma privada"),
  new SlashCommandBuilder()
    .setName("saldo")
    .setDescription("Consultar o teu saldo disponível e estado do cartão"),
  new SlashCommandBuilder()
    .setName("movimentos")
    .setDescription("Consultar os últimos movimentos do teu cartão"),
  new SlashCommandBuilder()
    .setName("logout")
    .setDescription("Desassociar a tua conta MyEdenred e remover todos os teus dados"),
  new SlashCommandBuilder()
    .setName("ajuda")
    .setDescription("Informações de ajuda e como configurar o 2FA automático"),
];

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  console.log("🔄 Registando Slash Commands no Discord...");
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log("✅ Slash Commands registados com sucesso!");
}

// ============================================================================
// Slash Command & Modal Handlers
// ============================================================================

client.on("interactionCreate", async (interaction) => {
  try {
    // ------------------------------------------------------------------------
    // Slash Commands
    // ------------------------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === "login") {
        const embed = new EmbedBuilder()
          .setTitle("🔐 Ligar Conta MyEdenred Portugal")
          .setColor(0x3498db)
          .setDescription(
            "Para receberes notificações automáticas e consultares o teu saldo, clica no botão **Ligar Conta** abaixo.\n\n" +
            "💡 **Dica (2FA 100% Automático):**\n" +
            "Se usas Gmail, podes gerar uma **Palavra-passe de Aplicação** no Google para o bot ler o código de 5 dígitos sozinho sem te pedir nada!"
          )
          .setFooter({ text: "Os teus dados são processados de forma privada." });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("btn_open_login_modal")
            .setLabel("🔐 Ligar Conta")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setLabel("🌐 Criar App Password no Google")
            .setStyle(ButtonStyle.Link)
            .setURL("https://myaccount.google.com/apppasswords")
        );

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        return;
      }

      if (commandName === "saldo") {
        await interaction.deferReply({ ephemeral: true });
        const user = stmtGetUser.get(interaction.user.id);
        if (!user || !user.edenred_token) {
          await interaction.editReply("❌ Ainda não tens nenhuma conta MyEdenred associada. Usa o comando `/login` para começar!");
          return;
        }

        try {
          const { balance } = await edenredGetTransactions(user.edenred_token, user.edenred_card_id);
          const embed = new EmbedBuilder()
            .setTitle("💳 Saldo MyEdenred")
            .setColor(0x2ecc71)
            .addFields(
              { name: "👤 Titular", value: user.edenred_owner_name || "Utilizador", inline: true },
              { name: "💳 Cartão", value: `•••• ${user.edenred_card_last4}`, inline: true },
              { name: "💰 Saldo Disponível", value: `**${balance.toFixed(2)} €**`, inline: false }
            )
            .setFooter({ text: "MyEdenred Portugal" })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } catch (err) {
          if (err.message === "TOKEN_EXPIRED") {
            await interaction.editReply("⚠️ A tua sessão MyEdenred expirou. Usa o comando `/login` para renovar o acesso.");
          } else {
            await interaction.editReply(`❌ Erro ao consultar saldo: ${err.message}`);
          }
        }
        return;
      }

      if (commandName === "movimentos") {
        await interaction.deferReply({ ephemeral: true });
        const user = stmtGetUser.get(interaction.user.id);
        if (!user || !user.edenred_token) {
          await interaction.editReply("❌ Ainda não tens nenhuma conta MyEdenred associada. Usa o comando `/login` para começar!");
          return;
        }

        try {
          const { balance, transactions } = await edenredGetTransactions(user.edenred_token, user.edenred_card_id);
          const recent = transactions.slice(0, 7);

          const fields = recent.map((t) => {
            const isDeposit = t.amount >= 0;
            const sign = isDeposit ? "+" : "-";
            const date = t.transactionDate ? t.transactionDate.split("T")[0] : "";
            return {
              name: `${isDeposit ? "🟢" : "🔴"} ${t.transactionName || "Edenred"}`,
              value: `Valor: **${sign}${Math.abs(t.amount).toFixed(2)} €** | Data: \`${date}\``,
              inline: false,
            };
          });

          const embed = new EmbedBuilder()
            .setTitle(`📜 Últimos Movimentos (Saldo: ${balance.toFixed(2)} €)`)
            .setColor(0x3498db)
            .addFields(fields.length > 0 ? fields : [{ name: "Sem movimentos recentes", value: "—" }])
            .setFooter({ text: `Cartão •••• ${user.edenred_card_last4}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } catch (err) {
          if (err.message === "TOKEN_EXPIRED") {
            await interaction.editReply("⚠️ A tua sessão MyEdenred expirou. Usa o comando `/login` para renovar o acesso.");
          } else {
            await interaction.editReply(`❌ Erro ao consultar movimentos: ${err.message}`);
          }
        }
        return;
      }

      if (commandName === "logout") {
        stmtDeleteUser.run(interaction.user.id);
        await interaction.reply({
          content: "✅ A tua conta MyEdenred foi desassociada com sucesso e todos os teus dados locais foram apagados.",
          ephemeral: true,
        });
        return;
      }

      if (commandName === "ajuda") {
        const embed = new EmbedBuilder()
          .setTitle("ℹ️ Ajuda — Edenred Alerts Bot")
          .setColor(0x9b59b6)
          .setDescription(
            "Este bot monitoriza o teu cartão MyEdenred Portugal e avisa-te por mensagem privada sempre que houver dinheiro a entrar ou sair!"
          )
          .addFields(
            { name: "🔐 /login", value: "Associa o teu cartão através de um pop-up seguro e privado." },
            { name: "💰 /saldo", value: "Mostra o teu saldo disponível atual." },
            { name: "📜 /movimentos", value: "Mostra os últimos movimentos do cartão." },
            { name: "🚪 /logout", value: "Apaga a tua conta e desativa notificações." },
            {
              name: "🤖 2FA 100% Automático (Recomendado)",
              value:
                "Se usares Gmail, podes gerar uma **Palavra-passe de Aplicação** em https://myaccount.google.com/apppasswords e colocá-la no `/login`. O bot lê o código de 5 dígitos sozinho e nunca mais precisas de aprovar 2FA manualmente!",
            }
          )
          .setFooter({ text: "Desenvolvido com ❤️ para a malta do escritório" });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
    }

    // ------------------------------------------------------------------------
    // Modal Submissions
    // ------------------------------------------------------------------------
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "modal_login") {
        await interaction.deferReply({ ephemeral: true });

        const email = interaction.fields.getTextInputValue("input_email").trim();
        const password = interaction.fields.getTextInputValue("input_password").trim();
        const gmailPass = interaction.fields.getTextInputValue("input_gmail_pass").trim();

        try {
          await interaction.editReply("🔐 A autenticar na Edenred...");
          const { token, challengeId } = await edenredLogin(email, password);

          // Case 1: No 2FA required (direct token)
          if (token) {
            await finalizeUserSetup(interaction, email, password, token, gmailPass);
            return;
          }

          // Case 2: 2FA required + Gmail App Password provided -> Auto solve!
          if (gmailPass) {
            await interaction.editReply("📬 Código 2FA enviado. A aguardar leitura automática no Gmail (~5-10s)...");
            const code = await fetchEmail2FACode(email, gmailPass);
            const jwt = await edenredSubmitChallenge(email, password, challengeId, code);
            await finalizeUserSetup(interaction, email, password, jwt, gmailPass);
            return;
          }

          // Case 3: 2FA required without Gmail App Password -> Ask for code interactively
          pendingLogins.set(interaction.user.id, {
            email,
            password,
            challengeId,
            gmailPass,
            timestamp: Date.now(),
          });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("btn_enter_2fa")
              .setLabel("Inserir Código 2FA")
              .setStyle(ButtonStyle.Primary)
          );

          await interaction.editReply({
            content: "📱 **Código 2FA enviado!** A Edenred enviou um código de 5 dígitos para o teu telemóvel/email.\n\nClica no botão abaixo para inserires o código:",
            components: [row],
          });
        } catch (err) {
          await interaction.editReply(`❌ Erro no login: ${err.message}`);
        }
        return;
      }

      if (interaction.customId === "modal_2fa_code") {
        await interaction.deferReply({ ephemeral: true });
        const pending = pendingLogins.get(interaction.user.id);
        if (!pending) {
          await interaction.editReply("❌ Sessão de login expirada. Por favor usa `/login` novamente.");
          return;
        }

        const code = interaction.fields.getTextInputValue("input_2fa_code").trim();
        try {
          const jwt = await edenredSubmitChallenge(
            pending.email,
            pending.password,
            pending.challengeId,
            code
          );
          pendingLogins.delete(interaction.user.id);
          await finalizeUserSetup(interaction, pending.email, pending.password, jwt, pending.gmailPass);
        } catch (err) {
          await interaction.editReply(`❌ Erro na validação do código 2FA: ${err.message}`);
        }
        return;
      }
    }

    // ------------------------------------------------------------------------
    // Button Interactions
    // ------------------------------------------------------------------------
    if (interaction.isButton()) {
      if (interaction.customId === "btn_open_login_modal") {
        const modal = new ModalBuilder()
          .setCustomId("modal_login")
          .setTitle("Ligar Conta MyEdenred Portugal");

        const emailInput = new TextInputBuilder()
          .setCustomId("input_email")
          .setLabel("Email do MyEdenred")
          .setPlaceholder("o-teu-email@gmail.com")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const passInput = new TextInputBuilder()
          .setCustomId("input_password")
          .setLabel("Palavra-passe do MyEdenred")
          .setPlaceholder("A tua palavra-passe do MyEdenred")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const gmailInput = new TextInputBuilder()
          .setCustomId("input_gmail_pass")
          .setLabel("App Password Gmail (2FA Automático)")
          .setPlaceholder("Opcional: cria em myaccount.google.com/apppasswords")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(emailInput),
          new ActionRowBuilder().addComponents(passInput),
          new ActionRowBuilder().addComponents(gmailInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "btn_enter_2fa") {
        const modal = new ModalBuilder()
          .setCustomId("modal_2fa_code")
          .setTitle("Código de Verificação 2FA");

        const codeInput = new TextInputBuilder()
          .setCustomId("input_2fa_code")
          .setLabel("Código de 5 dígitos")
          .setPlaceholder("Ex: 12345")
          .setMinLength(5)
          .setMaxLength(6)
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
        await interaction.showModal(modal);
        return;
      }
    }
  } catch (err) {
    console.error("Unhandled Interaction Error:", err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`❌ Ocorreu um erro inesperado: ${err.message}`).catch(() => {});
    }
  }
});

/**
 * Finalizes user registration, fetches cards, saves to SQLite, and sends confirmation embed.
 */
async function finalizeUserSetup(interaction, email, password, token, gmailPass) {
  const cards = await edenredGetCards(token);
  if (!cards || cards.length === 0) {
    await interaction.editReply("⚠️ Login concluído, mas não foi encontrado nenhum cartão associado a esta conta.");
    return;
  }

  const primaryCard = cards[0];
  const { balance, transactions } = await edenredGetTransactions(token, primaryCard.id);
  const seenTx = transactions.map((t) => getTxId(t));

  const now = Date.now();
  stmtUpsertUser.run({
    discord_user_id: interaction.user.id,
    edenred_email: email,
    edenred_password: password,
    edenred_token: token,
    edenred_card_id: String(primaryCard.id),
    edenred_card_last4: primaryCard.number ? primaryCard.number.slice(-4) : "Card",
    edenred_owner_name: primaryCard.ownerName || "Utilizador",
    edenred_balance: balance,
    gmail_app_password: gmailPass || null,
    seen_transactions: JSON.stringify(seenTx),
    created_at: now,
    updated_at: now,
  });

  const embed = new EmbedBuilder()
    .setTitle("🎉 Cartão MyEdenred Ligado com Sucesso!")
    .setColor(0x2ecc71)
    .setDescription("O teu cartão está agora associado. Vais receber notificações privadas sempre que houver dinheiro a entrar ou sair!")
    .addFields(
      { name: "👤 Titular", value: primaryCard.ownerName || "Utilizador", inline: true },
      { name: "💳 Cartão", value: `•••• ${primaryCard.number ? primaryCard.number.slice(-4) : ""}`, inline: true },
      { name: "💰 Saldo Inicial", value: `**${balance.toFixed(2)} €**`, inline: false },
      {
        name: "🤖 2FA Automático",
        value: gmailPass ? "✅ Ativado (Gmail IMAP)" : "⚠️ Manual (Usa `/login` quando expirar)",
        inline: false,
      }
    )
    .setFooter({ text: "Podes usar /saldo e /movimentos a qualquer altura!" })
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [embed], components: [] });
}

// ============================================================================
// Multi-User Background Polling Engine
// ============================================================================

async function pollAllUsers() {
  const users = stmtGetAllUsers.all();
  if (!users || users.length === 0) return;

  console.log(`[${new Date().toLocaleTimeString()}] 🔍 A verificar movimentos para ${users.length} utilizador(es)...`);

  for (const user of users) {
    try {
      let token = user.edenred_token;

      // Try fetching movements
      let result;
      try {
        result = await edenredGetTransactions(token, user.edenred_card_id);
      } catch (err) {
        if (err.message === "TOKEN_EXPIRED") {
          // Attempt auto-reauth if Gmail App Password exists
          if (user.gmail_app_password && user.edenred_password) {
            console.log(`   🔄 Token expirado para ${user.edenred_email} — a renovar via Gmail 2FA...`);
            const { token: directToken, challengeId } = await edenredLogin(user.edenred_email, user.edenred_password);
            if (directToken) {
              token = directToken;
            } else {
              const code = await fetchEmail2FACode(user.edenred_email, user.gmail_app_password);
              token = await edenredSubmitChallenge(user.edenred_email, user.edenred_password, challengeId, code);
            }
            result = await edenredGetTransactions(token, user.edenred_card_id);
          } else {
            // Notify user in DM that session expired
            const discordUser = await client.users.fetch(user.discord_user_id).catch(() => null);
            if (discordUser) {
              await discordUser.send("⚠️ **A tua sessão MyEdenred expirou!** Por favor usa o comando `/login` no servidor para renovares o acesso e continuares a receber notificações.").catch(() => {});
            }
            continue;
          }
        } else {
          throw err;
        }
      }

      const { balance, transactions } = result;
      let seenTx = [];
      try {
        seenTx = JSON.parse(user.seen_transactions || "[]");
      } catch {
        seenTx = [];
      }

      const newTxList = [];
      for (const t of transactions) {
        const id = getTxId(t);
        if (!seenTx.includes(id)) {
          newTxList.push(t);
          seenTx.push(id);
        }
      }

      // If new transactions found, send DMs!
      if (newTxList.length > 0) {
        console.log(`   🔔 Encontrados ${newTxList.length} novos movimentos para ${user.edenred_email}!`);
        const discordUser = await client.users.fetch(user.discord_user_id).catch(() => null);

        if (discordUser) {
          for (const t of newTxList) {
            const isDeposit = t.amount >= 0;
            const absAmount = Math.abs(t.amount).toFixed(2);
            const sign = isDeposit ? "+" : "-";
            const date = t.transactionDate ? t.transactionDate.split(".")[0].replace("T", " ") : "Agora";

            const embed = new EmbedBuilder()
              .setTitle(isDeposit ? "💰 Edenred — Entrada de Saldo" : "💳 Edenred — Novo Movimento")
              .setColor(isDeposit ? 0x2ecc71 : 0xe74c3c)
              .addFields(
                { name: "🏬 Entidade / Comerciante", value: t.transactionName || "Edenred", inline: false },
                { name: isDeposit ? "💵 Valor Creditado" : "💸 Valor Gasto", value: `**${sign}${absAmount} €**`, inline: true },
                { name: "📊 Saldo Atual", value: `**${balance.toFixed(2)} €**`, inline: true },
                { name: "📅 Data", value: date, inline: true }
              )
              .setFooter({ text: `Cartão •••• ${user.edenred_card_last4}` })
              .setTimestamp();

            await discordUser.send({ embeds: [embed] }).catch((err) => {
              console.error(`   ⚠️ Não foi possível enviar DM para ${user.discord_user_id}: ${err.message}`);
            });
          }
        }
      }

      // Update user state in database
      stmtUpdateTokenAndBalance.run(token, balance, JSON.stringify(seenTx), Date.now(), user.discord_user_id);
    } catch (err) {
      console.error(`   ⚠️ Erro ao verificar utilizador ${user.edenred_email}: ${err.message}`);
    }
  }
}

// ============================================================================
// Bot Startup
// ============================================================================

client.on("guildCreate", (guild) => {
  console.log(`🎉 Bot adicionado ao servidor: ${guild.name} (ID: ${guild.id})!`);
});

client.once("ready", async () => {
  console.log(`🤖 Bot ligado como ${client.user.tag}!`);
  console.log(`🏰 Servidores atuais (${client.guilds.cache.size}):`, client.guilds.cache.map((g) => g.name).join(", ") || "Nenhum ainda");
  await registerSlashCommands();

  // Start background polling loop
  console.log(`⏰ Polling agendado para cada ${POLL_INTERVAL_MS / 60000} minutos.`);
  setInterval(pollAllUsers, POLL_INTERVAL_MS);

  // Run initial check on start
  pollAllUsers();
});

client.login(DISCORD_BOT_TOKEN);
