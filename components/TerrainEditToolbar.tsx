import type {
  TerrainBrushSize,
  TerrainBrushShape,
  TerrainEditMode,
  TerrainInspection,
  TerrainPaint,
  TerrainPaletteLayer,
} from '../runtime/GameViewport';
import './terrainEditToolbar.css';

type Props = {
  mode: TerrainEditMode | 'inspect' | null;
  inspection: TerrainInspection | null;
  brushSize: TerrainBrushSize;
  brushShape: TerrainBrushShape;
  palette: { surface: number; subsurface: number; deep: number };
  paletteLayer: TerrainPaletteLayer;
  customPaint: TerrainPaint;
  disabled?: boolean;
  onModeChange: (mode: TerrainEditMode | 'inspect' | null) => void;
  onBrushSizeChange: (size: TerrainBrushSize) => void;
  onBrushShapeChange: (shape: TerrainBrushShape) => void;
  onPaletteLayerChange: (layer: TerrainPaletteLayer) => void;
  onCustomPaintChange: (paint: TerrainPaint) => void;
};

export default function TerrainEditToolbar({
  mode,
  inspection,
  brushSize,
  brushShape,
  palette,
  paletteLayer,
  customPaint,
  disabled = false,
  onModeChange,
  onBrushSizeChange,
  onBrushShapeChange,
  onPaletteLayerChange,
  onCustomPaintChange,
}: Props) {
  return (
    <div className="terrain-edit-toolbar" role="group" aria-label="Terrain tools">
      {mode === 'inspect' ? (
        <>
          <strong>Inspect terrain</strong>
          <output className="terrain-inspection" aria-label="Selected terrain cell" aria-live="polite">
            {inspection ? (
              <>
                <span>
                  <b>Cell</b> <code>{inspection.position.join(', ')}</code>
                </span>
                <span>
                  <b>Position</b>{' '}
                  <code>
                    {inspection.physicalPosition.map((value) => `${Number(value.toFixed(3))} m`).join(', ')}
                  </code>
                </span>
                <span>
                  <b>Cell data</b>{' '}
                  {inspection.cell
                    ? `#${inspection.cell.color.toString(16).padStart(6, '0').toUpperCase()} · ${inspection.cell.materialType} · `
                    : ''}
                  {inspection.status === 'generated'
                    ? 'Generated terrain'
                    : inspection.status === 'sparse'
                      ? 'Sparse override'
                      : inspection.status === 'removed'
                        ? 'Removed by sparse edit'
                        : 'No generated cell'}
                </span>
              </>
            ) : (
              <span>Click a visible terrain cell to inspect it.</span>
            )}
          </output>
          <button aria-label="Switch to terrain editing" onClick={() => onModeChange('place')}>
            Edit terrain
          </button>
          <button className="terrain-edit-done" onClick={() => onModeChange(null)}>
            Done
          </button>
        </>
      ) : mode ? (
        <>
          <span>Terrain</span>
          <button aria-pressed={mode === 'place'} disabled={disabled} onClick={() => onModeChange('place')}>
            Place
          </button>
          <button aria-pressed={mode === 'remove'} disabled={disabled} onClick={() => onModeChange('remove')}>
            Remove
          </button>
          <button aria-pressed={false} disabled={disabled} onClick={() => onModeChange('inspect')}>
            Inspect
          </button>
          <span>Material</span>
          {(['surface', 'subsurface', 'deep'] as const).map((layer) => (
            <button
              className="terrain-edit-palette"
              key={layer}
              aria-label={`${layer} palette layer`}
              aria-pressed={paletteLayer === layer}
              disabled={disabled}
              onClick={() => onPaletteLayerChange(layer)}
            >
              <span
                aria-hidden="true"
                style={{ backgroundColor: `#${palette[layer].toString(16).padStart(6, '0')}` }}
              />
              {layer}
            </button>
          ))}
          <button
            className="terrain-edit-palette"
            aria-label="Custom paint"
            aria-pressed={paletteLayer === 'custom'}
            disabled={disabled}
            onClick={() => onPaletteLayerChange('custom')}
          >
            <span
              aria-hidden="true"
              style={{ backgroundColor: `#${customPaint.color.toString(16).padStart(6, '0')}` }}
            />
            Custom
          </button>
          {paletteLayer === 'custom' && (
            <>
              <label className="terrain-edit-custom-field">
                Color
                <input
                  aria-label="Custom terrain color"
                  type="color"
                  value={`#${customPaint.color.toString(16).padStart(6, '0')}`}
                  disabled={disabled}
                  onChange={(event) =>
                    onCustomPaintChange({
                      ...customPaint,
                      color: Number.parseInt(event.currentTarget.value.slice(1), 16),
                    })
                  }
                />
              </label>
              <label className="terrain-edit-custom-field">
                Cell material
                <select
                  aria-label="Custom terrain material"
                  value={customPaint.materialType}
                  disabled={disabled}
                  onChange={(event) =>
                    onCustomPaintChange({
                      ...customPaint,
                      materialType: event.currentTarget.value as TerrainPaint['materialType'],
                    })
                  }
                >
                  {(['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE'] as const).map((material) => (
                    <option key={material} value={material}>
                      {material.toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <span>Shape</span>
          {(['brush', 'cube', 'sphere'] as const).map((shape) => (
            <button
              key={shape}
              aria-label={`${shape} terrain shape`}
              aria-pressed={brushShape === shape}
              disabled={disabled}
              onClick={() => onBrushShapeChange(shape)}
            >
              {shape === 'brush' ? 'Brush' : shape}
            </button>
          ))}
          <span>Size</span>
          {([1, 3, 5] as const).map((size) => (
            <button
              key={size}
              aria-label={`${size} cell ${brushShape === 'brush' ? 'brush' : `${brushShape} stamp`}`}
              aria-pressed={brushSize === size}
              disabled={disabled}
              onClick={() => onBrushSizeChange(size)}
            >
              {size}
            </button>
          ))}
          <button className="terrain-edit-done" disabled={disabled} onClick={() => onModeChange(null)}>
            Done
          </button>
          <small>One stroke · Undo restores all cells</small>
        </>
      ) : (
        <>
          <button disabled={disabled} onClick={() => onModeChange('place')}>
            Edit terrain
          </button>
          <button disabled={disabled} onClick={() => onModeChange('inspect')}>
            Inspect terrain
          </button>
        </>
      )}
    </div>
  );
}
