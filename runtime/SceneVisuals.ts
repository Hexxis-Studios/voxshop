import * as THREE from 'three';
import type { Asset, SceneNode } from '../services/projectDocument';
import { OcclusionQueries, type OcclusionToken } from './occlusionQueries';
import {
  createAssetVisual,
  createNodeVisual,
  disposeObject,
  isRigidOpaqueAsset,
  shouldChunkAsset,
  type AssetVisual,
} from './assetMesh';
import {
  createTerrainLodGeometryChunks,
  getTerrainLodTransform,
  TERRAIN_FAR_LOD_CELL_SIZE,
  TERRAIN_LOD_CELL_SIZE,
  VOXEL_CHUNK_SIZE,
} from './voxelGeometry';

type Batch = {
  assetId: string;
  cellKey: string;
  nodeIds: string[];
  mesh: THREE.InstancedMesh;
  template: THREE.Mesh;
  capacity: number;
  dirty: boolean;
  occlusionToken?: OcclusionToken;
  occlusionProxy?: THREE.Mesh;
  drawCount?: number;
};
type Instance = { batch: Batch; index: number; matrix: THREE.Matrix4 };
type VisualState = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  enabled: boolean;
  attachments: SceneNode['attachments'];
};
type TerrainLod = {
  group: THREE.Group;
  fine: THREE.Group;
  medium: THREE.Group;
  far: THREE.Group;
  center: THREE.Vector3;
  voxelSize: number;
  tier: 0 | 1 | 2;
};
const TERRAIN_LOD_PIXEL_THRESHOLD = 2;

function isTerrainLodCandidate(node: SceneNode, asset: Asset, hasChildren: boolean) {
  const recipe = asset.recipe;
  return (
    !node.parentId &&
    !hasChildren &&
    !node.components.length &&
    !node.attachments.length &&
    !asset.variantOf &&
    isRigidOpaqueAsset(asset) &&
    asset.source.kind === 'generated' &&
    asset.source.seed !== undefined &&
    asset.source.seed === recipe?.seed &&
    recipe.shapes.length === 1 &&
    recipe.shapes[0].kind === 'terrain' &&
    recipe.shapes[0].operation === 'add'
  );
}

function sameArray<T>(left: readonly T[], right: readonly T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAttachments(left: SceneNode['attachments'], right: SceneNode['attachments']) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((attachment, index) => {
        const other = right[index];
        return (
          attachment.assetId === other.assetId &&
          attachment.socket === other.socket &&
          attachment.slot === other.slot &&
          sameArray(attachment.transform.position, other.transform.position) &&
          sameArray(attachment.transform.rotation, other.transform.rotation) &&
          sameArray(attachment.transform.scale, other.transform.scale) &&
          sameArray(attachment.hiddenBones, other.hiddenBones)
        );
      }))
  );
}

function instanceCellKey(position: SceneNode['transform']['position']) {
  return `${Math.floor(position[0] / 32)}:${Math.floor(position[2] / 32)}`;
}

function instanceBatchKey(assetId: string, cellKey: string) {
  return `${assetId}:${cellKey}`;
}

function instanceCapacity(count: number) {
  let capacity = 1;
  while (capacity < count) capacity *= 2;
  return capacity;
}

