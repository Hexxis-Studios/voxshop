import { z } from 'zod';
import { VoxelMaterial, type VoxelData } from '../types';
import { createTerrainNoise } from './terrainNoise';
const vec = z.tuple([
  z.number().finite().min(-256).max(256),
  z.number().finite().min(-256).max(256),
  z.number().finite().min(-256).max(256),
]);
const rotation = z
  .tuple([
    z
      .number()
      .finite()
      .min(-Math.PI * 2)
      .max(Math.PI * 2),
    z
      .number()
      .finite()
      .min(-Math.PI * 2)
      .max(Math.PI * 2),
    z
      .number()
      .finite()
      .min(-Math.PI * 2)
      .max(Math.PI * 2),
  ])
  .optional()
  .describe(
    'Optional Euler XYZ rotation in radians for box, ellipsoid, and cylinder shapes; not valid for terrain. Each angle is -2π..2π.',
  );

function makeRotationMatrix([x, y, z]: [number, number, number]) {
  const cx = Math.cos(x),
    sx = Math.sin(x),
    cy = Math.cos(y),
    sy = Math.sin(y),
    cz = Math.cos(z),
    sz = Math.sin(z);
  const snap = (value: number) => (Math.abs(value) < 1e-12 ? 0 : value);
  return [
    [snap(cz * cy), snap(cz * sy * sx - sz * cx), snap(cz * sy * cx + sz * sx)],
    [snap(sz * cy), snap(sz * sy * sx + cz * cx), snap(sz * sy * cx - cz * sx)],
    [snap(-sy), snap(cy * sx), snap(cy * cx)],
  ];
}

export const recipeSchema = z.object({
  version: z.literal(1),
  seed: z.number().int().default(0),
  shapes: z
    .array(
      z
        .object({
          kind: z
            .enum(['box', 'ellipsoid', 'cylinder', 'ramp', 'terrain'])
            .describe('Ramp is a solid voxel wedge that rises toward positive local X.'),
          operation: z.enum(['add', 'subtract', 'paint']).default('add'),
          center: vec,
          rotation,
          size: z.tuple([
            z.number().positive().max(256),
            z.number().positive().max(256),
            z.number().positive().max(256),
          ]),
          color: z.number().int().min(0).max(0xffffff),
          material: z.enum(['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE']).default('STANDARD'),
          palette: z
            .object({
              surface: z.number().int().min(0).max(0xffffff),
              subsurface: z.number().int().min(0).max(0xffffff),
              deep: z.number().int().min(0).max(0xffffff),
              surfaceDepth: z.number().int().min(1).max(16).default(3),
              subsurfaceDepth: z.number().int().min(1).max(32).default(4),
            })
            .optional(),
          bone: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
            .optional(),
          noise: z.number().min(0).max(1).default(0.25),
        })
        .superRefine((shape, context) => {
          if (shape.palette && shape.kind !== 'terrain')
            context.addIssue({
              code: 'custom',
              message: 'Terrain palettes can only be used on terrain shapes.',
            });
          if (shape.rotation && shape.kind === 'terrain')
            context.addIssue({
              code: 'custom',
              path: ['rotation'],
              message: 'Terrain recipe shapes do not support rotation.',
            });
        }),
    )
    .min(1)
    .max(256),
});
export type Recipe = z.infer<typeof recipeSchema>;
/** Composable mathematical solids, deterministic, bounded, independent of any model provider. */
export function generateRecipe(input: unknown): VoxelData[] {
  const recipe = recipeSchema.parse(input);
  const grid = new Map<string, VoxelData>();
  let visits = 0;
  for (const [index, shape] of recipe.shapes.entries()) {
    const [cx, cy, cz] = shape.center;
    const [sx, sy, sz] = shape.size;
    const matrix = shape.rotation?.some((angle) => angle !== 0) ? makeRotationMatrix(shape.rotation) : null;
    let lo = shape.center.map((c, i) => Math.ceil(c - shape.size[i] / 2));
    let hi = shape.center.map((c, i) => Math.ceil(c + shape.size[i] / 2) - 1);
    if (matrix) {
      const half = [sx / 2, sy / 2, sz / 2];
      const extent = matrix.map((row) =>
        row.reduce((sum, coefficient, axis) => sum + Math.abs(coefficient) * half[axis], 0),
      );
      lo = shape.center.map((center, axis) => Math.ceil(center - extent[axis]));
      hi = shape.center.map((center, axis) => Math.ceil(center + extent[axis]) - 1);
    }
    visits += (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (visits > 4000000)
      throw new Error('Recipe exceeds the four million cell evaluation budget. Reduce size or shape count.');
    const place = (x: number, y: number, z: number, color = shape.color) => {
      const key = `${x},${y},${z}`;
      if (shape.operation === 'subtract') grid.delete(key);
      else if (shape.operation !== 'paint' || grid.has(key))
        grid.set(key, {
          x,
          y,
          z,
          color,
          materialType: shape.material as VoxelMaterial,
          isLocked: false,
          ...(shape.bone && { bone: shape.bone, weights: [{ bone: shape.bone, weight: 1 }] }),
        });
      if (grid.size > 250000) throw new Error('Recipe exceeds 250,000 voxels.');
    };
    if (shape.kind === 'terrain') {
      const width = hi[0] - lo[0] + 1,
        depth = hi[2] - lo[2] + 1,
        heights = new Float32Array(width * depth),
        sample = createTerrainNoise(recipe.seed ^ Math.imul(index + 1, 0x9e3779b9));
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let z = lo[2]; z <= hi[2]; z++)
          heights[(x - lo[0]) * depth + z - lo[2]] = cy + sy * (sample(x, z) * shape.noise - 0.1);
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const surface = heights[(x - lo[0]) * depth + z - lo[2]];
          const top = Math.floor(surface);
          for (let y = lo[1]; y <= hi[1] && y <= surface; y++) {
            const depth = top - y,
              palette = shape.palette,
              color = palette
                ? depth < palette.surfaceDepth
                  ? palette.surface
                  : depth < palette.surfaceDepth + palette.subsurfaceDepth
                    ? palette.subsurface
                    : palette.deep
                : shape.color;
            place(x, y, z, color);
          }
        }
      continue;
    }
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          let dx: number, dy: number, dz: number;
          if (matrix) {
            const wx = x - cx,
              wy = y - cy,
              wz = z - cz;
            dx = ((matrix[0][0] * wx + matrix[1][0] * wy + matrix[2][0] * wz) * 2) / sx;
            dy = ((matrix[0][1] * wx + matrix[1][1] * wy + matrix[2][1] * wz) * 2) / sy;
            dz = ((matrix[0][2] * wx + matrix[1][2] * wy + matrix[2][2] * wz) * 2) / sz;
          } else {
            dx = ((x - cx) * 2) / sx;
            dy = ((y - cy) * 2) / sy;
            dz = ((z - cz) * 2) / sz;
          }
          if (matrix && shape.kind === 'box' && (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(dz) > 1))
            continue;
          if (shape.kind === 'ramp' && (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(dz) > 1 || dy > dx))
            continue;
          if (shape.kind === 'ellipsoid' && dx * dx + dy * dy + dz * dz > 1) continue;
          if (shape.kind === 'cylinder' && dx * dx + dz * dz > 1) continue;
          place(x, y, z);
        }
  }
  return [...grid.values()];
}
