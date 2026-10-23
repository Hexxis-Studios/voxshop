import { createNoise2D, createNoise3D } from 'simplex-noise';

export function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic, normalized four-octave height variation in approximately [-1, 1]. */
export function createTerrainNoise(seed: number, frequency = 0.035) {
  const sample = createNoise2D(createSeededRandom(seed));
  return (x: number, z: number) => {
    let amplitude = 1,
      octaveFrequency = frequency,
      value = 0,
      weight = 0;
    for (let octave = 0; octave < 4; octave++) {
      value += sample(x * octaveFrequency, z * octaveFrequency) * amplitude;
      weight += amplitude;
      amplitude *= 0.5;
      octaveFrequency *= 2;
    }
    return value / weight;
  };
}

type TerrainSurfaceWorld = {
  seed: number;
  voxelSize: number;
  generator: {
    minY: number;
    maxY: number;
    baseHeight: number;
    amplitude: number;
    noise: number;
    landformScale?: number;
  };
};

/** Returns the generated surface cell at integer terrain-cell coordinates. */
export function createTerrainSurfaceSampler(world: TerrainSurfaceWorld) {
  const { generator } = world;
  const sample = createTerrainNoise(
    world.seed,
    generator.landformScale === undefined ? undefined : world.voxelSize / generator.landformScale,
  );
  return (x: number, z: number) =>
    Math.max(
      generator.minY,
      Math.min(
        generator.maxY,
        Math.floor(generator.baseHeight + sample(x, z) * generator.amplitude * generator.noise),
      ),
    );
}

type TerrainVolumeWorld = TerrainSurfaceWorld & {
  generator: TerrainSurfaceWorld['generator'] & {
    origin: [number, number];
    size: [number, number];
    minY: number;
    maxY: number;
    caveDensity?: number;
    caveEntrancesPerRegion?: number;
    caveDepth?: number;
    caveCrossPassage?: boolean;
    caveBranchCount?: number;
    caveNetwork?: boolean;
    caveNetworkReach?: number;
    overhangDensity?: number;
    overhangMaxHeight?: number;
    overhangProfile?: number[];
    overhangFootprint?: number[][];
    overhangHeightMap?: number[][];
  };
};

export type TerrainCellBounds = { minX: number; maxX: number; minZ: number; maxZ: number };
type CaveEntrance = { x: number; z: number };
type CavePoint = [number, number, number];
export type TerrainCaveNetworkConnector = {
  shaft: [CavePoint, CavePoint];
  tunnel: [CavePoint, CavePoint];
};
type CaveNetworkConnector = TerrainCaveNetworkConnector;
const CAVE_FIELD_FREQUENCY = 0.035;
const CAVE_ENTRANCE_REGION_SIZE = 256;
const CAVE_ENTRANCE_ATTEMPTS = 8;
export const TERRAIN_CAVE_ENTRANCE_REGION_SIZE = CAVE_ENTRANCE_REGION_SIZE;
export const TERRAIN_CAVE_ENTRANCE_LIMIT = 4;
export const TERRAIN_CAVE_NETWORK_CONNECTOR_RADIUS = 2;
export const TERRAIN_CAVE_NETWORK_MAX_CONNECTORS_PER_TILE = TERRAIN_CAVE_ENTRANCE_LIMIT * 3 * 35;
const CAVE_ENTRANCE_MIN_SEPARATION = 32;
const CAVE_NETWORK_CONNECTOR_RADIUS_SQUARED = TERRAIN_CAVE_NETWORK_CONNECTOR_RADIUS ** 2;
export const TERRAIN_CAVE_NETWORK_REACH_DEFAULT = 256;
export const TERRAIN_CAVE_NETWORK_REACH_LIMIT = 4096;
export const TERRAIN_CAVE_DEPTH_LIMIT = 256;
export const TERRAIN_CAVE_BRANCH_LIMIT = 4;
export const TERRAIN_OVERHANG_DEFAULT_MAX_HEIGHT = 8;
export const TERRAIN_OVERHANG_HEIGHT_LIMIT = 64;
const OVERHANG_FIELD_FREQUENCY = 0.07;

function sampleNormalizedGrid(
  grid: number[][],
  origin: [number, number],
  size: [number, number],
  x: number,
  z: number,
) {
  const [originX, originZ] = origin;
  const [width, depth] = size;
  const gridWidth = grid[0].length;
  const gridHeight = grid.length;
  const sampleX = width <= 1 ? 0 : ((x - originX) / (width - 1)) * (gridWidth - 1);
  const sampleZ = depth <= 1 ? 0 : ((z - originZ) / (depth - 1)) * (gridHeight - 1);
  const x0 = Math.floor(sampleX),
    z0 = Math.floor(sampleZ),
    x1 = Math.min(gridWidth - 1, x0 + 1),
    z1 = Math.min(gridHeight - 1, z0 + 1),
    tx = sampleX - x0,
    tz = sampleZ - z0;
  const lower = grid[z0][x0] + (grid[z0][x1] - grid[z0][x0]) * tx;
  const upper = grid[z1][x0] + (grid[z1][x1] - grid[z1][x0]) * tx;
  return lower + (upper - lower) * tz;
}

