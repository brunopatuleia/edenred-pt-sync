"""Config flow for Edenred PT integration (with 2FA)."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import (
    EdenredApiClient,
    EdenredAuthError,
    EdenredConnectionError,
)
from .const import (
    CONF_USERNAME,
    CONF_PASSWORD,
    CONF_INCLUDE_TRANSACTIONS,
    CONF_TOKEN,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_USERNAME): str,
        vol.Required(CONF_PASSWORD): str,
        vol.Optional(CONF_INCLUDE_TRANSACTIONS, default=False): bool,
    }
)

STEP_2FA_SCHEMA = vol.Schema(
    {
        vol.Required("code"): str,
    }
)

STEP_REAUTH_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_USERNAME): str,
        vol.Required(CONF_PASSWORD): str,
    }
)

STEP_REAUTH_2FA_SCHEMA = vol.Schema(
    {
        vol.Required("code"): str,
    }
)


class EdenredPTConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Edenred PT with 2FA."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialise the config flow."""
        super().__init__()
        self._username: str = ""
        self._password: str = ""
        self._include_transactions: bool = False
        self._challenge_id: int = 0
        self._api: EdenredApiClient | None = None

    # ------------------------------------------------------------------
    # Step 1: User enters credentials
    # ------------------------------------------------------------------

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step — user enters credentials."""
        errors: dict[str, str] = {}

        if user_input is not None:
            self._username = user_input[CONF_USERNAME]
            self._password = user_input[CONF_PASSWORD]
            self._include_transactions = user_input.get(
                CONF_INCLUDE_TRANSACTIONS, False
            )

            # Prevent duplicate entries for the same account
            await self.async_set_unique_id(self._username.lower())
            self._abort_if_unique_id_configured()

            session = async_get_clientsession(self.hass)
            self._api = EdenredApiClient(session)

            try:
                challenge_id = await self._api.async_login(
                    self._username, self._password
                )

                if challenge_id == 0:
                    # No 2FA required — token acquired directly
                    return self._create_entry()

                # 2FA required — proceed to code entry
                self._challenge_id = challenge_id
                return await self.async_step_2fa()

            except EdenredAuthError:
                errors["base"] = "invalid_auth"
            except EdenredConnectionError:
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error during login")
                errors["base"] = "unknown"

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_SCHEMA,
            errors=errors,
        )

    # ------------------------------------------------------------------
    # Step 2: User enters 2FA code
    # ------------------------------------------------------------------

    async def async_step_2fa(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the 2FA code entry step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            code = user_input["code"].strip()

            try:
                token = await self._api.async_submit_challenge(
                    self._username,
                    self._password,
                    self._challenge_id,
                    code,
                )
                return self._create_entry(token=token)

            except EdenredAuthError:
                errors["base"] = "invalid_code"
            except EdenredConnectionError:
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error during 2FA")
                errors["base"] = "unknown"

        return self.async_show_form(
            step_id="2fa",
            data_schema=STEP_2FA_SCHEMA,
            errors=errors,
        )

    # ------------------------------------------------------------------
    # Re-authentication flow
    # ------------------------------------------------------------------

    async def async_step_reauth(
        self, entry_data: dict[str, Any]
    ) -> ConfigFlowResult:
        """Handle re-authentication when the token expires."""
        self._username = entry_data.get(CONF_USERNAME, "")
        self._password = entry_data.get(CONF_PASSWORD, "")
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle re-auth — user re-enters credentials."""
        errors: dict[str, str] = {}

        if user_input is not None:
            self._username = user_input[CONF_USERNAME]
            self._password = user_input[CONF_PASSWORD]

            session = async_get_clientsession(self.hass)
            self._api = EdenredApiClient(session)

            try:
                challenge_id = await self._api.async_login(
                    self._username, self._password
                )

                if challenge_id == 0:
                    return self._update_reauth_entry()

                self._challenge_id = challenge_id
                return await self.async_step_reauth_2fa()

            except EdenredAuthError:
                errors["base"] = "invalid_auth"
            except EdenredConnectionError:
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error during re-auth")
                errors["base"] = "unknown"

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=STEP_REAUTH_SCHEMA,
            errors=errors,
        )

    async def async_step_reauth_2fa(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle re-auth 2FA code entry."""
        errors: dict[str, str] = {}

        if user_input is not None:
            code = user_input["code"].strip()

            try:
                await self._api.async_submit_challenge(
                    self._username,
                    self._password,
                    self._challenge_id,
                    code,
                )
                return self._update_reauth_entry()

            except EdenredAuthError:
                errors["base"] = "invalid_code"
            except EdenredConnectionError:
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error during re-auth 2FA")
                errors["base"] = "unknown"

        return self.async_show_form(
            step_id="reauth_2fa",
            data_schema=STEP_REAUTH_2FA_SCHEMA,
            errors=errors,
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _create_entry(self, token: str | None = None) -> ConfigFlowResult:
        """Create the config entry with credentials and token."""
        return self.async_create_entry(
            title=f"Edenred {self._username}",
            data={
                CONF_USERNAME: self._username,
                CONF_PASSWORD: self._password,
                CONF_INCLUDE_TRANSACTIONS: self._include_transactions,
                CONF_TOKEN: token or (self._api.token if self._api else ""),
            },
        )

    def _update_reauth_entry(self) -> ConfigFlowResult:
        """Update the existing config entry after re-authentication."""
        reauth_entry = self._get_reauth_entry()
        new_token = self._api.token if self._api else ""
        return self.async_update_reload_and_abort(
            reauth_entry,
            data={
                **reauth_entry.data,
                CONF_USERNAME: self._username,
                CONF_PASSWORD: self._password,
                CONF_TOKEN: new_token,
            },
        )
