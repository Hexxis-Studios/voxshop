import { z } from 'zod';
import {
  createTerrainSurfaceSampler,
  createTerrainVolumeSampler,
  TERRAIN_CAVE_BRANCH_LIMIT,
  TERRAIN_CAVE_DEPTH_LIMIT,
  TERRAIN_CAVE_ENTRANCE_LIMIT,
  TERRAIN_CAVE_NETWORK_REACH_DEFAULT,
  TERRAIN_CAVE_NETWORK_REACH_LIMIT,
  TERRAIN_OVERHANG_HEIGHT_LIMIT,
} from './terrainNoise';
import {
  createTerrainBiomeSampler,
  terrainBiomeFieldSchema,
  terrainPaletteSchema,
} from './terrainBiomeField';
import { WorldChunkStore, type CellPosition } from './worldChunks';

const coordinate = z.number().int().safe().min(-1_000_000_000).max(1_000_000_000);
const color = z.number().int().min(0).max(0xffffff);
const materialType = z.enum(['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE']);
export const worldCellSchema = z.object({ color, materialType });
export type WorldCell = z.infer<typeof worldCellSchema>;

export const terrainGeneratorSchema = z
  .object({
    type: z.literal('terrain'),
    version: z.literal(1),
    // Omitted on existing project files; those continue to use the original heightfield generator.
    mode: z
      .enum(['heightfield', 'voxel3d'])
      .optional()
      .describe(
        'Omitted mode uses heightfield; voxel3d adds bounded 3D occupancy, caves, shafts and overhangs.',
      ),
    origin: z
      .tuple([coordinate, coordinate])
      .describe('Horizontal origin in logical terrain-cell coordinates (X, Z).'),
    // Extent bounds the deterministic generator, not resident memory. Chunks are evaluated on demand.
    size: z
      .tuple([z.number().int().min(1).max(1_000_000), z.number().int().min(1).max(1_000_000)])
      .describe('Finite horizontal extent in logical terrain cells; chunks are evaluated on demand.'),
    minY: z.number().int().min(-2048).max(2048),
    maxY: z.number().int().min(-2048).max(2048),
    baseHeight: z.number().int().min(-2048).max(2048),
    amplitude: z.number().finite().min(0).max(256),
    noise: z.number().min(0).max(1).default(0.25),
    landformScale: z.number().finite().min(1).max(1_000_000).optional(),
    caveDensity: z
      .number()
      .finite()
      .min(0)
      .max(1)
      .optional()
      .describe(
        `Optional seeded cave field; up to caveEntrancesPerRegion (default one, maximum four) separated 3×3 mouths can open per region when the field reaches the surface cap. With caveNetwork enabled, mouths within caveNetworkReach cells across connect to its trunk (default ${TERRAIN_CAVE_NETWORK_REACH_DEFAULT}).`,
      ),
    caveEntrancesPerRegion: z
      .number()
      .int()
      .min(0)
      .max(TERRAIN_CAVE_ENTRANCE_LIMIT)
      .optional()
      .describe(
        `Optional maximum seeded cave mouths per 256×256-cell region; defaults to one and is limited by cave density and a fixed candidate budget. The cave network connects mouths within caveNetworkReach cells across (default ${TERRAIN_CAVE_NETWORK_REACH_DEFAULT}).`,
      ),
    caveCrossPassage: z
      .boolean()
      .optional()
      .describe(
        'Optional connected perpendicular passage for the finite voxel3d cave; omitted/false preserves legacy geometry.',
      ),
    caveDepth: z
      .number()
      .int()
      .min(0)
      .max(TERRAIN_CAVE_DEPTH_LIMIT)
      .optional()
      .describe(
        `Depth of the finite main passage below baseHeight in terrain cells; 0 or omitted keeps automatic placement, and positive values clamp to the world's vertical bounds.`,
      ),
    caveBranchCount: z
      .number()
      .int()
      .min(0)
      .max(TERRAIN_CAVE_BRANCH_LIMIT)
      .optional()
      .describe(
        'Optional deterministic side passages connected to the main cave; small worlds may fit fewer than requested.',
      ),
    caveNetwork: z
      .boolean()
      .optional()
      .describe(
        'Optional deterministic curved cave trunk across the longer world axis, connected to the central entrance. Generated cave-density mouths within caveNetworkReach cells across join via bounded shafts and tunnels; farther mouths remain separate. Requires at least seven cells across and vertically; omitted/false preserves existing cave geometry.',
      ),
    caveNetworkReach: z
      .number()
      .int()
      .min(0)
      .max(TERRAIN_CAVE_NETWORK_REACH_LIMIT)
      .optional()
      .describe(
        `Maximum lateral reach in terrain cells for generated cave-mouth connectors; defaults to ${TERRAIN_CAVE_NETWORK_REACH_DEFAULT}, and 0 disables generated mouth-to-trunk connectors. The bounded maximum is ${TERRAIN_CAVE_NETWORK_REACH_LIMIT}.`,
      ),
    overhangDensity: z
      .number()
      .finite()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Optional seeded voxel3d overhang field; connected terrain extends above its heightfield surface up to overhangMaxHeight.',
      ),
    overhangMaxHeight: z
      .number()
      .int()
      .min(1)
      .max(TERRAIN_OVERHANG_HEIGHT_LIMIT)
      .optional()
      .describe(
        `Maximum connected voxel3d overhang height in terrain cells; defaults to eight and is capped at ${TERRAIN_OVERHANG_HEIGHT_LIMIT}.`,
      ),
    overhangProfile: z
      .array(z.number().finite().min(0).max(1))
      .min(1)
      .max(TERRAIN_OVERHANG_HEIGHT_LIMIT)
      .optional()
      .describe(
        'Optional normalized layer-density samples from the overhang base to its configured maximum height; samples are linearly interpolated, and omission preserves uniform density.',
      ),
    overhangFootprint: z
      .array(z.array(z.number().finite().min(0).max(1)).min(1).max(64))
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Optional rectangular 2D density mask over the world bounds; rows run along +Z, columns along +X, values interpolate across the map, and omission preserves the seeded horizontal field.',
      ),
    overhangHeightMap: z
      .array(z.array(z.number().finite().min(0).max(1)).min(1).max(64))
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Optional deterministic normalized overhang-height map over the world bounds; rows run along +Z, columns along +X, and each value scales the configured maximum height without seeded density noise.',
      ),
    palette: terrainPaletteSchema,
    biomeField: terrainBiomeFieldSchema
      .optional()
      .describe('Optional deterministic palette distribution sampled at a world-meter scale.'),
  })
  .superRefine((generator, context) => {
    if (generator.minY > generator.maxY)
      context.addIssue({ code: 'custom', message: 'Terrain minY must not exceed maxY.' });
    if (generator.baseHeight < generator.minY || generator.baseHeight > generator.maxY)
      context.addIssue({ code: 'custom', message: 'Terrain baseHeight must be within its vertical bounds.' });
    if (
      generator.overhangFootprint &&
      generator.overhangFootprint.some((row) => row.length !== generator.overhangFootprint![0].length)
    )
      context.addIssue({
        code: 'custom',
        path: ['overhangFootprint'],
        message: 'Overhang footprint rows must have the same number of samples.',
      });
    if (
      generator.overhangHeightMap &&
      generator.overhangHeightMap.some((row) => row.length !== generator.overhangHeightMap![0].length)
    )
      context.addIssue({
        code: 'custom',
        path: ['overhangHeightMap'],
        message: 'Overhang height-map rows must have the same number of samples.',
      });
    if (
      generator.origin[0] + generator.size[0] - 1 > 1_000_000_000 ||
      generator.origin[1] + generator.size[1] - 1 > 1_000_000_000
    )
      context.addIssue({ code: 'custom', message: 'Terrain bounds exceed the supported coordinate range.' });
  });
