# Edenred → Actual Budget Sync

Standalone Node.js script that syncs your MyEdenred Portugal transactions into [Actual Budget](https://actualbudget.org/).

**No modifications to Actual Budget are needed** — this uses the official [`@actual-app/api`](https://www.npmjs.com/package/@actual-app/api).

## Setup

### 1. Install dependencies

```bash
cd actual-budget-sync
npm install
```

### 2. Create `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Edenred
EDENRED_EMAIL=your-email@example.com
EDENRED_PASSWORD=your-password

# Actual Budget
ACTUAL_SERVER_URL=http://localhost:5006
ACTUAL_PASSWORD=your-actual-password
ACTUAL_SYNC_ID=your-budget-sync-id
ACTUAL_ACCOUNT_NAME=Edenred
```

> **Finding your Sync ID**: In Actual Budget, go to **Settings → Show advanced settings → Sync ID**.

### 3. First run (interactive — requires 2FA)

```bash
npm run setup
```

This will:
1. Log in to Edenred
2. Send an SMS code to your phone
3. Prompt you to enter the code
4. Cache the authentication token for future runs
5. Fetch and display your card data
6. Sync transactions to Actual Budget

### 4. Subsequent runs

```bash
npm run sync
```

Uses the cached token — no 2FA needed unless the token has expired.

## Automation

You can run this on a schedule using cron:

```bash
# Every 2 hours
0 */2 * * * cd /opt/edenred-sync && /usr/bin/node sync.mjs >> /var/log/edenred-sync.log 2>&1
```

> **Note**: If the token expires, the cron job will fail and log an error. Run `npm run setup` manually to re-authenticate with 2FA.

## Transaction Deduplication

Actual Budget's `importTransactions()` automatically deduplicates using the `imported_id` field. Each Edenred transaction gets a unique ID based on its date, name, and amount, so running the sync multiple times is safe.

## Edenred-Only Mode

If you just want to view your Edenred data without syncing to Actual Budget, simply don't configure the `ACTUAL_*` variables. The script will fetch and display your card balance and transactions without attempting to sync.
