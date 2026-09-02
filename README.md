# 💳 Edenred Portugal Sync & Alerts

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Actual Budget](https://img.shields.io/badge/Actual%20Budget-API%20v26-5c3dbb.svg)](https://actualbudget.org/)
[![Discord](https://img.shields.io/badge/Discord-Webhook%20Alerts-5865F2.svg)](https://discord.com/)

An automated bridge for **MyEdenred Portugal** that connects your meal card movements directly to **Actual Budget** and sends instant **Discord notifications** whenever money enters or leaves your account — with **100% zero-touch automated 2FA**.

---

## 🌟 Credits & Disclaimer

> **Author**: [Bruno Patuleia](https://github.com/brunopatuleia)  
> **Development**: Built with AI assistance via *Google Antigravity* (Claude Opus & Gemini 3.7 Flash).

*Note: This project is an independent open-source tool and is not affiliated with, sponsored, or endorsed by [Edenred](https://www.edenred.pt/) or [MyEdenred Portugal](https://www.myedenred.pt/).*

---

## ✨ Features

- 💰 **Actual Budget Sync**: Automatically imports card transactions and balance via `@actual-app/api` with automatic deduplication. Transactions arrive **uncleared / unchecked** so you can review and categorize them.
- 🔔 **Instant Discord Alerts**:
  - 🟢 **Deposits / Subsídio de Refeição**: Rich green embed with amount credited and updated balance.
  - 🔴 **Purchases**: Rich red embed with merchant name, amount spent, and updated balance.
- 🤖 **100% Zero-Touch 2FA**: Connects to Gmail via IMAP using a Google App Password to automatically extract the 5-digit verification code. No manual SMS/email entry ever needed.
- ⏰ **Set & Forget Automation**: Runs seamlessly via `cron` or `systemd` on any server or LXC container.

---

## 🏗️ Architecture

```
                       ┌──────────────────────┐
                       │  MyEdenred PT (v2)   │
                       └──────────┬───────────┘
                                  │
                  Session Expired?│ (Requests 2FA)
                                  ▼
┌──────────────────┐    IMAP ┌─────────┐
│     sync.mjs     │ ◄───────┤  Gmail  │ (Reads 5-digit code)
└────────┬─────────┘         └─────────┘
         │
         ├───► 💰 Actual Budget Server (Imports new movements, uncleared)
         │
         └───► 🔔 Discord Webhook (Sends Green/Red rich embeds)
```

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js** v18 or later (Node 20+ recommended)
- **npm** v10+

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/brunopatuleia/edenred-pt-sync.git
npm install
```

### 3. Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# ==========================================
# MyEdenred Portugal Credentials
# ==========================================
EDENRED_EMAIL=your-email@gmail.com
EDENRED_PASSWORD=your-edenred-password

# ==========================================
# Automated 2FA via Gmail (100% Zero-Touch)
# ==========================================
# Generate at: https://myaccount.google.com/apppasswords
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx

# ==========================================
# Actual Budget (Optional)
# ==========================================
ACTUAL_SERVER_URL=http://localhost:5006
ACTUAL_PASSWORD=your-actual-budget-password
ACTUAL_SYNC_ID=your-budget-sync-id
ACTUAL_ACCOUNT_NAME=Edenred

# ==========================================
# Discord Notifications (Optional)
# ==========================================
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

> **Finding your Actual Budget Sync ID**:  
> In Actual Budget, go to **Settings → Show advanced settings → Sync ID**.

---

## 🧪 Testing

### Test live sync:
```bash
node sync.mjs
```

### Test Discord webhook notification:
```bash
node sync.mjs --test-discord
```

---

## ⏰ Automated Scheduling (Cron)

To run the sync automatically every 2 hours:

```bash
crontab -e
```

Add the following line:

```bash
0 */2 * * * cd /path/to/edenred-pt-sync && /usr/bin/node sync.mjs >> /var/log/edenred-sync.log 2>&1
```

---

## 📁 Project Structure

```
.
├── .env.example          # Template configuration
├── .gitignore            # Git ignore rules (protects credentials & cache)
├── CHANGELOG.md          # Release history
├── LICENSE               # MIT License
├── README.md             # Project documentation
├── package.json          # Node dependencies (@actual-app/api, imapflow, mailparser)
└── sync.mjs              # Main synchronization & notification engine
```

---

## 🔒 Security & Privacy

- **Zero credential leaks**: All passwords, tokens, and webhooks are strictly kept in your local `.env` and `.token_cache` (both gitignored).
- **Google App Passwords**: Uses scoped Google App Passwords for IMAP access instead of primary Google account credentials.
- **Direct local connection**: Actual Budget communication can be run entirely over local loopback (`http://localhost:5006`).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
