import {
  validateProject,
  type CraftingRecipe,
  type ItemDefinition,
  type ProjectDocument,
} from '../services/projectDocument';

export type CatalogScene = ProjectDocument['scenes'][number];

function nextId(prefix: string, values: { id: string }[]) {
  const used = new Set(values.map((value) => value.id));
  for (let index = 1; index <= 128; index++) {
    const candidate = `${prefix}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`This scene already has the maximum number of ${prefix === 'item' ? 'items' : 'recipes'}.`);
}

export function addCatalogItem(scene: CatalogScene): CatalogScene {
  return {
    ...scene,
    items: [
      ...scene.items,
      { id: nextId('item', scene.items), name: 'New item', description: '', maxStack: 99 },
    ],
  };
}

export function updateCatalogItem(
  scene: CatalogScene,
  itemId: string,
  patch: Partial<ItemDefinition>,
): CatalogScene {
  const nextId = patch.id ?? itemId;
  return {
    ...scene,
    objectives: scene.objectives.map((objective) => {
      const condition = objective.condition;
      return 'itemId' in condition && condition.itemId === itemId
        ? { ...objective, condition: { itemId: nextId, op: condition.op, value: condition.value } }
        : objective;
    }),
    items: scene.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    recipes: scene.recipes.map((recipe) => ({
      ...recipe,
      ingredients: recipe.ingredients.map((entry) =>
        entry.itemId === itemId ? { ...entry, itemId: nextId } : entry,
      ),
      outputs: recipe.outputs.map((entry) =>
        entry.itemId === itemId ? { ...entry, itemId: nextId } : entry,
      ),
    })),
    nodes: scene.nodes.map((node) => ({
      ...node,
      components: node.components.map((component) => {
        if (component.type === 'collectible' && component.itemId === itemId)
          return { ...component, itemId: nextId };
        if (component.type === 'construction')
          return {
            ...component,
            placeCost: component.placeCost.map((entry) =>
              entry.itemId === itemId ? { ...entry, itemId: nextId } : entry,
            ),
            removeYield: component.removeYield.map((entry) =>
              entry.itemId === itemId ? { ...entry, itemId: nextId } : entry,
            ),
          };
        if (component.type !== 'rules') return component;
        return {
          ...component,
          rules: component.rules.map((rule) => ({
            ...rule,
            condition:
              rule.condition?.itemId === itemId ? { ...rule.condition, itemId: nextId } : rule.condition,
            conditionGroup: rule.conditionGroup
              ? {
                  ...rule.conditionGroup,
                  conditions: rule.conditionGroup.conditions.map((condition) =>
                    condition.itemId === itemId ? { ...condition, itemId: nextId } : condition,
                  ),
                }
              : undefined,
            actions: rule.actions.map((action) =>
              action.type === 'inventory'
                ? {
                    ...action,
                    remove: action.remove.map((entry) =>
                      entry.itemId === itemId ? { ...entry, itemId: nextId } : entry,
                    ),
                    add: action.add.map((entry) =>
                      entry.itemId === itemId ? { ...entry, itemId: nextId } : entry,
                    ),
                  }
                : action,
            ),
          })),
        };
      }),
    })),
  };
}

export function deleteCatalogItem(scene: CatalogScene, itemId: string): CatalogScene {
  return { ...scene, items: scene.items.filter((item) => item.id !== itemId) };
}

export function addCatalogRecipe(scene: CatalogScene): CatalogScene {
  if (!scene.items.length) throw new Error('Add an item before creating a recipe.');
  const itemId = scene.items[0].id;
  return {
    ...scene,
    recipes: [
      ...scene.recipes,
      {
        id: nextId('recipe', scene.recipes),
        name: 'New recipe',
        ingredients: [{ itemId, quantity: 1 }],
        outputs: [{ itemId, quantity: 1 }],
      },
    ],
  };
}

export function updateCatalogRecipe(
  scene: CatalogScene,
  recipeId: string,
  patch: Partial<CraftingRecipe>,
): CatalogScene {
  const nextId = patch.id ?? recipeId;
  return {
    ...scene,
    recipes: scene.recipes.map((recipe) => (recipe.id === recipeId ? { ...recipe, ...patch } : recipe)),
    nodes: scene.nodes.map((node) => ({
      ...node,
      components: node.components.map((component) =>
        component.type === 'rules'
          ? {
              ...component,
              rules: component.rules.map((rule) => ({
                ...rule,
                actions: rule.actions.map((action) =>
                  action.type === 'craft' && action.recipeId === recipeId
                    ? { ...action, recipeId: nextId }
                    : action,
                ),
              })),
            }
          : component,
      ),
    })),
  };
}

export function deleteCatalogRecipe(scene: CatalogScene, recipeId: string): CatalogScene {
  return { ...scene, recipes: scene.recipes.filter((recipe) => recipe.id !== recipeId) };
}

export function validateCatalogDraft(project: ProjectDocument, scene: CatalogScene): string | null {
  try {
    validateProject({
      ...project,
      scenes: project.scenes.map((candidate) => (candidate.id === scene.id ? scene : candidate)),
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'The scene catalog is invalid.';
  }
}