/** Samples an authored normalized height map as a deterministic integer extension above the surface. */
export function sampleTerrainOverhangHeightMap(world: TerrainVolumeWorld, x: number, z: number) {
  const { generator } = world;
  const map = generator.overhangHeightMap;
  if (!map) return 0;
  const [originX, originZ] = generator.origin;
  const [width, depth] = generator.size;
  if (x < originX || x >= originX + width || z < originZ || z >= originZ + depth) return 0;
  const normalizedHeight = sampleNormalizedGrid(map, generator.origin, generator.size, x, z);
  const maximum = Math.max(
    1,
    Math.min(
      TERRAIN_OVERHANG_HEIGHT_LIMIT,
      Math.floor(generator.overhangMaxHeight ?? TERRAIN_OVERHANG_DEFAULT_MAX_HEIGHT),
    ),
  );
  return Math.round(normalizedHeight * maximum);
}

/** Center of the generated cave mouth and shaft in terrain-cell coordinates. */
export function terrainCaveEntrance(world: Pick<TerrainVolumeWorld, 'generator'>) {
  const { origin, size } = world.generator;
  return {
    x: origin[0] + Math.floor(size[0] / 2),
    z: origin[1] + Math.floor(size[1] / 2),
  };
}

export type TerrainCaveBranch = { x: number; direction: -1 | 1; length: number };

/** Bounded, deterministic side passages attached to the finite main cave tunnel. */
export function terrainCaveBranches(
  world: Pick<TerrainVolumeWorld, 'seed' | 'generator'>,
): TerrainCaveBranch[] {
  const requested = Math.max(
    0,
    Math.min(TERRAIN_CAVE_BRANCH_LIMIT, Math.floor(world.generator.caveBranchCount ?? 0)),
  );
  const entrance = terrainCaveEntrance(world);
  const caveHalfLength = Math.max(2, Math.min(12, Math.floor(world.generator.size[0] / 2) - 2));
  const maxOffset = caveHalfLength - 4;
  const count = Math.min(requested, Math.floor(maxOffset / 2));
  if (count < 1) return [];

  const branchHalfLength = Math.max(2, Math.min(12, Math.floor(world.generator.size[1] / 2) - 2));
  const random = createSeededRandom(world.seed ^ 0x4b1d5a37);
  return Array.from({ length: count }, (_, index) => ({
    x: entrance.x + Math.round(-maxOffset + ((index + 1) * 2 * maxOffset) / (count + 1)),
    direction: random() < 0.5 ? -1 : 1,
    length: Math.max(2, Math.floor(branchHalfLength * (0.55 + random() * 0.45))),
  }));
}

/** Center of the finite cave passage; zero/omitted depth keeps the original amplitude-based placement. */
export function terrainCaveCenterY(world: Pick<TerrainVolumeWorld, 'generator'>) {
  const { generator } = world;
  const defaultDepth = Math.max(4, Math.min(12, Math.round(generator.amplitude * 0.2)));
  const requestedDepth = generator.caveDepth ?? 0;
  if (requestedDepth <= 0) return generator.baseHeight - defaultDepth;
  const depth = Math.min(TERRAIN_CAVE_DEPTH_LIMIT, Math.floor(requestedDepth));
  const margin = Math.min(3, Math.floor((generator.maxY - generator.minY) / 2));
  const lowestCenter = generator.minY + margin;
  const highestCenter = generator.maxY - margin;
  return Math.max(lowestCenter, Math.min(highestCenter, generator.baseHeight - depth));
}

export type TerrainCaveNetworkPath = {
  axis: 'x' | 'z';
  at: (along: number) => { x: number; y: number; z: number };
};

export const TERRAIN_CAVE_NETWORK_LATERAL_RADIUS = 3;
export const TERRAIN_CAVE_NETWORK_VERTICAL_RADIUS = 2.5;
export const TERRAIN_CAVE_NETWORK_BRANCH_RADIUS = 2.5;

