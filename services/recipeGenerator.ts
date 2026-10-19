import { z } from 'zod';
import { VoxelMaterial, type VoxelData } from '../types';
const vec = z.tuple([
  z.number().finite().min(-256).max(256),
  z.number().finite().min(-256).max(256),
  z.number().finite().min(-256).max(256),
]);
export const recipeSchema = z.object({
  version: z.literal(1),
  seed: z.number().int().default(0),
  shapes: z
    .array(
      z.object({
        kind: z.enum(['box', 'ellipsoid', 'cylinder', 'terrain']),
        operation: z.enum(['add', 'subtract', 'paint']).default('add'),
        center: vec,
        size: z.tuple([
          z.number().positive().max(256),
          z.number().positive().max(256),
          z.number().positive().max(256),
        ]),
        color: z.number().int().min(0).max(0xffffff),
        material: z.enum(['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE']).default('STANDARD'),
        bone: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
          .optional(),
        noise: z.number().min(0).max(1).default(0.25),
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
  for (const shape of recipe.shapes) {
    const [cx, cy, cz] = shape.center;
    const [sx, sy, sz] = shape.size;
    const lo = shape.center.map((c, i) => Math.ceil(c - shape.size[i] / 2));
    const hi = shape.center.map((c, i) => Math.ceil(c + shape.size[i] / 2) - 1);
    visits += (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (visits > 4000000)
      throw new Error('Recipe exceeds the four million cell evaluation budget. Reduce size or shape count.');
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let zz = lo[2]; zz <= hi[2]; zz++) {
          const dx = ((x - cx) * 2) / sx,
            dy = ((y - cy) * 2) / sy,
            dz = ((zz - cz) * 2) / sz;
          if (shape.kind === 'ellipsoid' && dx * dx + dy * dy + dz * dz > 1) continue;
          if (shape.kind === 'cylinder' && dx * dx + dz * dz > 1) continue;
          if (shape.kind === 'terrain') {
            const wave = Math.sin((x + recipe.seed) * 0.19) * Math.cos((zz - recipe.seed) * 0.23);
            if (y > cy + sy * (wave * shape.noise - 0.1)) continue;
          }
          const key = `${x},${y},${zz}`;
          if (shape.operation === 'subtract') grid.delete(key);
          else if (shape.operation !== 'paint' || grid.has(key))
            grid.set(key, {
              x,
              y,
              z: zz,
              color: shape.color,
              materialType: shape.material as VoxelMaterial,
              isLocked: false,
              ...(shape.bone && { bone: shape.bone, weights: [{ bone: shape.bone, weight: 1 }] }),
            });
          if (grid.size > 250000) throw new Error('Recipe exceeds 250,000 voxels.');
        }
  }
  return [...grid.values()];
}
