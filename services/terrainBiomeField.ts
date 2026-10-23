import { z } from 'zod';
import { createNoise2D } from 'simplex-noise';
import { createSeededRandom } from './terrainNoise';

const color = z.number().int().min(0).max(0xffffff);

export const terrainPaletteSchema = z.object({
  surface: color,
  subsurface: color,
  deep: color,
  surfaceDepth: z.number().int().min(1).max(16).default(3),
  subsurfaceDepth: z.number().int().min(1).max(32).default(4),
  materialType: z.enum(['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE']),
});
export type TerrainPalette = z.infer<typeof terrainPaletteSchema>;

const terrainBiomeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(40),
  palette: terrainPaletteSchema,
});

export const terrainBiomeFieldSchema = z
  .object({
    scale: z.number().finite().min(8).max(1_000_000),
    biomes: z.array(terrainBiomeSchema).min(2).max(8),
  })
  .superRefine(({ biomes }, context) => {
    const ids = new Set<string>();
    biomes.forEach(({ id }, index) => {
      if (ids.has(id))
        context.addIssue({
          code: 'custom',
          path: ['biomes', index, 'id'],
          message: 'Biome IDs must be unique.',
        });
      ids.add(id);
    });
  });
export type TerrainBiomeField = z.infer<typeof terrainBiomeFieldSchema>;

const BIOME_BLEND_WIDTH = 0.3;

function mixColor(first: number, second: number, amount: number) {
  const channel = (shift: number) =>
    Math.round(((first >> shift) & 0xff) * (1 - amount) + ((second >> shift) & 0xff) * amount);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function blendPalette(first: TerrainPalette, second: TerrainPalette, amount: number): TerrainPalette {
  return {
    surface: mixColor(first.surface, second.surface, amount),
    subsurface: mixColor(first.subsurface, second.subsurface, amount),
    deep: mixColor(first.deep, second.deep, amount),
    surfaceDepth: Math.round(first.surfaceDepth * (1 - amount) + second.surfaceDepth * amount),
    subsurfaceDepth: Math.round(first.subsurfaceDepth * (1 - amount) + second.subsurfaceDepth * amount),
    materialType: amount < 0.5 ? first.materialType : second.materialType,
  };
}

/** Samples an optional seeded biome field in world meters, independent of terrain-cell spacing. */
export function createTerrainBiomeSampler(
  seed: number,
  voxelSize: number,
  fallback: TerrainPalette,
  field?: TerrainBiomeField,
) {
  if (!field) return (_x: number, _z: number) => fallback;
  const sample = createNoise2D(createSeededRandom(seed ^ 0x2f6e2b1));
  return (x: number, z: number) => {
    const position =
      (sample((x * voxelSize) / field.scale, (z * voxelSize) / field.scale) + 1) * 0.5 * field.biomes.length;
    const nearestBoundary = Math.round(position);
    if (
      nearestBoundary > 0 &&
      nearestBoundary < field.biomes.length &&
      Math.abs(position - nearestBoundary) < BIOME_BLEND_WIDTH / 2
    ) {
      const amount = (position - (nearestBoundary - BIOME_BLEND_WIDTH / 2)) / BIOME_BLEND_WIDTH;
      const easedAmount = amount * amount * (3 - 2 * amount);
      return blendPalette(
        field.biomes[nearestBoundary - 1].palette,
        field.biomes[nearestBoundary].palette,
        easedAmount,
      );
    }
    const index = Math.min(field.biomes.length - 1, Math.floor(position));
    return field.biomes[index].palette;
  };
}