/** Creates an opt-in deterministic trunk that curves across the longer world axis. */
export function createTerrainCaveNetworkPath(
  world: Pick<TerrainVolumeWorld, 'seed' | 'generator'>,
): TerrainCaveNetworkPath | null {
  const { generator } = world;
  if (generator.caveNetwork !== true) return null;
  const [originX, originZ] = generator.origin;
  const [width, depth] = generator.size;
  const axis: 'x' | 'z' = width >= depth ? 'x' : 'z';
  const alongOrigin = axis === 'x' ? originX : originZ;
  const alongSize = axis === 'x' ? width : depth;
  const crossOrigin = axis === 'x' ? originZ : originX;
  const crossSize = axis === 'x' ? depth : width;
  const lateralRadius = TERRAIN_CAVE_NETWORK_LATERAL_RADIUS;
  const verticalRadius = TERRAIN_CAVE_NETWORK_VERTICAL_RADIUS;
  if (crossSize < lateralRadius * 2 + 1 || generator.maxY - generator.minY < Math.ceil(verticalRadius) * 2)
    return null;

  const alongCenter = alongOrigin + Math.floor(alongSize / 2);
  const crossCenter = crossOrigin + Math.floor(crossSize / 2);
  const maxWander = Math.max(
    0,
    Math.min(
      12,
      crossCenter - crossOrigin - lateralRadius,
      crossOrigin + crossSize - 1 - lateralRadius - crossCenter,
    ),
  );
  const noise = createNoise3D(createSeededRandom(world.seed ^ 0x17c29b4d));
  const frequency = 0.006;
  const noiseAt = (along: number) =>
    axis === 'x' ? noise(along * frequency, 1.73, 5.37) : noise(1.73, along * frequency, 5.37);
  const centerNoise = noiseAt(alongCenter);
  const lowestPossibleSurface = generator.baseHeight - generator.amplitude * generator.noise;
  const desiredY = Math.min(terrainCaveCenterY(world), Math.floor(lowestPossibleSurface) - 6);
  const centerY = Math.max(
    generator.minY + Math.ceil(verticalRadius),
    Math.min(generator.maxY - Math.ceil(verticalRadius), desiredY),
  );
  const cache = new Map<number, { x: number; y: number; z: number }>();

  return {
    axis,
    at(along: number) {
      const coordinate = Math.max(alongOrigin, Math.min(alongOrigin + alongSize - 1, Math.floor(along)));
      const cached = cache.get(coordinate);
      if (cached) return cached;
      const cross = Math.max(
        crossOrigin + lateralRadius,
        Math.min(
          crossOrigin + crossSize - 1 - lateralRadius,
          crossCenter + (noiseAt(coordinate) - centerNoise) * maxWander * 0.5,
        ),
      );
      const point =
        axis === 'x' ? { x: coordinate, y: centerY, z: cross } : { x: cross, y: centerY, z: coordinate };
      if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
      cache.set(coordinate, point);
      return point;
    },
  };
}

/** Tests a terrain-cell coordinate against the shared cave-network tunnel profile. */
export function terrainCaveNetworkContains(path: TerrainCaveNetworkPath, x: number, y: number, z: number) {
  const point = path.at(path.axis === 'x' ? x : z);
  const lateral = path.axis === 'x' ? z - point.z : x - point.x;
  return (
    (lateral / TERRAIN_CAVE_NETWORK_LATERAL_RADIUS) ** 2 +
      ((y - point.y) / TERRAIN_CAVE_NETWORK_VERTICAL_RADIUS) ** 2 <
    1
  );
}

export type TerrainCaveNetworkBranch = { along: number; direction: -1 | 1; length: number };

/** Places the authored side-passage count along the world trunk when the network option is enabled. */
export function terrainCaveNetworkBranches(
  world: Pick<TerrainVolumeWorld, 'seed' | 'generator'>,
  path = createTerrainCaveNetworkPath(world),
): TerrainCaveNetworkBranch[] {
  const requested = Math.max(
    0,
    Math.min(TERRAIN_CAVE_BRANCH_LIMIT, Math.floor(world.generator.caveBranchCount ?? 0)),
  );
  if (!path || requested === 0) return [];
  const [originX, originZ] = world.generator.origin;
  const [width, depth] = world.generator.size;
  const alongOrigin = path.axis === 'x' ? originX : originZ;
  const alongSize = path.axis === 'x' ? width : depth;
  const crossOrigin = path.axis === 'x' ? originZ : originX;
  const crossSize = path.axis === 'x' ? depth : width;
  const margin = Math.min(8, Math.floor(alongSize / 4));
  const available = alongSize - margin * 2;
  const count = Math.min(requested, Math.floor(available / 8));
  if (count < 1) return [];

  const random = createSeededRandom(world.seed ^ 0x72f51ab3);
  const branches: TerrainCaveNetworkBranch[] = [];
  for (let index = 0; index < count; index++) {
    const along = alongOrigin + margin + Math.floor(((index + 1) * available) / (count + 1));
    const center = path.at(along);
    const centerCross = path.axis === 'x' ? center.z : center.x;
    const direction: -1 | 1 = random() < 0.5 ? -1 : 1;
    const edgeDistance =
      direction > 0 ? crossOrigin + crossSize - 1 - 3 - centerCross : centerCross - (crossOrigin + 3);
    const length = Math.floor(Math.min(64, edgeDistance) * (0.6 + random() * 0.35));
    if (length >= 4) branches.push({ along, direction, length });
  }
  return branches;
}

