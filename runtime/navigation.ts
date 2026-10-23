export interface NavigationPoint {
  x: number;
  z: number;
}

export interface NavigationVoxelPoint extends NavigationPoint {
  y: number;
}

export interface NavigationObstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface NavigationPathResult {
  path: NavigationPoint[] | null;
  expanded: number;
  capped: boolean;
}

const MAX_EXPANDED = 512;
const MAX_CELLS = 4096;
const MAX_VOXEL_EXPANDED = 2048;
const MAX_VOXEL_CELLS = 32768;
// ponytail: flat X/Z routing with fixed search ceilings; add hierarchical routing only if longer routes need support.
const DIRECTIONS: readonly [number, number][] = [
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];
const VOXEL_DIRECTIONS: readonly [number, number, number][] = [
  [-1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [0, 1, 0],
  [1, 0, 0],
];

function validPoint(point: NavigationPoint) {
  return Number.isFinite(point.x) && Number.isFinite(point.z);
}

function validObstacle(obstacle: NavigationObstacle) {
  return (
    Number.isFinite(obstacle.minX) &&
    Number.isFinite(obstacle.maxX) &&
    Number.isFinite(obstacle.minZ) &&
    Number.isFinite(obstacle.maxZ) &&
    obstacle.minX <= obstacle.maxX &&
    obstacle.minZ <= obstacle.maxZ
  );
}

export function segmentHitsObstacle(
  start: NavigationPoint,
  end: NavigationPoint,
  obstacle: NavigationObstacle,
  clearance = 0,
) {
  if (
    !validPoint(start) ||
    !validPoint(end) ||
    !validObstacle(obstacle) ||
    !Number.isFinite(clearance) ||
    clearance < 0
  )
    return false;
  const minX = obstacle.minX - clearance,
    maxX = obstacle.maxX + clearance,
    minZ = obstacle.minZ - clearance,
    maxZ = obstacle.maxZ + clearance;
  let enter = 0,
    leave = 1;
  for (const [origin, delta, minimum, maximum] of [
    [start.x, end.x - start.x, minX, maxX],
    [start.z, end.z - start.z, minZ, maxZ],
  ]) {
    if (Math.abs(delta) < 1e-10) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    const first = (minimum - origin) / delta,
      last = (maximum - origin) / delta;
    enter = Math.max(enter, Math.min(first, last));
    leave = Math.min(leave, Math.max(first, last));
    if (enter > leave) return false;
  }
  return true;
}

function segmentHitsAny(
  start: NavigationPoint,
  end: NavigationPoint,
  obstacles: readonly NavigationObstacle[],
  clearance: number,
) {
  return obstacles.some((obstacle) => segmentHitsObstacle(start, end, obstacle, clearance));
}

export function findGridPath(
  start: NavigationPoint,
  goal: NavigationPoint,
  obstacles: readonly NavigationObstacle[],
  options: {
    cellSize?: number;
    clearance?: number;
    paddingCells?: number;
    maxExpanded?: number;
    traversable?: (from: NavigationPoint, to: NavigationPoint) => boolean;
  } = {},
): NavigationPathResult {
  const cellSize = options.cellSize ?? 0.5,
    clearance = options.clearance ?? 0,
    padding = options.paddingCells ?? 8,
    maxExpanded = Math.min(options.maxExpanded ?? MAX_EXPANDED, MAX_EXPANDED);
  if (
    !validPoint(start) ||
    !validPoint(goal) ||
    !Number.isFinite(cellSize) ||
    cellSize <= 0 ||
    !Number.isFinite(clearance) ||
    clearance < 0 ||
    !Number.isInteger(padding) ||
    padding < 0 ||
    !Number.isInteger(maxExpanded) ||
    maxExpanded < 1
  )
    return { path: null, expanded: 0, capped: true };

  const startX = Math.round(start.x / cellSize),
    startZ = Math.round(start.z / cellSize),
    goalX = Math.round(goal.x / cellSize),
    goalZ = Math.round(goal.z / cellSize),
    minX = Math.min(startX, goalX) - padding,
    maxX = Math.max(startX, goalX) + padding,
    minZ = Math.min(startZ, goalZ) - padding,
    maxZ = Math.max(startZ, goalZ) + padding,
    width = maxX - minX + 1,
    height = maxZ - minZ + 1,
    cellCount = width * height;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_CELLS)
    return { path: null, expanded: 0, capped: true };

  const index = (x: number, z: number) => (z - minZ) * width + (x - minX),
    startIndex = index(startX, startZ),
    goalIndex = index(goalX, goalZ),
    gScore = new Float64Array(cellCount).fill(Infinity),
    parent = new Int32Array(cellCount).fill(-1),
    closed = new Uint8Array(cellCount),
    inOpen = new Uint8Array(cellCount),
    open = [startIndex];
  gScore[startIndex] = 0;
  inOpen[startIndex] = 1;

  const coordinates = (cell: number): NavigationPoint => ({
      x: ((cell % width) + minX) * cellSize,
      z: (Math.floor(cell / width) + minZ) * cellSize,
    }),
    heuristic = (cell: number) => {
      const point = coordinates(cell),
        dx = Math.abs(point.x / cellSize - goalX),
        dz = Math.abs(point.z / cellSize - goalZ);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    },
    blocked = (point: NavigationPoint) =>
      obstacles.some(
        (obstacle) =>
          validObstacle(obstacle) &&
          point.x >= obstacle.minX - clearance &&
          point.x <= obstacle.maxX + clearance &&
          point.z >= obstacle.minZ - clearance &&
          point.z <= obstacle.maxZ + clearance,
      );

  if (blocked(coordinates(goalIndex))) return { path: null, expanded: 0, capped: false };
  let expanded = 0;
  while (open.length) {
    let bestPosition = 0,
      bestCell = open[0],
      bestHeuristic = heuristic(bestCell),
      bestScore = gScore[bestCell] + bestHeuristic;
    for (let i = 1; i < open.length; i++) {
      const candidate = open[i],
        estimate = heuristic(candidate),
        score = gScore[candidate] + estimate;
      if (
        score < bestScore - 1e-9 ||
        (Math.abs(score - bestScore) <= 1e-9 &&
          (estimate < bestHeuristic - 1e-9 ||
            (Math.abs(estimate - bestHeuristic) <= 1e-9 && candidate < bestCell)))
      ) {
        bestPosition = i;
        bestCell = candidate;
        bestHeuristic = estimate;
        bestScore = score;
      }
    }
    if (expanded >= maxExpanded) return { path: null, expanded, capped: true };
    open.splice(bestPosition, 1);
    inOpen[bestCell] = 0;
    closed[bestCell] = 1;
    expanded++;
    if (bestCell === goalIndex) {
      const cells = [bestCell];
      for (let current = bestCell; current !== startIndex;) {
        current = parent[current];
        if (current < 0) return { path: null, expanded, capped: false };
        cells.push(current);
      }
      cells.reverse();
      const startCenter = coordinates(startIndex),
        path: NavigationPoint[] = [start];
      if (Math.hypot(startCenter.x - start.x, startCenter.z - start.z) > 1e-8) {
        if (
          segmentHitsAny(start, startCenter, obstacles, clearance) ||
          (options.traversable && !options.traversable(start, startCenter))
        )
          return { path: null, expanded, capped: false };
        path.push(startCenter);
      }
      for (const cell of cells.slice(1)) {
        const point = coordinates(cell),
          previous = path[path.length - 1];
        if (Math.hypot(point.x - previous.x, point.z - previous.z) > 1e-8) path.push(point);
      }
      const last = path[path.length - 1];
      if (
        segmentHitsAny(last, goal, obstacles, clearance) ||
        (options.traversable && !options.traversable(last, goal))
      )
        return { path: null, expanded, capped: false };
      path.push(goal);
      return { path, expanded, capped: false };
    }

    const from = coordinates(bestCell),
      cellX = (bestCell % width) + minX,
      cellZ = Math.floor(bestCell / width) + minZ;
    for (const [dx, dz] of DIRECTIONS) {
      const x = cellX + dx,
        z = cellZ + dz;
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const neighbor = index(x, z);
      if (closed[neighbor]) continue;
      const destination = coordinates(neighbor),
        isStart = neighbor === startIndex;
      if (!isStart && blocked(destination)) continue;
      if (
        dx &&
        dz &&
        (blocked(coordinates(index(cellX + dx, cellZ))) || blocked(coordinates(index(cellX, cellZ + dz))))
      )
        continue;
      if (
        segmentHitsAny(from, destination, obstacles, clearance) ||
        (options.traversable && !options.traversable(from, destination))
      )
        continue;
      const tentative = gScore[bestCell] + (dx && dz ? Math.SQRT2 : 1);
      if (tentative >= gScore[neighbor] - 1e-9) continue;
      gScore[neighbor] = tentative;
      parent[neighbor] = bestCell;
      if (!inOpen[neighbor]) {
        inOpen[neighbor] = 1;
        open.push(neighbor);
      }
    }
  }
  return { path: null, expanded, capped: false };
}

