# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-09-02

### Added
- **MyEdenred Portugal API v2 Client**:
  - Full support for the modern v2 authentication endpoints (`/v2/authenticate/default` & `/v2/authenticate/default/challenge`).
  - Automatic JWT bearer token caching and lifecycle management.
  - Safe extraction of card balances and account movements.
- **Actual Budget Integration**:
  - Direct budget synchronization using the latest `@actual-app/api`.
  - Automatic account discovery and creation.
  - Deterministic transaction deduplication using custom `imported_id`.
  - Configured transactions to arrive **uncleared / unchecked** (`cleared: false`) for review and categorization.
- **Discord Webhook Alerts**:
  - Instant rich embeds for every new movement.
  - 🟢 **Green status** for balance credits / deposits (*Subsídio de Refeição*).
  - 🔴 **Red status** for store purchases with merchant names and timestamps.
  - Tracking of notified transaction IDs via `.seen_transactions.json` to prevent duplicates.
- **Automated 2FA Email Solver**:
  - Zero-touch 2FA verification using Gmail IMAP (`imapflow` + `mailparser`).
  - Automatic polling, extraction of 5-digit security codes from incoming Edenred emails, and challenge resolution.
- **Scheduling**:
  - Optimized cron scheduling for 2-hour synchronization intervals.
- **Documentation & Structure**:
  - Comprehensive JSDoc annotations throughout `sync.mjs`.
  - Full README with setup guide, architecture diagrams, and Maestro/AI credits.