/** Tests a source cell against a bounded, dead-end branch attached to the cave trunk. */
export function terrainCaveNetworkBranchContains(
  path: TerrainCaveNetworkPath,
  branch: TerrainCaveNetworkBranch,
  x: number,
  y: number,
  z: number,
) {
  const along = path.axis === 'x' ? x : z;
  const alongOffset = along - branch.along;
  if (Math.abs(alongOffset) >= 2.5) return false;
  const center = path.at(branch.along);
  const centerCross = path.axis === 'x' ? center.z : center.x;
  const cross = path.axis === 'x' ? z : x;
  const distance = (cross - centerCross) * branch.direction;
  return (
    distance >= -2 &&
    distance <= branch.length &&
    (alongOffset / TERRAIN_CAVE_NETWORK_BRANCH_RADIUS) ** 2 +
      ((y - center.y) / TERRAIN_CAVE_NETWORK_BRANCH_RADIUS) ** 2 <
      1
  );
}

function createCaveEntranceLookup(
  world: TerrainVolumeWorld,
  surfaceAt: (x: number, z: number) => number,
  caveField: (x: number, y: number, z: number) => number,
) {
  const { generator } = world;
  const density = generator.caveDensity ?? 0;
  const requestedEntrances = Math.max(
    0,
    Math.min(TERRAIN_CAVE_ENTRANCE_LIMIT, Math.floor(generator.caveEntrancesPerRegion ?? 1)),
  );
  const [originX, originZ] = generator.origin;
  const [width, depth] = generator.size;
  const legacyEntrance = terrainCaveEntrance(world);
  const caveHalfLength = Math.max(2, Math.min(12, Math.floor(width / 2) - 2));
  const cache = new Map<string, CaveEntrance[]>();

  return (regionX: number, regionZ: number): CaveEntrance[] => {
    const key = `${regionX},${regionZ}`;
    if (cache.has(key)) return cache.get(key)!;
    if (density <= 0 || requestedEntrances === 0) {
      cache.set(key, []);
      return [];
    }

    const random = createSeededRandom(
      world.seed ^ Math.imul(regionX, 0x9e3779b1) ^ Math.imul(regionZ, 0x85ebca6b) ^ 0x7f4a7c15,
    );
    const entrances: CaveEntrance[] = [];
    for (let attempt = 0; attempt < CAVE_ENTRANCE_ATTEMPTS * requestedEntrances; attempt++) {
      // Keep the 3×3 mouth inside its region so each voxel can resolve it with one lookup.
      const x =
        regionX * CAVE_ENTRANCE_REGION_SIZE + 1 + Math.floor(random() * (CAVE_ENTRANCE_REGION_SIZE - 2));
      const z =
        regionZ * CAVE_ENTRANCE_REGION_SIZE + 1 + Math.floor(random() * (CAVE_ENTRANCE_REGION_SIZE - 2));
      if (x < originX || x >= originX + width || z < originZ || z >= originZ + depth) continue;
      if (Math.hypot(x - legacyEntrance.x, z - legacyEntrance.z) <= caveHalfLength + 4) continue;
      if (
        entrances.some(
          (existing) => Math.hypot(x - existing.x, z - existing.z) < CAVE_ENTRANCE_MIN_SEPARATION,
        )
      )
        continue;

      const caveY = surfaceAt(x, z) - 3;
      if (caveY < generator.minY + 2) continue;
      if (
        caveField(x * CAVE_FIELD_FREQUENCY, caveY * CAVE_FIELD_FREQUENCY, z * CAVE_FIELD_FREQUENCY) >
        1 - density
      ) {
        entrances.push({ x, z });
        if (entrances.length >= requestedEntrances) break;
      }
    }
    if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
    cache.set(key, entrances);
    return entrances;
  };
}

