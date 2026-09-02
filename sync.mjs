/**
 * ============================================================================
 * Edenred Portugal → Actual Budget Sync & Discord Notification Engine
 * ============================================================================
 *
 * Automated bridge connecting the MyEdenred Portugal API (v2) with:
 *   1. Actual Budget (via @actual-app/api)
 *   2. Discord Webhooks (rich embed notifications)
 *   3. Gmail IMAP (100% zero-touch automated 2FA code extraction)
 *
 * @author Bruno Patuleia (Architect & Project Lead)
 * @author Claude Opus & Gemini 3.7 Flash via Google Antigravity (AI Development)
 * @license MIT
 * ============================================================================
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import api from "@actual-app/api";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// ============================================================================
// Configuration & Constants
// ============================================================================

const CONFIG_FILE = ".env";
const TOKEN_CACHE_FILE = ".token_cache";
const SEEN_TX_FILE = ".seen_transactions.json";

// Edenred Portugal API v2 Endpoints
const EDENRED_BASE = "https://www.myedenred.pt/edenred-customer/v2";
const EDENRED_PARAMS = "appVersion=1.0&appType=PORTAL&channel=WEB";

/**
 * Loads environment variables from local .env file and merges with process.env.
 * @returns {Record<string, string>}
 */
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

/**
 * CLI prompt helper for manual / interactive 2FA input fallback.
 * @param {string} question
 * @returns {Promise<string>}
 */
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// Seen Transactions Cache
// ============================================================================

/**
 * Loads the list of transaction IDs that have already been notified.
 * @returns {string[] | null} null if running for the first time
 */
function loadSeenTransactions() {
  if (existsSync(SEEN_TX_FILE)) {
    try {
      return JSON.parse(readFileSync(SEEN_TX_FILE, "utf-8"));
    } catch {
      return [];
    }
  }
  return null;
}

/**
 * Persists the notified transaction IDs to avoid duplicate alerts.
 * @param {string[]} seenIds
 */
function saveSeenTransactions(seenIds) {
  writeFileSync(SEEN_TX_FILE, JSON.stringify(seenIds, null, 2), "utf-8");
}

/**
 * Generates a unique deterministic ID for an Edenred transaction.
 * @param {object} t
 * @returns {string}
 */
function getTxId(t) {
  return `edenred-${t.transactionDate}-${t.transactionName}-${t.amount}`;
}

// ============================================================================
// Automated 2FA Email Fetcher (Gmail IMAP)
// ============================================================================

/**
 * Connects to Gmail via IMAP and retrieves the 5-digit 2FA code sent by Edenred.
 * Polls for incoming emails up to maxWaitSeconds.
 *
 * @param {string} email - Gmail address
 * @param {string} appPassword - 16-character Google App Password
 * @param {number} maxWaitSeconds - Maximum wait time in seconds (default 45s)
 * @returns {Promise<string>} 5-digit verification code
 */
async function fetchEmail2FACode(email, appPassword, maxWaitSeconds = 45) {
  console.log("📬 Waiting for Edenred 2FA email in Gmail...");
  const startTime = Date.now();

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: email,
      pass: appPassword.replace(/\s+/g, ""),
    },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  try {
    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      // Search for emails from Edenred's notification sender
      const uids = await client.search({ from: "appmyedenred.pt" }, { uid: true });
      if (uids && uids.length > 0) {
        const latestUid = uids[uids.length - 1];
        const msg = await client.fetchOne(latestUid, { envelope: true, source: true }, { uid: true });
        const emailTime = new Date(msg.envelope.date).getTime();

        // Check if the email was received around the time of login initiation
        if (emailTime >= startTime - 30000) {
          const parsed = await simpleParser(msg.source);
          const body = parsed.html || parsed.text || "";
          // Extract 5-digit code formatted inside <b> tags or text
          const match = body.match(/<b>\s*(\d{5})\s*<\/b>/i) || body.match(/\b\d{5}\b/);
          if (match) {
            const code = match[1] || match[0];
            console.log(`✅ Automatically retrieved 2FA code from email: ${code}`);
            return code;
          }
        }
      }
      // Wait 3 seconds before next IMAP poll
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("Timed out waiting for Edenred 2FA email from Gmail");
  } finally {
    lock.release();
    await client.logout();
  }
}

// ============================================================================
// Edenred API Client (v2)
// ============================================================================

/**
 * Initiates authentication with the MyEdenred v2 API.
 * Returns either a direct JWT token or a challengeId requiring 2FA.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{token: string|null, challengeId: number|null}>}
 */
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

  throw new Error("Unexpected login response from Edenred API");
}

/**
 * Submits the 2FA verification code to resolve the challenge.
 *
 * @param {string} email
 * @param {string} password
 * @param {number} challengeId
 * @param {string} code
 * @returns {Promise<string>} JWT bearer token
 */
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
    throw new Error(`2FA validation failed: ${body?.internalCode || res.status}`);
  }

  return body.data.token;
}

