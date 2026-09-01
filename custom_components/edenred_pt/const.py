"""Constants for the Edenred PT integration."""

DOMAIN = "edenred_pt"

# Configuration keys
CONF_USERNAME = "username"
CONF_PASSWORD = "password"
CONF_INCLUDE_TRANSACTIONS = "include_transactions"
CONF_TOKEN = "token"

# API endpoints (v2)
API_BASE_URL = "https://www.myedenred.pt/edenred-customer/v2"
API_LOGIN_ENDPOINT = "/authenticate/default"
API_CHALLENGE_ENDPOINT = "/authenticate/default/challenge"
API_CARDS_ENDPOINT = "/protected/card/list"
API_ACCOUNT_ENDPOINT = "/protected/card/{card_id}/accountmovement"

# API parameters
API_LOGIN_PARAMS = {"appVersion": "1.0", "appType": "PORTAL", "channel": "WEB"}

# Defaults
DEFAULT_SCAN_INTERVAL_MINUTES = 60
DEFAULT_ICON = "mdi:credit-card"
CURRENCY = "€"

ATTRIBUTION = "Data provided by https://www.myedenred.pt/"
