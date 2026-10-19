import type { Asset } from './projectDocument';
/** Bounded, dependency-free isometric preview. SVG contains no external resources or user markup. */
export function assetPreview(asset: Asset): string {
  const data = asset.model.voxels;
  if (!data.length)
    return '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#111827"/><text x="170" y="256" fill="white">Empty asset</text></svg>';
  const points = data.map((v) => ({ v, x: (v.x - v.z) * 0.866, y: (v.x + v.z) * 0.5 - v.y }));
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]);
    maxY = Math.max(maxY, ys[i]);
  }
  const scale = Math.min(440 / (maxX - minX + 2), 440 / (maxY - minY + 2));
  const grid = new Set(data.map((v) => `${v.x},${v.y},${v.z}`));
  const polygons: string[] = [];
  const shade = (c: number, m: number) =>
    '#' +
    [c >> 16, (c >> 8) & 255, c & 255]
      .map((n) =>
        Math.min(255, Math.round(n * m))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  const face = (x: number, y: number, offsets: number[][], color: string) =>
    polygons.push(
      `<polygon points="${offsets.map(([a, b]) => `${(x + a * scale).toFixed(2)},${(y + b * scale).toFixed(2)}`).join(' ')}" fill="${color}" stroke="${color}" stroke-width="0.3"/>`,
    );
  const sorted = points
    .filter(
      ({ v }) =>
        !grid.has(`${v.x + 1},${v.y},${v.z}`) ||
        !grid.has(`${v.x},${v.y + 1},${v.z}`) ||
        !grid.has(`${v.x},${v.y},${v.z + 1}`),
    )
    .sort((a, b) => a.v.x + a.v.y + a.v.z - b.v.x - b.v.y - b.v.z);
  if (sorted.length > 40000)
    throw new Error('Preview exceeds 40,000 visible voxels. Preview a lower-detail variant.');
  for (const { v, x: px, y: py } of sorted) {
    const x = 256 + (px - (minX + maxX) / 2) * scale,
      y = 256 + (py - (minY + maxY) / 2) * scale;
    if (!grid.has(`${v.x + 1},${v.y},${v.z}`))
      face(
        x,
        y,
        [
          [0, 1],
          [0.866, 0.5],
          [0.866, -0.5],
          [0, 0],
        ],
        shade(v.color, 0.8),
      );
    if (!grid.has(`${v.x},${v.y},${v.z + 1}`))
      face(
        x,
        y,
        [
          [0, 1],
          [-0.866, 0.5],
          [-0.866, -0.5],
          [0, 0],
        ],
        shade(v.color, 0.6),
      );
    if (!grid.has(`${v.x},${v.y + 1},${v.z}`))
      face(
        x,
        y,
        [
          [0, -1],
          [-0.866, -0.5],
          [0, 0],
          [0.866, -0.5],
        ],
        shade(v.color, 1),
      );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="16" fill="#111827"/>${polygons.join('')}</svg>`;
}
