import React, { useEffect, useRef, useState } from 'react';
import type { CraftingRecipe, ItemDefinition, ProjectDocument } from '../services/projectDocument';
import {
  addCatalogItem,
  addCatalogRecipe,
  deleteCatalogItem,
  deleteCatalogRecipe,
  type CatalogScene,
  updateCatalogItem,
  updateCatalogRecipe,
  validateCatalogDraft,
} from './catalogAuthoring';
import { idSchema } from '../services/projectDocument';

function itemUses(scene: CatalogScene, id: string) {
  return (
    scene.recipes.reduce(
      (count, recipe) =>
        count +
        recipe.ingredients.filter((entry) => entry.itemId === id).length +
        recipe.outputs.filter((entry) => entry.itemId === id).length,
      0,
    ) +
    scene.nodes.reduce(
      (nodeCount, node) =>
        nodeCount +
        node.components.reduce(
          (count, component) =>
            count +
            (component.type === 'collectible' && component.itemId === id
              ? 1
              : component.type === 'construction'
                ? [...component.placeCost, ...component.removeYield].filter((entry) => entry.itemId === id)
                    .length
                : component.type === 'rules'
                  ? component.rules.reduce(
                      (ruleCount, rule) =>
                        ruleCount +
                        (rule.condition?.itemId === id ? 1 : 0) +
                        (rule.conditionGroup?.conditions.filter((condition) => condition.itemId === id)
                          .length ?? 0) +
                        rule.actions.reduce(
                          (actionCount, action) =>
                            actionCount +
                            (action.type === 'inventory'
                              ? [...action.remove, ...action.add].filter((entry) => entry.itemId === id)
                                  .length
                              : 0),
                          0,
                        ),
                      0,
                    )
                  : 0),
          0,
        ),
      0,
    )
  );
}

function recipeUses(scene: CatalogScene, id: string) {
  return scene.nodes.reduce(
    (count, node) =>
      count +
      node.components.reduce(
        (componentCount, component) =>
          componentCount +
          (component.type === 'rules'
            ? component.rules.reduce(
                (ruleCount, rule) =>
                  ruleCount +
                  rule.actions.filter((action) => action.type === 'craft' && action.recipeId === id).length,
                0,
              )
            : 0),
        0,
      ),
    0,
  );
}

function availableItems(items: ItemDefinition[], entries: { itemId: string }[], currentId: string) {
  const used = new Set(entries.filter((entry) => entry.itemId !== currentId).map((entry) => entry.itemId));
  return items.filter((item) => !used.has(item.id) || item.id === currentId);
}

function compatibleEquipment(project: ProjectDocument, scene: CatalogScene) {
  const player = scene.nodes.find((node) => node.components.some((component) => component.type === 'player')),
    body = project.assets.find((asset) => asset.id === player?.assetId);
  return body?.rig ? project.assets.filter((asset) => asset.equipment?.bodyAssetId === body.id) : [];
}

