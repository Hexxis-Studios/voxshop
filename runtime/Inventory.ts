import type { CraftingRecipe, ItemDefinition } from '../services/projectDocument';

export type InventoryStack = { itemId: string; quantity: number };
export type InventoryChange = {
  remove?: readonly { itemId: string; quantity: number }[];
  add?: readonly { itemId: string; quantity: number }[];
};
export type InventoryChangeResult =
  | { status: 'changed'; inventory: InventoryStack[] }
  | { status: 'missing-items' | 'inventory-full' | 'missing-item' | 'invalid'; inventory: InventoryStack[] };
export type CraftResult =
  | { status: 'crafted'; inventory: InventoryStack[] }
  | { status: 'missing-items' | 'inventory-full' | 'missing-item'; inventory: InventoryStack[] };

function copyInventory(inventory: readonly InventoryStack[]) {
  return Array.isArray(inventory)
    ? inventory.map((stack) =>
        stack && typeof stack === 'object' ? { ...stack } : { itemId: '', quantity: 0 },
      )
    : [];
}

function validInventory(inventory: readonly InventoryStack[]) {
  return (
    Array.isArray(inventory) &&
    inventory.every(
      (stack) =>
        !!stack &&
        typeof stack.itemId === 'string' &&
        stack.itemId.length > 0 &&
        Number.isSafeInteger(stack.quantity) &&
        stack.quantity > 0,
    )
  );
}

function validChanges(
  changes: readonly { itemId: string; quantity: number }[],
  maxQuantity: number,
  uniqueIds: boolean,
) {
  const ids = new Set<string>();
  return (
    Array.isArray(changes) &&
    changes.length <= 16 &&
    changes.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const { itemId, quantity } = entry;
      if (
        typeof itemId !== 'string' ||
        !itemId ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > maxQuantity ||
        (uniqueIds && ids.has(itemId))
      )
        return false;
      ids.add(itemId);
      return true;
    })
  );
}

export function addInventoryItem(
  inventory: readonly InventoryStack[],
  item: ItemDefinition,
  quantity: number,
  maxSlots: number,
): InventoryStack[] | null {
  if (
    !validInventory(inventory) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !item ||
    typeof item.id !== 'string' ||
    !item.id ||
    !Number.isInteger(item.maxStack) ||
    item.maxStack < 1 ||
    item.maxStack > 999 ||
    !Number.isInteger(maxSlots) ||
    maxSlots < 1 ||
    maxSlots > 128 ||
    inventory.length > maxSlots ||
    inventory.some((stack) => stack.itemId === item.id && stack.quantity > item.maxStack)
  )
    return null;
  let remaining = quantity;
  const next = copyInventory(inventory);
  for (const stack of next) {
    if (stack.itemId !== item.id || stack.quantity >= item.maxStack) continue;
    const added = Math.min(remaining, item.maxStack - stack.quantity);
    stack.quantity += added;
    remaining -= added;
    if (!remaining) return next;
  }
  const requiredSlots = Math.ceil(remaining / item.maxStack);
  if (next.length + requiredSlots > maxSlots) return null;
  while (remaining > 0) {
    const added = Math.min(remaining, item.maxStack);
    next.push({ itemId: item.id, quantity: added });
    remaining -= added;
  }
  return next;
}

export function removeInventoryItem(
  inventory: readonly InventoryStack[],
  itemId: string,
  quantity: number,
): InventoryStack[] | null {
  if (
    !validInventory(inventory) ||
    typeof itemId !== 'string' ||
    !itemId ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  )
    return null;
  if (
    inventory.reduce((total, stack) => total + (stack.itemId === itemId ? stack.quantity : 0), 0) < quantity
  )
    return null;
  let remaining = quantity;
  return inventory.flatMap((stack) => {
    if (stack.itemId !== itemId || !remaining) return [{ ...stack }];
    const removed = Math.min(remaining, stack.quantity);
    remaining -= removed;
    const left = stack.quantity - removed;
    return left ? [{ itemId, quantity: left }] : [];
  });
}