/** Shared opaque geometry is grouped spatially; moving instances rebucket so Three.js can cull each cell. */
export class SceneVisuals {
  readonly nodes = new Map<string, AssetVisual>();
  readonly pickables: THREE.Object3D[] = [];
  private instances = new Map<string, Instance>();
  private batches: Batch[] = [];
  private batchesByCell = new Map<string, Batch>();
  private templates: AssetVisual[] = [];
  private templatesByAsset = new Map<string, THREE.Mesh>();
  private assets: Map<string, Asset>;
  private individual = new Set<string>();
  private states = new Map<string, VisualState>();
  private terrainLods = new Map<string, TerrainLod>();
  private scene: THREE.Scene;
  private occlusion?: OcclusionQueries;
  private occlusionGeometry?: THREE.BoxGeometry;
  private occlusionMaterial?: THREE.MeshBasicMaterial;
  private occlusionBatches: Batch[] = [];
  private occlusionSuppressedInstances = 0;
  private occlusionSuppressedBatchFrames = 0;
  private occlusionEnabled = true;
  private occlusionCamera?: THREE.Camera;
  private previousOcclusionWorld = new THREE.Matrix4();
  private previousOcclusionProjection = new THREE.Matrix4();
  private occlusionView = new THREE.Matrix4();
  private occlusionProjectionView = new THREE.Matrix4();
  private occlusionFrustum = new THREE.Frustum();
  private occlusionBounds = new THREE.Box3();
  private visibleOcclusionTokens = new Set<OcclusionToken>();
  private hasOcclusionCamera = false;
  private contextLost = () => this.occlusion?.contextLost();
  private contextRestored = () => this.occlusion?.contextRestored();
  private contextCanvas?: HTMLCanvasElement;
  private previousSceneHook: THREE.Scene['onBeforeRender'] | null = null;
  private installedSceneHook: THREE.Scene['onBeforeRender'] | null = null;
  private chunkedAssets = 0;
  private chunkMeshes = 0;
  private terrainLodMeshes = 0;
  private matrix = new THREE.Matrix4();
  private zero = new THREE.Vector3();
  private cameraPosition = new THREE.Vector3();
  private cameraDirection = new THREE.Vector3();
  private cameraToTerrain = new THREE.Vector3();
  private terrainCenter = new THREE.Vector3();
  private terrainScale = new THREE.Vector3();
  private viewportSize = new THREE.Vector2();
  private processedNodeCount = 0;
  get occlusionCullingEnabled() {
    return this.occlusionEnabled;
  }

  setOcclusionEnabled(enabled: boolean) {
    if (this.occlusionEnabled === enabled) return;
    this.occlusionEnabled = enabled;
    this.occlusion?.invalidate();
  }

