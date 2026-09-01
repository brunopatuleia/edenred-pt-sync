"""Edenred PT API client with 2FA and secure token management."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import aiohttp

from .const import (
    API_BASE_URL,
    API_LOGIN_ENDPOINT,
    API_CHALLENGE_ENDPOINT,
    API_CARDS_ENDPOINT,
    API_ACCOUNT_ENDPOINT,
    API_LOGIN_PARAMS,
)

_LOGGER = logging.getLogger(__name__)


class EdenredAuthError(Exception):
    """Raised when authentication fails (invalid credentials or expired token)."""


class EdenredChallengeRequired(Exception):
    """Raised when 2FA challenge is required.

    Attributes:
        challenge_id: The server-issued challenge ID needed to submit the code.
        message: Human-readable message from the server.
    """

    def __init__(self, challenge_id: int, message: str = "") -> None:
        super().__init__(message or f"2FA challenge required (id={challenge_id})")
        self.challenge_id = challenge_id
        self.message = message


class EdenredApiError(Exception):
    """Raised when an API request fails."""


class EdenredConnectionError(Exception):
    """Raised when a connection to the API fails."""


@dataclass
class CardData:
    """Represents an Edenred card."""

    card_id: str
    number: str
    owner_name: str
    status: str

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> CardData:
        """Create from API response dict with safe access."""
        return cls(
            card_id=str(data.get("id", "")),
            number=data.get("number", ""),
            owner_name=data.get("ownerName", ""),
            status=data.get("status", "unknown"),
        )


@dataclass
class TransactionData:
    """Represents a single transaction."""

    date: str
    name: str
    amount: float

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> TransactionData:
        """Create from API response dict with safe access."""
        try:
            amount = float(data.get("amount", 0))
        except (ValueError, TypeError):
            amount = 0.0
        return cls(
            date=data.get("transactionDate", ""),
            name=data.get("transactionName", ""),
            amount=amount,
        )


@dataclass
class AccountData:
    """Represents an Edenred account with balance and transactions."""

    available_balance: float
    card_number: str
    card_holder_first_name: str
    card_holder_last_name: str
    card_activated: bool
    transactions: list[TransactionData] = field(default_factory=list)

    @classmethod
    def from_api(
        cls, account: dict[str, Any], movements: list[dict[str, Any]]
    ) -> AccountData:
        """Create from API response dicts with safe access."""
        try:
            balance = float(account.get("availableBalance", 0))
        except (ValueError, TypeError):
            balance = 0.0

        return cls(
            available_balance=balance,
            card_number=account.get("cardNumber", ""),
            card_holder_first_name=account.get("cardHolderFirstName", ""),
            card_holder_last_name=account.get("cardHolderLastName", ""),
            card_activated=bool(account.get("cardActivated", False)),
            transactions=[TransactionData.from_api(m) for m in (movements or [])],
        )


class EdenredApiClient:
    """Secure client for the MyEdenred PT API (v2 with 2FA)."""

    def __init__(self, session: aiohttp.ClientSession) -> None:
        """Initialise the API client.

        Args:
            session: An aiohttp session **with SSL verification enabled**.
        """
        self._session = session
        self._token: str | None = None

    # ------------------------------------------------------------------
    # Token management
    # ------------------------------------------------------------------

    @property
    def token(self) -> str | None:
        """Return the current token (may be None)."""
        return self._token

    @token.setter
    def token(self, value: str | None) -> None:
        """Set the token (e.g. restored from config entry)."""
        self._token = value

    def invalidate_token(self) -> None:
        """Force the next request to re-authenticate."""
        self._token = None

    # ------------------------------------------------------------------
    # Authentication — Step 1: Login (triggers 2FA)
    # ------------------------------------------------------------------

    async def async_login(self, username: str, password: str) -> int:
        """Initiate login — sends credentials and triggers a 2FA SMS.

        Returns the challenge_id needed for step 2.
        Raises EdenredAuthError if credentials are wrong.
        Raises EdenredConnectionError on network issues.
        """
        url = f"{API_BASE_URL}{API_LOGIN_ENDPOINT}"
        _LOGGER.debug("Initiating login (step 1 — triggers 2FA)")

        try:
            async with self._session.post(
                url,
                params=API_LOGIN_PARAMS,
                headers={"Content-Type": "application/json"},
                json={"userId": username, "password": password},
            ) as resp:
                if resp.content_type == "application/json":
                    body = await resp.json()
                else:
                    raise EdenredAuthError(
                        f"Login failed with HTTP {resp.status}"
                    )

                if resp.status == 409:
                    # 409 = invalid credentials or server error
                    code = body.get("internalCode", "")
                    raise EdenredAuthError(
                        f"Login rejected (code {code})"
                    )

                if resp.status != 200:
                    raise EdenredAuthError(
                        f"Login failed with HTTP {resp.status}"
                    )

        except aiohttp.ClientError as err:
            raise EdenredConnectionError(
                f"Connection error during login: {err}"
            ) from err

        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict):
            raise EdenredAuthError("Unexpected login response format")

        # If the response contains a token directly (no 2FA), use it
        if data.get("token"):
            self._token = data["token"]
            _LOGGER.debug("Login returned token directly (no 2FA)")
            return 0  # 0 means no challenge needed

        # Otherwise, expect a challengeId for 2FA
        challenge_id = data.get("challengeId")
        if not challenge_id:
            raise EdenredAuthError(
                "Login response contained neither a token nor a challengeId"
            )

        _LOGGER.debug("2FA challenge triggered (id=%s)", challenge_id)
        return int(challenge_id)

    # ------------------------------------------------------------------
    # Authentication — Step 2: Submit 2FA code
    # ------------------------------------------------------------------

    async def async_submit_challenge(
        self,
        username: str,
        password: str,
        challenge_id: int,
        code: str,
    ) -> str:
        """Submit the 2FA code to complete authentication.

        Returns the JWT token on success.
        Raises EdenredAuthError if the code is wrong.
        Raises EdenredConnectionError on network issues.
        """
        url = f"{API_BASE_URL}{API_CHALLENGE_ENDPOINT}"
        _LOGGER.debug("Submitting 2FA code (step 2)")

        payload = {
            "userId": username,
            "password": password,
            "authenticationMfaProcessId": challenge_id,
            "token": code,
        }

        try:
            async with self._session.post(
                url,
                params=API_LOGIN_PARAMS,
                headers={"Content-Type": "application/json"},
                json=payload,
            ) as resp:
                if resp.content_type == "application/json":
                    body = await resp.json()
                else:
                    raise EdenredAuthError(
                        f"Challenge failed with HTTP {resp.status}"
                    )

                if resp.status != 200:
                    code_str = ""
                    if isinstance(body, dict):
                        code_str = body.get("internalCode", "")
                    raise EdenredAuthError(
                        f"Challenge rejected (HTTP {resp.status}, code {code_str})"
                    )

        except aiohttp.ClientError as err:
            raise EdenredConnectionError(
                f"Connection error during challenge: {err}"
            ) from err

        data = body.get("data") if isinstance(body, dict) else None
        token = data.get("token") if isinstance(data, dict) else None
        if not token:
            raise EdenredAuthError("Challenge response did not contain a token")

        self._token = token
        _LOGGER.debug("2FA complete — token acquired")
        return token

    # ------------------------------------------------------------------
    # Card list
    # ------------------------------------------------------------------

    async def async_get_cards(self, *, _retried: bool = False) -> list[CardData]:
        """Fetch all cards for the authenticated user.

        Requires a valid token (set via async_submit_challenge or token setter).
        Raises EdenredAuthError if token is expired/invalid.
        """
        if not self._token:
            raise EdenredAuthError("No token available — authentication required")

        url = f"{API_BASE_URL}{API_CARDS_ENDPOINT}"
        _LOGGER.debug("Fetching card list")

        try:
            async with self._session.get(
                url,
                params=API_LOGIN_PARAMS,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": self._token,
                },
            ) as resp:
                if resp.status == 401 and not _retried:
                    self.invalidate_token()
                    raise EdenredAuthError("Token expired")

                if resp.status != 200 or resp.content_type != "application/json":
                    raise EdenredApiError(
                        f"Failed to fetch cards: HTTP {resp.status}"
                    )
                body = await resp.json()

        except aiohttp.ClientError as err:
            raise EdenredConnectionError(
                f"Connection error fetching cards: {err}"
            ) from err

        raw_cards = body.get("data") if isinstance(body, dict) else None
        if not isinstance(raw_cards, list):
            raise EdenredApiError("Unexpected card list response format")

        return [CardData.from_api(c) for c in raw_cards]

    # ------------------------------------------------------------------
    # Account details
    # ------------------------------------------------------------------

    async def async_get_account(
        self, card_id: str, *, _retried: bool = False
    ) -> AccountData:
        """Fetch account details and movements for a specific card."""
        if not self._token:
            raise EdenredAuthError("No token available — authentication required")

        # Validate card_id to prevent URL injection
        safe_card_id = str(card_id).strip()
        if not safe_card_id or "/" in safe_card_id or ".." in safe_card_id:
            raise EdenredApiError(f"Invalid card ID: {card_id!r}")

        url = f"{API_BASE_URL}{API_ACCOUNT_ENDPOINT}".replace(
            "{card_id}", safe_card_id
        )
        _LOGGER.debug("Fetching account details for card %s", safe_card_id)

        try:
            async with self._session.get(
                url,
                params=API_LOGIN_PARAMS,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": self._token,
                },
            ) as resp:
                if resp.status == 401 and not _retried:
                    self.invalidate_token()
                    raise EdenredAuthError("Token expired")

                if resp.status != 200 or resp.content_type != "application/json":
                    raise EdenredApiError(
                        f"Failed to fetch account: HTTP {resp.status}"
                    )
                body = await resp.json()

        except aiohttp.ClientError as err:
            raise EdenredConnectionError(
                f"Connection error fetching account: {err}"
            ) from err

        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict):
            raise EdenredApiError("Unexpected account response format")

        account_data = data.get("account", {})
        movement_list = data.get("movementList", [])

        if not isinstance(account_data, dict):
            raise EdenredApiError("Unexpected account data format")

        return AccountData.from_api(account_data, movement_list)
