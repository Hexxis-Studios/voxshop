import type { Box3 } from 'three';

/** X/Z broad phase. Exact 3D intersection remains the caller's responsibility. */
export class SpatialIndex {
  private cells = new Map<string, Set<string>>();
  private membership = new Map<string, string[]>();
  private large = new Set<string>();
  constructor(private cellSize = 8) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw Error('Cell size must be positive.');
  }
  private keys(box: Box3): string[] | null {
    const x = Math.floor(box.min.x / this.cellSize),
      z = Math.floor(box.min.z / this.cellSize);
    const endX = Math.floor(box.max.x / this.cellSize),
      endZ = Math.floor(box.max.z / this.cellSize);
    if (![x, z, endX, endZ].every(Number.isFinite) || (endX - x + 1) * (endZ - z + 1) > 4096) return null;
    const keys: string[] = [];
    for (let i = x; i <= endX; i++) for (let j = z; j <= endZ; j++) keys.push(`${i}:${j}`);
    return keys;
  }
  set(id: string, box: Box3) {
    const keys = this.keys(box),
      previous = this.membership.get(id);
    if (keys === null && previous !== undefined && this.large.has(id)) return;
    if (
      keys !== null &&
      previous !== undefined &&
      !this.large.has(id) &&
      keys.length === previous.length &&
      keys.every((key, i) => key === previous[i])
    )
      return;
    this.delete(id);
    this.membership.set(id, keys ?? []);
    if (!keys) {
      this.large.add(id);
      return;
    }
    for (const key of keys) {
      if (!this.cells.has(key)) this.cells.set(key, new Set());
      this.cells.get(key)!.add(id);
    }
  }
  delete(id: string) {
    for (const key of this.membership.get(id) ?? []) {
      const cell = this.cells.get(key)!;
      cell.delete(id);
      if (!cell.size) this.cells.delete(key);
    }
    this.membership.delete(id);
    this.large.delete(id);
  }
  query(box: Box3): Set<string> {
    const keys = this.keys(box);
    if (!keys) return new Set(this.membership.keys());
    const result = new Set(this.large);
    for (const key of keys) for (const id of this.cells.get(key) ?? []) result.add(id);
    return result;
  }
}
