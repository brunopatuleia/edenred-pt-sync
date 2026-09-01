# Edenred Portugal — Home Assistant Integration

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/integration)
![License](https://img.shields.io/github/license/YOUR_USERNAME/ha-edenred-pt?style=for-the-badge)

Custom component for [Home Assistant](https://www.home-assistant.io/) that displays your **MyEdenred Portugal** meal card balance and transaction history.

> **Note**: This project is not affiliated with or endorsed by [Edenred](https://www.edenred.pt/).

## Features

- 💳 Card balance as a sensor entity
- 📊 Transaction history as sensor attributes
- 🔐 Two-factor authentication (SMS) support
- 🔄 Automatic polling every 60 minutes
- 🔁 Re-authentication notification when session expires

## Installation

### HACS (Recommended)

1. Open HACS in your Home Assistant instance
2. Click the three dots in the top right → **Custom repositories**
3. Add this repository URL and select **Integration** as the category
4. Search for **"Edenred Portugal"** and install it
5. Restart Home Assistant

### Manual

1. Copy the `custom_components/edenred_pt/` folder to your Home Assistant's `custom_components/` directory
2. Restart Home Assistant

## Configuration

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **"Edenred Portugal"**
3. Enter your MyEdenred email and password
4. Enter the SMS verification code sent to your phone
5. Done! Your card balance will appear as a sensor

### Options

| Option | Default | Description |
|--------|---------|-------------|
| Email | — | Your MyEdenred Portugal login email |
| Password | — | Your MyEdenred Portugal password |
| Include transactions | `false` | Store recent transactions as sensor attributes |

## Sensor

The integration creates one sensor per card:

- **State**: Current available balance (€)
- **Device class**: `monetary`
- **Unit**: `€`

### Attributes

| Attribute | Description |
|-----------|-------------|
| `owner_name` | Card holder name |
| `card_status` | Card status (ACTIVE, etc.) |
| `card_number` | Full card number |
| `transactions` | List of recent transactions (if enabled) |

Each transaction in the list contains:

| Field | Description |
|-------|-------------|
| `date` | Transaction date and time |
| `name` | Merchant / description |
| `amount` | Amount (positive = credit, negative = purchase) |

## Displaying Transactions

### Using a custom:list-card

```yaml
type: custom:list-card
entity: sensor.edenred_card_XXXXXXX
feed_attribute: transactions
title: Edenred Transactions
row_limit: 10
columns:
  - title: Data
    field: date
  - title: Descrição
    field: name
  - title: Valor
    field: amount
    postfix: ' €'
    style:
      - text-align: right
      - white-space: nowrap
```

### Using Markdown card

```yaml
type: markdown
title: Últimos Movimentos
content: >
  | Data | Descrição | Valor |
  |------|-----------|-------|
  {% for t in state_attr('sensor.edenred_card_XXXXXXX', 'transactions') %}
  | {{ t.date[:10] }} | {{ t.name }} | {{ t.amount }} € |
  {% endfor %}
```

## Two-Factor Authentication

This integration supports Edenred's mandatory SMS-based 2FA:

1. **During setup**: After entering your credentials, you'll receive an SMS code
2. **Token persistence**: The authentication token is stored and reused across HA restarts
3. **Re-authentication**: If the token expires, HA will show a notification asking you to re-authenticate

## Actual Budget Sync

This repository includes a standalone Node.js script to sync Edenred transactions to [Actual Budget](https://actualbudget.org/). See the [`actual-budget-sync/`](actual-budget-sync/) directory for details.

## Troubleshooting

### "Cannot connect" error
- Check that https://www.myedenred.pt/ is accessible
- Edenred's servers are known to have issues at the beginning of each month

### "Invalid code" error
- SMS codes expire quickly — enter the code promptly after receiving it
- Request a new code by going back and re-entering your credentials

### Sensor shows "unavailable"
- The authentication token may have expired
- Check for a re-authentication notification in HA

## Legal Notice

This is a personal project and is not in any way affiliated with, sponsored, or endorsed by [Edenred](https://www.edenred.pt/) or [MyEdenred Portugal](https://www.myedenred.pt/).

All product names, trademarks, and registered trademarks are property of their respective owners.

## License

[MIT](LICENSE)