function createCaveNetworkConnectorLookup(
  world: TerrainVolumeWorld,
  path: TerrainCaveNetworkPath,
  surfaceAt: (x: number, z: number) => number,
  entrancesInRegion: (regionX: number, regionZ: number) => CaveEntrance[],
  maxConnectorLength: number,
) {
  const [originX, originZ] = world.generator.origin;
  const [width, depth] = world.generator.size;
  const alongOrigin = path.axis === 'x' ? originX : originZ;
  const alongSize = path.axis === 'x' ? width : depth;
  const crossOrigin = path.axis === 'x' ? originZ : originX;
  const crossSize = path.axis === 'x' ? depth : width;
  const cache = new Map<string, Map<number, CaveNetworkConnector[]>>();
  return (regionX: number, regionZ: number) => {
    const key = `${regionX},${regionZ}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const alongRegion = path.axis === 'x' ? regionX : regionZ;
    const crossRegion = path.axis === 'x' ? regionZ : regionX;
    const alongStart = Math.max(alongOrigin, alongRegion * CAVE_ENTRANCE_REGION_SIZE);
    const alongEnd = Math.min(alongOrigin + alongSize - 1, (alongRegion + 1) * CAVE_ENTRANCE_REGION_SIZE - 1);
    const crossStart = Math.max(crossOrigin, crossRegion * CAVE_ENTRANCE_REGION_SIZE);
    const crossEnd = Math.min(crossOrigin + crossSize - 1, (crossRegion + 1) * CAVE_ENTRANCE_REGION_SIZE - 1);
    // One aligned 64/256-cell tile scans at most 3 along-axis by 35 cross-axis source regions.
    const firstAlongRegion = Math.floor(Math.max(alongOrigin, alongStart - 2) / CAVE_ENTRANCE_REGION_SIZE);
    const lastAlongRegion = Math.floor(
      Math.min(alongOrigin + alongSize - 1, alongEnd + 2) / CAVE_ENTRANCE_REGION_SIZE,
    );
    const firstCrossRegion = Math.floor(
      Math.max(crossOrigin, crossStart - maxConnectorLength - 2) / CAVE_ENTRANCE_REGION_SIZE,
    );
    const lastCrossRegion = Math.floor(
      Math.min(crossOrigin + crossSize - 1, crossEnd + maxConnectorLength + 2) / CAVE_ENTRANCE_REGION_SIZE,
    );
    const connectors = new Map<number, CaveNetworkConnector[]>();
    for (let sourceAlongRegion = firstAlongRegion; sourceAlongRegion <= lastAlongRegion; sourceAlongRegion++)
      for (
        let sourceCrossRegion = firstCrossRegion;
        sourceCrossRegion <= lastCrossRegion;
        sourceCrossRegion++
      ) {
        const sourceRegionX = path.axis === 'x' ? sourceAlongRegion : sourceCrossRegion;
        const sourceRegionZ = path.axis === 'x' ? sourceCrossRegion : sourceAlongRegion;
        for (const { x, z } of entrancesInRegion(sourceRegionX, sourceRegionZ)) {
          const along = path.axis === 'x' ? x : z;
          if (along < alongStart - 2 || along > alongEnd + 2) continue;
          const point = path.at(along);
          const mouthCross = path.axis === 'x' ? z : x;
          const trunkCross = path.axis === 'x' ? point.z : point.x;
          if (
            Math.abs(mouthCross - trunkCross) > maxConnectorLength ||
            Math.max(mouthCross, trunkCross) + 2 < crossStart ||
            Math.min(mouthCross, trunkCross) - 2 > crossEnd
          )
            continue;
          const mouthY = surfaceAt(x, z) - 3;
          const bend: CavePoint = [x, point.y, z];
          const alongConnectors = connectors.get(along) ?? [];
          alongConnectors.push({
            shaft: [[x, mouthY, z], bend],
            tunnel: [bend, [point.x, point.y, point.z]],
          });
          connectors.set(along, alongConnectors);
        }
      }
    if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
    cache.set(key, connectors);
    return connectors;
  };
}

function caveConnectorSegmentContains(segment: [CavePoint, CavePoint], x: number, y: number, z: number) {
  const [start, end] = segment;
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const deltaZ = end[2] - start[2];
  const lengthSquared = deltaX ** 2 + deltaY ** 2 + deltaZ ** 2;
  const offsetX = x - start[0];
  const offsetY = y - start[1];
  const offsetZ = z - start[2];
  const along =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, (offsetX * deltaX + offsetY * deltaY + offsetZ * deltaZ) / lengthSquared));
  const distanceX = offsetX - deltaX * along;
  const distanceY = offsetY - deltaY * along;
  const distanceZ = offsetZ - deltaZ * along;
  return distanceX ** 2 + distanceY ** 2 + distanceZ ** 2 < CAVE_NETWORK_CONNECTOR_RADIUS_SQUARED;
}

function caveNetworkConnectorsContain(
  connectorsByAlong: Map<number, CaveNetworkConnector[]>,
  axis: 'x' | 'z',
  x: number,
  y: number,
  z: number,
) {
  const along = Math.floor(axis === 'x' ? x : z);
  for (let candidateAlong = along - 2; candidateAlong <= along + 2; candidateAlong++)
    if (
      connectorsByAlong
        .get(candidateAlong)
        ?.some(
          (connector) =>
            caveConnectorSegmentContains(connector.shaft, x, y, z) ||
            caveConnectorSegmentContains(connector.tunnel, x, y, z),
        )
    )
      return true;
  return false;
}

/** Returns deterministic cave-field mouths intersecting a bounded horizontal tile. */
export function terrainCaveEntrancesIn(
  world: TerrainVolumeWorld,
  bounds: TerrainCellBounds,
  surfaceAt = createTerrainSurfaceSampler(world),
): CaveEntrance[] {
  if ((world.generator.caveDensity ?? 0) <= 0) return [];
  const caveField = createNoise3D(createSeededRandom(world.seed ^ 0x6d2b79f5));
  const entranceInRegion = createCaveEntranceLookup(world, surfaceAt, caveField);
  const firstRegionX = Math.floor((bounds.minX - 1) / CAVE_ENTRANCE_REGION_SIZE);
  const lastRegionX = Math.floor(bounds.maxX / CAVE_ENTRANCE_REGION_SIZE);
  const firstRegionZ = Math.floor((bounds.minZ - 1) / CAVE_ENTRANCE_REGION_SIZE);
  const lastRegionZ = Math.floor(bounds.maxZ / CAVE_ENTRANCE_REGION_SIZE);
  const entrances: CaveEntrance[] = [];
  for (let regionZ = firstRegionZ; regionZ <= lastRegionZ; regionZ++) {
    for (let regionX = firstRegionX; regionX <= lastRegionX; regionX++) {
      for (const entrance of entranceInRegion(regionX, regionZ))
        if (
          entrance.x >= bounds.minX - 1 &&
          entrance.x <= bounds.maxX &&
          entrance.z >= bounds.minZ - 1 &&
          entrance.z <= bounds.maxZ
        )
          entrances.push(entrance);
    }
  }
  return entrances;
}

/** Samples only the seeded density field, excluding the authored finite passage and cave network. */
export function createTerrainCaveFieldVoidSampler(
  world: TerrainVolumeWorld,
  surfaceAt = createTerrainSurfaceSampler(world),
) {
  const { generator } = world;
  const caveDensity = generator.caveDensity ?? 0;
  if (caveDensity <= 0) return () => false;
  const field = createNoise3D(createSeededRandom(world.seed ^ 0x6d2b79f5));
  const [originX, originZ] = generator.origin;
  const [width, depth] = generator.size;
  return (x: number, y: number, z: number) =>
    x >= originX &&
    x < originX + width &&
    z >= originZ &&
    z < originZ + depth &&
    y >= generator.minY + 2 &&
    y <= generator.maxY &&
    y <= surfaceAt(x, z) - 3 &&
    field(x * CAVE_FIELD_FREQUENCY, y * CAVE_FIELD_FREQUENCY, z * CAVE_FIELD_FREQUENCY) > 1 - caveDensity;
}

/**
 * Creates a cached lookup for generated mouth-to-trunk paths crossing aligned 64- or 256-cell renderer tiles.
 * The tile alignment keeps each lookup within one 256-cell destination region and the 420-connector budget.
 */
export function createTerrainCaveNetworkConnectorSampler(
  world: TerrainVolumeWorld,
  surfaceAt = createTerrainSurfaceSampler(world),
): (bounds: TerrainCellBounds) => TerrainCaveNetworkConnector[] {
  const { generator } = world;
  const path = createTerrainCaveNetworkPath(world);
  const caveDensity = generator.caveDensity ?? 0;
  const reach = Math.max(
    0,
    Math.min(
      TERRAIN_CAVE_NETWORK_REACH_LIMIT,
      Math.floor(generator.caveNetworkReach ?? TERRAIN_CAVE_NETWORK_REACH_DEFAULT),
    ),
  );
  if (!path || caveDensity <= 0 || reach <= 0) return () => [];

  const caveField = createNoise3D(createSeededRandom(world.seed ^ 0x6d2b79f5));
  const entrancesInRegion = createCaveEntranceLookup(world, surfaceAt, caveField);
  const connectorsInRegion = createCaveNetworkConnectorLookup(
    world,
    path,
    surfaceAt,
    entrancesInRegion,
    reach,
  );
  return (bounds: TerrainCellBounds): TerrainCaveNetworkConnector[] => {
    if (bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) return [];
    const regionX = Math.floor(bounds.minX / CAVE_ENTRANCE_REGION_SIZE);
    const regionZ = Math.floor(bounds.minZ / CAVE_ENTRANCE_REGION_SIZE);
    if (
      Math.floor((bounds.maxX - 1) / CAVE_ENTRANCE_REGION_SIZE) !== regionX ||
      Math.floor((bounds.maxZ - 1) / CAVE_ENTRANCE_REGION_SIZE) !== regionZ
    )
      throw new RangeError('Cave connector bounds must stay within one 256-cell region.');
    const unique = new Map<string, TerrainCaveNetworkConnector>();
    const intersects = (segment: [CavePoint, CavePoint]) => {
      const minX = Math.min(segment[0][0], segment[1][0]) - TERRAIN_CAVE_NETWORK_CONNECTOR_RADIUS;
      const maxX = Math.max(segment[0][0], segment[1][0]) + TERRAIN_CAVE_NETWORK_CONNECTOR_RADIUS;
      const minZ = Math.min(segment[0][2], segment[1][2]) - TERRAIN_CAVE_NETWORK_CONNECTOR_RADIUS;
      const maxZ = Math.max(segment[0][2], segment[1][2]) + TERRAIN_CAVE_NETWORK_CONNECTOR_RADIUS;
      return minX < bounds.maxX && maxX >= bounds.minX && minZ < bounds.maxZ && maxZ >= bounds.minZ;
    };
    for (const connectors of connectorsInRegion(regionX, regionZ).values())
      for (const connector of connectors)
        if (intersects(connector.shaft) || intersects(connector.tunnel))
          unique.set(`${connector.shaft[0][0]},${connector.shaft[0][2]}`, connector);
    return [...unique.values()].sort(
      (a, b) => a.shaft[0][0] - b.shaft[0][0] || a.shaft[0][2] - b.shaft[0][2],
    );
  };
}

/** Deterministic solid occupancy for the optional 3D terrain mode. */
export function createTerrainVolumeSampler(
  world: TerrainVolumeWorld,
  surfaceAt = createTerrainSurfaceSampler(world),
) {
  const density = createNoise3D(createSeededRandom(world.seed ^ 0x51ed270b));
  const { generator } = world;
  const caveFieldDensity = generator.caveDensity ?? 0;
  const caveField =
    caveFieldDensity > 0 ? createNoise3D(createSeededRandom(world.seed ^ 0x6d2b79f5)) : undefined;
  const overhangDensity = generator.overhangDensity ?? 0;
  const overhangMaxHeight = Math.max(
    1,
    Math.min(
      TERRAIN_OVERHANG_HEIGHT_LIMIT,
      Math.floor(generator.overhangMaxHeight ?? TERRAIN_OVERHANG_DEFAULT_MAX_HEIGHT),
    ),
  );
  const overhangProfile = generator.overhangProfile?.length ? generator.overhangProfile : [1];
  const overhangLayerDensity = Array.from({ length: overhangMaxHeight }, (_, layer) => {
    const position =
      overhangMaxHeight <= 1 ? 0 : (layer / (overhangMaxHeight - 1)) * (overhangProfile.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(overhangProfile.length - 1, lower + 1);
    return overhangProfile[lower] + (overhangProfile[upper] - overhangProfile[lower]) * (position - lower);
  });
  const overhangHeightMap = generator.overhangHeightMap;
  const overhangField =
    overhangDensity > 0 && !overhangHeightMap
      ? createNoise3D(createSeededRandom(world.seed ^ 0x2c9277b5))
      : undefined;
  const footprint = generator.overhangFootprint;
  const sampleFootprint = (x: number, z: number) =>
    footprint ? sampleNormalizedGrid(footprint, generator.origin, generator.size, x, z) : 1;
  const overhangHeights = new Map<string, number>();
  const generatedEntranceInRegion = caveField ? createCaveEntranceLookup(world, surfaceAt, caveField) : null;
  const [originX, originZ] = generator.origin;
  const [width, depth] = generator.size;
  const caveY = terrainCaveCenterY(world);
  const entrance = terrainCaveEntrance(world);
  const caveNetworkPath = createTerrainCaveNetworkPath(world);
  const caveNetworkBranches = terrainCaveNetworkBranches(world, caveNetworkPath);
  const caveNetworkReach = Math.max(
    0,
    Math.min(
      TERRAIN_CAVE_NETWORK_REACH_LIMIT,
      Math.floor(generator.caveNetworkReach ?? TERRAIN_CAVE_NETWORK_REACH_DEFAULT),
    ),
  );
  const caveNetworkConnectorsInRegion =
    caveNetworkPath && generatedEntranceInRegion && caveNetworkReach > 0
      ? createCaveNetworkConnectorLookup(
          world,
          caveNetworkPath,
          surfaceAt,
          generatedEntranceInRegion,
          caveNetworkReach,
        )
      : null;
  const caveNetworkCenter = caveNetworkPath?.at(caveNetworkPath.axis === 'x' ? entrance.x : entrance.z);
  const caveNetworkEntranceY = caveNetworkCenter?.y ?? caveY;
  const caveZ = entrance.z;
  const entranceX = entrance.x;
  const caveBranches = terrainCaveBranches(world);
  // This phase exposes one finite, walkable passage around the entrance. Keeping both ends
  // inside the streamed window avoids a distant heightfield appearing through an endless cave.
  const caveHalfLength = Math.max(2, Math.min(12, Math.floor(generator.size[0] / 2) - 2));
  const caveBranchHalfLength = Math.max(2, Math.min(12, Math.floor(generator.size[1] / 2) - 2));
  const overhangHeightAt = (x: number, z: number, surface: number) => {
    const key = `${x},${z}`;
    const cached = overhangHeights.get(key);
    if (cached !== undefined) return cached;
    let height = 0;
    const maximum = Math.min(overhangMaxHeight, generator.maxY - surface);
    if (overhangHeightMap) {
      height = Math.min(maximum, sampleTerrainOverhangHeightMap(world, x, z));
      if (overhangHeights.size >= 1024) overhangHeights.delete(overhangHeights.keys().next().value!);
      overhangHeights.set(key, height);
      return height;
    }
    const horizontalDensity = sampleFootprint(x, z);
    for (let layer = 1; layer <= maximum; layer++) {
      const layerDensity = overhangLayerDensity[layer - 1];
      if (
        layerDensity <= 0 ||
        horizontalDensity <= 0 ||
        overhangField!(
          x * OVERHANG_FIELD_FREQUENCY,
          (surface + layer) * OVERHANG_FIELD_FREQUENCY,
          z * OVERHANG_FIELD_FREQUENCY,
        ) <=
          1 - overhangDensity * layerDensity * horizontalDensity
      )
        break;
      height = layer;
    }
    if (overhangHeights.size >= 1024) overhangHeights.delete(overhangHeights.keys().next().value!);
    overhangHeights.set(key, height);
    return height;
  };
  return (x: number, y: number, z: number) => {
    if (y < generator.minY || y > generator.maxY) return false;
    const surface = surfaceAt(x, z);
    if (y > surface) {
      if (!overhangField && !overhangHeightMap) return false;
      const insideBounds = x >= originX && x < originX + width && z >= originZ && z < originZ + depth;
      const legacyEntrance =
        Math.abs(x - entranceX) <= 1 && Math.abs(z - caveZ) <= 1 && y > caveNetworkEntranceY;
      if (!insideBounds || legacyEntrance) return false;
      const generatedEntrances = generatedEntranceInRegion?.(
        Math.floor(x / CAVE_ENTRANCE_REGION_SIZE),
        Math.floor(z / CAVE_ENTRANCE_REGION_SIZE),
      );
      if (
        generatedEntrances?.some(
          (generatedEntrance) =>
            Math.abs(x - generatedEntrance.x) <= 1 &&
            Math.abs(z - generatedEntrance.z) <= 1 &&
            y >= surface - 3,
        )
      )
        return false;
      return y - surface <= overhangHeightAt(x, z, surface);
    }
    if (
      caveField &&
      x >= originX &&
      x < originX + width &&
      z >= originZ &&
      z < originZ + depth &&
      y >= generator.minY + 2 &&
      y <= surface - 3 &&
      caveField(x * CAVE_FIELD_FREQUENCY, y * CAVE_FIELD_FREQUENCY, z * CAVE_FIELD_FREQUENCY) >
        1 - caveFieldDensity
    )
      return false;
    const regionX = Math.floor(x / CAVE_ENTRANCE_REGION_SIZE);
    const regionZ = Math.floor(z / CAVE_ENTRANCE_REGION_SIZE);
    const generatedEntrances = generatedEntranceInRegion?.(regionX, regionZ);
    if (
      generatedEntrances?.some(
        (generatedEntrance) =>
          Math.abs(x - generatedEntrance.x) <= 1 &&
          Math.abs(z - generatedEntrance.z) <= 1 &&
          y >= surface - 3,
      )
    )
      return false;
    const insideWorld = x >= originX && x < originX + width && z >= originZ && z < originZ + depth;
    if (
      insideWorld &&
      caveNetworkPath &&
      caveNetworkConnectorsInRegion &&
      y >= generator.minY + 2 &&
      y <= surface - 3 &&
      caveNetworkConnectorsContain(
        caveNetworkConnectorsInRegion(regionX, regionZ),
        caveNetworkPath.axis,
        x,
        y,
        z,
      )
    )
      return false;
    if (
      caveNetworkPath &&
      insideWorld &&
      y >= generator.minY + 2 &&
      y <= surface - 3 &&
      (terrainCaveNetworkContains(caveNetworkPath, x, y, z) ||
        caveNetworkBranches.some((branch) =>
          terrainCaveNetworkBranchContains(caveNetworkPath, branch, x, y, z),
        ))
    )
      return false;
    // Both the finite cave and its shaft lie inside this X span.
    if (Math.abs(x - entranceX) > caveHalfLength) return true;

    // A seeded 3D field meanders the cave while keeping its surface aligned with heightfield LOD.
    const centerY = caveY + density(x * 0.025, 4.3, caveZ * 0.025) * 1.5;
    const centerZ = caveZ + density(x * 0.025, 2.1, caveZ * 0.025) * 1.5;
    const radius = 1 + density(x * 0.07, y * 0.07, z * 0.07) * 0.08;
    const cave =
      Math.abs(x - entranceX) <= caveHalfLength &&
      ((y - centerY) / 3) ** 2 + ((z - centerZ) / 4) ** 2 < radius;
    const branchCenterY = caveY + density(entranceX * 0.025, 4.3, caveZ * 0.025) * 1.5;
    const branchCenterX = entranceX + density(z * 0.025, 2.1, caveZ * 0.025) * 1.5;
    const caveBranch =
      generator.caveCrossPassage === true &&
      Math.abs(z - caveZ) <= caveBranchHalfLength &&
      ((y - branchCenterY) / 3) ** 2 + ((x - branchCenterX) / 4) ** 2 < radius;
    const caveNetworkBranch = caveBranches.some((branch) => {
      const distance = (z - caveZ) * branch.direction;
      if (distance < -4 || distance > branch.length) return false;
      const branchCenterY = caveY + density(branch.x * 0.025, 4.3, caveZ * 0.025) * 1.5;
      const branchCenterX = branch.x + density(z * 0.025, 2.1, caveZ * 0.025) * 1.5;
      return ((y - branchCenterY) / 3) ** 2 + ((x - branchCenterX) / 4) ** 2 < radius;
    });
    const legacyEntrance =
      Math.abs(x - entranceX) <= 1 && Math.abs(z - caveZ) <= 1 && y > caveNetworkEntranceY;
    return !(
      ((cave || caveBranch || caveNetworkBranch) && y < surface - 2) ||
      (legacyEntrance && y <= surface)
    );
  };
}