/** Moves one complete stack; item quantities and stack membership stay unchanged. */
export function reorderInventoryStacks(
  inventory: readonly InventoryStack[],
  fromIndex: number,
  toIndex: number,
): InventoryStack[] | null {
  if (
    !validInventory(inventory) ||
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= inventory.length ||
    toIndex >= inventory.length
  )
    return null;
  const next = copyInventory(inventory);
  const [stack] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, stack!);
  return next;
}

/** Stable case-insensitive name sort with item ID as a deterministic tie-breaker. */
export function sortInventoryStacks(
  inventory: readonly InventoryStack[],
  items: ReadonlyMap<string, ItemDefinition>,
): InventoryStack[] | null {
  if (!validInventory(inventory)) return null;
  return copyInventory(inventory).sort((left, right) => {
    const leftName = (items.get(left.itemId)?.name ?? left.itemId).toLowerCase();
    const rightName = (items.get(right.itemId)?.name ?? right.itemId).toLowerCase();
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0;
  });
}

/** Apply removals before additions on a private copy and commit only when every change fits. */
export function changeInventory(
  inventory: readonly InventoryStack[],
  change: InventoryChange,
  items: ReadonlyMap<string, ItemDefinition>,
  maxSlots: number,
): InventoryChangeResult {
  return applyInventoryTransaction(inventory, change, items, maxSlots, 9999, true);
}

function applyInventoryTransaction(
  inventory: readonly InventoryStack[],
  change: InventoryChange,
  items: ReadonlyMap<string, ItemDefinition>,
  maxSlots: number,
  maxQuantity: number,
  uniqueIds: boolean,
): InventoryChangeResult {
  const remove = change?.remove ?? [],
    add = change?.add ?? [],
    unchanged = copyInventory(inventory);
  if (
    !validInventory(inventory) ||
    !Number.isInteger(maxSlots) ||
    maxSlots < 1 ||
    maxSlots > 128 ||
    inventory.length > maxSlots ||
    !validChanges(remove, maxQuantity, uniqueIds) ||
    !validChanges(add, maxQuantity, uniqueIds) ||
    (remove.length === 0 && add.length === 0)
  )
    return { status: 'invalid', inventory: unchanged };

  let next = copyInventory(inventory);
  for (const item of remove) {
    if (!items.has(item.itemId)) return { status: 'missing-item', inventory: unchanged };
    const removed = removeInventoryItem(next, item.itemId, item.quantity);
    if (!removed) return { status: 'missing-items', inventory: unchanged };
    next = removed;
  }
  for (const entry of add) {
    const definition = items.get(entry.itemId);
    if (!definition) return { status: 'missing-item', inventory: unchanged };
    const added = addInventoryItem(next, definition, entry.quantity, maxSlots);
    if (!added) return { status: 'inventory-full', inventory: unchanged };
    next = added;
  }
  return { status: 'changed', inventory: next };
}

export function craftInventory(
  inventory: readonly InventoryStack[],
  recipe: CraftingRecipe,
  items: ReadonlyMap<string, ItemDefinition>,
  batches: number,
  maxSlots: number,
): CraftResult {
  if (!Number.isInteger(batches) || batches < 1 || batches > 99)
    return { status: 'missing-items', inventory: copyInventory(inventory) };
  const result = applyInventoryTransaction(
    inventory,
    {
      remove: recipe.ingredients.map(({ itemId, quantity }) => ({ itemId, quantity: quantity * batches })),
      add: recipe.outputs.map(({ itemId, quantity }) => ({ itemId, quantity: quantity * batches })),
    },
    items,
    maxSlots,
    Number.MAX_SAFE_INTEGER,
    false,
  );
  if (result.status === 'changed') return { status: 'crafted', inventory: result.inventory };
  if (result.status === 'missing-item') return { status: 'missing-item', inventory: result.inventory };
  if (result.status === 'inventory-full') return { status: 'inventory-full', inventory: result.inventory };
  return { status: 'missing-items', inventory: result.inventory };
}
