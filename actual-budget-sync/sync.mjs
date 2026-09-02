/**
 * Edenred → Actual Budget Sync + Discord Notifications
 *
 * Fetches transactions from the MyEdenred Portugal API, imports them
 * into Actual Budget, and sends Discord notifications for new movements.
 *
 * Usage:
 *   node sync.mjs --setup          # First-time setup (prompts for credentials + 2FA)
 *   node sync.mjs                  # Normal sync (uses cached token)
 *   node sync.mjs --test-discord   # Test Discord webhook notification
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import api from "@actual-app/api";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_FILE = ".env";
const TOKEN_CACHE_FILE = ".token_cache";
const SEEN_TX_FILE = ".seen_transactions.json";

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

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Seen Transactions Cache
// ---------------------------------------------------------------------------

function loadSeenTransactions() {
  if (existsSync(SEEN_TX_FILE)) {
    try {
      return JSON.parse(readFileSync(SEEN_TX_FILE, "utf-8"));
    } catch {
      return [];
    }
  }
  return null; // null indicates first initialization
}

function saveSeenTransactions(seenIds) {
  writeFileSync(SEEN_TX_FILE, JSON.stringify(seenIds, null, 2), "utf-8");
}

function getTxId(t) {
  return `edenred-${t.transactionDate}-${t.transactionName}-${t.amount}`;
}

// ---------------------------------------------------------------------------
// Edenred API
// ---------------------------------------------------------------------------

const EDENRED_BASE = "https://www.myedenred.pt/edenred-customer/v2";
const EDENRED_PARAMS = "appVersion=1.0&appType=PORTAL&channel=WEB";

async function edenredLogin(email, password) {
  const res = await fetch(
    `${EDENRED_BASE}/authenticate/default?${EDENRED_PARAMS}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: email, password }),
    }
  );
  const body = await res.json();

  if (!res.ok) {
    throw new Error(`Login failed: ${body?.internalCode || res.status}`);
  }

  if (body?.data?.token) return { token: body.data.token, challengeId: null };
  if (body?.data?.challengeId) return { token: null, challengeId: body.data.challengeId };

  throw new Error("Unexpected login response");
}

async function edenredSubmitChallenge(email, password, challengeId, code) {
  const res = await fetch(
    `${EDENRED_BASE}/authenticate/default/challenge?${EDENRED_PARAMS}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: email,
        password,
        authenticationMfaProcessId: challengeId,
        token: code,
      }),
    }
  );
  const body = await res.json();

  if (!res.ok || !body?.data?.token) {
    throw new Error(`2FA failed: ${body?.internalCode || res.status}`);
  }

  return body.data.token;
}

async function edenredGetCards(token) {
  const res = await fetch(
    `${EDENRED_BASE}/protected/card/list?${EDENRED_PARAMS}`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
    }
  );

  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`Failed to fetch cards: ${res.status}`);

  const body = await res.json();
  return body?.data || [];
}

async function edenredGetTransactions(token, cardId) {
  const res = await fetch(
    `${EDENRED_BASE}/protected/card/${cardId}/accountmovement?${EDENRED_PARAMS}`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
    }
  );

  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`Failed to fetch account: ${res.status}`);

  const body = await res.json();
  return {
    balance: body?.data?.account?.availableBalance || 0,
    transactions: body?.data?.movementList || [],
  };
}

// ---------------------------------------------------------------------------
// Token Cache
// ---------------------------------------------------------------------------

function loadCachedToken() {
  if (existsSync(TOKEN_CACHE_FILE)) {
    return readFileSync(TOKEN_CACHE_FILE, "utf-8").trim();
  }
  return null;
}

function saveCachedToken(token) {
  writeFileSync(TOKEN_CACHE_FILE, token, "utf-8");
}

// ---------------------------------------------------------------------------
// Edenred Auth (Interactive)
// ---------------------------------------------------------------------------

async function authenticateInteractive(email, password) {
  console.log("🔐 Logging in to Edenred...");
  const { token, challengeId } = await edenredLogin(email, password);

  if (token) {
    console.log("✅ Authenticated (no 2FA required)");
    saveCachedToken(token);
    return token;
  }

  console.log("📱 2FA code sent to your phone");
  const code = await prompt("Enter the SMS code: ");
  const jwt = await edenredSubmitChallenge(email, password, challengeId, code);
  console.log("✅ Authenticated successfully");
  saveCachedToken(jwt);
  return jwt;
}

// ---------------------------------------------------------------------------
// Discord Notifications
// ---------------------------------------------------------------------------

async function sendDiscordNotification(webhookUrl, transaction, balance, card) {
  const isDeposit = transaction.amount >= 0;
  const absAmount = Math.abs(transaction.amount).toFixed(2);
  const sign = isDeposit ? "+" : "-";
  const color = isDeposit ? 0x2ecc71 : 0xe74c3c; // Green or Red
  const title = isDeposit ? "💰 Edenred — Entrada de Saldo" : "💳 Edenred — Novo Movimento";
  const cardLast4 = card?.number ? card.number.slice(-4) : "Card";

  const dateFormatted = transaction.transactionDate
    ? transaction.transactionDate.split(".")[0].replace("T", " ")
    : "Agora";

  const payload = {
    username: "Edenred PT",
    avatar_url: "https://www.myedenred.pt/images/favicon.png",
    embeds: [
      {
        title,
        color,
        fields: [
          {
            name: "🏬 Entidade / Comerciante",
            value: transaction.transactionName || "Edenred",
            inline: false,
          },
          {
            name: isDeposit ? "💵 Valor Creditado" : "💸 Valor Gasto",
            value: `**${sign}${absAmount} €**`,
            inline: true,
          },
          {
            name: "📊 Saldo Atual",
            value: `**${balance.toFixed(2)} €**`,
            inline: true,
          },
          {
            name: "📅 Data",
            value: dateFormatted,
            inline: true,
          },
        ],
        footer: {
          text: `Cartão •••• ${cardLast4}`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`   ⚠️ Discord webhook failed: HTTP ${res.status}`);
    } else {
      console.log(`   🔔 Sent Discord alert for: ${transaction.transactionName} (${sign}${absAmount}€)`);
    }
  } catch (err) {
    console.error(`   ⚠️ Discord notification error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Actual Budget
// ---------------------------------------------------------------------------

async function syncToActualBudget(env, transactions, balance) {
  const serverUrl = env.ACTUAL_SERVER_URL;
  const serverPassword = env.ACTUAL_PASSWORD;
  const syncId = env.ACTUAL_SYNC_ID;
  const accountName = env.ACTUAL_ACCOUNT_NAME || "Edenred";

  if (!serverUrl || !serverPassword || !syncId) {
    console.log("⚠️  Actual Budget not configured — skipping sync");
    return;
  }

  console.log(`\n💰 Syncing to Actual Budget (${serverUrl})...`);

  await api.init({
    dataDir: "./data",
    serverURL: serverUrl,
    password: serverPassword,
  });
  await api.downloadBudget(syncId);

  const accounts = await api.getAccounts();
  let account = accounts.find(
    (a) => a.name.toLowerCase() === accountName.toLowerCase()
  );

  if (!account) {
    console.log(`   Creating account "${accountName}"...`);
    const id = await api.createAccount({ name: accountName, type: "checking" }, 0);
    account = { id, name: accountName };
  }

  const abTransactions = transactions.map((t) => {
    const date = parseEdenredDate(t.transactionDate);
    const amountCents = Math.round((t.amount || 0) * 100);
    return {
      date,
      account: account.id,
      amount: amountCents,
      payee_name: t.transactionName || "Edenred",
      imported_id: getTxId(t),
      cleared: false,
    };
  });

  if (abTransactions.length > 0) {
    const result = await api.importTransactions(account.id, abTransactions);
    console.log(
      `   ✅ Imported: ${result.added?.length || 0} new, ${result.updated?.length || 0} updated`
    );
  }

  await api.shutdown();
}

function parseEdenredDate(dateStr) {
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  if (dateStr.includes("T") || dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
    return dateStr.slice(0, 10);
  }
  const parts = dateStr.split(" ")[0].split("/");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  }
  return dateStr.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const isSetup = process.argv.includes("--setup");
  const isTestDiscord = process.argv.includes("--test-discord");

  const email = env.EDENRED_EMAIL;
  const password = env.EDENRED_PASSWORD;
  const discordWebhook = env.DISCORD_WEBHOOK_URL;

  if (!email || !password) {
    console.error("❌ Set EDENRED_EMAIL and EDENRED_PASSWORD in .env file");
    process.exit(1);
  }

  let token = isSetup ? null : loadCachedToken();

  if (token) {
    try {
      await edenredGetCards(token);
      console.log("🔑 Using cached token");
    } catch (e) {
      if (e.message === "TOKEN_EXPIRED") {
        console.log("🔑 Cached token expired — re-authenticating...");
        token = null;
      } else {
        throw e;
      }
    }
  }

  if (!token) {
    token = await authenticateInteractive(email, password);
  }

  console.log("\n📋 Fetching Edenred data...");
  const cards = await edenredGetCards(token);
  console.log(`   Found ${cards.length} card(s)`);

  let seenTx = loadSeenTransactions();
  const isFirstRun = seenTx === null;
  if (isFirstRun) seenTx = [];

  for (const card of cards) {
    console.log(`\n💳 Card: ${card.number} (${card.ownerName})`);
    const { balance, transactions } = await edenredGetTransactions(token, card.id);
    console.log(`   Balance: €${balance}`);
    console.log(`   Transactions: ${transactions.length}`);

    // Check for new transactions for Discord notifications
    const newTxList = [];
    for (const t of transactions) {
      const id = getTxId(t);
      if (!seenTx.includes(id)) {
        newTxList.push(t);
        seenTx.push(id);
      }
    }

    // Send notifications
    if (discordWebhook) {
      if (isTestDiscord && transactions.length > 0) {
        console.log("\n🧪 Sending test Discord notification for latest transaction...");
        await sendDiscordNotification(discordWebhook, transactions[0], balance, card);
      } else if (!isFirstRun && newTxList.length > 0) {
        console.log(`\n🔔 Sending ${newTxList.length} Discord notification(s)...`);
        for (const t of newTxList) {
          await sendDiscordNotification(discordWebhook, t, balance, card);
        }
      } else if (isFirstRun) {
        console.log(`   ℹ️ Initialized Discord seen list with ${transactions.length} historical transactions.`);
      }
    }

    // Sync to Actual Budget
    await syncToActualBudget(env, transactions, balance);
  }

  saveSeenTransactions(seenTx);
  console.log("\n✅ Done!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