export type TerrainGenerator = z.infer<typeof terrainGeneratorSchema>;

export const worldEditSchema = z.object({
  x: coordinate.describe('Logical terrain-cell coordinate.'),
  y: coordinate.describe('Logical terrain-cell coordinate.'),
  z: coordinate.describe('Logical terrain-cell coordinate.'),
  value: worldCellSchema.nullable(),
});
export type WorldEdit = z.infer<typeof worldEditSchema>;

export const worldDocumentSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    name: z.string().trim().min(1).max(120),
    seed: z.number().int().min(-2147483648).max(2147483647),
    chunkSize: z.number().int().min(1).max(32),
    voxelSize: z
      .number()
      .positive()
      .min(0.001)
      .max(100)
      .describe('Meters per terrain cell; independent of asset voxel size and scene-node scale.'),
    generator: terrainGeneratorSchema,
    edits: z.array(worldEditSchema).max(250_000).default([]),
  })
  .superRefine((world, context) => {
    const cells = new Set<string>();
    for (const edit of world.edits) {
      const key = `${edit.x},${edit.y},${edit.z}`;
      if (cells.has(key)) {
        context.addIssue({ code: 'custom', message: 'World edits contain duplicate cell coordinates.' });
        return;
      }
      cells.add(key);
    }
  });