export function findVoxelPath(
  start: NavigationVoxelPoint,
  goal: NavigationVoxelPoint,
  options: {
    cellSize?: number;
    paddingCells?: number;
    maxExpanded?: number;
    maxCells?: number;
    traversable: (point: NavigationVoxelPoint) => boolean;
    segmentTraversable?: (from: NavigationVoxelPoint, to: NavigationVoxelPoint) => boolean;
  },
): { path: NavigationVoxelPoint[] | null; expanded: number; capped: boolean } {
  const cellSize = options.cellSize ?? 0.5,
    padding = options.paddingCells ?? 8,
    maxExpanded = Math.min(options.maxExpanded ?? MAX_VOXEL_EXPANDED, MAX_VOXEL_EXPANDED),
    maxCells = Math.min(options.maxCells ?? MAX_VOXEL_CELLS, MAX_VOXEL_CELLS);
  if (
    !validPoint(start) ||
    !validPoint(goal) ||
    !Number.isFinite(start.y) ||
    !Number.isFinite(goal.y) ||
    !Number.isFinite(cellSize) ||
    cellSize <= 0 ||
    !Number.isInteger(padding) ||
    padding < 0 ||
    !Number.isInteger(maxExpanded) ||
    maxExpanded < 1 ||
    !Number.isInteger(maxCells) ||
    maxCells < 1
  )
    return { path: null, expanded: 0, capped: true };

  const sx = Math.round(start.x / cellSize),
    sy = Math.round(start.y / cellSize),
    sz = Math.round(start.z / cellSize),
    gx = Math.round(goal.x / cellSize),
    gy = Math.round(goal.y / cellSize),
    gz = Math.round(goal.z / cellSize),
    minX = Math.min(sx, gx) - padding,
    maxX = Math.max(sx, gx) + padding,
    minY = Math.min(sy, gy) - padding,
    maxY = Math.max(sy, gy) + padding,
    minZ = Math.min(sz, gz) - padding,
    maxZ = Math.max(sz, gz) + padding,
    width = maxX - minX + 1,
    height = maxY - minY + 1,
    depth = maxZ - minZ + 1,
    cellCount = width * height * depth;
  if (!Number.isSafeInteger(cellCount) || cellCount > maxCells)
    return { path: null, expanded: 0, capped: true };

  const plane = width * depth,
    index = (x: number, y: number, z: number) => (y - minY) * plane + (z - minZ) * width + x - minX,
    startIndex = index(sx, sy, sz),
    goalIndex = index(gx, gy, gz),
    gScore = new Float32Array(cellCount).fill(Infinity),
    parent = new Int32Array(cellCount).fill(-1),
    closed = new Uint8Array(cellCount),
    inOpen = new Uint8Array(cellCount),
    open = [startIndex];
  gScore[startIndex] = 0;
  inOpen[startIndex] = 1;

  const coordinates = (cell: number): NavigationVoxelPoint => ({
      x: ((cell % width) + minX) * cellSize,
      y: (Math.floor(cell / plane) + minY) * cellSize,
      z: ((Math.floor(cell / width) % depth) + minZ) * cellSize,
    }),
    heuristic = (cell: number) => {
      const point = coordinates(cell);
      return (
        Math.abs(point.x / cellSize - gx) +
        Math.abs(point.y / cellSize - gy) +
        Math.abs(point.z / cellSize - gz)
      );
    },
    startPoint = coordinates(startIndex),
    goalPoint = coordinates(goalIndex),
    segmentClear = options.segmentTraversable ?? (() => true);
  if (!options.traversable(start) || !options.traversable(goal))
    return { path: null, expanded: 0, capped: false };

  let expanded = 0;
  while (open.length) {
    let bestPosition = 0,
      bestCell = open[0],
      bestHeuristic = heuristic(bestCell),
      bestScore = gScore[bestCell] + bestHeuristic;
    for (let i = 1; i < open.length; i++) {
      const candidate = open[i],
        estimate = heuristic(candidate),
        score = gScore[candidate] + estimate;
      if (
        score < bestScore - 1e-9 ||
        (Math.abs(score - bestScore) <= 1e-9 &&
          (estimate < bestHeuristic - 1e-9 ||
            (Math.abs(estimate - bestHeuristic) <= 1e-9 && candidate < bestCell)))
      ) {
        bestPosition = i;
        bestCell = candidate;
        bestHeuristic = estimate;
        bestScore = score;
      }
    }
    if (expanded >= maxExpanded) return { path: null, expanded, capped: true };
    open.splice(bestPosition, 1);
    inOpen[bestCell] = 0;
    closed[bestCell] = 1;
    expanded++;
    if (bestCell === goalIndex) {
      const cells = [bestCell];
      for (let current = bestCell; current !== startIndex;) {
        current = parent[current];
        if (current < 0) return { path: null, expanded, capped: false };
        cells.push(current);
      }
      cells.reverse();
      const path: NavigationVoxelPoint[] = [start];
      if (Math.hypot(start.x - startPoint.x, start.y - startPoint.y, start.z - startPoint.z) > 1e-8) {
        if (!segmentClear(start, startPoint)) return { path: null, expanded, capped: false };
        path.push(startPoint);
      }
      for (const cell of cells.slice(1)) {
        const point = coordinates(cell),
          previous = path[path.length - 1];
        if (Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) > 1e-8)
          path.push(point);
      }
      const last = path[path.length - 1];
      if (!segmentClear(last, goal)) return { path: null, expanded, capped: false };
      path.push(goal);
      return { path, expanded, capped: false };
    }

    const from = coordinates(bestCell),
      cellY = Math.floor(bestCell / plane) + minY,
      cellZ = (Math.floor(bestCell / width) % depth) + minZ,
      cellX = (bestCell % width) + minX;
    for (const [dx, dy, dz] of VOXEL_DIRECTIONS) {
      const x = cellX + dx,
        y = cellY + dy,
        z = cellZ + dz;
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) continue;
      const neighbor = index(x, y, z);
      if (closed[neighbor]) continue;
      const destination = coordinates(neighbor);
      if (!options.traversable(destination) || !segmentClear(from, destination)) continue;
      const tentative = gScore[bestCell] + 1;
      if (tentative >= gScore[neighbor] - 1e-9) continue;
      gScore[neighbor] = tentative;
      parent[neighbor] = bestCell;
      if (!inOpen[neighbor]) {
        inOpen[neighbor] = 1;
        open.push(neighbor);
      }
    }
  }
  return { path: null, expanded, capped: false };
}
