import {
  actionSchema,
  COLLISION_OTHER_TARGET,
  type Action,
  type Rule,
  type RuleCondition,
  type RuleConditionGroup,
} from '../services/projectDocument';

export const ruleEvents = [
  'start',
  'interact',
  'touch',
  'untouch',
  'collision',
  'separation',
  'tick',
  'destroyed',
  'attack',
  'animation',
  'ui',
  'signal',
] as const;

export const actionTypes = [
  'set',
  'add',
  'destroy',
  'enable',
  'emit',
  'message',
  'sound',
  'audio',
  'win',
  'lose',
  'damage',
  'heal',
  'teleport',
  'craft',
  'inventory',
  'spawn',
  'transition',
] satisfies Action['type'][];

export function canCreateAction(
  type: Action['type'],
  available: { recipes: number; nodes: number; items: number; prefabs?: number; audioClips?: number },
): boolean {
  return (
    (type !== 'craft' || available.recipes > 0) &&
    (type !== 'enable' || available.nodes > 0) &&
    (type !== 'inventory' || available.items > 0) &&
    (type !== 'spawn' || (available.prefabs ?? 0) > 0) &&
    (type !== 'audio' || (available.audioClips ?? 0) > 0)
  );
}

export type InventoryEntry = Extract<Action, { type: 'inventory' }>['add'][number];

export function addInventoryEntry(entries: InventoryEntry[], itemId: string): InventoryEntry[] {
  if (entries.length >= 16 || entries.some((entry) => entry.itemId === itemId)) return entries;
  return [...entries, { itemId, quantity: 1 }];
}

export function updateInventoryEntry(
  entries: InventoryEntry[],
  index: number,
  patch: Partial<InventoryEntry>,
): InventoryEntry[] {
  if (index < 0 || index >= entries.length) return entries;
  const current = entries[index];
  const next = { ...current, ...patch };
  if (
    (patch.itemId !== undefined &&
      entries.some((entry, i) => i !== index && entry.itemId === patch.itemId)) ||
    !Number.isInteger(next.quantity) ||
    next.quantity < 1 ||
    next.quantity > 9999
  )
    return entries;
  return entries.map((entry, i) => (i === index ? next : entry));
}

export function removeInventoryEntry(entries: InventoryEntry[], index: number): InventoryEntry[] {
  return entries.filter((_, i) => i !== index);
}

export function createRule(): Rule {
  return {
    event: 'interact',
    interval: 1,
    once: false,
    actions: [{ type: 'message', text: 'Hello, creator!' }],
  };
}

export function defaultRuleCondition(): RuleCondition {
  return { variable: 'score', scope: 'scene', op: '>=', value: 1 };
}

export function useRuleConditionGroup(rule: Rule): Rule {
  if (rule.conditionGroup) return rule;
  return {
    ...rule,
    condition: undefined,
    conditionGroup: {
      mode: 'all',
      conditions: [rule.condition ?? defaultRuleCondition()],
    },
  };
}

export function setRuleConditionMode(rule: Rule, mode: RuleConditionGroup['mode']): Rule {
  return rule.conditionGroup ? { ...rule, conditionGroup: { ...rule.conditionGroup, mode } } : rule;
}

export function addRuleCondition(rule: Rule): Rule {
  const group = rule.conditionGroup;
  if (!group || group.conditions.length >= 8) return rule;
  return {
    ...rule,
    conditionGroup: { ...group, conditions: [...group.conditions, defaultRuleCondition()] },
  };
}

export function updateRuleCondition(rule: Rule, index: number, condition: RuleCondition): Rule {
  const group = rule.conditionGroup;
  if (!group || index < 0 || index >= group.conditions.length) return rule;
  return {
    ...rule,
    conditionGroup: {
      ...group,
      conditions: group.conditions.map((current, i) => (i === index ? condition : current)),
    },
  };
}

export function removeRuleCondition(rule: Rule, index: number): Rule {
  const group = rule.conditionGroup;
  if (!group || group.conditions.length <= 1 || index < 0 || index >= group.conditions.length) return rule;
  return {
    ...rule,
    conditionGroup: { ...group, conditions: group.conditions.filter((_, i) => i !== index) },
  };
}

export function setRuleEvent(rule: Rule, event: Rule['event']): Rule {
  if (event === 'animation' && rule.event === 'animation') return rule;
  const { eventId, ...previous } = rule;
  return {
    ...previous,
    event,
    ...((event === 'ui' || event === 'signal') && { eventId: eventId ?? 'event' }),
    marker: undefined,
    actions:
      event === 'collision' || event === 'separation'
        ? rule.actions
        : rule.actions.map((action) =>
            (action.type === 'destroy' ||
              action.type === 'damage' ||
              action.type === 'heal' ||
              action.type === 'teleport') &&
            action.target === COLLISION_OTHER_TARGET
              ? { ...action, target: undefined }
              : action,
          ),
  };
}

export function createAction(
  type: Action['type'],
  recipeId?: string,
  targetId?: string,
  sceneId?: string,
  itemId?: string,
  prefabId?: string,
  audioClipId?: string,
): Action | undefined {
  switch (type) {
    case 'set':
    case 'add':
      return { type, variable: 'score', value: 1, scope: 'scene' };
    case 'destroy':
      return { type };
    case 'enable':
      return targetId ? { type, target: targetId, value: true } : undefined;
    case 'emit':
      return { type, eventId: 'event' };
    case 'message':
      return { type, text: 'Hello, creator!' };
    case 'sound':
      return { type, waveform: 'sine', frequency: 440, duration: 0.15, volume: 0.5 };
    case 'audio':
      return audioClipId ? { type, clipId: audioClipId, volume: 1 } : undefined;
    case 'win':
    case 'lose':
      return { type };
    case 'damage':
    case 'heal':
      return { type, amount: 10 };
    case 'teleport':
      return { type, position: [0, 0, 0] };
    case 'craft':
      return recipeId ? { type, recipeId, batches: 1 } : undefined;
    case 'inventory':
      return itemId ? { type, remove: [], add: [{ itemId, quantity: 1 }] } : undefined;
    case 'spawn':
      return prefabId ? { type, prefabId, offset: [0, 0, 0] } : undefined;
    case 'transition':
      return sceneId ? { type, sceneId } : undefined;
  }
}

export function parseActionJson(
  source: string,
): { success: true; action: Action } | { success: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  const parsed = actionSchema.safeParse(value);
  return parsed.success
    ? { success: true, action: parsed.data }
    : { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid action.' };
}
