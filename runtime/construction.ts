import { Box3, Vector3 } from 'three';
import type { Component, ItemDefinition } from '../services/projectDocument';
import { changeInventory, type InventoryStack } from './Inventory';

type Construction = Extract<Component, { type: 'construction' }>;
type ConstructionResult =
  { allowed: true; inventory: InventoryStack[] } | { allowed: false; reason: string; message: string };

/** Prepare a cell's cost/reward without mutating either the world or the player's inventory. */
export function prepareConstruction({
  settings,
  placing,
  cellBounds,
  actorBounds,
  solidBounds,
  inventory,
  items,
  slots,
}: {
  settings: Construction;
  placing: boolean;
  cellBounds: Box3;
  actorBounds: Box3;
  solidBounds: readonly Box3[];
  inventory: readonly InventoryStack[];
  items: ReadonlyMap<string, ItemDefinition>;
  slots: number;
}): ConstructionResult {
  if (!(placing ? settings.place : settings.remove))
    return {
      allowed: false,
      reason: 'disabled',
      message: placing ? 'Building is disabled for this player.' : 'Harvesting is disabled for this player.',
    };
  const origin = actorBounds.getCenter(new Vector3());
  if (cellBounds.distanceToPoint(origin) > settings.range + 1e-7)
    return { allowed: false, reason: 'out-of-reach', message: 'That terrain cell is out of reach.' };
  // Face contact is allowed; positive-volume overlap must not trap an actor or bury a solid prop.
  const interior = cellBounds.clone().expandByScalar(-1e-5);
  if (placing && [actorBounds, ...solidBounds].some((bounds) => interior.intersectsBox(bounds)))
    return {
      allowed: false,
      reason: 'occupied',
      message: 'A terrain cell cannot be built inside the player or a solid object.',
    };
  const remove = placing ? settings.placeCost : [],
    add = placing ? [] : settings.removeYield;
  if (!remove.length && !add.length)
    return { allowed: true, inventory: inventory.map((stack) => ({ ...stack })) };
  const result = changeInventory(inventory, { remove, add }, items, slots);
  if (result.status === 'changed') return { allowed: true, inventory: result.inventory };
  return {
    allowed: false,
    reason: result.status,
    message:
      result.status === 'inventory-full'
        ? 'Inventory full; make room before harvesting this cell.'
        : result.status === 'missing-items'
          ? 'Not enough materials to build this terrain cell.'
          : 'The construction item configuration is unavailable.',
  };
}
