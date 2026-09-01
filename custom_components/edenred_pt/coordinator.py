"""DataUpdateCoordinator for the Edenred PT integration."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import (
    DataUpdateCoordinator,
    UpdateFailed,
)

from .api import (
    AccountData,
    CardData,
    EdenredApiClient,
    EdenredAuthError,
    EdenredConnectionError,
    EdenredApiError,
)
from .const import (
    CONF_INCLUDE_TRANSACTIONS,
    DEFAULT_SCAN_INTERVAL_MINUTES,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


@dataclass
class EdenredCardState:
    """Holds the latest state for a single card."""

    card: CardData
    account: AccountData | None = None


@dataclass
class EdenredCoordinatorData:
    """Data structure returned by the coordinator."""

    cards: dict[str, EdenredCardState] = field(default_factory=dict)


class EdenredDataUpdateCoordinator(DataUpdateCoordinator[EdenredCoordinatorData]):
    """Coordinator that polls the Edenred API for all cards."""

    config_entry: ConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        api_client: EdenredApiClient,
        config_entry: ConfigEntry,
    ) -> None:
        """Initialise the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(minutes=DEFAULT_SCAN_INTERVAL_MINUTES),
            config_entry=config_entry,
        )
        self.api_client = api_client
        self._include_transactions: bool = config_entry.data.get(
            CONF_INCLUDE_TRANSACTIONS, False
        )

    async def _async_update_data(self) -> EdenredCoordinatorData:
        """Fetch data from the Edenred API.

        This is called by the DataUpdateCoordinator at the configured interval.
        """
        try:
            cards = await self.api_client.async_get_cards()
        except EdenredAuthError as err:
            # Token is expired/invalid — trigger re-auth flow in HA
            raise ConfigEntryAuthFailed(
                "Authentication token expired — re-authentication required"
            ) from err
        except EdenredConnectionError as err:
            raise UpdateFailed(f"Connection error: {err}") from err
        except EdenredApiError as err:
            raise UpdateFailed(f"API error: {err}") from err

        result = EdenredCoordinatorData()

        for card in cards:
            state = EdenredCardState(card=card)
            try:
                account = await self.api_client.async_get_account(card.card_id)
                if not self._include_transactions:
                    # Strip transactions to keep state attributes lean
                    account.transactions = []
                state.account = account
            except EdenredAuthError as err:
                raise ConfigEntryAuthFailed(
                    "Authentication token expired — re-authentication required"
                ) from err
            except (EdenredConnectionError, EdenredApiError) as err:
                _LOGGER.warning(
                    "Failed to fetch account for card %s: %s", card.number, err
                )
                # Keep the card in results but with no account data
            result.cards[card.card_id] = state

        return result