export type WorldDocument = z.infer<typeof worldDocumentSchema>;

/** Reads deterministic generated cells and sparse overrides without retaining hydrated chunks. */
export function createWorldCellSampler(
  input: WorldDocument,
): (position: CellPosition) => WorldCell | undefined {
  const world = worldDocumentSchema.parse(input);
  const generate = createWorldCellGenerator(world);
  const edits = new Map(world.edits.map((edit) => [`${edit.x},${edit.y},${edit.z}`, edit.value]));
  return (position) => {
    const key = `${position.x},${position.y},${position.z}`;
    if (edits.has(key)) return edits.get(key) ?? undefined;
    return generate(position);
  };
}

function createWorldCellGenerator(world: WorldDocument): (position: CellPosition) => WorldCell | undefined {
  const { generator } = world;
  const [originX, originZ] = generator.origin;
  const [width, depth] = generator.size;
  const surfaceAt = createTerrainSurfaceSampler(world);
  // Bound the working set independently of world extent or distance traveled.
  const columns = new Map<string, { surface: number; palette?: typeof generator.palette }>();
  const columnAt = (x: number, z: number) => {
    const key = `${x},${z}`;
    let column = columns.get(key);
    if (!column) {
      column = { surface: surfaceAt(x, z) };
      if (columns.size === 1024) columns.delete(columns.keys().next().value!);
      columns.set(key, column);
    }
    return column;
  };
  const solidAt =
    generator.mode === 'voxel3d' ? createTerrainVolumeSampler(world, (x, z) => columnAt(x, z).surface) : null;
  const paletteAt = createTerrainBiomeSampler(
    world.seed,
    world.voxelSize,
    generator.palette,
    generator.biomeField,
  );
  return (position) => {
    if (
      position.x < originX ||
      position.x >= originX + width ||
      position.z < originZ ||
      position.z >= originZ + depth ||
      position.y < generator.minY ||
      position.y > generator.maxY
    )
      return undefined;
    const column = columnAt(position.x, position.z);
    const surface = column.surface;
    if (solidAt ? !solidAt(position.x, position.y, position.z) : position.y > surface) return undefined;
    const layer = surface - position.y;
    const palette = (column.palette ??= paletteAt(position.x, position.z));
    return {
      color:
        layer < palette.surfaceDepth
          ? palette.surface
          : layer < palette.surfaceDepth + palette.subsurfaceDepth
            ? palette.subsurface
            : palette.deep,
      materialType: palette.materialType,
    };
  };
}

/** Adapts the persisted descriptor and sparse edits to the existing logical chunk store. */
export function createWorldChunkStore(input: WorldDocument): WorldChunkStore<WorldCell> {
  const world = worldDocumentSchema.parse(input);
  const chunks = new WorldChunkStore<WorldCell>(world.seed, world.chunkSize, createWorldCellGenerator(world));
  chunks.restoreEdits(world.edits);
  return chunks;
}
