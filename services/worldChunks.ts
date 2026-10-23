/** Integer coordinates in the world's logical voxel grid. Physical scale belongs to the asset/world. */
export interface CellPosition {
  x: number;
  y: number;
  z: number;
}

export interface ChunkCoordinate {
  x: number;
  y: number;
  z: number;
}

export interface ChunkLocation {
  chunk: ChunkCoordinate;
  local: CellPosition;
}

export interface WorldChunk<T extends {}> {
  readonly coordinate: Readonly<ChunkCoordinate>;
  /** Sparse values keyed by the chunk's packed local cell index. */
  cells: ReadonlyMap<number, T>;
}

/** A null value is a tombstone that removes a generated cell. */
export interface ChunkEdit<T extends {}> extends CellPosition {
  value: T | null;
}

/** Keep generation dependent only on position and this seeded random stream for repeatable output. */
export type CellGenerator<T extends {}> = (position: CellPosition, random: () => number) => T | undefined;

const MAX_CHUNK_SIZE = 32;
const UINT32_RANGE = 0x1_0000_0000;

function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
  return value;
}

function validateChunkSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CHUNK_SIZE)
    throw new Error(`Chunk size must be an integer from 1 to ${MAX_CHUNK_SIZE}.`);
  return size;
}

function coordinateKey(coordinate: ChunkCoordinate): string {
  return `${coordinate.x},${coordinate.y},${coordinate.z}`;
}

function checkedPosition(position: CellPosition): CellPosition {
  return {
    x: integer(position.x, 'Cell x'),
    y: integer(position.y, 'Cell y'),
    z: integer(position.z, 'Cell z'),
  };
}

function checkedChunk(coordinate: ChunkCoordinate): ChunkCoordinate {
  return {
    x: integer(coordinate.x, 'Chunk x'),
    y: integer(coordinate.y, 'Chunk y'),
    z: integer(coordinate.z, 'Chunk z'),
  };
}

/** Maps world cells to chunks with floor division, so negative coordinates map correctly. */
export function locateCell(position: CellPosition, chunkSize: number): ChunkLocation {
  const size = validateChunkSize(chunkSize);
  const p = checkedPosition(position);
  const chunk = {
    x: Math.floor(p.x / size),
    y: Math.floor(p.y / size),
    z: Math.floor(p.z / size),
  };
  const origin = { x: chunk.x * size, y: chunk.y * size, z: chunk.z * size };
  if (![origin.x, origin.y, origin.z].every(Number.isSafeInteger))
    throw new Error('Cell coordinate is outside the supported chunk range.');
  return {
    chunk,
    local: { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z },
  };
}

/** Stable packed index for a local cell; x varies fastest, followed by z and y. */
export function localCellIndex(position: CellPosition, chunkSize: number): number {
  const size = validateChunkSize(chunkSize);
  const p = checkedPosition(position);
  if (p.x < 0 || p.x >= size || p.y < 0 || p.y >= size || p.z < 0 || p.z >= size)
    throw new Error('Local cell coordinate is outside the chunk.');
  return p.x + size * (p.z + size * p.y);
}

function localPosition(index: number, chunkSize: number): CellPosition {
  const size = chunkSize;
  const y = Math.floor(index / (size * size));
  const withinLayer = index - y * size * size;
  const z = Math.floor(withinLayer / size);
  return { x: withinLayer - z * size, y, z };
}

function cellRandom(seed: number, position: CellPosition): () => number {
  // Mix both halves of safe integers so nearby and negative coordinates remain distinct inputs.
  let state = 0x811c9dc5;
  for (const value of [seed, position.x, position.y, position.z]) {
    const low = value >>> 0;
    const high = Math.floor(value / UINT32_RANGE) >>> 0;
    state = Math.imul(state ^ low, 0x01000193) >>> 0;
    state = Math.imul(state ^ high, 0x01000193) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / UINT32_RANGE;
  };
}

/**
 * Deterministic sparse chunk data with an in-memory loaded cache and separately exportable edits.
 * World documents persist edit snapshots; this store only hydrates and applies them at runtime.
 */
export class WorldChunkStore<T extends {}> {
  readonly seed: number;
  readonly chunkSize: number;
  private readonly generateCell: CellGenerator<T>;
  private readonly loaded = new Map<string, WorldChunk<T>>();
  private readonly overrides = new Map<string, Map<number, T | null>>();

