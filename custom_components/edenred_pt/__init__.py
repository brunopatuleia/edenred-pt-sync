"""The Edenred PT integration."""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import EdenredApiClient
from .const import CONF_TOKEN, DOMAIN
from .coordinator import EdenredDataUpdateCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[str] = ["sensor"]

type EdenredConfigEntry = ConfigEntry[EdenredDataUpdateCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: EdenredConfigEntry) -> bool:
    """Set up Edenred PT from a config entry."""
    # Use the default session — SSL verification is ENABLED
    session = async_get_clientsession(hass)
    api_client = EdenredApiClient(session)

    # Restore the JWT token from the config entry
    stored_token = entry.data.get(CONF_TOKEN)
    if stored_token:
        api_client.token = stored_token

    coordinator = EdenredDataUpdateCoordinator(hass, api_client, entry)

    # Perform the first refresh; raises ConfigEntryNotReady on failure,
    # or ConfigEntryAuthFailed if the token is expired (triggers re-auth)
    await coordinator.async_config_entry_first_refresh()

    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EdenredConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