export default function SceneCatalogEditor({
  project,
  scene,
  onSave,
  onClose,
}: {
  project: ProjectDocument;
  scene: CatalogScene;
  onSave: (scene: CatalogScene, revision: number) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    baseRevision = useRef(project.revision);
  const [draft, setDraft] = useState<CatalogScene>(() => structuredClone(scene)),
    [itemIdDrafts, setItemIdDrafts] = useState<Record<string, string>>({}),
    [recipeIdDrafts, setRecipeIdDrafts] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const setIdDraft = (kind: 'item' | 'recipe', id: string, value: string) => {
    (kind === 'item' ? setItemIdDrafts : setRecipeIdDrafts)((current) => ({ ...current, [id]: value }));
    setError('');
  };
  const commitIdDraft = (kind: 'item' | 'recipe', oldId: string) => {
    const values = kind === 'item' ? itemIdDrafts : recipeIdDrafts;
    const proposed = values[oldId];
    if (proposed === undefined) return;
    const entries = kind === 'item' ? draft.items : draft.recipes;
    const duplicate = entries.some((entry) => entry.id === proposed && entry.id !== oldId);
    if (!idSchema.safeParse(proposed).success || duplicate) {
      setError(
        duplicate
          ? `ID “${proposed}” is already in use.`
          : 'IDs must start with a letter or number and use only letters, numbers, _ or - (up to 64 characters).',
      );
      return;
    }
    setDraft((current) =>
      kind === 'item'
        ? updateCatalogItem(current, oldId, { id: proposed })
        : updateCatalogRecipe(current, oldId, { id: proposed }),
    );
    (kind === 'item' ? setItemIdDrafts : setRecipeIdDrafts)((current) => {
      const next = { ...current };
      delete next[oldId];
      return next;
    });
    setError('');
  };

  const changeItem = (id: string, patch: Partial<ItemDefinition>) =>
    setDraft((current) => updateCatalogItem(current, id, patch));
  const changeRecipe = (id: string, patch: Partial<CraftingRecipe>) =>
    setDraft((current) => updateCatalogRecipe(current, id, patch));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (Object.keys(itemIdDrafts).length || Object.keys(recipeIdDrafts).length) {
      setError('Fix the highlighted IDs before applying this catalog.');
      return;
    }
    const validation = validateCatalogDraft(project, draft);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(draft, baseRevision.current);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The catalog could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const gearOptions = compatibleEquipment(project, draft);

  return (
    <dialog
      ref={dialog}
      className="studio-dialog studio-catalog-dialog"
      aria-labelledby="catalog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form className="studio-catalog-form" onSubmit={save}>
        <div className="studio-catalog-content">
          <header className="studio-catalog-heading">
            <div>
              <span className="studio-eyebrow">MANUAL GAMEPLAY DATA</span>
              <h2 id="catalog-title">Scene items & recipes</h2>
              <p>Define stackable items, then use them in pickups, craft rules and inventory actions.</p>
            </div>
            <button type="button" aria-label="Close scene catalog" onClick={onClose} disabled={saving}>
              ×
            </button>
          </header>

          <section className="studio-catalog-section" aria-labelledby="catalog-items-title">
            <div className="studio-catalog-section-heading">
              <div>
                <h3 id="catalog-items-title">Items</h3>
                <small>{draft.items.length}/128 · Item ID changes update scene references.</small>
              </div>
              <button
                type="button"
                onClick={() => {
                  try {
                    setDraft((current) => addCatalogItem(current));
                    setError('');
                  } catch (cause) {
                    setError((cause as Error).message);
                  }
                }}
                disabled={saving || draft.items.length >= 128}
              >
                + Add item
              </button>
            </div>
            {draft.items.length ? (
              draft.items.map((item) => {
                const references = itemUses(draft, item.id);
                const idValue = itemIdDrafts[item.id] ?? item.id;
                const idError =
                  !idSchema.safeParse(idValue).success ||
                  draft.items.some((other) => other.id === idValue && other.id !== item.id);
                const gearUse = item.use?.type === 'equip' ? item.use : null;
                return (
                  <article className="studio-catalog-card" key={item.id}>
                    <div className="studio-catalog-fields">
                      <label className="studio-field">
                        Item name
                        <input
                          required
                          maxLength={120}
                          value={item.name}
                          onChange={(event) => changeItem(item.id, { name: event.target.value })}
                        />
                      </label>
                      <label className="studio-field">
                        Item ID
                        <input
                          required
                          maxLength={64}
                          value={idValue}
                          aria-invalid={idError}
                          aria-describedby={idError ? `item-id-error-${item.id}` : undefined}
                          onChange={(event) => setIdDraft('item', item.id, event.target.value)}
                          onBlur={() => commitIdDraft('item', item.id)}
                        />
                        {idError && (
                          <small className="studio-catalog-inline-error" id={`item-id-error-${item.id}`}>
                            Enter a unique ID using letters, numbers, _ or - (up to 64 characters).
                          </small>
                        )}
                      </label>
                      <label className="studio-field">
                        Max stack
                        <input
                          type="number"
                          min={1}
                          max={999}
                          step={1}
                          required
                          value={item.maxStack}
                          onChange={(event) => changeItem(item.id, { maxStack: Number(event.target.value) })}
                        />
                      </label>
                    </div>
                    <label className="studio-field studio-catalog-description">
                      Description
                      <textarea
                        aria-label={`Description for ${item.name}`}
                        rows={2}
                        maxLength={500}
                        value={item.description ?? ''}
                        onChange={(event) => changeItem(item.id, { description: event.target.value })}
                      />
                      <small>{(item.description ?? '').length}/500</small>
                    </label>
                    <div className="studio-catalog-fields studio-catalog-recipe-fields">
                      <label className="studio-field">
                        Use effect
                        <select
                          aria-label={`Use effect for ${item.name}`}
                          value={item.use?.type ?? ''}
                          onChange={(event) =>
                            changeItem(item.id, {
                              use:
                                event.target.value === 'heal'
                                  ? item.use?.type === 'heal'
                                    ? item.use
                                    : { type: 'heal', amount: 25 }
                                  : event.target.value === 'equip' && gearOptions[0]
                                    ? item.use?.type === 'equip'
                                      ? item.use
                                      : { type: 'equip', assetId: gearOptions[0].id }
                                    : undefined,
                            })
                          }
                        >
                          <option value="">Not usable</option>
                          <option value="heal">Restore player health</option>
                          <option value="equip" disabled={!gearOptions.length}>
                            Equip fitted equipment
                          </option>
                        </select>
                      </label>
                      {gearUse ? (
                        <label className="studio-field">
                          Fitted gear
                          <select
                            aria-label={`Fitted gear for ${item.name}`}
                            value={gearUse.assetId}
                            onChange={(event) =>
                              changeItem(item.id, { use: { type: 'equip', assetId: event.target.value } })
                            }
                          >
                            {!gearOptions.some((asset) => asset.id === gearUse.assetId) && (
                              <option value={gearUse.assetId}>{gearUse.assetId} (unavailable)</option>
                            )}
                            {gearOptions.map((asset) => (
                              <option key={asset.id} value={asset.id}>
                                {asset.name} · {asset.equipment!.kind}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <label className="studio-field">
                          Health restored
                          <input
                            aria-label={`Health restored by ${item.name}`}
                            type="number"
                            min={0.01}
                            max={10000}
                            step={0.01}
                            required={item.use?.type === 'heal'}
                            disabled={item.use?.type !== 'heal'}
                            value={item.use?.type === 'heal' ? item.use.amount : 25}
                            onChange={(event) =>
                              changeItem(item.id, {
                                use: { type: 'heal', amount: Number(event.target.value) },
                              })
                            }
                          />
                        </label>
                      )}
                    </div>
                    <div className="studio-catalog-card-actions">
                      {references > 0 && (
                        <small>
                          {references} reference{references === 1 ? '' : 's'} · remove them before deleting
                        </small>
                      )}
                      <button
                        type="button"
                        className="studio-danger"
                        aria-label={`Delete item ${item.name}`}
                        disabled={saving || references > 0}
                        onClick={() => {
                          setDraft((current) => deleteCatalogItem(current, item.id));
                          setItemIdDrafts((current) => {
                            const next = { ...current };
                            delete next[item.id];
                            return next;
                          });
                        }}
                      >
                        Delete item
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <p className="studio-catalog-empty">No items yet. Add one before creating a recipe.</p>
            )}
          </section>

          <section className="studio-catalog-section" aria-labelledby="catalog-recipes-title">
            <div className="studio-catalog-section-heading">
              <div>
                <h3 id="catalog-recipes-title">Crafting recipes</h3>
                <small>{draft.recipes.length}/128 · Recipes use item IDs from this scene.</small>
              </div>
              <button
                type="button"
                onClick={() => {
                  try {
                    setDraft((current) => addCatalogRecipe(current));
                    setError('');
                  } catch (cause) {
                    setError((cause as Error).message);
                  }
                }}
                disabled={saving || draft.items.length === 0 || draft.recipes.length >= 128}
              >
                + Add recipe
              </button>
            </div>
            {draft.recipes.length ? (
              draft.recipes.map((recipe) => {
                const references = recipeUses(draft, recipe.id);
                const idValue = recipeIdDrafts[recipe.id] ?? recipe.id;
                const idError =
                  !idSchema.safeParse(idValue).success ||
                  draft.recipes.some((other) => other.id === idValue && other.id !== recipe.id);
                const entryRows = (kind: 'ingredients' | 'outputs') => {
                  const entries = recipe[kind];
                  return (
                    <div className="studio-catalog-entry-list">
                      {entries.map((entry, index) => (
                        <div className="studio-catalog-entry" key={`${kind}-${index}`}>
                          <label className="studio-field">
                            {kind === 'ingredients' ? 'Item needed' : 'Item produced'}
                            <select
                              required
                              value={entry.itemId}
                              onChange={(event) =>
                                changeRecipe(recipe.id, {
                                  [kind]: entries.map((candidate, row) =>
                                    row === index ? { ...candidate, itemId: event.target.value } : candidate,
                                  ),
                                })
                              }
                            >
                              {availableItems(draft.items, entries, entry.itemId).map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name} · {item.id}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="studio-field">
                            Quantity
                            <input
                              type="number"
                              min={1}
                              max={9999}
                              step={1}
                              required
                              value={entry.quantity}
                              onChange={(event) =>
                                changeRecipe(recipe.id, {
                                  [kind]: entries.map((candidate, row) =>
                                    row === index
                                      ? { ...candidate, quantity: Number(event.target.value) }
                                      : candidate,
                                  ),
                                })
                              }
                            />
                          </label>
                          <button
                            type="button"
                            aria-label={`Remove ${kind === 'ingredients' ? 'ingredient' : 'output'} row ${index + 1} from ${recipe.name}`}
                            disabled={saving || entries.length <= 1}
                            onClick={() =>
                              changeRecipe(recipe.id, {
                                [kind]: entries.filter((_, row) => row !== index),
                              })
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="studio-catalog-add-entry"
                        disabled={
                          saving ||
                          entries.length >= 16 ||
                          availableItems(draft.items, entries, '').length === 0
                        }
                        onClick={() => {
                          const itemId = availableItems(draft.items, entries, '')[0]?.id;
                          if (itemId)
                            changeRecipe(recipe.id, { [kind]: [...entries, { itemId, quantity: 1 }] });
                        }}
                      >
                        + Add {kind === 'ingredients' ? 'ingredient' : 'output'}
                      </button>
                    </div>
                  );
                };
                return (
                  <article className="studio-catalog-card" key={recipe.id}>
                    <div className="studio-catalog-fields studio-catalog-recipe-fields">
                      <label className="studio-field">
                        Recipe name
                        <input
                          required
                          maxLength={120}
                          value={recipe.name}
                          onChange={(event) => changeRecipe(recipe.id, { name: event.target.value })}
                        />
                      </label>
                      <label className="studio-field">
                        Recipe ID
                        <input
                          required
                          maxLength={64}
                          value={idValue}
                          aria-invalid={idError}
                          aria-describedby={idError ? `recipe-id-error-${recipe.id}` : undefined}
                          onChange={(event) => setIdDraft('recipe', recipe.id, event.target.value)}
                          onBlur={() => commitIdDraft('recipe', recipe.id)}
                        />
                        {idError && (
                          <small className="studio-catalog-inline-error" id={`recipe-id-error-${recipe.id}`}>
                            Enter a unique ID using letters, numbers, _ or - (up to 64 characters).
                          </small>
                        )}
                      </label>
                    </div>
                    {entryRows('ingredients')}
                    {entryRows('outputs')}
                    <div className="studio-catalog-card-actions">
                      {references > 0 && (
                        <small>
                          {references} craft rule{references === 1 ? '' : 's'} · remove them before deleting
                        </small>
                      )}
                      <button
                        type="button"
                        className="studio-danger"
                        aria-label={`Delete recipe ${recipe.name}`}
                        disabled={saving || references > 0}
                        onClick={() => {
                          setDraft((current) => deleteCatalogRecipe(current, recipe.id));
                          setRecipeIdDrafts((current) => {
                            const next = { ...current };
                            delete next[recipe.id];
                            return next;
                          });
                        }}
                      >
                        Delete recipe
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <p className="studio-catalog-empty">No recipes yet.</p>
            )}
          </section>

          {error && (
            <p className="studio-catalog-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="studio-catalog-actions">
          <button type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="studio-primary" type="submit" disabled={saving}>
            {saving ? 'Applying…' : 'Apply scene catalog'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