  constructor(seed: number, chunkSize: number, generateCell: CellGenerator<T>) {
    this.seed = integer(seed, 'Seed');
    this.chunkSize = validateChunkSize(chunkSize);
    this.generateCell = generateCell;
  }

  /** Generates a sparse chunk once, then applies every stored edit for that chunk. */
  hydrate(coordinate: ChunkCoordinate): WorldChunk<T> {
    const chunk = checkedChunk(coordinate);
    const key = coordinateKey(chunk);
    const cached = this.loaded.get(key);
    if (cached) return cached;

    const cells = new Map<number, T>();
    const size = this.chunkSize;
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        for (let x = 0; x < size; x++) {
          const position = { x: chunk.x * size + x, y: chunk.y * size + y, z: chunk.z * size + z };
          if (![position.x, position.y, position.z].every(Number.isSafeInteger))
            throw new Error('Chunk coordinate is outside the supported cell range.');
          const value = this.generateCell(position, cellRandom(this.seed, position));
          if (value !== undefined) cells.set(localCellIndex({ x, y, z }, size), value);
        }
      }
    }

    for (const [index, value] of this.overrides.get(key) ?? []) {
      if (value === null) cells.delete(index);
      else cells.set(index, value);
    }
    const result: WorldChunk<T> = { coordinate: Object.freeze(chunk), cells };
    this.loaded.set(key, result);
    return result;
  }

  /** Reads a cell, hydrating its chunk on demand. */
  get(position: CellPosition): T | undefined {
    const p = checkedPosition(position);
    const { chunk, local } = locateCell(p, this.chunkSize);
    return this.hydrate(chunk).cells.get(localCellIndex(local, this.chunkSize));
  }

  /** Writes a sparse override. Null removes a generated cell; undefined is reserved for no value. */
  set(position: CellPosition, value: T | null): void {
    const p = checkedPosition(position);
    const { chunk, local } = locateCell(p, this.chunkSize);
    const key = coordinateKey(chunk);
    const index = localCellIndex(local, this.chunkSize);
    let chunkOverrides = this.overrides.get(key);
    if (!chunkOverrides) this.overrides.set(key, (chunkOverrides = new Map()));
    chunkOverrides.set(index, value);
    const loaded = this.loaded.get(key);
    if (loaded) {
      if (value === null) (loaded.cells as Map<number, T>).delete(index);
      else (loaded.cells as Map<number, T>).set(index, value);
    }
  }

  /** Drops generated cell data while retaining edits for the next hydrate. */
  unload(coordinate: ChunkCoordinate): boolean {
    return this.loaded.delete(coordinateKey(checkedChunk(coordinate)));
  }

  /** Drops all loaded chunks but keeps edit overrides. */
  unloadAll(): void {
    this.loaded.clear();
  }

  /** Replaces all overrides with a serializable snapshot and invalidates loaded chunks. */
  restoreEdits(edits: readonly ChunkEdit<T>[]): void {
    const restored = new Map<string, Map<number, T | null>>();
    for (const edit of edits) {
      const position = checkedPosition(edit);
      if (edit.value === undefined) throw new Error('Edit values must be a cell value or null.');
      const { chunk, local } = locateCell(position, this.chunkSize);
      const key = coordinateKey(chunk);
      let chunkOverrides = restored.get(key);
      if (!chunkOverrides) restored.set(key, (chunkOverrides = new Map()));
      const index = localCellIndex(local, this.chunkSize);
      if (chunkOverrides.has(index)) throw new Error('Edit snapshot contains duplicate cell coordinates.');
      chunkOverrides.set(index, edit.value);
    }
    this.overrides.clear();
    for (const [key, values] of restored) this.overrides.set(key, values);
    this.unloadAll();
  }

  /** Returns a stable, coordinate-sorted snapshot suitable for a persistence adapter. */
  exportEdits(): ChunkEdit<T>[] {
    const result: ChunkEdit<T>[] = [];
    for (const [key, values] of this.overrides) {
      const [cx, cy, cz] = key.split(',').map(Number);
      for (const [index, value] of values) {
        const local = localPosition(index, this.chunkSize);
        result.push({
          x: cx * this.chunkSize + local.x,
          y: cy * this.chunkSize + local.y,
          z: cz * this.chunkSize + local.z,
          value,
        });
      }
    }
    result.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
    return result;
  }

  loadedChunkCount(): number {
    return this.loaded.size;
  }
}
