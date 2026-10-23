import type * as THREE from 'three';
import type { SkeletonDef } from './utils/riggingConstants';

export enum AppState {
  STABLE = 'STABLE',
  DISMANTLING = 'DISMANTLING',
  REBUILDING = 'REBUILDING',
  RIGGING = 'RIGGING',
  EDITING = 'EDITING',
}

export enum VoxelMaterial {
  STANDARD = 'STANDARD',
  METALLIC = 'METALLIC',
  GLASS = 'GLASS',
  EMISSIVE = 'EMISSIVE',
}

export enum DetailLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum Pose {
  AUTO = 'AUTO',
  T_POSE = 'T_POSE',
  A_POSE = 'A_POSE',
  NEUTRAL_STAND = 'NEUTRAL_STAND',
  SAWHORSE = 'SAWHORSE',
  WINGS_SPREAD = 'WINGS_SPREAD',
  TORPEDO = 'TORPEDO',
  STAR_POSE = 'STAR_POSE',
  MOUTH_OPEN = 'MOUTH_OPEN',
}

export interface VoxelWeight {
  bone: string;
  weight: number;
}

export interface VoxelData {
  x: number;
  y: number;
  z: number;
  color: number;
  bone?: string;
  weights?: VoxelWeight[];
  materialType?: VoxelMaterial;
  isLocked?: boolean;
}

export interface SimulationVoxel {
  id: number;
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  originalColor?: THREE.Color;
  bone?: string;
  weights: VoxelWeight[];
  materialType: VoxelMaterial;
  isLocked: boolean;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  rvx: number;
  rvy: number;
  rvz: number;
  scale?: number;
}

export interface RebuildTarget {
  x: number;
  y: number;
  z: number;
  delay: number;
  color?: number;
  isRubble?: boolean;
}

export interface VoxelDelta {
  action: 'add' | 'delete' | 'paint' | 'move' | 'lock' | 'fill' | 'weight' | 'replace' | 'transform';
  voxels: { before: VoxelData | null; after: VoxelData | null }[];
}

export interface SymmetryConfig {
  x: boolean;
  y: boolean;
  z: boolean;
}

export interface SavedModel {
  name: string;
  data: VoxelData[];
  baseModel?: string;
  skeleton?: SkeletonDef | null;
}

export interface SceneObject {
  id: string;
  name: string;
  data: VoxelData[];
  offsetX: number;
  offsetZ: number;
}
