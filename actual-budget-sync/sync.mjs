/**
 * Edenred → Actual Budget Sync
 *
 * Fetches transactions from the MyEdenred Portugal API and imports them
 * into Actual Budget. Requires a one-time 2FA setup.
 *
 * Usage:
 *   node sync.mjs --setup     # First-time setup (prompts for credentials + 2FA)
 *   node sync.mjs             # Sync transactions (uses cached token)
 *
 * Environment variables (or .env file):
 *   ACTUAL_SERVER_URL    - Actual Budget server URL (e.g. http://localhost:5006)
 *   ACTUAL_PASSWORD      - Actual Budget password
 *   ACTUAL_SYNC_ID       - Actual Budget sync ID (budget ID)
 *   ACTUAL_ACCOUNT_NAME  - Actual Budget account name to sync to (e.g. "Edenred")
 *   EDENRED_EMAIL        - MyEdenred email
 *   EDENRED_PASSWORD     - MyEdenred password
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import api from "@actual-app/api";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_FILE = ".env";
const TOKEN_CACHE_FILE = ".token_cache";

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
  // Process env vars override .env file
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

  // Direct token (no 2FA)
  if (body?.data?.token) return { token: body.data.token, challengeId: null };

  // 2FA required
  if (body?.data?.challengeId) {
    return { token: null, challengeId: body.data.challengeId };
  }

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
// Token cache
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
// Edenred auth flow (interactive)
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
// Actual Budget
// ---------------------------------------------------------------------------

async function syncToActualBudget(env, transactions, balance) {
  const serverUrl = env.ACTUAL_SERVER_URL;
  const serverPassword = env.ACTUAL_PASSWORD;
  const syncId = env.ACTUAL_SYNC_ID;
  const accountName = env.ACTUAL_ACCOUNT_NAME || "Edenred";

  if (!serverUrl || !serverPassword || !syncId) {
    console.log("⚠️  Actual Budget not configured — skipping sync");
    console.log("   Set ACTUAL_SERVER_URL, ACTUAL_PASSWORD, and ACTUAL_SYNC_ID");
    return;
  }

  console.log(`\n💰 Syncing to Actual Budget (${serverUrl})...`);

  await api.init({
    dataDir: "./data",
    serverURL: serverUrl,
    password: serverPassword,
  });
  await api.downloadBudget(syncId);

  // Find or create the account
  const accounts = await api.getAccounts();
  let account = accounts.find(
    (a) => a.name.toLowerCase() === accountName.toLowerCase()
  );

  if (!account) {
    console.log(`   Creating account "${accountName}"...`);
    const id = await api.createAccount({ name: accountName, type: "checking" }, 0);
    account = { id, name: accountName };
  }

  // Convert Edenred transactions to Actual Budget format
  const abTransactions = transactions.map((t) => {
    const date = parseEdenredDate(t.transactionDate);
    const amountCents = Math.round((t.amount || 0) * 100);
    return {
      date,
      account: account.id,
      amount: amountCents,
      payee_name: t.transactionName || "Edenred",
      imported_id: `edenred-${t.transactionDate}-${t.transactionName}-${t.amount}`,
      cleared: true,
    };
  });

  if (abTransactions.length > 0) {
    const result = await api.importTransactions(account.id, abTransactions);
    console.log(
      `   ✅ Imported: ${result.added?.length || 0} new, ${result.updated?.length || 0} updated`
    );
  } else {
    console.log("   No transactions to import");
  }

  await api.shutdown();
}

function parseEdenredDate(dateStr) {
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  // ISO format: "2026-08-31T13:09:47..."
  if (dateStr.includes("T") || dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
    return dateStr.slice(0, 10);
  }
  // Slash format: "MM/DD/YYYY HH:MM:SS"
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

  const email = env.EDENRED_EMAIL;
  const password = env.EDENRED_PASSWORD;

  if (!email || !password) {
    console.error("❌ Set EDENRED_EMAIL and EDENRED_PASSWORD in .env file");
    process.exit(1);
  }

  // Authenticate
  let token = isSetup ? null : loadCachedToken();

  if (token) {
    // Verify cached token still works
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

  // Fetch data
  console.log("\n📋 Fetching Edenred data...");
  const cards = await edenredGetCards(token);
  console.log(`   Found ${cards.length} card(s)`);

  for (const card of cards) {
    console.log(`\n💳 Card: ${card.number} (${card.ownerName})`);
    const { balance, transactions } = await edenredGetTransactions(
      token,
      card.id
    );
    console.log(`   Balance: €${balance}`);
    console.log(`   Transactions: ${transactions.length}`);

    // Show recent transactions
    for (const t of transactions.slice(0, 5)) {
      const sign = t.amount >= 0 ? "+" : "";
      console.log(
        `   ${t.transactionDate?.split(" ")[0]} | ${t.transactionName} | ${sign}${t.amount}€`
      );
    }
    if (transactions.length > 5) {
      console.log(`   ... and ${transactions.length - 5} more`);
    }

    // Sync to Actual Budget
    await syncToActualBudget(env, transactions, balance);
  }

  console.log("\n✅ Done!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
