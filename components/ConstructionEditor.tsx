import React from 'react';
import type { Component, ConstructionPaint, ItemDefinition } from '../services/projectDocument';
import { CatalogItemListEditor } from './RuleEditor';

type Construction = Extract<Component, { type: 'construction' }>;
type PaletteEntry = NonNullable<Construction['palette']>[number];

const paletteMaterials: PaletteEntry['materialType'][] = ['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE'];

export function nextConstructionPaletteId(entries: readonly Pick<PaletteEntry, 'id'>[]) {
  const used = new Set(entries.map((entry) => entry.id));
  for (let index = 1; ; index++) {
    const id = `paint-${index}`;
    if (!used.has(id)) return id;
  }
}

export function addConstructionPaletteEntry(entries: readonly ConstructionPaint[]): ConstructionPaint[] {
  if (entries.length >= 32) return [...entries];
  return [
    ...entries,
    {
      id: nextConstructionPaletteId(entries),
      name: 'New color',
      color: 0xffffff,
      materialType: 'STANDARD',
    },
  ];
}

export function formatPaletteColor(color: number) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function parsePaletteColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? Number.parseInt(value.slice(1), 16) : null;
}

export function ConstructionEditor({
  construction,
  items,
  onChange,
}: {
  construction: Construction;
  items: ItemDefinition[];
  onChange: (patch: Partial<Construction>) => void;
}) {
  const palette = construction.palette ?? [];
  const updatePaletteEntry = (index: number, patch: Partial<PaletteEntry>) =>
    onChange({
      palette: palette.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)),
    });

  return (
    <>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={construction.place}
          onChange={(e) => onChange({ place: e.target.checked })}
        />
        Enable placement
      </label>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={construction.remove}
          onChange={(e) => onChange({ remove: e.target.checked })}
        />
        Enable removal
      </label>
      <label className="studio-field">
        Construction reach (m)
        <input
          type="number"
          step="any"
          max={100}
          value={construction.range}
          onChange={(e) => onChange({ range: Number(e.target.value) })}
        />
      </label>
      <small>Reach must be greater than 0 and no more than 100 meters.</small>
      <CatalogItemListEditor
        label="Place costs"
        quantityLabel="Place cost quantity"
        entries={construction.placeCost}
        items={items}
        allowEmpty
        onChange={(placeCost) => onChange({ placeCost })}
      />
      <CatalogItemListEditor
        label="Remove yields"
        quantityLabel="Remove yield quantity"
        entries={construction.removeYield}
        items={items}
        allowEmpty
        onChange={(removeYield) => onChange({ removeYield })}
      />
      <section className="studio-component" aria-label="Paint palette">
        <div>
          <strong>Paint palette</strong>
          <small>{palette.length}/32 · Colors remain independent of per-cell costs and yields.</small>
        </div>
        <button
          type="button"
          onClick={() => onChange({ palette: addConstructionPaletteEntry(palette) })}
          disabled={palette.length >= 32}
        >
          + Add paint color
        </button>
        {palette.length ? (
          palette.map((entry, index) => (
            <article className="studio-catalog-card" key={entry.id}>
              <div className="studio-catalog-fields">
                <label className="studio-field">
                  Paint color {index + 1} name
                  <input
                    required
                    maxLength={120}
                    value={entry.name}
                    onChange={(event) => updatePaletteEntry(index, { name: event.target.value })}
                  />
                </label>
                <label className="studio-field">
                  Paint color {index + 1} hex color
                  <input
                    type="color"
                    value={formatPaletteColor(entry.color)}
                    onChange={(event) => {
                      const color = parsePaletteColor(event.target.value);
                      if (color !== null) updatePaletteEntry(index, { color });
                    }}
                  />
                </label>
                <label className="studio-field">
                  Paint color {index + 1} material
                  <select
                    value={entry.materialType}
                    onChange={(event) =>
                      updatePaletteEntry(index, {
                        materialType: event.target.value as PaletteEntry['materialType'],
                      })
                    }
                  >
                    {paletteMaterials.map((materialType) => (
                      <option key={materialType} value={materialType}>
                        {materialType}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="studio-catalog-card-actions">
                <small>
                  Palette ID: <code>{entry.id}</code>
                </small>
                <button
                  type="button"
                  aria-label={`Remove paint color ${index + 1}`}
                  onClick={() =>
                    onChange({ palette: palette.filter((_, entryIndex) => entryIndex !== index) })
                  }
                >
                  ×
                </button>
              </div>
            </article>
          ))
        ) : (
          <small>Add paint colors to provide material and color shortcuts in Play.</small>
        )}
      </section>
      <small>
        Costs apply per successfully placed cell, and yields apply per removed cell. Failed edits spend or
        grant nothing.
      </small>
    </>
  );
}
