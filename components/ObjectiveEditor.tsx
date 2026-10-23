import React from 'react';
import type { GameScene, RuleCondition } from '../services/projectDocument';

type Objective = GameScene['objectives'][number];
const isVariableCondition = (
  condition: RuleCondition,
): condition is Extract<RuleCondition, { variable: string }> => typeof condition.variable === 'string';
const variableScope = (condition: RuleCondition) =>
  (isVariableCondition(condition) ? condition.scope : undefined) ?? 'scene';

export default function ObjectiveEditor({
  objectives,
  items,
  onChange,
}: {
  objectives: GameScene['objectives'];
  items: GameScene['items'];
  onChange: (objectives: GameScene['objectives']) => void;
}) {
  const update = (index: number, objective: Objective) =>
    onChange(objectives.map((current, itemIndex) => (itemIndex === index ? objective : current)));
  const setCondition = (objective: Objective, condition: Objective['condition']) => ({
    ...objective,
    condition,
  });
  const dependsOn = (objectiveId: string, targetId: string, visited = new Set<string>()): boolean => {
    if (objectiveId === targetId) return true;
    if (visited.has(objectiveId)) return false;
    visited.add(objectiveId);
    const objective = objectives.find((candidate) => candidate.id === objectiveId);
    return (objective?.requires ?? []).some((requiredId) => dependsOn(requiredId, targetId, visited));
  };
  const removeObjective = (id: string) =>
    onChange(
      objectives
        .filter((objective) => objective.id !== id)
        .map((objective) => {
          const requires = objective.requires?.filter((requiredId) => requiredId !== id);
          return requires?.length
            ? { ...objective, requires }
            : { id: objective.id, text: objective.text, condition: objective.condition };
        }),
    );

  return (
    <fieldset className="studio-component studio-objectives">
      <legend>Player objectives</legend>
      <p>
        Objectives use scene or campaign variables and inventory counts as gameplay rules. Add prerequisites
        to unlock later objectives.
      </p>
      {objectives.map((objective, index) => {
        const number = index + 1,
          condition = objective.condition,
          itemId =
            'itemId' in condition && typeof condition.itemId === 'string' ? condition.itemId : undefined,
          variableId =
            'variable' in condition && typeof condition.variable === 'string' ? condition.variable : 'score',
          requires = objective.requires ?? [],
          availablePrerequisites = objectives.filter(
            (candidate) => candidate.id !== objective.id && !dependsOn(candidate.id, objective.id),
          );
        return (
          <section className="studio-objective" key={objective.id} aria-label={`Objective ${number}`}>
            <label className="studio-field">
              Objective text
              <input
                aria-label={`Objective ${number} text`}
                maxLength={120}
                value={objective.text}
                onChange={(event) => update(index, { ...objective, text: event.target.value })}
              />
            </label>
            <div className="studio-two">
              <label className="studio-field">
                Track
                <select
                  aria-label={`Objective ${number} track`}
                  value={itemId ? 'item' : 'variable'}
                  onChange={(event) =>
                    update(
                      index,
                      setCondition(
                        objective,
                        event.target.value === 'item'
                          ? {
                              itemId: items[0]?.id ?? 'item',
                              op: condition.op,
                              value: Math.max(0, Math.trunc(condition.value)),
                            }
                          : { variable: 'score', scope: 'scene', op: condition.op, value: condition.value },
                      ),
                    )
                  }
                >
                  <option value="variable">Variable</option>
                  <option value="item" disabled={!items.length}>
                    Inventory item
                  </option>
                </select>
              </label>
              {itemId ? (
                <label className="studio-field">
                  Inventory item
                  <select
                    aria-label={`Objective ${number} inventory item`}
                    value={itemId}
                    onChange={(event) =>
                      update(
                        index,
                        setCondition(objective, {
                          itemId: event.target.value,
                          op: condition.op,
                          value: Math.max(0, Math.trunc(condition.value)),
                        }),
                      )
                    }
                  >
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="studio-field">
                  Variable ID
                  <input
                    aria-label={`Objective ${number} variable`}
                    maxLength={64}
                    pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                    required
                    value={variableId}
                    onChange={(event) =>
                      update(
                        index,
                        setCondition(objective, {
                          variable: event.target.value,
                          scope: variableScope(condition),
                          op: condition.op,
                          value: condition.value,
                        }),
                      )
                    }
                  />
                </label>
              )}
              {!itemId && (
                <label className="studio-field">
                  Variable scope
                  <select
                    aria-label={`Objective ${number} variable scope`}
                    value={variableScope(condition)}
                    onChange={(event) =>
                      update(
                        index,
                        setCondition(objective, {
                          variable: variableId,
                          scope: event.target.value as 'scene' | 'campaign',
                          op: condition.op,
                          value: condition.value,
                        }),
                      )
                    }
                  >
                    <option value="scene">This scene</option>
                    <option value="campaign">Across scenes</option>
                  </select>
                </label>
              )}
            </div>
            <div className="studio-objective-target">
              <label className="studio-field">
                Comparison
                <select
                  aria-label={`Objective ${number} comparison`}
                  value={condition.op}
                  onChange={(event) => {
                    const op = event.target.value as Objective['condition']['op'];
                    update(
                      index,
                      setCondition(
                        objective,
                        itemId
                          ? { itemId, op, value: Math.max(0, Math.trunc(condition.value)) }
                          : {
                              variable: variableId,
                              scope: variableScope(condition),
                              op,
                              value: condition.value,
                            },
                      ),
                    );
                  }}
                >
                  {['>=', '==', '>', '<=', '<'].map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-field">
                Target
                <input
                  aria-label={`Objective ${number} target`}
                  type="number"
                  min={itemId ? 0 : undefined}
                  max={itemId ? 1_000_000 : undefined}
                  step={itemId ? 1 : 'any'}
                  value={condition.value}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    update(
                      index,
                      setCondition(
                        objective,
                        itemId
                          ? { itemId, op: condition.op, value: Math.max(0, Math.trunc(value)) }
                          : {
                              variable: variableId,
                              scope: variableScope(condition),
                              op: condition.op,
                              value,
                            },
                      ),
                    );
                  }}
                />
              </label>
              <button
                type="button"
                aria-label={`Remove objective ${number}`}
                onClick={() => removeObjective(objective.id)}
              >
                Remove
              </button>
            </div>
            {availablePrerequisites.length > 0 && (
              <fieldset className="studio-objective-prerequisites">
                <legend>Requires completed objectives</legend>
                {availablePrerequisites.map((prerequisite) => (
                  <label key={prerequisite.id}>
                    <input
                      type="checkbox"
                      aria-label={`Objective ${number} requires ${prerequisite.text}`}
                      checked={requires.includes(prerequisite.id)}
                      onChange={() => {
                        const nextRequires = requires.includes(prerequisite.id)
                          ? requires.filter((id) => id !== prerequisite.id)
                          : [...requires, prerequisite.id];
                        const nextObjective = nextRequires.length
                          ? { ...objective, requires: nextRequires }
                          : { id: objective.id, text: objective.text, condition: objective.condition };
                        update(index, nextObjective);
                      }}
                    />
                    {prerequisite.text}
                  </label>
                ))}
              </fieldset>
            )}
          </section>
        );
      })}
      {objectives.length < 16 && (
        <button
          type="button"
          onClick={() => {
            let suffix = 1;
            while (objectives.some((objective) => objective.id === `objective-${suffix}`)) suffix++;
            onChange([
              ...objectives,
              {
                id: `objective-${suffix}`,
                text: 'Complete objective',
                condition: { variable: 'score', scope: 'scene', op: '>=', value: 1 },
              },
            ]);
          }}
        >
          Add objective
        </button>
      )}
      <small>Variable objectives read missing variables as 0. Inventory targets are whole item counts.</small>
    </fieldset>
  );
}
