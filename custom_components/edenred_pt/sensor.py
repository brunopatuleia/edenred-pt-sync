"""Sensor platform for the Edenred PT integration."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import EdenredConfigEntry
from .const import ATTRIBUTION, CURRENCY, DEFAULT_ICON, DOMAIN
from .coordinator import EdenredCoordinatorData, EdenredDataUpdateCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: EdenredConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Edenred PT sensors from a config entry."""
    coordinator = config_entry.runtime_data

    # Create a sensor for each card discovered during the first refresh
    sensors: list[EdenredCardSensor] = []
    if coordinator.data and coordinator.data.cards:
        for card_id in coordinator.data.cards:
            sensors.append(EdenredCardSensor(coordinator, card_id))

    async_add_entities(sensors)


class EdenredCardSensor(
    CoordinatorEntity[EdenredDataUpdateCoordinator], SensorEntity
):
    """Sensor representing an Edenred card balance."""

    _attr_has_entity_name = True
    _attr_device_class = SensorDeviceClass.MONETARY
    _attr_state_class = SensorStateClass.TOTAL
    _attr_native_unit_of_measurement = CURRENCY
    _attr_icon = DEFAULT_ICON
    _attr_attribution = ATTRIBUTION

    def __init__(
        self,
        coordinator: EdenredDataUpdateCoordinator,
        card_id: str,
    ) -> None:
        """Initialise the sensor."""
        super().__init__(coordinator)
        self._card_id = card_id

        card_state = coordinator.data.cards.get(card_id)
        card_number = card_state.card.number if card_state else card_id

        self._attr_unique_id = f"{DOMAIN}_{card_id}".lower()
        self._attr_name = f"Edenred Card {card_number}"

    @property
    def available(self) -> bool:
        """Return True if the coordinator has data and this card has an account."""
        if not super().available:
            return False
        card_state = self._get_card_state()
        return card_state is not None and card_state.account is not None

    @property
    def native_value(self) -> float | None:
        """Return the card balance."""
        card_state = self._get_card_state()
        if card_state and card_state.account:
            return card_state.account.available_balance
        return None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return additional state attributes."""
        card_state = self._get_card_state()
        if not card_state:
            return {}

        attrs: dict[str, Any] = {
            "owner_name": card_state.card.owner_name,
            "card_status": card_state.card.status,
            "card_number": card_state.card.number,
        }

        if card_state.account and card_state.account.transactions:
            attrs["transactions"] = [
                {
                    "date": t.date,
                    "name": t.name,
                    "amount": t.amount,
                }
                for t in card_state.account.transactions
            ]

        return attrs

    def _get_card_state(self):
        """Safely retrieve the current card state from coordinator data."""
        if self.coordinator.data and self.coordinator.data.cards:
            return self.coordinator.data.cards.get(self._card_id)
        return None