  constructor(
    scene: THREE.Scene,
    nodes: SceneNode[],
    assets: Map<string, Asset>,
    renderer?: THREE.WebGLRenderer,
  ) {
    this.scene = scene;
    this.assets = assets;
    if (renderer && renderer.capabilities.isWebGL2) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (
        typeof gl.createQuery === 'function' &&
        typeof gl.beginQuery === 'function' &&
        typeof gl.endQuery === 'function' &&
        typeof gl.getQueryParameter === 'function' &&
        typeof gl.deleteQuery === 'function' &&
        typeof gl.ANY_SAMPLES_PASSED_CONSERVATIVE === 'number' &&
        typeof gl.QUERY_RESULT_AVAILABLE === 'number' &&
        typeof gl.QUERY_RESULT === 'number'
      ) {
        this.occlusion = new OcclusionQueries(gl);
        this.occlusionGeometry = new THREE.BoxGeometry(1, 1, 1);
        this.occlusionMaterial = new THREE.MeshBasicMaterial({
          colorWrite: false,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        this.contextCanvas = renderer.domElement;
        this.contextCanvas.addEventListener('webglcontextlost', this.contextLost);
        this.contextCanvas.addEventListener('webglcontextrestored', this.contextRestored);
      }
    }
    const parents = new Set(nodes.map((n) => n.parentId).filter(Boolean));
    const candidates = new Map<string, Asset>(),
      candidateCounts = new Map<string, number>(),
      groups = new Map<string, SceneNode[]>();
    for (const node of nodes) {
      const asset = node.assetId ? assets.get(node.assetId) : undefined;
      if (
        !asset ||
        !isRigidOpaqueAsset(asset) ||
        node.parentId ||
        parents.has(node.id) ||
        node.attachments.length ||
        isTerrainLodCandidate(node, asset, parents.has(node.id))
      )
        continue;
      candidates.set(node.id, asset);
      candidateCounts.set(asset.id, (candidateCounts.get(asset.id) ?? 0) + 1);
    }
    for (const node of nodes) {
      const terrainAsset = node.assetId ? assets.get(node.assetId) : undefined;
      if (terrainAsset && isTerrainLodCandidate(node, terrainAsset, parents.has(node.id))) {
        const { visual, lod } = this.createTerrainLodVisual(node, terrainAsset);
        this.nodes.set(node.id, visual);
        this.individual.add(node.id);
        this.pickables.push(visual.group);
        this.terrainLods.set(node.id, lod);
        this.chunkedAssets++;
        this.chunkMeshes += visual.group.userData.voxelChunkCount as number;
        this.terrainLodMeshes += visual.group.userData.terrainLodMeshCount as number;
        continue;
      }
      const asset = candidates.get(node.id);
      if (asset && (!shouldChunkAsset(asset) || candidateCounts.get(asset.id)! > 1)) {
        const key = `${asset.id}:${instanceCellKey(node.transform.position)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(node);
        this.nodes.set(node.id, { group: new THREE.Group(), bones: new Map(), animate: () => {} });
      } else {
        const visual = createNodeVisual(node, assets);
        visual.group.userData.nodeId = node.id;
        this.nodes.set(node.id, visual);
        this.individual.add(node.id);
        this.pickables.push(visual.group);
        if (visual.group.userData.voxelChunkCount) {
          this.chunkedAssets++;
          this.chunkMeshes += visual.group.userData.voxelChunkCount as number;
        }
      }
    }
    for (const members of groups.values()) this.createBatch(members);
    for (const node of nodes) {
      const group = this.nodes.get(node.id)!.group;
      if (this.individual.has(node.id)) {
        const parent = node.parentId ? this.nodes.get(node.parentId)!.group : scene;
        parent.add(group);
      }
      this.update(node);
    }
    this.flush();
    this.processedNodeCount = nodes.length;
    if (this.terrainLods.size || this.occlusion) this.installSceneLodHook();
  }

  addNodes(nodes: SceneNode[]) {
    if (nodes.length <= this.processedNodeCount) return;
    const additions = nodes.slice(this.processedNodeCount);
    this.processedNodeCount = nodes.length;
    const parents = new Set(nodes.map((node) => node.parentId).filter(Boolean));
    const instanced: SceneNode[] = [];
    const individual: SceneNode[] = [];
    for (const node of additions) {
      const asset = node.assetId ? this.assets.get(node.assetId) : undefined;
      if (
        asset &&
        isRigidOpaqueAsset(asset) &&
        !node.parentId &&
        !parents.has(node.id) &&
        !node.attachments.length &&
        !isTerrainLodCandidate(node, asset, false)
      ) {
        this.nodes.set(node.id, { group: new THREE.Group(), bones: new Map(), animate: () => {} });
        instanced.push(node);
      } else {
        const terrainAsset =
          asset && isTerrainLodCandidate(node, asset, parents.has(node.id)) ? asset : undefined;
        const { visual, lod } = terrainAsset
          ? this.createTerrainLodVisual(node, terrainAsset)
          : { visual: createNodeVisual(node, this.assets), lod: undefined };
        visual.group.userData.nodeId = node.id;
        this.nodes.set(node.id, visual);
        this.individual.add(node.id);
        this.pickables.push(visual.group);
        individual.push(node);
        if (lod) {
          this.terrainLods.set(node.id, lod);
          this.chunkedAssets++;
          this.chunkMeshes += visual.group.userData.voxelChunkCount as number;
          this.terrainLodMeshes += visual.group.userData.terrainLodMeshCount as number;
        }
        const chunks = visual.group.userData.voxelChunkCount as number | undefined;
        if (chunks) {
          this.chunkedAssets++;
          this.chunkMeshes += chunks;
        }
      }
    }
    for (const node of individual) {
      const parent = node.parentId ? this.nodes.get(node.parentId)?.group : this.scene;
      parent?.add(this.nodes.get(node.id)!.group);
    }
    for (const node of instanced) this.addInstance(node, this.assets.get(node.assetId!)!);
    for (const node of additions) this.update(node);
    this.flush();
    if (this.terrainLods.size || this.occlusion) this.installSceneLodHook();
  }

  private template(assetId: string) {
    let template = this.templatesByAsset.get(assetId);
    if (!template) {
      const asset = this.assets.get(assetId);
      if (!asset) throw new Error(`Missing shared asset ${assetId}.`);
      const visual = createAssetVisual(asset);
      this.templates.push(visual);
      template = visual.group.children[0] as THREE.Mesh;
      template.updateMatrix();
      this.templatesByAsset.set(assetId, template);
    }
    return template;
  }

  private createBatch(members: SceneNode[], cellKey = instanceCellKey(members[0].transform.position)) {
    const assetId = members[0].assetId!;
    const template = this.template(assetId);
    const nodeIds = members.map((node) => node.id);
    const capacity = instanceCapacity(nodeIds.length);
    const mesh = new THREE.InstancedMesh(template.geometry, template.material, capacity);
    mesh.count = nodeIds.length;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const batch = { assetId, cellKey, nodeIds, mesh, template, capacity, dirty: true };
    mesh.userData.nodeIds = nodeIds;
    this.batches.push(batch);
    this.batchesByCell.set(instanceBatchKey(assetId, cellKey), batch);
    this.pickables.push(mesh);
    this.scene.add(mesh);
    this.enableBatchOcclusion(batch);
    members.forEach((node, index) =>
      this.instances.set(node.id, { batch, index, matrix: new THREE.Matrix4().makeScale(0, 0, 0) }),
    );
    return batch;
  }

  private ensureCapacity(batch: Batch, count: number) {
    if (count <= batch.capacity) return;
    const capacity = instanceCapacity(count),
      previous = batch.mesh,
      mesh = new THREE.InstancedMesh(batch.template.geometry, batch.template.material, capacity),
      matrix = new THREE.Matrix4();
    mesh.count = previous.count;
    mesh.castShadow = previous.castShadow;
    mesh.receiveShadow = previous.receiveShadow;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.nodeIds = batch.nodeIds;
    for (let index = 0; index < previous.count; index++) {
      previous.getMatrixAt(index, matrix);
      mesh.setMatrixAt(index, matrix);
    }
    const pickableIndex = this.pickables.indexOf(previous);
    previous.removeFromParent();
    previous.dispose();
    this.scene.add(mesh);
    if (pickableIndex < 0) this.pickables.push(mesh);
    else this.pickables[pickableIndex] = mesh;
    batch.mesh = mesh;
    batch.capacity = capacity;
    batch.dirty = true;
    this.bindOcclusionBatchMesh(batch);
  }

  private addInstance(node: SceneNode, asset: Asset) {
    const cellKey = instanceCellKey(node.transform.position);
    let batch = this.batchesByCell.get(instanceBatchKey(asset.id, cellKey));
    if (!batch) batch = this.createBatch([node], cellKey);
    else {
      this.ensureCapacity(batch, batch.nodeIds.length + 1);
      const index = batch.nodeIds.push(node.id) - 1;
      batch.mesh.count = batch.nodeIds.length;
      batch.mesh.userData.nodeIds = batch.nodeIds;
      batch.dirty = true;
      const instance = { batch, index, matrix: new THREE.Matrix4().makeScale(0, 0, 0) };
      this.instances.set(node.id, instance);
      return instance;
    }
    return this.instances.get(node.id)!;
  }

  private removeInstance(nodeId: string, instance: Instance) {
    const { batch, index } = instance,
      lastIndex = batch.nodeIds.length - 1,
      lastNodeId = batch.nodeIds[lastIndex];
    if (index !== lastIndex) {
      const matrix = new THREE.Matrix4();
      batch.mesh.getMatrixAt(lastIndex, matrix);
      batch.mesh.setMatrixAt(index, matrix);
      batch.nodeIds[index] = lastNodeId;
      const moved = this.instances.get(lastNodeId)!;
      moved.index = index;
    }
    batch.nodeIds.pop();
    batch.mesh.count = batch.nodeIds.length;
    batch.mesh.userData.nodeIds = batch.nodeIds;
    batch.dirty = true;
    this.instances.delete(nodeId);
    if (batch.nodeIds.length) return;
    this.removeBatchOcclusion(batch);
    const batchIndex = this.batches.indexOf(batch),
      pickableIndex = this.pickables.indexOf(batch.mesh);
    batch.mesh.removeFromParent();
    batch.mesh.dispose();
    if (batchIndex >= 0) this.batches.splice(batchIndex, 1);
    this.batchesByCell.delete(instanceBatchKey(batch.assetId, batch.cellKey));
    if (pickableIndex >= 0) this.pickables.splice(pickableIndex, 1);
  }

  private rebuildNode(node: SceneNode) {
    const previous = this.nodes.get(node.id)!,
      oldGroup = previous.group,
      parent = oldGroup.parent ?? (node.parentId ? this.nodes.get(node.parentId)?.group : this.scene),
      children = oldGroup.children.filter((child) => !!child.userData.nodeId),
      pickableIndex = this.pickables.indexOf(oldGroup),
      instance = this.instances.get(node.id);
    for (const child of children) child.removeFromParent();
    if (instance) this.removeInstance(node.id, instance);
    oldGroup.removeFromParent();
    if (this.individual.has(node.id)) {
      const chunks = oldGroup.userData.voxelChunkCount as number | undefined;
      if (chunks) {
        this.chunkedAssets--;
        this.chunkMeshes -= chunks;
      }
      disposeObject(oldGroup);
    }
    const visual = createNodeVisual(node, this.assets);
    visual.group.userData.nodeId = node.id;
    this.nodes.set(node.id, visual);
    this.individual.add(node.id);
    parent?.add(visual.group);
    for (const child of children) visual.group.add(child);
    const chunks = visual.group.userData.voxelChunkCount as number | undefined;
    if (chunks) {
      this.chunkedAssets++;
      this.chunkMeshes += chunks;
    }
    if (pickableIndex >= 0) this.pickables[pickableIndex] = visual.group;
    else this.pickables.push(visual.group);
  }

  private createTerrainLodVisual(node: SceneNode, asset: Asset): { visual: AssetVisual; lod: TerrainLod } {
    const fineVisual = createNodeVisual(node, new Map([[asset.id, asset]]));
    const fine = fineVisual.group,
      medium = new THREE.Group(),
      far = new THREE.Group();
    let sharedMaterials: THREE.Material[] | undefined;
    let fineMeshes = 0;
    fine.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      fineMeshes++;
      if (!sharedMaterials)
        sharedMaterials = Array.isArray(object.material) ? object.material : [object.material];
    });
    const materials = sharedMaterials ?? [];
    let lodMeshes = 0;
    for (const [cellSize, target] of [
      [TERRAIN_LOD_CELL_SIZE, medium],
      [TERRAIN_FAR_LOD_CELL_SIZE, far],
    ] as const) {
      const remap = getTerrainLodTransform(asset, cellSize),
        chunks = createTerrainLodGeometryChunks(asset, VOXEL_CHUNK_SIZE, cellSize);
      lodMeshes += chunks.length;
      for (const chunk of chunks) {
        const mesh = new THREE.Mesh(chunk.geometry, materials);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        mesh.scale.set(
          cellSize * remap.scaleX * asset.voxelSize,
          asset.voxelSize,
          cellSize * remap.scaleZ * asset.voxelSize,
        );
        mesh.position.set(
          (chunk.origin[0] * cellSize * remap.scaleX + remap.offsetX - asset.pivot[0]) * asset.voxelSize,
          (chunk.origin[1] - asset.pivot[1]) * asset.voxelSize,
          (chunk.origin[2] * cellSize * remap.scaleZ + remap.offsetZ - asset.pivot[2]) * asset.voxelSize,
        );
        mesh.userData.voxelChunk = true;
        target.add(mesh);
      }
    }
    const group = new THREE.Group();
    group.userData.nodeId = node.id;
    group.userData.voxelChunkCount = fineMeshes;
    group.userData.terrainLodMeshCount = lodMeshes;
    medium.visible = false;
    far.visible = false;
    group.add(fine, medium, far);
    fine.updateWorldMatrix(true, true);
    const localBounds = new THREE.Box3().setFromObject(fine),
      sphere = localBounds.getBoundingSphere(new THREE.Sphere());
    const lod: TerrainLod = {
      group,
      fine,
      medium,
      far,
      center: sphere.center.clone(),
      voxelSize: asset.voxelSize,
      tier: 0,
    };
    return { visual: { group, bones: fineVisual.bones, animate: fineVisual.animate }, lod };
  }

  private installSceneLodHook() {
    if (this.installedSceneHook) return;
    const scene = this.scene,
      previous = scene.onBeforeRender;
    this.previousSceneHook = previous;
    const hook: THREE.Scene['onBeforeRender'] = (...args) => {
      Reflect.apply(previous, scene, args);
      this.prepareOcclusion(args[2]);
      this.updateLod(args[2], args[0].getDrawingBufferSize(this.viewportSize).y);
    };
    this.installedSceneHook = hook;
    scene.onBeforeRender = hook;
  }

  private enableBatchOcclusion(batch: Batch) {
    const scheduler = this.occlusion,
      geometry = this.occlusionGeometry,
      material = this.occlusionMaterial;
    if (!scheduler || !geometry || !material) return;
    const token = {};
    if (!scheduler.register(token)) return;
    batch.occlusionToken = token;
    batch.occlusionProxy = new THREE.Mesh(geometry, material);
    batch.occlusionProxy.matrixAutoUpdate = false;
    batch.occlusionProxy.frustumCulled = false;
    batch.occlusionProxy.renderOrder = 0.5;
    batch.occlusionProxy.castShadow = false;
    batch.occlusionProxy.receiveShadow = false;
    batch.occlusionProxy.onBeforeRender = () => scheduler.begin(token);
    batch.occlusionProxy.onAfterRender = () => scheduler.end(token);
    this.scene.add(batch.occlusionProxy);
    this.occlusionBatches.push(batch);
    this.bindOcclusionBatchMesh(batch);
  }

  private bindOcclusionBatchMesh(batch: Batch) {
    const token = batch.occlusionToken,
      scheduler = this.occlusion;
    if (!token || !scheduler) return;
    const mesh = batch.mesh;
    mesh.renderOrder = 1;
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      if (!this.occlusionEnabled || camera !== this.occlusionCamera || !scheduler.isOccluded(token)) return;
      batch.drawCount = mesh.count;
      this.occlusionSuppressedInstances += mesh.count;
      this.occlusionSuppressedBatchFrames++;
      mesh.count = 0;
    };
    mesh.onAfterRender = () => {
      if (batch.drawCount === undefined) return;
      mesh.count = batch.drawCount;
      batch.drawCount = undefined;
    };
  }

  private removeBatchOcclusion(batch: Batch) {
    const token = batch.occlusionToken;
    if (token) this.occlusion?.remove(token);
    batch.occlusionProxy?.removeFromParent();
    const index = this.occlusionBatches.indexOf(batch);
    if (index >= 0) this.occlusionBatches.splice(index, 1);
    batch.occlusionProxy = undefined;
    batch.occlusionToken = undefined;
  }

  private prepareOcclusion(camera: THREE.Camera) {
    const scheduler = this.occlusion;
    this.occlusionCamera = camera;
    if (!scheduler) return;
    if (!this.occlusionEnabled) {
      for (const batch of this.occlusionBatches) {
        batch.mesh.renderOrder = 0;
        batch.occlusionProxy!.visible = false;
      }
      return;
    }
    camera.updateWorldMatrix(true, false);
    if (
      !this.hasOcclusionCamera ||
      !camera.matrixWorld.equals(this.previousOcclusionWorld) ||
      !camera.projectionMatrix.equals(this.previousOcclusionProjection)
    ) {
      scheduler.invalidate();
      this.previousOcclusionWorld.copy(camera.matrixWorld);
      this.previousOcclusionProjection.copy(camera.projectionMatrix);
      this.hasOcclusionCamera = true;
    }
    this.occlusionView.copy(camera.matrixWorld).invert();
    this.occlusionProjectionView.multiplyMatrices(camera.projectionMatrix, this.occlusionView);
    this.occlusionFrustum.setFromProjectionMatrix(this.occlusionProjectionView);
    this.visibleOcclusionTokens.clear();
    for (const batch of this.occlusionBatches) {
      const token = batch.occlusionToken,
        mesh = batch.mesh;
      if (!token) continue;
      mesh.updateWorldMatrix(true, false);
      if (!mesh.boundingBox) mesh.computeBoundingBox();
      if (
        mesh.boundingBox &&
        this.occlusionFrustum.intersectsBox(
          this.occlusionBounds.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld),
        )
      )
        this.visibleOcclusionTokens.add(token);
    }
    scheduler.prepare((token) => this.visibleOcclusionTokens.has(token));
    for (const batch of this.occlusionBatches) {
      if (scheduler.enabled) {
        batch.mesh.renderOrder = 1;
        batch.occlusionProxy!.renderOrder = 0.5;
        const token = batch.occlusionToken!;
        batch.occlusionProxy!.visible = this.visibleOcclusionTokens.has(token) && scheduler.willRun(token);
      } else {
        batch.mesh.renderOrder = 0;
        batch.occlusionProxy!.visible = false;
      }
    }
  }

  /** Refreshes terrain representations for the active render camera. */
  updateLod(camera: THREE.Camera, viewportHeight = 900) {
    if (!this.terrainLods.size) return;
    camera.getWorldPosition(this.cameraPosition);
    camera.getWorldDirection(this.cameraDirection);
    const perspective = camera instanceof THREE.PerspectiveCamera;
    const pixelsPerDepthUnit =
      Math.abs(camera.projectionMatrix.elements[5]) * Math.max(0, viewportHeight) * 0.5;
    for (const lod of this.terrainLods.values()) {
      lod.group.updateWorldMatrix(true, false);
      this.terrainCenter.copy(lod.center).applyMatrix4(lod.group.matrixWorld);
      lod.group.getWorldScale(this.terrainScale);
      const worldScale = Math.max(this.terrainScale.x, this.terrainScale.y, this.terrainScale.z);
      const depth = this.cameraToTerrain
        .copy(this.terrainCenter)
        .sub(this.cameraPosition)
        .dot(this.cameraDirection);
      const pixelsPerMeter = pixelsPerDepthUnit / (perspective ? Math.max(camera.near, depth, 0.001) : 1);
      const projectedCell = lod.voxelSize * worldScale * pixelsPerMeter;
      const mediumSpacing = projectedCell * (TERRAIN_LOD_CELL_SIZE - 1);
      const farSpacing = projectedCell * (TERRAIN_FAR_LOD_CELL_SIZE - 1);
      const thresholdIn = TERRAIN_LOD_PIXEL_THRESHOLD * 0.9;
      const thresholdOut = TERRAIN_LOD_PIXEL_THRESHOLD * 1.1;
      let tier = lod.tier;
      if (tier === 0) {
        if (farSpacing <= thresholdIn) tier = 2;
        else if (mediumSpacing <= thresholdIn) tier = 1;
      } else if (tier === 1) {
        if (farSpacing <= thresholdIn) tier = 2;
        else if (mediumSpacing > thresholdOut) tier = 0;
      } else if (farSpacing > thresholdOut) {
        tier = mediumSpacing > thresholdOut ? 0 : 1;
      }
      if (tier === lod.tier) continue;
      lod.tier = tier;
      lod.fine.visible = tier === 0;
      lod.medium.visible = tier === 1;
      lod.far.visible = tier === 2;
    }
  }
  update(node: SceneNode, enabled = node.enabled) {
    const { position, rotation, scale } = node.transform;
    const previous = this.states.get(node.id),
      attachmentsChanged = !!previous && !sameAttachments(previous.attachments, node.attachments);
    if (
      previous &&
      previous.enabled === enabled &&
      previous.position[0] === position[0] &&
      previous.position[1] === position[1] &&
      previous.position[2] === position[2] &&
      previous.rotation[0] === rotation[0] &&
      previous.rotation[1] === rotation[1] &&
      previous.rotation[2] === rotation[2] &&
      previous.scale[0] === scale[0] &&
      previous.scale[1] === scale[1] &&
      previous.scale[2] === scale[2] &&
      !attachmentsChanged
    )
      return;
    this.states.set(node.id, {
      position: [position[0], position[1], position[2]],
      rotation: [rotation[0], rotation[1], rotation[2]],
      scale: [scale[0], scale[1], scale[2]],
      enabled,
      attachments: node.attachments,
    });
    this.occlusion?.invalidate();
    if (attachmentsChanged) this.rebuildNode(node);
    const group = this.nodes.get(node.id)!.group;
    group.position.set(...position);
    group.rotation.set(...rotation);
    group.scale.set(...scale);
    group.visible = enabled;
    let instance = this.instances.get(node.id);
    if (!instance) return;
    if (instance.batch.cellKey !== instanceCellKey(position)) {
      const asset = this.assets.get(instance.batch.assetId);
      if (!asset) return;
      this.removeInstance(node.id, instance);
      instance = this.addInstance(node, asset);
      instance.batch.cellKey = instanceCellKey(position);
    }
    group.updateMatrix();
    const matrix = this.matrix.copy(group.matrix).multiply(instance.batch.template.matrix);
    if (!enabled) matrix.scale(this.zero);
    if (matrix.equals(instance.matrix)) return;
    instance.matrix.copy(matrix);
    instance.batch.mesh.setMatrixAt(instance.index, matrix);
    instance.batch.dirty = true;
  }
  flush() {
    for (const batch of this.batches)
      if (batch.dirty) {
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.mesh.computeBoundingBox();
        batch.mesh.computeBoundingSphere();
        if (batch.occlusionProxy && batch.mesh.boundingBox) {
          const center = batch.mesh.boundingBox.getCenter(new THREE.Vector3());
          const size = batch.mesh.boundingBox.getSize(new THREE.Vector3());
          size.set(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4));
          batch.occlusionProxy.matrix.compose(center, new THREE.Quaternion(), size);
          batch.occlusionProxy.matrixWorldNeedsUpdate = true;
          this.occlusion?.invalidate(batch.occlusionToken);
        }
        batch.dirty = false;
      }
  }
  bounds(id: string) {
    const instance = this.instances.get(id);
    if (instance) {
      const geometry = instance.batch.mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      return geometry.boundingBox!.clone().applyMatrix4(instance.matrix);
    }
    const lod = this.terrainLods.get(id);
    if (lod) {
      lod.fine.updateWorldMatrix(true, true);
      return new THREE.Box3().setFromObject(lod.fine);
    }
    const group = this.nodes.get(id)!.group;
    group.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3();
    group.traverse((object) => {
      const assetBounds = object.userData.assetBounds as THREE.Box3 | undefined;
      if (assetBounds && !assetBounds.isEmpty())
        bounds.union(assetBounds.clone().applyMatrix4(object.matrixWorld));
      else if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh)) {
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        if (object.geometry.boundingBox)
          bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      }
    });
    if (bounds.isEmpty()) return new THREE.Box3().setFromObject(group);
    return bounds;
  }
  nodeAt(hit: THREE.Intersection) {
    if (hit.instanceId !== undefined && hit.object.userData.nodeIds)
      return hit.object.userData.nodeIds[hit.instanceId] as string;
    let object: THREE.Object3D | null = hit.object;
    while (object && !object.userData.nodeId) object = object.parent;
    return object?.userData.nodeId as string | undefined;
  }
  stats() {
    const terrainLodTiers = { fine: 0, medium: 0, far: 0 };
    for (const lod of this.terrainLods.values())
      terrainLodTiers[lod.tier === 0 ? 'fine' : lod.tier === 1 ? 'medium' : 'far']++;
    return {
      objects: this.nodes.size,
      instances: this.instances.size,
      batches: this.batches.length,
      sharedAssets: this.templates.length,
      individualObjects: this.individual.size,
      chunkedAssets: this.chunkedAssets,
      chunkMeshes: this.chunkMeshes,
      terrainLodMeshes: this.terrainLodMeshes,
      terrainLods: this.terrainLods.size,
      terrainLodTiers,
      occlusion: {
        ...(this.occlusion?.stats() ?? {
          available: false,
          registeredBatches: 0,
          pendingQueries: 0,
          scheduledQueries: 0,
          occludedBatches: 0,
          visibleResults: 0,
          occludedResults: 0,
          discardedResults: 0,
        }),
        enabled: this.occlusionEnabled,
        suppressedInstances: this.occlusionSuppressedInstances,
        suppressedBatchFrames: this.occlusionSuppressedBatchFrames,
      },
    };
  }
  dispose() {
    if (this.installedSceneHook && this.scene.onBeforeRender === this.installedSceneHook)
      this.scene.onBeforeRender = this.previousSceneHook!;
    for (const id of this.individual) {
      const group = this.nodes.get(id)!.group;
      if (!group.parent?.userData.nodeId) disposeObject(group);
    }
    for (const batch of this.batches) {
      this.removeBatchOcclusion(batch);
      batch.mesh.removeFromParent();
      batch.mesh.dispose();
    }
    this.occlusion?.dispose();
    if (this.contextCanvas) {
      this.contextCanvas.removeEventListener('webglcontextlost', this.contextLost);
      this.contextCanvas.removeEventListener('webglcontextrestored', this.contextRestored);
    }
    this.occlusionGeometry?.dispose();
    this.occlusionMaterial?.dispose();
    for (const template of this.templates) disposeObject(template.group);
    this.nodes.clear();
    this.states.clear();
    this.terrainLods.clear();
    this.templatesByAsset.clear();
    this.batchesByCell.clear();
    this.occlusionBatches = [];
  }
}