/**
 * Retrieves the list of cards for the authenticated user.
 * @param {string} token - JWT bearer token
 * @returns {Promise<object[]>}
 */
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

/**
 * Retrieves account balance and transaction movements for a specific card.
 * @param {string} token - JWT bearer token
 * @param {string|number} cardId - Edenred card ID
 * @returns {Promise<{balance: number, transactions: object[]}>}
 */
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
  if (!res.ok) throw new Error(`Failed to fetch account movements: ${res.status}`);

  const body = await res.json();
  return {
    balance: body?.data?.account?.availableBalance || 0,
    transactions: body?.data?.movementList || [],
  };
}

// ============================================================================
// Token Storage & Authentication Flow
// ============================================================================

function loadCachedToken() {
  if (existsSync(TOKEN_CACHE_FILE)) {
    return readFileSync(TOKEN_CACHE_FILE, "utf-8").trim();
  }
  return null;
}

function saveCachedToken(token) {
  writeFileSync(TOKEN_CACHE_FILE, token, "utf-8");
}

/**
 * Handles full authentication: attempts login, retrieves 2FA code via Gmail IMAP
 * (or fallback prompt), and caches the resulting JWT token.
 *
 * @param {string} email
 * @param {string} password
 * @param {Record<string, string>} env
 * @returns {Promise<string>}
 */
async function authenticate(email, password, env) {
  console.log("🔐 Logging in to Edenred...");
  const { token, challengeId } = await edenredLogin(email, password);

  if (token) {
    console.log("✅ Authenticated (no 2FA required)");
    saveCachedToken(token);
    return token;
  }

  let code = "";
  if (env.GMAIL_APP_PASSWORD) {
    code = await fetchEmail2FACode(email, env.GMAIL_APP_PASSWORD);
  } else {
    console.log("📱 2FA code sent to your email");
    code = await prompt("Enter the verification code: ");
  }

  const jwt = await edenredSubmitChallenge(email, password, challengeId, code);
  console.log("✅ Authenticated successfully");
  saveCachedToken(jwt);
  return jwt;
}

// ============================================================================
// Discord Webhook Notifications
// ============================================================================

/**
 * Sends a rich Discord embed for an Edenred transaction movement.
 *
 * @param {string} webhookUrl - Discord webhook URL
 * @param {object} transaction - Edenred transaction object
 * @param {number} balance - Current available balance
 * @param {object} card - Edenred card object
 */
async function sendDiscordNotification(webhookUrl, transaction, balance, card) {
  const isDeposit = transaction.amount >= 0;
  const absAmount = Math.abs(transaction.amount).toFixed(2);
  const sign = isDeposit ? "+" : "-";
  const color = isDeposit ? 0x2ecc71 : 0xe74c3c; // Green (Deposit) vs Red (Purchase)
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

// ============================================================================
// Actual Budget Synchronization
// ============================================================================

/**
 * Imports transactions into Actual Budget using @actual-app/api.
 * Automatically marks transactions as uncleared (cleared: false) for manual review.
 *
 * @param {Record<string, string>} env
 * @param {object[]} transactions - List of Edenred movements
 * @param {number} balance - Current card balance
 */
async function syncToActualBudget(env, transactions, balance) {
  const serverUrl = env.ACTUAL_SERVER_URL;
  const serverPassword = env.ACTUAL_PASSWORD;
  const syncId = env.ACTUAL_SYNC_ID;
  const accountName = env.ACTUAL_ACCOUNT_NAME || "Edenred";

  if (!serverUrl || !serverPassword || !syncId) {
    console.log("⚠️  Actual Budget not configured — skipping budget sync");
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

  // Convert to Actual Budget transaction format
  const abTransactions = transactions.map((t) => {
    const date = parseEdenredDate(t.transactionDate);
    const amountCents = Math.round((t.amount || 0) * 100);
    return {
      date,
      account: account.id,
      amount: amountCents,
      payee_name: t.transactionName || "Edenred",
      imported_id: getTxId(t),
      cleared: false, // Imported as unchecked / uncleared
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

/**
 * Normalizes Edenred date strings into ISO "YYYY-MM-DD" format.
 * @param {string} dateStr
 * @returns {string}
 */
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

// ============================================================================
// Main Execution Loop
// ============================================================================

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

  // Test if cached token is still valid
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

  // Authenticate if no valid token
  if (!token) {
    token = await authenticate(email, password, env);
  }

  // Retrieve user cards & movements
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

    // Detect new movements that haven't been alerted on Discord
    const newTxList = [];
    for (const t of transactions) {
      const id = getTxId(t);
      if (!seenTx.includes(id)) {
        newTxList.push(t);
        seenTx.push(id);
      }
    }

    // Discord Notifications
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

    // Actual Budget Import
    await syncToActualBudget(env, transactions, balance);
  }

  saveSeenTransactions(seenTx);
  console.log("\n✅ Done!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
