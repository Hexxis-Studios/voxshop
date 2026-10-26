import { encodeVOX, encodeQB, encodeMinecraft, decodeVOX, decodeQB, decodeMinecraft } from './voxelFormats';
import { loadRasterImage, imageVoxels, textVoxels } from './rasterVoxelization';
import { voxelizeMeshWithMetadata, voxelizeMeshWithRig } from './meshVoxelization';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createNoise2D, createNoise3D } from 'simplex-noise';
import {
  AppState,
  SimulationVoxel,
  RebuildTarget,
  VoxelData,
  VoxelDelta,
  VoxelMaterial,
  VoxelWeight,
  SceneObject,
} from '../types';
import { CONFIG } from '../utils/voxelConstants';
import { SkeletonDef, SKELETONS } from '../utils/riggingConstants';
import {
  cloneSkeleton,
  cloneVoxel,
  createModelDocument,
  normalizeVoxels,
  parseModelDocument,
  serializeModelDocument,
  type ModelDocument,
} from './modelDocument';
import {
  applyVoxelCommand,
  blendVoxelWeights,
  createMoveCommandFromLookup,
  moveVoxelInLookup,
  createVoxelEdit,
  createVoxelEditFromLookup,
  replaceModelCommand,
  type VoxelEdit,
} from './modelCommands';
import { flipVoxels, rotateVoxels90 } from './modelTransforms';
import { resolveSkinWeights } from './skinWeights';
import { countVoxelsByMaterial, materialInstanceCapacities } from './modelInstanceCapacity';

function sameVoxelData(a: VoxelData, b: VoxelData): boolean {
  const aWeights = a.weights ?? [];
  const bWeights = b.weights ?? [];
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.z === b.z &&
    a.color === b.color &&
    (a.materialType ?? VoxelMaterial.STANDARD) === (b.materialType ?? VoxelMaterial.STANDARD) &&
    !!a.isLocked === !!b.isLocked &&
    a.bone === b.bone &&
    aWeights.length === bWeights.length &&
    aWeights.every(
      (weight, index) => weight.bone === bWeights[index].bone && weight.weight === bWeights[index].weight,
    )
  );
}

export class VoxelEngine {
  public onDocumentChange?: (document: ModelDocument) => void;
  public onWeightSelection?: (voxel: VoxelData | null) => void;
  public active = true;
  private replayVersion = 0;
  private replaySource: VoxelData[] | null = null;
  private documentVersion = 0;
  public get documentRevision() {
    return this.documentVersion ?? 0;
  }
  private container: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private controls: OrbitControls;
  private standardMesh: THREE.InstancedMesh | null = null;
  private metallicMesh: THREE.InstancedMesh | null = null;
  private glassMesh: THREE.InstancedMesh | null = null;
  private emissiveMesh: THREE.InstancedMesh | null = null;

  private dummy = new THREE.Object3D();
  private transformControl: TransformControls;
  private editMesh: THREE.Mesh | null = null;
  private editInstanceId: number | null = null;
  private editInstanceType: VoxelMaterial | null = null;

  public currentEditColor: string | null = null;
  public currentEditMaterial: VoxelMaterial = VoxelMaterial.STANDARD;
  public editMode: 'move' | 'paint' | 'add' | 'delete' | 'lock' | 'fill' = 'move';
  private symmetryX = false;
  private symmetryY = false;
  private symmetryZ = false;
  private undoStack: VoxelDelta[] = [];
  private redoStack: VoxelDelta[] = [];
  private initialModelState: VoxelData[] = [];
  private voxelSnapshot: VoxelData[] | null = null;
  public brushType: 'single' | 'sphere' | 'box' = 'single';
  public brushSize: number = 1;

  private voxels: SimulationVoxel[] = [];
  private voxelMap: Map<string, SimulationVoxel> = new Map();
  private instanceIndices = new WeakMap<SimulationVoxel, number>();
  private rebuildTargets: RebuildTarget[] = [];
  private pendingRebuildModel: VoxelData[] | null = null;
  private pendingRebuildCommand: VoxelDelta | null = null;
  private rebuildStartTime: number = 0;
  private dismantleStartTime: number = 0;

  private state: AppState = AppState.STABLE;
  private onStateChange: (state: AppState) => void;
  private onCountChange: (count: number) => void;
  private animationId: number = 0;
  private sceneObjectMeshes: Map<string, THREE.InstancedMesh[]> = new Map();
  private gridHelper: THREE.GridHelper | null = null;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private isPainting = false;
  private paintStroke: Map<string, { before: VoxelData; after: VoxelData }> | null = null;
  private currentPaintBone: string | null = null;
  private currentPaintWeight = 1;
  private currentPaintColor: THREE.Color = new THREE.Color();
  private selectedWeightPosition: { x: number; y: number; z: number } | null = null;

  private currentSkeleton: SkeletonDef | null = null;
  private rigGroup: THREE.Group | null = null;
  private boneGroups: Record<string, THREE.Bone> = {};
  private bonePivots: Record<string, THREE.Vector3> = {};
  private boneRestRotations: Record<string, THREE.Quaternion> = {};
  private rigSkeleton: THREE.Skeleton | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private clock = new THREE.Clock();
  private currentAction: THREE.AnimationAction | null = null;
  private bloomPass!: UnrealBloomPass;
  private bakedAOEnabled = false;
  private bakedAOStrength = 0.5;
  private solidPreviewEnabled = false;
  private solidPreviewMesh: THREE.Mesh | null = null;
  private boneIndexMap: Record<string, number> = {};

  constructor(
    container: HTMLElement,
    onStateChange: (state: AppState) => void,
    onCountChange: (count: number) => void,
  ) {
    this.container = container;
    this.onStateChange = onStateChange;
    this.onCountChange = onCountChange;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(CONFIG.BG_COLOR);
    this.scene.fog = new THREE.Fog(CONFIG.BG_COLOR, 80, 160);

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(30, 30, 60);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.3,
      0.5,
      0.1,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.controls.target.set(0, 5, 0);

    this.transformControl = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControl.addEventListener('dragging-changed', (e) => (this.controls.enabled = !e.value));
    this.scene.add(this.transformControl.getHelper());
    this.scene.add(new THREE.AmbientLight(0x8bb4d8, 0.5));

    const dirLight = new THREE.DirectionalLight(0xfff5e0, 2.2);
    dirLight.position.set(50, 80, 30);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 300;
    this.scene.add(dirLight);

    const rimLight = new THREE.DirectionalLight(0x4488ff, 0.8);
    rimLight.position.set(-60, 40, -60);
    this.scene.add(rimLight);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x141922, roughness: 0.95, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = CONFIG.FLOOR_Y;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.gridHelper = new THREE.GridHelper(64, 64, 0x1e2530, 0x1e2530);
    this.gridHelper.position.y = CONFIG.FLOOR_Y + 0.01;
    this.gridHelper.visible = false;
    this.scene.add(this.gridHelper);

    this.animate = this.animate.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    this.animate();
  }

  public setGridVisible(visible: boolean) {
    if (this.gridHelper) {
      this.gridHelper.visible = visible;
    }
  }

  public loadInitialModel(data: VoxelData[], skeleton: SkeletonDef | null = null) {
    const document = createModelDocument(data, skeleton);
    this.selectedWeightPosition = null;
    this.onWeightSelection?.(null);
    this.documentVersion = this.documentRevision + 1;
    this.replayVersion = (this.replayVersion ?? 0) + 1;
    this.replaySource = null;
    this.clearEditSelection();
    this.clearRig();
    this.currentSkeleton = document.skeleton;
    this.pendingRebuildModel = null;
    this.pendingRebuildCommand = null;
    this.rebuildTargets = [];
    this.isPainting = false;
    this.paintStroke = null;
    this.initialModelState = document.voxels.map(cloneVoxel);
    this.createVoxels(document.voxels);
    this.onCountChange(this.voxels.length);
    this.state = AppState.STABLE;
    this.onStateChange(this.state);
    this.applyDisplayState();

    this.undoStack = [];
    this.redoStack = [];
    this.voxelSnapshot = null;
    this.onDocumentChange?.(this.getModelDocument());
  }

  public setBrushType(type: 'single' | 'sphere' | 'box') {
    this.brushType = type;
  }

  public setBrushSize(size: number) {
    this.brushSize = size;
  }

  public undo() {
    if (this.state === AppState.REBUILDING || this.state === AppState.DISMANTLING) return;
    this.deselectEditVoxel();
    if (this.undoStack.length === 0) return;
    const delta = this.undoStack.pop()!;
    this.redoStack.push(delta);
    this.applyDelta(delta, true);
  }

  public redo() {
    if (this.state === AppState.REBUILDING || this.state === AppState.DISMANTLING) return;
    this.deselectEditVoxel();
    if (this.redoStack.length === 0) return;
    const delta = this.redoStack.pop()!;
    this.undoStack.push(delta);
    this.applyDelta(delta, false);
  }

  private applyDelta(delta: VoxelDelta, isUndo: boolean, publishDocument = true) {
    this.cancelReplay();
    this.documentVersion = this.documentRevision + 1;
    if (this.applyDataOnlyDelta(delta, isUndo, publishDocument)) return;
    const updated = applyVoxelCommand(this.getVoxelDataForSave(), delta, isUndo);
    const rig = this.state === AppState.RIGGING ? this.currentSkeleton : null;
    this.clearRig();
    this.createVoxels(updated);
    this.publishWeightSelection();
    if (rig) this.buildRigAndPreview(rig, false);
    else this.applyDisplayState();
    this.onCountChange(this.voxels.length);
    if (publishDocument) this.onDocumentChange?.(this.getModelDocument());
  }

  public editVoxels(edit: VoxelEdit) {
    if (this.state === AppState.REBUILDING || this.state === AppState.DISMANTLING) return;
    const command = createVoxelEditFromLookup((key) => {
      const voxel = this.voxelMap.get(key);
      return voxel ? this.toVoxelData(voxel) : undefined;
    }, edit);
    if (command.voxels.length === 0) return;
    this.applyDelta(command, false, false);
    this.commitChange(command);
  }

  private commitChange(delta: VoxelDelta) {
    this.undoStack.push(structuredClone(delta));
    this.redoStack = [];
    this.onDocumentChange?.(this.getModelDocument());
  }

  private applyDataOnlyDelta(delta: VoxelDelta, isUndo: boolean, publishDocument: boolean): boolean {
    if (
      (this.state !== AppState.STABLE && this.state !== AppState.EDITING) ||
      this.rigGroup ||
      this.solidPreviewEnabled ||
      this.solidPreviewMesh ||
      this.replaySource
    )
      return false;
    if (delta.action === 'move') return this.applyMoveDataOnlyDelta(delta, isUndo, publishDocument);

    const updates: {
      voxel: SimulationVoxel;
      after: VoxelData;
      mesh: THREE.InstancedMesh;
      index: number;
      updateColor: boolean;
    }[] = [];
    for (const change of delta.voxels) {
      const source = isUndo ? change.after : change.before;
      const target = isUndo ? change.before : change.after;
      if (
        !source ||
        !target ||
        source.x !== target.x ||
        source.y !== target.y ||
        source.z !== target.z ||
        (source.materialType ?? VoxelMaterial.STANDARD) !== (target.materialType ?? VoxelMaterial.STANDARD)
      )
        return false;

      const voxel = this.voxelMap.get(`${source.x},${source.y},${source.z}`);
      if (!voxel || !sameVoxelData(this.toVoxelData(voxel), source)) return false;
      const mesh = this.getMeshForMaterial(voxel.materialType);
      const index = this.instanceIndices?.get(voxel);
      if (
        !mesh ||
        index === undefined ||
        index >= mesh.count ||
        voxel.materialType === VoxelMaterial.EMISSIVE
      )
        return false;
      const after = normalizeVoxels([target])[0];
      updates.push({
        voxel,
        after,
        mesh,
        index,
        updateColor: voxel.originalColor?.getHex() !== after.color || voxel.isLocked !== !!after.isLocked,
      });
    }

    const colorMeshes = new Set<THREE.InstancedMesh>();
    for (const { voxel, after, mesh, index, updateColor } of updates) {
      if (updateColor) {
        const originalColor = new THREE.Color(after.color);
        voxel.originalColor?.copy(originalColor);
        voxel.color.copy(after.isLocked ? originalColor.clone().offsetHSL(0, 0, -0.2) : originalColor);
        mesh.setColorAt(index, voxel.color);
        colorMeshes.add(mesh);
      }
      voxel.isLocked = !!after.isLocked;
      voxel.bone = after.bone;
      voxel.weights = (after.weights ?? []).map((weight) => ({ ...weight }));
    }
    for (const mesh of colorMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.publishWeightSelection();
    this.onCountChange(this.voxels.length);
    if (publishDocument) this.onDocumentChange?.(this.getModelDocument());
    return true;
  }

  private applyMoveDataOnlyDelta(delta: VoxelDelta, isUndo: boolean, publishDocument: boolean): boolean {
    if (delta.voxels.length !== 1) return false;
    const change = delta.voxels[0];
    const source = isUndo ? change.after : change.before;
    const target = isUndo ? change.before : change.after;
    if (!source || !target || (source.x === target.x && source.y === target.y && source.z === target.z))
      return false;

    const expectedTarget = { ...source, x: target.x, y: target.y, z: target.z };
    if (!sameVoxelData(expectedTarget, target)) return false;
    const sourceKey = `${source.x},${source.y},${source.z}`;
    const destinationKey = `${target.x},${target.y},${target.z}`;
    const voxel = this.voxelMap.get(sourceKey);
    if (!voxel || voxel.isLocked || !sameVoxelData(this.toVoxelData(voxel), source)) return false;
    const mesh = this.getMeshForMaterial(voxel.materialType);
    const index = this.instanceIndices.get(voxel);
    if (!mesh || index === undefined || index >= mesh.count || this.voxelMap.has(destinationKey))
      return false;
    if (moveVoxelInLookup(this.voxelMap, source, target) !== voxel) return false;

    this.dummy.position.set(voxel.x, voxel.y, voxel.z);
    this.dummy.rotation.set(voxel.rx, voxel.ry, voxel.rz);
    this.dummy.scale.setScalar(voxel.scale ?? 1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
    this.publishWeightSelection();
    this.onCountChange(this.voxels.length);
    if (publishDocument) this.onDocumentChange?.(this.getModelDocument());
    return true;
  }

  private toVoxelData(voxel: SimulationVoxel): VoxelData {
    return {
      x: Math.round(voxel.x),
      y: Math.round(voxel.y),
      z: Math.round(voxel.z),
      color: (voxel.originalColor || voxel.color).getHex(),
      isLocked: voxel.isLocked,
      ...(voxel.materialType !== VoxelMaterial.STANDARD && { materialType: voxel.materialType }),
      ...(voxel.bone && { bone: voxel.bone }),
      ...(voxel.weights.length > 0 && { weights: voxel.weights.map((weight) => ({ ...weight })) }),
    };
  }

  public async playTimeLapse() {
    if (this.undoStack.length === 0 || this.state !== AppState.STABLE || this.replaySource) return;
    const commands = structuredClone(this.undoStack);
    const source = this.getVoxelDataForSave();
    const generation = (this.replayVersion = (this.replayVersion ?? 0) + 1);
    this.replaySource = source;
    let preview = structuredClone(this.initialModelState);
    this.createVoxels(preview);
    try {
      for (const command of commands) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (generation !== this.replayVersion) return;
        preview = applyVoxelCommand(preview, command);
        this.createVoxels(preview);
        this.applyDisplayState();
      }
    } finally {
      if (generation === this.replayVersion) {
        this.replaySource = null;
        this.createVoxels(source);
        this.applyDisplayState();
      }
    }
  }

  private cancelReplay() {
    if (!this.replaySource) return;
    const source = this.replaySource;
    this.replaySource = null;
    this.replayVersion++;
    this.createVoxels(source);
    this.applyDisplayState();
  }

  public async voxelizeImage(imageFile: File) {
    const version = this.documentRevision;
    const image = await loadRasterImage(imageFile);
    if (this.documentRevision !== version)
      throw new Error('Image import cancelled because the active model changed.');
    this.loadInitialModel(imageVoxels(image));
  }

  public voxelizeText(text: string, fontSize = 32, color = 0x3b82f6) {
    this.loadInitialModel(textVoxels(text, fontSize, color));
  }

  public async voxelizeMesh(
    object: THREE.Object3D,
    resolution: number | null = null,
    clips: THREE.AnimationClip[] = [],
  ): Promise<number | undefined> {
    const rigged = voxelizeMeshWithRig(object, resolution, clips);
    if (rigged) {
      this.loadInitialModel(rigged.voxels, rigged.skeleton);
      return rigged.voxelSize;
    }
    const converted = voxelizeMeshWithMetadata(object, resolution);
    if (converted?.voxels) this.loadInitialModel(converted.voxels);
    return converted?.voxels ? converted.voxelSize : undefined;
  }

  public resample(scaleFactor: number) {
    if (this.voxels.length === 0) return;
    const newVoxelsMap = new Map<string, VoxelData>();
    this.getVoxelDataForSave().forEach((v) => {
      const rx = Math.round(v.x * scaleFactor),
        ry = Math.round(v.y * scaleFactor),
        rz = Math.round(v.z * scaleFactor);
      const key = `${rx},${ry},${rz}`;
      if (!newVoxelsMap.has(key)) {
        newVoxelsMap.set(key, { ...v, x: rx, y: ry, z: rz });
      }
    });
    this.transformModel(Array.from(newVoxelsMap.values()));
  }

  private getAllMeshes(): THREE.InstancedMesh[] {
    return [this.standardMesh, this.metallicMesh, this.glassMesh, this.emissiveMesh].filter(
      (m) => m !== null,
    ) as THREE.InstancedMesh[];
  }

  private createVoxels(data: VoxelData[]) {
    this.voxels = normalizeVoxels(data).map((v, i) => {
      const c = new THREE.Color(v.color);
      return {
        id: i,
        x: v.x,
        y: v.y,
        z: v.z,
        color: v.isLocked ? c.clone().offsetHSL(0, 0, -0.2) : c.clone(),
        originalColor: c,
        materialType: v.materialType || VoxelMaterial.STANDARD,
        isLocked: !!v.isLocked,
        bone: v.bone,
        weights: v.weights || [],
        vx: 0,
        vy: 0,
        vz: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        rvx: 0,
        rvy: 0,
        rvz: 0,
        scale: 1,
      };
    });
    this.rebuildInstancedMesh();
  }

  private initMaterialMeshes() {
    this.getAllMeshes().forEach((mesh) => {
      if (mesh) {
        this.scene.remove(mesh);
        mesh.dispose();
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
    const geometry = new THREE.BoxGeometry(
      CONFIG.VOXEL_SIZE - 0.05,
      CONFIG.VOXEL_SIZE - 0.05,
      CONFIG.VOXEL_SIZE - 0.05,
    );

    const capacities = materialInstanceCapacities(countVoxelsByMaterial(this.voxels));

    this.standardMesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 }),
      capacities[VoxelMaterial.STANDARD],
    );
    this.metallicMesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0.9 }),
      capacities[VoxelMaterial.METALLIC],
    );
    this.glassMesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshPhysicalMaterial({ transmission: 0.9, thickness: 0.5, transparent: true }),
      capacities[VoxelMaterial.GLASS],
    );
    this.emissiveMesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ emissiveIntensity: 2, roughness: 0.5 }),
      capacities[VoxelMaterial.EMISSIVE],
    );

    this.getAllMeshes().forEach((mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    });
  }

  private getMeshForMaterial(type: VoxelMaterial): THREE.InstancedMesh | null {
    switch (type) {
      case VoxelMaterial.METALLIC:
        return this.metallicMesh;
      case VoxelMaterial.GLASS:
        return this.glassMesh;
      case VoxelMaterial.EMISSIVE:
        return this.emissiveMesh;
      default:
        return this.standardMesh;
    }
  }

  private draw() {
    this.instanceIndices ??= new WeakMap();
    const counts = {
      [VoxelMaterial.STANDARD]: 0,
      [VoxelMaterial.METALLIC]: 0,
      [VoxelMaterial.GLASS]: 0,
      [VoxelMaterial.EMISSIVE]: 0,
    };
    this.voxels.forEach((v) => {
      const matType = v.materialType || VoxelMaterial.STANDARD;
      const mesh = this.getMeshForMaterial(matType);
      if (!mesh) return;
      const idx = counts[matType]++;
      this.instanceIndices.set(v, idx);

      if (idx >= mesh.instanceMatrix.count) return;

      this.dummy.position.set(v.x, v.y, v.z);
      this.dummy.rotation.set(v.rx, v.ry, v.rz);
      this.dummy.scale.setScalar(v.scale !== undefined ? v.scale : 1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(idx, this.dummy.matrix);
      mesh.setColorAt(idx, v.color);
      if (matType === VoxelMaterial.EMISSIVE)
        (mesh.material as THREE.MeshStandardMaterial).emissive.copy(v.color);
    });
    const allMeshes = [this.standardMesh, this.metallicMesh, this.glassMesh, this.emissiveMesh];
    const matKeys = [
      VoxelMaterial.STANDARD,
      VoxelMaterial.METALLIC,
      VoxelMaterial.GLASS,
      VoxelMaterial.EMISSIVE,
    ];
    allMeshes.forEach((mesh, i) => {
      if (mesh) {
        mesh.count = counts[matKeys[i]];
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    });
  }

  private rebuildInstancedMesh() {
    const counts = countVoxelsByMaterial(this.voxels);
    const meshes = {
      [VoxelMaterial.STANDARD]: this.standardMesh,
      [VoxelMaterial.METALLIC]: this.metallicMesh,
      [VoxelMaterial.GLASS]: this.glassMesh,
      [VoxelMaterial.EMISSIVE]: this.emissiveMesh,
    };
    if (
      Object.values(VoxelMaterial).some((material) => {
        const mesh = meshes[material];
        return !mesh || counts[material] > mesh.instanceMatrix.count;
      })
    ) {
      this.initMaterialMeshes();
    }

    this.voxelMap.clear();
    this.voxels.forEach((v, i) => {
      v.id = i;
      this.voxelMap.set(`${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`, v);
    });
    this.draw();
    this.getAllMeshes().forEach((mesh) => {
      mesh.boundingSphere = null;
    });
  }

  public mergeAIGeneratedModel(newData: VoxelData[]) {
    const locked = this.getVoxelDataForSave().filter((v) => v.isLocked);
    const preserved = new Set(locked.map((v) => `${v.x},${v.y},${v.z}`));
    const generated = normalizeVoxels(newData).filter((v) => !preserved.has(`${v.x},${v.y},${v.z}`));
    this.rebuild([...locked, ...generated]);
  }

  public explodeFromRig(preserveSnapshot = false) {
    if (!this.rigGroup || !this.rigSkeleton) return;

    if (!preserveSnapshot) this.createSnapshot();

    this.rigGroup.updateMatrixWorld(true);

    this.voxels.forEach((v) => {
      if (!v.bone) return;
      const bone = this.boneGroups[v.bone];
      if (!bone) return;
      const boneIdx = this.rigSkeleton!.bones.indexOf(bone);
      if (boneIdx === -1) return;
      const skinMatrix = new THREE.Matrix4().multiplyMatrices(
        bone.matrixWorld,
        this.rigSkeleton!.boneInverses[boneIdx],
      );
      const pos = new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(skinMatrix);
      const worldQuat = new THREE.Quaternion();
      bone.getWorldQuaternion(worldQuat);
      const euler = new THREE.Euler().setFromQuaternion(worldQuat);
      v.x = pos.x;
      v.y = pos.y;
      v.z = pos.z;
      v.rx = euler.x;
      v.ry = euler.y;
      v.rz = euler.z;
    });

    this.exitRiggingMode();
    this.dismantle(preserveSnapshot);
  }

  public dismantle(preserveSnapshot = false) {
    this.cancelReplay();
    if (this.state !== AppState.STABLE) return;
    if (!preserveSnapshot) this.createSnapshot();

    this.state = AppState.DISMANTLING;
    this.dismantleStartTime = performance.now();
    this.onStateChange(this.state);

    this.voxels.forEach((v) => {
      v.vx = (Math.random() - 0.5) * 0.8;
      v.vy = Math.random() * 0.5;
      v.vz = (Math.random() - 0.5) * 0.8;
      v.rvx = (Math.random() - 0.5) * 0.2;
      v.rvy = (Math.random() - 0.5) * 0.2;
      v.rvz = (Math.random() - 0.5) * 0.2;
      v.scale = 1;
    });
  }

  private createSnapshot() {
    this.voxelSnapshot = this.getVoxelDataForSave();
  }

  public restoreFromSnapshot() {
    if (!this.voxelSnapshot) return;
    const skeleton = this.currentSkeleton;
    const snapshotData = this.voxelSnapshot;
    this.loadInitialModel(snapshotData, skeleton);
    if (skeleton) {
      this.state = AppState.RIGGING;
      this.onStateChange(this.state);
      this.buildRigAndPreview(skeleton);
    }
  }

  public get hasSnapshot(): boolean {
    return this.voxelSnapshot !== null;
  }

  public rebuild(targetModel: VoxelData[]) {
    this.cancelReplay();
    if (this.state === AppState.REBUILDING) return;
    const target = normalizeVoxels(targetModel);
    const before =
      this.state === AppState.DISMANTLING && this.voxelSnapshot
        ? this.voxelSnapshot.map(cloneVoxel)
        : this.getVoxelDataForSave();
    this.pendingRebuildModel = target;
    this.pendingRebuildCommand = replaceModelCommand(before, target);
    this.clearRig();
    this.disposeSolidPreview();
    this.getAllMeshes().forEach((mesh) => {
      mesh.visible = true;
    });

    const available = this.voxels.map((v, i) => ({ index: i, color: v.color, taken: false }));
    const mappings: RebuildTarget[] = new Array(this.voxels.length).fill(null);

    target.forEach((target) => {
      let bestDist = 9999,
        bestIdx = -1;
      for (let i = 0; i < available.length; i++) {
        if (available[i].taken) continue;
        const c2 = new THREE.Color(target.color);
        const d = Math.sqrt(
          Math.pow((available[i].color.r - c2.r) * 0.3, 2) +
            Math.pow((available[i].color.g - c2.g) * 0.59, 2) +
            Math.pow((available[i].color.b - c2.b) * 0.11, 2),
        );
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
          if (d < 0.01) break;
        }
      }
      if (bestIdx !== -1) {
        available[bestIdx].taken = true;
        mappings[available[bestIdx].index] = {
          x: target.x,
          y: target.y,
          z: target.z,
          delay: Math.max(0, (target.y - CONFIG.FLOOR_Y) / 15) * 800,
          color: target.color,
        };
      } else {
        const newIdx = this.voxels.length;
        this.voxels.push({
          id: newIdx,
          x: (Math.random() - 0.5) * 10,
          y: CONFIG.FLOOR_Y + 0.5,
          z: (Math.random() - 0.5) * 10,
          color: new THREE.Color(target.color),
          originalColor: new THREE.Color(target.color),
          weights: [],
          materialType: target.materialType || VoxelMaterial.STANDARD,
          isLocked: false,
          vx: 0,
          vy: 0,
          vz: 0,
          rx: 0,
          ry: 0,
          rz: 0,
          rvx: 0,
          rvy: 0,
          rvz: 0,
          scale: 1,
        });
        mappings.push({
          x: target.x,
          y: target.y,
          z: target.z,
          delay: Math.max(0, (target.y - CONFIG.FLOOR_Y) / 15) * 800,
          color: target.color,
        });
      }
    });

    this.rebuildTargets = mappings;
    this.rebuildStartTime = Date.now();
    this.state = AppState.REBUILDING;
    this.onStateChange(this.state);
    this.rebuildInstancedMesh();
    this.onCountChange(this.voxels.length);
  }

  private updatePhysics() {
    if (this.state === AppState.DISMANTLING) {
      const elapsed = performance.now() - this.dismantleStartTime;
      this.voxels.forEach((v) => {
        v.vy -= 0.025;
        v.x += v.vx;
        v.y += v.vy;
        v.z += v.vz;
        v.rx += v.rvx;
        v.ry += v.rvy;
        v.rz += v.rvz;
        if (v.y < CONFIG.FLOOR_Y + 0.5) {
          v.y = CONFIG.FLOOR_Y + 0.5;
          v.vy *= -0.5;
          v.vx *= 0.9;
          v.vz *= 0.9;
        }
        if (elapsed > 3000) v.scale = Math.max(0, 1 - Math.pow(Math.min(1, (elapsed - 3000) / 2000), 3));
      });
    } else if (this.state === AppState.REBUILDING) {
      const elapsed = Date.now() - this.rebuildStartTime;
      let allDone = true;
      this.voxels.forEach((v, i) => {
        const t = this.rebuildTargets[i];
        if (!t || elapsed < t.delay) {
          if (t) allDone = false;
          return;
        }
        const speed = 0.12;
        v.x += (t.x - v.x) * speed;
        v.y += (t.y - v.y) * speed;
        v.z += (t.z - v.z) * speed;
        v.rx *= 0.9;
        v.ry *= 0.9;
        v.rz *= 0.9;
        if (Math.max(Math.abs(v.x - t.x), Math.abs(v.y - t.y), Math.abs(v.z - t.z)) > 0.01) allDone = false;
        else {
          v.x = t.x;
          v.y = t.y;
          v.z = t.z;
          v.rx = 0;
          v.ry = 0;
          v.rz = 0;
          if (t.color !== undefined) {
            v.color.set(t.color);
            v.originalColor = v.color.clone();
          }
        }
      });
      if (allDone) {
        const model = this.pendingRebuildModel;
        const command = this.pendingRebuildCommand;
        this.pendingRebuildModel = null;
        this.pendingRebuildCommand = null;
        this.rebuildTargets = [];
        if (model) this.createVoxels(model);
        if (command) this.commitChange(command);
        this.state = AppState.STABLE;
        this.onStateChange(this.state);
        this.onCountChange(this.voxels.length);
        this.applyDisplayState();
      }
    }
  }

  private animate() {
    this.animationId = requestAnimationFrame(this.animate);
    if (!this.active) return;
    const delta = this.clock.getDelta();
    if (this.mixer) this.mixer.update(delta);
    this.controls.update();
    this.updatePhysics();
    this.draw();
    this.composer.render();
  }

  public handleResize() {
    if (this.camera && this.renderer && this.composer) {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer.setSize(window.innerWidth, window.innerHeight);
    }
  }

  public setBloom(enabled: boolean, strength: number = 0.4) {
    this.bloomPass.enabled = enabled;
    this.bloomPass.strength = strength;
  }

  public setToneMapping(mode: 'none' | 'cinematic' | 'filmic') {
    if (mode === 'none') {
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.toneMappingExposure = 1.0;
    } else if (mode === 'cinematic') {
      this.renderer.toneMapping = THREE.CineonToneMapping;
      this.renderer.toneMappingExposure = 1.2;
    } else {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.1;
    }
  }

  public generateSphere(radius: number = 8) {
    const voxels: VoxelData[] = [];
    const r2 = radius * radius;
    const base = CONFIG.FLOOR_Y + 1;
    for (let x = -radius; x <= radius; x++)
      for (let y = 0; y <= radius * 2; y++)
        for (let z = -radius; z <= radius; z++)
          if (x * x + (y - radius) * (y - radius) + z * z <= r2)
            voxels.push({ x, y: y + base, z, color: 0x4488ff });
    this.rebuild(voxels);
  }

  public generateTerrain(width: number = 24, depth: number = 24) {
    const noise2D = createNoise2D();
    const voxels: VoxelData[] = [];
    const base = CONFIG.FLOOR_Y + 1;
    const palette = [0x2d6a2d, 0x3a8a3a, 0x5aaa5a, 0x7b5c3a, 0x9b7a5a, 0xd4d4d4];
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        const n =
          noise2D(x * 0.18, z * 0.18) * 0.5 +
          noise2D(x * 0.35, z * 0.35) * 0.3 +
          noise2D(x * 0.7, z * 0.7) * 0.2;
        const h = Math.max(1, Math.round(3 + (n + 1) * 5));
        for (let y = 0; y < h; y++) {
          const col =
            y === h - 1
              ? h > 9
                ? palette[5]
                : h > 6
                  ? palette[2]
                  : palette[1]
              : y < 2
                ? palette[3]
                : palette[0];
          voxels.push({ x: x - width / 2, y: y + base, z: z - depth / 2, color: col });
        }
      }
    }
    this.rebuild(voxels);
  }

  public generateNoiseBlob(size: number = 10) {
    const noise3D = createNoise3D();
    const voxels: VoxelData[] = [];
    const base = CONFIG.FLOOR_Y + 1;
    const palette = [0xff6644, 0xff8866, 0xffaa88, 0xdd4422];
    for (let x = -size; x <= size; x++)
      for (let y = 0; y <= size * 2; y++)
        for (let z = -size; z <= size; z++) {
          const cy = y - size;
          const d = Math.sqrt(x * x + cy * cy + z * z) / size;
          const n = noise3D(x * 0.25, y * 0.25, z * 0.25);
          if (d < 0.75 + n * 0.35) {
            const col = palette[Math.floor(Math.abs(d + n * 0.3) * palette.length) % palette.length];
            voxels.push({ x, y: y + base, z, color: col });
          }
        }
    this.rebuild(voxels);
  }

  public setBakedAO(enabled: boolean, strength: number = 0.5) {
    this.bakedAOEnabled = enabled;
    this.bakedAOStrength = strength;
    if (this.rigGroup) {
      const hasEmissiveVoxels = this.voxels.some((v) => v.materialType === VoxelMaterial.EMISSIVE);
      (this.rigGroup.children.filter((c) => c instanceof THREE.SkinnedMesh) as THREE.SkinnedMesh[]).forEach(
        (sm) => {
          const f = hasEmissiveVoxels
            ? sm.name === 'skinned_emissive'
              ? 'emissive'
              : 'non-emissive'
            : undefined;
          const old = sm.geometry;
          sm.geometry = this.buildSkinnedGeo(this.solidPreviewEnabled, f);
          old.dispose();
        },
      );
    } else if (this.solidPreviewEnabled) {
      this.refreshSolidPreview();
    }
  }

  private disposeSolidPreview() {
    if (this.solidPreviewMesh) {
      this.scene.remove(this.solidPreviewMesh);
      this.solidPreviewMesh.geometry.dispose();
      (this.solidPreviewMesh.material as THREE.Material).dispose();
      this.solidPreviewMesh = null;
    }
  }
  private applyDisplayState() {
    if (this.rigGroup) {
      this.disposeSolidPreview();
      this.getAllMeshes().forEach((m) => (m.visible = false));
    } else if (this.solidPreviewEnabled) {
      this.refreshSolidPreview();
      this.getAllMeshes().forEach((m) => (m.visible = false));
    } else {
      this.disposeSolidPreview();
      this.getAllMeshes().forEach((m) => (m.visible = true));
    }
  }

  private buildSkinnedGeo(
    hiddenFaceRemoval: boolean,
    filter?: 'emissive' | 'non-emissive',
  ): THREE.BufferGeometry {
    const h = hiddenFaceRemoval ? CONFIG.VOXEL_SIZE / 2 : (CONFIG.VOXEL_SIZE - 0.05) / 2;
    const faceData = [
      {
        n: [0, 0, -1] as [number, number, number],
        v: [
          [-h, -h, -h],
          [h, -h, -h],
          [h, h, -h],
          [-h, h, -h],
        ] as [number, number, number][],
      },
      {
        n: [0, 0, 1] as [number, number, number],
        v: [
          [h, -h, h],
          [-h, -h, h],
          [-h, h, h],
          [h, h, h],
        ] as [number, number, number][],
      },
      {
        n: [0, -1, 0] as [number, number, number],
        v: [
          [-h, -h, h],
          [h, -h, h],
          [h, -h, -h],
          [-h, -h, -h],
        ] as [number, number, number][],
      },
      {
        n: [0, 1, 0] as [number, number, number],
        v: [
          [-h, h, -h],
          [h, h, -h],
          [h, h, h],
          [-h, h, h],
        ] as [number, number, number][],
      },
      {
        n: [-1, 0, 0] as [number, number, number],
        v: [
          [-h, -h, h],
          [-h, h, h],
          [-h, h, -h],
          [-h, -h, -h],
        ] as [number, number, number][],
      },
      {
        n: [1, 0, 0] as [number, number, number],
        v: [
          [h, -h, -h],
          [h, h, -h],
          [h, h, h],
          [h, -h, h],
        ] as [number, number, number][],
      },
    ];
    const positions: number[] = [],
      normals: number[] = [],
      colors: number[] = [];
    const skinIndices: number[] = [],
      skinWeights: number[] = [],
      indices: number[] = [];
    const voxelsToProcess =
      filter === 'emissive'
        ? this.voxels.filter((v) => v.materialType === VoxelMaterial.EMISSIVE)
        : filter === 'non-emissive'
          ? this.voxels.filter((v) => v.materialType !== VoxelMaterial.EMISSIVE)
          : this.voxels;
    voxelsToProcess.forEach((v) => {
      const skin = resolveSkinWeights(v, this.rigSkeleton?.bones.map((bone) => bone.name) ?? []);
      const col = v.originalColor || v.color;
      const rx = Math.round(v.x),
        ry = Math.round(v.y),
        rz = Math.round(v.z);
      faceData.forEach((face) => {
        if (hiddenFaceRemoval && this.voxelMap.has(`${rx + face.n[0]},${ry + face.n[1]},${rz + face.n[2]}`))
          return;
        const base = positions.length / 3;
        const ni = face.n.findIndex((x) => x !== 0);
        const tIdx = [0, 1, 2].filter((i) => i !== ni);
        face.v.forEach(([ox, oy, oz]) => {
          positions.push(v.x + ox, v.y + oy, v.z + oz);
          normals.push(face.n[0], face.n[1], face.n[2]);
          const vArr = [ox, oy, oz];
          const sa = Math.sign(vArr[tIdx[0]]),
            sb = Math.sign(vArr[tIdx[1]]);
          const ao = this.bakedAOEnabled ? this.computeVertexAO(rx, ry, rz, tIdx[0], tIdx[1], sa, sb) : 1;
          colors.push(col.r * ao, col.g * ao, col.b * ao);
          skinIndices.push(...skin.indices);
          skinWeights.push(...skin.weights);
        });
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    geo.setIndex(indices);
    return geo;
  }

  public setSolidPreview(enabled: boolean) {
    this.solidPreviewEnabled = enabled;
    if (this.rigGroup) {
      const hasEmissiveVoxels = this.voxels.some((v) => v.materialType === VoxelMaterial.EMISSIVE);
      (this.rigGroup.children.filter((c) => c instanceof THREE.SkinnedMesh) as THREE.SkinnedMesh[]).forEach(
        (sm) => {
          const f = hasEmissiveVoxels
            ? sm.name === 'skinned_emissive'
              ? 'emissive'
              : 'non-emissive'
            : undefined;
          const old = sm.geometry;
          sm.geometry = this.buildSkinnedGeo(enabled, f);
          old.dispose();
        },
      );
    } else {
      this.applyDisplayState();
    }
  }

  private refreshSolidPreview() {
    if (this.solidPreviewMesh) {
      this.scene.remove(this.solidPreviewMesh);
      this.solidPreviewMesh.geometry.dispose();
      (this.solidPreviewMesh.material as THREE.Material).dispose();
      this.solidPreviewMesh = null;
    }
    if (this.voxels.length === 0) return;
    const mesh = this.generateOptimizedMesh();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.solidPreviewMesh = mesh;
  }

  private computeVertexAO(
    rx: number,
    ry: number,
    rz: number,
    tAxis0: number,
    tAxis1: number,
    sa: number,
    sb: number,
  ): number {
    const p = [rx, ry, rz];
    const e1 = [...p];
    e1[tAxis0] += sa;
    const e2 = [...p];
    e2[tAxis1] += sb;
    const c = [...p];
    c[tAxis0] += sa;
    c[tAxis1] += sb;
    const s1 = this.voxelMap.has(`${e1[0]},${e1[1]},${e1[2]}`);
    const s2 = this.voxelMap.has(`${e2[0]},${e2[1]},${e2[2]}`);
    const cn = this.voxelMap.has(`${c[0]},${c[1]},${c[2]}`);
    if (s1 && s2) return Math.max(0, 1.0 - 0.5 * this.bakedAOStrength);
    const occ = (s1 ? 1 : 0) + (s2 ? 1 : 0) + (cn ? 1 : 0);
    return Math.max(0, 1.0 - occ * 0.2 * this.bakedAOStrength);
  }

  public setAutoRotate(enabled: boolean) {
    if (this.controls) this.controls.autoRotate = enabled;
  }

  public getVoxelDataForSave(): VoxelData[] {
    if (this.replaySource) return this.replaySource.map(cloneVoxel);
    if (this.state === AppState.REBUILDING && this.pendingRebuildModel)
      return this.pendingRebuildModel.map(cloneVoxel);
    if (this.state === AppState.DISMANTLING && this.voxelSnapshot) return this.voxelSnapshot.map(cloneVoxel);
    return this.voxels.map((voxel) => this.toVoxelData(voxel));
  }

  public getJsonData(): string {
    return serializeModelDocument(this.getModelDocument());
  }

  public getModelDocument(): ModelDocument {
    return {
      format: 'voxshop-model',
      version: 1,
      voxels: this.getVoxelDataForSave(),
      skeleton: cloneSkeleton(this.currentSkeleton),
    };
  }

  public importJsonData(json: string) {
    const document = parseModelDocument(json);
    this.loadInitialModel(document.voxels, document.skeleton);
  }

  public getUniqueColors(): string[] {
    const colors = new Set<string>();
    this.voxels.forEach((v) => colors.add('#' + (v.originalColor || v.color).getHexString()));
    return Array.from(colors);
  }

  private buildStaticEmissiveMesh(): THREE.Mesh {
    const h = (CONFIG.VOXEL_SIZE - 0.05) / 2;
    const faceData = [
      {
        n: [0, 0, -1] as [number, number, number],
        v: [
          [-h, -h, -h],
          [h, -h, -h],
          [h, h, -h],
          [-h, h, -h],
        ] as [number, number, number][],
      },
      {
        n: [0, 0, 1] as [number, number, number],
        v: [
          [h, -h, h],
          [-h, -h, h],
          [-h, h, h],
          [h, h, h],
        ] as [number, number, number][],
      },
      {
        n: [0, -1, 0] as [number, number, number],
        v: [
          [-h, -h, h],
          [h, -h, h],
          [h, -h, -h],
          [-h, -h, -h],
        ] as [number, number, number][],
      },
      {
        n: [0, 1, 0] as [number, number, number],
        v: [
          [-h, h, -h],
          [h, h, -h],
          [h, h, h],
          [-h, h, h],
        ] as [number, number, number][],
      },
      {
        n: [-1, 0, 0] as [number, number, number],
        v: [
          [-h, -h, h],
          [-h, h, h],
          [-h, h, -h],
          [-h, -h, -h],
        ] as [number, number, number][],
      },
      {
        n: [1, 0, 0] as [number, number, number],
        v: [
          [h, -h, -h],
          [h, h, -h],
          [h, h, h],
          [h, -h, h],
        ] as [number, number, number][],
      },
    ];
    const positions: number[] = [],
      normals: number[] = [],
      colors: number[] = [],
      indices: number[] = [];
    this.voxels
      .filter((v) => v.materialType === VoxelMaterial.EMISSIVE)
      .forEach((v) => {
        const col = v.originalColor || v.color;
        const rx = Math.round(v.x),
          ry = Math.round(v.y),
          rz = Math.round(v.z);
        faceData.forEach((face) => {
          if (this.voxelMap.has(`${rx + face.n[0]},${ry + face.n[1]},${rz + face.n[2]}`)) return;
          const base = positions.length / 3;
          face.v.forEach(([ox, oy, oz]) => {
            positions.push(v.x + ox, v.y + oy, v.z + oz);
            normals.push(face.n[0], face.n[1], face.n[2]);
            colors.push(col.r, col.g, col.b);
          });
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        });
      });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    return new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        emissive: new THREE.Color(1, 1, 1),
        emissiveIntensity: 1,
      }),
    );
  }

  public async exportGLTF(includeAnimations: boolean = true) {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    let exportGroup: THREE.Object3D;
    if (this.rigGroup) {
      exportGroup = this.rigGroup;
    } else if (this.voxels.some((v) => v.materialType === VoxelMaterial.EMISSIVE)) {
      const group = new THREE.Group();
      group.add(this.generateOptimizedMesh());
      group.add(this.buildStaticEmissiveMesh());
      exportGroup = group;
    } else {
      exportGroup = this.generateOptimizedMesh();
    }
    let animations: THREE.AnimationClip[] = [];
    if (includeAnimations && this.currentSkeleton && this.rigGroup) {
      this.currentSkeleton.animations.forEach((animDef) => {
        const tracks: THREE.KeyframeTrack[] = [];
        Object.entries(animDef.tracks).forEach(([boneName, keyframes]) => {
          const boneGroup = this.boneGroups[boneName];
          if (!boneGroup) return;
          const times = keyframes.map((k) => k.time);
          if (keyframes.some((k) => k.rot)) {
            const values: number[] = [];
            keyframes.forEach((k) => {
              const quat = (this.boneRestRotations[boneName]?.clone() ?? new THREE.Quaternion()).multiply(
                new THREE.Quaternion().setFromEuler(
                  new THREE.Euler(k.rot?.[0] || 0, k.rot?.[1] || 0, k.rot?.[2] || 0),
                ),
              );
              values.push(quat.x, quat.y, quat.z, quat.w);
            });
            const track = new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
            if (keyframes.every((keyframe) => keyframe.interpolation === 'step'))
              track.setInterpolation(THREE.InterpolateDiscrete);
            tracks.push(track);
          }
          if (keyframes.some((k) => k.pos)) {
            const values: number[] = [];
            const basePos = boneGroup.position.clone();
            keyframes.forEach((k) =>
              values.push(
                basePos.x + (k.pos?.[0] || 0),
                basePos.y + (k.pos?.[1] || 0),
                basePos.z + (k.pos?.[2] || 0),
              ),
            );
            tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, times, values));
          }
        });
        animations.push(new THREE.AnimationClip(animDef.name, animDef.duration, tracks));
      });
    }
    exportGroup.userData.voxelData = this.voxels.map((v) => ({
      x: Math.round(v.x),
      y: Math.round(v.y),
      z: Math.round(v.z),
      c: '#' + (v.originalColor || v.color).getHexString(),
      ...(v.materialType !== VoxelMaterial.STANDARD && { m: v.materialType }),
      ...(v.bone && { b: v.bone }),
      ...(v.weights && v.weights.length > 0 && { w: v.weights }),
      ...(v.isLocked && { l: true }),
    }));
    exportGroup.userData.voxshopSkeleton = cloneSkeleton(this.currentSkeleton);
    exporter.parse(
      exportGroup,
      (gltf) => {
        const blob = new Blob([gltf as ArrayBuffer], { type: 'application/octet-stream' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'voxel_model.glb';
        link.click();
      },
      (err) => console.error(err),
      { binary: true, animations },
    );
  }

  public generateOptimizedMesh(): THREE.Mesh {
    const box = new THREE.Box3();
    this.voxels.forEach((v) => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
    const min = { x: Math.floor(box.min.x), y: Math.floor(box.min.y), z: Math.floor(box.min.z) };
    const max = { x: Math.ceil(box.max.x), y: Math.ceil(box.max.y), z: Math.ceil(box.max.z) };
    const dims = [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1];
    const vertices: number[] = [],
      indices: number[] = [],
      normals: number[] = [],
      colors: number[] = [];
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3,
        v = (d + 2) % 3,
        x = [0, 0, 0],
        q = [0, 0, 0];
      q[d] = 1;
      const mask = new Array(dims[u] * dims[v]);
      for (x[d] = -1; x[d] < dims[d];) {
        let n = 0;
        for (x[v] = 0; x[v] < dims[v]; x[v]++) {
          for (x[u] = 0; x[u] < dims[u]; x[u]++, n++) {
            const voxelA = this.voxelMap.get(`${x[0] + min.x},${x[1] + min.y},${x[2] + min.z}`);
            const voxelB = this.voxelMap.get(
              `${x[0] + q[0] + min.x},${x[1] + q[1] + min.y},${x[2] + q[2] + min.z}`,
            );
            if (voxelA && voxelB && voxelA.color.getHex() === voxelB.color.getHex()) mask[n] = 0;
            else
              mask[n] = voxelA
                ? { c: voxelA.color.getHex(), d: 1 }
                : voxelB
                  ? { c: voxelB.color.getHex(), d: -1 }
                  : 0;
          }
        }
        x[d]++;
        n = 0;
        for (let j = 0; j < dims[v]; j++) {
          for (let i = 0; i < dims[u];) {
            if (mask[n]) {
              const cur = mask[n];
              let w, h;
              for (
                w = 1;
                i + w < dims[u] && mask[n + w] && mask[n + w].c === cur.c && mask[n + w].d === cur.d;
                w++
              );
              let done = false;
              for (h = 1; j + h < dims[v]; h++) {
                for (let k = 0; k < w; k++) {
                  const m = mask[n + k + h * dims[u]];
                  if (!m || m.c !== cur.c || m.d !== cur.d) {
                    done = true;
                    break;
                  }
                }
                if (done) break;
              }
              x[u] = i;
              x[v] = j;
              const du = [0, 0, 0],
                dv = [0, 0, 0];
              du[u] = w;
              dv[v] = h;
              const start = vertices.length / 3;
              vertices.push(
                x[0] + min.x,
                x[1] + min.y,
                x[2] + min.z,
                x[0] + du[0] + min.x,
                x[1] + du[1] + min.y,
                x[2] + du[2] + min.z,
                x[0] + du[0] + dv[0] + min.x,
                x[1] + du[1] + dv[1] + min.y,
                x[2] + du[2] + dv[2] + min.z,
                x[0] + dv[0] + min.x,
                x[1] + dv[1] + min.y,
                x[2] + dv[2] + min.z,
              );
              if (cur.d === 1) {
                indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
              } else {
                indices.push(start + 2, start + 1, start, start + 3, start + 2, start);
              }
              const norm = [0, 0, 0];
              norm[d] = cur.d;
              normals.push(...norm, ...norm, ...norm, ...norm);
              const col = new THREE.Color(cur.c);
              if (this.bakedAOEnabled) {
                const rx = cur.d === 1 ? x[0] + min.x : x[0] + q[0] + min.x;
                const ry = cur.d === 1 ? x[1] + min.y : x[1] + q[1] + min.y;
                const rz = cur.d === 1 ? x[2] + min.z : x[2] + q[2] + min.z;
                const signs: [number, number][] = [
                  [-1, -1],
                  [1, -1],
                  [1, 1],
                  [-1, 1],
                ];
                for (const [sa, sb] of signs) {
                  const ao = this.computeVertexAO(rx, ry, rz, u, v, sa, sb);
                  colors.push(col.r * ao, col.g * ao, col.b * ao);
                }
              } else {
                for (let k = 0; k < 4; k++) colors.push(col.r, col.g, col.b);
              }
              for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * dims[u]] = 0;
              i += w;
              n += w;
            } else {
              i++;
              n++;
            }
          }
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true }));
  }

  public async exportOBJ() {
    const { OBJExporter } = await import('three/addons/exporters/OBJExporter.js');
    const exporter = new OBJExporter();
    const result = exporter.parse(this.generateOptimizedMesh());
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([result], { type: 'text/plain' }));
    link.download = 'voxel_model.obj';
    link.click();
  }

  public async exportPLY() {
    const { PLYExporter } = await import('three/addons/exporters/PLYExporter.js');
    const exporter = new PLYExporter();
    exporter.parse(this.generateOptimizedMesh(), (result) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([result], { type: 'application/octet-stream' }));
      link.download = 'voxel_model.ply';
      link.click();
    });
  }

  public async exportSTL() {
    const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
    const exporter = new STLExporter();
    const result = exporter.parse(this.generateOptimizedMesh(), { binary: true });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([result], { type: 'application/octet-stream' }));
    link.download = 'voxel_model.stl';
    link.click();
  }

  public exportPNG() {
    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.renderer.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'voxel_snapshot.png';
    link.click();
  }

  public get hasRigData(): boolean {
    return this.voxels.some((v) => !!v.bone);
  }
  public get currentSkeletonDef(): SkeletonDef | null {
    return this.currentSkeleton;
  }

  public enterRiggingMode() {
    this.state = AppState.RIGGING;
    this.onStateChange(this.state);
    this.controls.autoRotate = false;
    this.exitAnimationPreview();
  }

  public exitRiggingMode() {
    this.state = AppState.STABLE;
    this.onStateChange(this.state);
    this.controls.autoRotate = true;
    this.disablePainting();
    this.exitAnimationPreview();
    this.voxels.forEach((v) => {
      if (v.originalColor) v.color.copy(v.originalColor);
    });
    this.getAllMeshes().forEach((m) => {
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });
  }

  public enablePainting(boneName: string, colorHex: string, influence = 1) {
    if (!boneName || !Number.isFinite(influence) || influence <= 0 || influence > 1)
      throw new Error('Paint influence must be greater than zero and at most one.');
    this.finishPaintStroke();
    this.currentPaintBone = boneName;
    this.currentPaintWeight = influence;
    this.currentPaintColor.set(colorHex);
    this.controls.enableRotate = false;
  }
  public disablePainting() {
    this.finishPaintStroke();
    this.currentPaintBone = null;
    this.controls.enableRotate = true;
  }

  public setSelectedVoxelWeight(boneName: string, influence: number) {
    const position = this.selectedWeightPosition;
    if (
      this.state !== AppState.RIGGING ||
      !position ||
      !this.currentSkeleton?.bones.some((bone) => bone.name === boneName)
    )
      return false;
    const voxel = this.voxelMap.get(`${position.x},${position.y},${position.z}`);
    if (!voxel || voxel.isLocked) return false;
    const before = this.modelVoxel(voxel);
    this.editVoxels({
      mode: 'weight',
      targets: [position],
      weights: blendVoxelWeights(before, boneName, influence, this.currentSkeleton.bones[0]?.name),
    });
    return true;
  }

  private onPointerDown(event: PointerEvent) {
    if (this.state === AppState.EDITING) {
      this.handleEditClick(event);
      return;
    }
    if (this.state !== AppState.RIGGING || event.button !== 0) return;
    if (!this.currentPaintBone) {
      this.inspectRigVoxel(event);
      return;
    }
    this.isPainting = true;
    this.paintStroke = new Map();
    this.paintVoxel(event);
  }

  private inspectRigVoxel(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      this.selectedWeightPosition = null;
      this.publishWeightSelection();
      return;
    }
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = this.raycaster.intersectObjects(this.getAllMeshes())[0];
    if (!hit || hit.instanceId === undefined) {
      this.selectedWeightPosition = null;
      this.publishWeightSelection();
      return;
    }
    const matrix = new THREE.Matrix4();
    (hit.object as THREE.InstancedMesh).getMatrixAt(hit.instanceId, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    const key = `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`;
    const voxel = this.voxelMap.get(key);
    this.selectedWeightPosition = voxel
      ? { x: Math.round(voxel.x), y: Math.round(voxel.y), z: Math.round(voxel.z) }
      : null;
    this.publishWeightSelection();
  }

  private modelVoxel(voxel: SimulationVoxel): VoxelData {
    return {
      x: voxel.x,
      y: voxel.y,
      z: voxel.z,
      color: (voxel.originalColor || voxel.color).getHex(),
      ...(voxel.bone ? { bone: voxel.bone } : {}),
      ...(voxel.weights.length ? { weights: voxel.weights.map((weight) => ({ ...weight })) } : {}),
      ...(voxel.materialType !== VoxelMaterial.STANDARD ? { materialType: voxel.materialType } : {}),
      ...(voxel.isLocked ? { isLocked: true } : {}),
    };
  }

  private publishWeightSelection() {
    if (!this.selectedWeightPosition) {
      this.onWeightSelection?.(null);
      return;
    }
    const key = `${this.selectedWeightPosition.x},${this.selectedWeightPosition.y},${this.selectedWeightPosition.z}`;
    const voxel = this.voxelMap.get(key);
    if (!voxel) {
      this.selectedWeightPosition = null;
      this.onWeightSelection?.(null);
      return;
    }
    this.onWeightSelection?.(this.modelVoxel(voxel));
  }

  private onPointerMove(event: PointerEvent) {
    if (!this.isPainting || this.state !== AppState.RIGGING || !this.currentPaintBone) return;
    this.paintVoxel(event);
  }
  private onPointerUp() {
    this.finishPaintStroke();
  }

  private finishPaintStroke() {
    const stroke = this.paintStroke;
    this.paintStroke = null;
    this.isPainting = false;
    if (!stroke?.size) return;
    this.documentVersion = this.documentRevision + 1;
    if (this.state === AppState.RIGGING && this.currentSkeleton)
      this.buildRigAndPreview(this.currentSkeleton, false);
    this.commitChange({
      action: 'weight',
      voxels: [...stroke.values()].map(({ before, after }) => ({ before, after })),
    });
    this.publishWeightSelection();
  }

  private paintVoxel(event: PointerEvent) {
    if (!this.paintStroke || !this.currentPaintBone) return;
    const allMeshes = this.getAllMeshes();
    if (allMeshes.length === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(allMeshes);
    if (intersects.length > 0) {
      const intersect = intersects[0];
      const instanceId = intersect.instanceId;
      const targetMesh = intersect.object as THREE.InstancedMesh;
      if (instanceId !== undefined) {
        const hitPos = new THREE.Vector3(),
          hitMatrix = new THREE.Matrix4();
        targetMesh.getMatrixAt(instanceId, hitMatrix);
        hitPos.setFromMatrixPosition(hitMatrix);
        const voxel = this.voxelMap.get(
          `${Math.round(hitPos.x)},${Math.round(hitPos.y)},${Math.round(hitPos.z)}`,
        );
        if (voxel && !voxel.isLocked) {
          const position = { x: Math.round(voxel.x), y: Math.round(voxel.y), z: Math.round(voxel.z) };
          const key = `${position.x},${position.y},${position.z}`;
          this.selectedWeightPosition = position;
          const before = this.paintStroke.get(key)?.before ?? this.modelVoxel(voxel);
          const weights = blendVoxelWeights(
            before,
            this.currentPaintBone,
            this.currentPaintWeight,
            this.currentSkeleton?.bones[0]?.name,
          );
          const command = createVoxelEdit([before], {
            mode: 'weight',
            targets: [position],
            weights,
          });
          const after = command.voxels[0]?.after;
          if (!after) return;
          const strokeBefore = this.paintStroke.get(key)?.before ?? before;
          this.paintStroke.set(key, { before: strokeBefore, after });
          voxel.bone = after.bone;
          voxel.weights = after.weights ?? [];
          const mixedColor = (voxel.originalColor || voxel.color).clone().lerp(this.currentPaintColor, 0.6);
          voxel.color.copy(mixedColor);
          targetMesh.setColorAt(instanceId, voxel.color);
          if (targetMesh.instanceColor) targetMesh.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  public enterEditingMode() {
    this.state = AppState.EDITING;
    this.onStateChange(this.state);
    this.controls.autoRotate = false;
  }

  public exitEditingMode() {
    this.state = AppState.STABLE;
    this.onStateChange(this.state);
    this.controls.autoRotate = true;
    this.deselectEditVoxel();
  }
  public setEditColor(colorHex: string | null) {
    this.currentEditColor = colorHex;
    if (colorHex) this.deselectEditVoxel();
  }
  public setEditMode(mode: 'move' | 'paint' | 'add' | 'delete' | 'lock' | 'fill') {
    this.editMode = mode;
    if (mode !== 'move') this.deselectEditVoxel();
  }
  public setSymmetry(x: boolean, y: boolean, z: boolean) {
    this.symmetryX = x;
    this.symmetryY = y;
    this.symmetryZ = z;
  }
  public setEditMaterial(material: VoxelMaterial) {
    this.currentEditMaterial = material;
  }

  private clearEditSelection() {
    if (this.editMesh) {
      this.scene.remove(this.editMesh);
      this.editMesh.geometry.dispose();
      (this.editMesh.material as THREE.Material).dispose();
    }
    this.transformControl?.detach();
    this.editMesh = null;
    this.editInstanceId = null;
    this.editInstanceType = null;
  }

  private deselectEditVoxel() {
    if (!this.editMesh || this.editInstanceId === null || this.editInstanceType === null) return;
    const mesh = this.getMeshForMaterial(this.editInstanceType);
    if (!mesh) {
      this.clearEditSelection();
      return;
    }
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(this.editInstanceId, matrix);
    const from = new THREE.Vector3().setFromMatrixPosition(matrix);
    const to = {
      x: Math.round(this.editMesh.position.x),
      y: Math.round(this.editMesh.position.y),
      z: Math.round(this.editMesh.position.z),
    };
    const command = createMoveCommandFromLookup(
      (key) => {
        const voxel = this.voxelMap.get(key);
        return voxel ? this.toVoxelData(voxel) : undefined;
      },
      from,
      to,
    );
    this.clearEditSelection();
    if (command.voxels.length > 0) {
      this.applyDelta(command, false, false);
      this.commitChange(command);
    }
  }

  private getVoxelPositionsInBrush(
    baseX: number,
    baseY: number,
    baseZ: number,
  ): { x: number; y: number; z: number }[] {
    const positions: { x: number; y: number; z: number }[] = [];
    const size = this.brushSize - 1;
    if (this.brushType === 'single') positions.push({ x: baseX, y: baseY, z: baseZ });
    else {
      for (let x = -size; x <= size; x++)
        for (let y = -size; y <= size; y++)
          for (let z = -size; z <= size; z++) {
            if (this.brushType === 'sphere' ? x * x + y * y + z * z <= size * size : true)
              positions.push({ x: baseX + x, y: baseY + y, z: baseZ + z });
          }
    }
    return positions;
  }

  private getBrushTargets(base: { x: number; y: number; z: number }, normal?: THREE.Vector3) {
    const result: { position: THREE.Vector3; normal?: THREE.Vector3 }[] = [];
    for (const point of this.getVoxelPositionsInBrush(base.x, base.y, base.z)) {
      const targets = [{ position: new THREE.Vector3(point.x, point.y, point.z), normal: normal?.clone() }];
      for (const axis of ['x', 'y', 'z'] as const) {
        if (!(axis === 'x' ? this.symmetryX : axis === 'y' ? this.symmetryY : this.symmetryZ)) continue;
        for (const target of [...targets]) {
          const mirrored = { position: target.position.clone(), normal: target.normal?.clone() };
          mirrored.position[axis] *= -1;
          if (mirrored.normal) mirrored.normal[axis] *= -1;
          targets.push(mirrored);
        }
      }
      result.push(...targets);
    }
    return result;
  }

  private handleEditClick(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (this.transformControl.dragging || this.transformControl.axis !== null) return;
    const hit = this.raycaster.intersectObjects(this.getAllMeshes())[0];
    if (!hit) {
      if (this.editMode === 'add' && this.currentEditColor) {
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(CONFIG.FLOOR_Y + 1));
        const point = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (point) {
          const base = { x: Math.round(point.x), y: CONFIG.FLOOR_Y + 1, z: Math.round(point.z) };
          this.editVoxels({
            mode: 'add',
            targets: this.getBrushTargets(base).map((t) => t.position),
            color: new THREE.Color(this.currentEditColor).getHex(),
            materialType: this.currentEditMaterial,
          });
        }
      } else if (this.editMode === 'move') this.deselectEditVoxel();
      return;
    }
    if (hit.instanceId === undefined) return;
    const mesh = hit.object as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(hit.instanceId, matrix);
    const point = new THREE.Vector3().setFromMatrixPosition(matrix);
    const base = this.voxelMap.get(`${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}`);
    if (!base) return;
    if (this.editMode === 'move') {
      if (base.isLocked) return;
      this.deselectEditVoxel();
      this.editInstanceId = hit.instanceId;
      this.editInstanceType = base.materialType;
      this.editMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.95, 0.95),
        (mesh.material as THREE.Material).clone(),
      );
      this.editMesh.position.copy(point);
      this.scene.add(this.editMesh);
      this.transformControl.attach(this.editMesh);
      return;
    }
    const targets = this.getBrushTargets(base, hit.face?.normal).flatMap((target) => {
      if (this.editMode !== 'add') return [target.position];
      if (!target.normal) return [];
      return [target.position.clone().addScaledVector(target.normal, CONFIG.VOXEL_SIZE).round()];
    });
    this.editVoxels({
      mode: this.editMode,
      targets,
      color: this.currentEditColor ? new THREE.Color(this.currentEditColor).getHex() : undefined,
      materialType: this.currentEditMaterial,
    });
  }

  public autoRig(skeletonDef: SkeletonDef) {
    this.cancelReplay();
    if (this.state === AppState.DISMANTLING) this.exitRiggingMode();

    const box = new THREE.Box3();
    this.voxels.forEach((v) => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
    const center = new THREE.Vector3(),
      size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const cx = center.x,
      cz = center.z;
    const h = size.y,
      d = size.z;
    const yMin = box.min.y,
      zMin = box.min.z;
    const pct = (arr: number[], p: number): number => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor((p / 100) * (s.length - 1))];
    };
    const countXZClusters = (yi: number): number => {
      const keys = new Set(
        this.voxels
          .filter((v) => Math.abs(v.y - yi) < 0.6)
          .map((v) => `${Math.round(v.x)},${Math.round(v.z)}`),
      );
      if (!keys.size) return 0;
      const visited = new Set<string>();
      let count = 0;
      const bfs = (start: string) => {
        const q = [start];
        while (q.length) {
          const k = q.shift()!;
          if (visited.has(k)) continue;
          visited.add(k);
          const [x, z] = k.split(',').map(Number);
          for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nk = `${x + dx},${z + dz}`;
            if (keys.has(nk) && !visited.has(nk)) q.push(nk);
          }
        }
      };
      keys.forEach((k) => {
        if (!visited.has(k)) {
          count++;
          bfs(k);
        }
      });
      return count;
    };

    if (skeletonDef.id === 'humanoid') {
      let legZoneTop = yMin + h * 0.42;
      outer: for (let yi = Math.round(yMin + h * 0.55); yi >= Math.round(yMin + h * 0.15); yi--) {
        const xs = this.voxels
          .filter((v) => Math.abs(v.y - yi) < 0.6)
          .map((v) => v.x)
          .sort((a, b) => a - b);
        if (xs.length < 4) continue;
        for (let i = 0; i < xs.length - 1; i++) {
          const gap = xs[i + 1] - xs[i];
          const gapMid = (xs[i] + xs[i + 1]) / 2;
          if (gap >= 2 && Math.abs(gapMid - cx) < size.x * 0.25 && i >= 1 && i <= xs.length - 3) {
            legZoneTop = yi + 1;
            break outer;
          }
        }
      }

      const legVoxels = this.voxels.filter((v) => v.y < legZoneTop);
      const upperVoxels = this.voxels.filter((v) => v.y >= legZoneTop);

      legVoxels.forEach((v) => {
        v.bone = v.x < cx ? 'LegL' : 'LegR';
      });
      const hipXAbs = upperVoxels.filter((v) => v.y <= legZoneTop + h * 0.1).map((v) => Math.abs(v.x - cx));
      const armThresh = (pct(hipXAbs, 90) || size.x * 0.3) + 1;
      upperVoxels.forEach((v) => {
        const dx = Math.abs(v.x - cx);
        v.bone = dx > armThresh ? (v.x < cx ? 'ArmL' : 'ArmR') : 'Torso';
      });
    } else if (skeletonDef.id === 'quadruped') {
      let legZoneTop = yMin + h * 0.38;
      for (let yi = Math.round(yMin); yi <= Math.round(yMin + h * 0.5); yi++) {
        if (countXZClusters(yi) >= 2) legZoneTop = yi + 1;
      }

      const legXSplit = cx;
      const legZSplit = cz;

      this.voxels.forEach((v) => {
        if (v.y < legZoneTop) {
          const front = v.z > legZSplit,
            left = v.x < legXSplit;
          v.bone = front ? (left ? 'LegFL' : 'LegFR') : left ? 'LegBL' : 'LegBR';
        } else {
          v.bone = 'Torso';
        }
      });
    } else if (skeletonDef.id === 'bird') {
      const bodyXAbs = this.voxels
        .filter((v) => Math.abs(v.z - cz) <= size.z * 0.3)
        .map((v) => Math.abs(v.x - cx));
      const wingThresh = (pct(bodyXAbs, 85) || size.x * 0.25) + 1;
      this.voxels.forEach((v) => {
        const dx = Math.abs(v.x - cx);
        v.bone = dx > wingThresh ? (v.x < cx ? 'WingL' : 'WingR') : 'Torso';
      });
    } else if (skeletonDef.id === 'fish') {
      const tailZ = zMin + d * 0.2;
      const bodyXAbs = this.voxels
        .filter((v) => v.z >= cz - d * 0.3 && v.z <= cz + d * 0.3 && v.z > tailZ)
        .map((v) => Math.abs(v.x - cx));
      const finThresh = (pct(bodyXAbs, 85) || size.x * 0.3) + 1;
      this.voxels.forEach((v) => {
        if (v.z <= tailZ) v.bone = 'Tail';
        else if (Math.abs(v.x - cx) > finThresh) v.bone = v.x < cx ? 'FinL' : 'FinR';
        else v.bone = 'Torso';
      });
    } else if (skeletonDef.id === 'insect') {
      const legTop = yMin + h * 0.35;
      const legXThresh =
        (pct(
          this.voxels.filter((v) => v.y >= legTop).map((v) => Math.abs(v.x - cx)),
          80,
        ) || size.x * 0.25) + 0.5;
      const z1 = zMin + d / 3,
        z2 = zMin + (d * 2) / 3;
      this.voxels.forEach((v) => {
        if (v.y < legTop && Math.abs(v.x - cx) > legXThresh) {
          const left = v.x < cx;
          v.bone =
            v.z >= z2
              ? left
                ? 'Leg1L'
                : 'Leg1R'
              : v.z >= z1
                ? left
                  ? 'Leg2L'
                  : 'Leg2R'
                : left
                  ? 'Leg3L'
                  : 'Leg3R';
        } else {
          v.bone = 'Torso';
        }
      });
    } else if (skeletonDef.id === 'cube_monster') {
      const splitY = yMin + h * 0.45;
      this.voxels.forEach((v) => {
        v.bone = v.y < splitY ? 'Base' : 'Body';
      });
    } else {
      this.voxels.forEach((v) => {
        v.bone = skeletonDef.bones[0].name;
      });
    }

    this.voxels.forEach((v) => {
      v.weights = v.bone ? [{ bone: v.bone, weight: 1.0 }] : [];
    });

    this.currentSkeleton = skeletonDef;
    this.state = AppState.RIGGING;
    this.onStateChange(this.state);
    this.buildRigAndPreview(skeletonDef);
  }

  public buildRigAndPreview(skeletonDef: SkeletonDef, notify = true) {
    this.cancelReplay();
    if (notify) this.documentVersion = this.documentRevision + 1;
    this.clearRig();
    this.currentSkeleton = skeletonDef;
    if (notify) {
      this.onDocumentChange?.(this.getModelDocument());
      this.publishWeightSelection();
    }
    this.rigGroup = new THREE.Group();
    this.boneGroups = {};
    this.bonePivots = {};
    this.boneRestRotations = {};

    const modelBounds = new THREE.Box3();
    this.voxels.forEach((voxel) => modelBounds.expandByPoint(new THREE.Vector3(voxel.x, voxel.y, voxel.z)));
    const modelCenter = modelBounds.getCenter(new THREE.Vector3());
    const pivots: Record<string, THREE.Vector3> = {};
    const worldRotations: Record<string, THREE.Quaternion> = {};
    const boneDefs = new Map(skeletonDef.bones.map((bone) => [bone.name, bone]));
    const worldPivot = (name: string): THREE.Vector3 => {
      const prior = pivots[name];
      if (prior) return prior;
      const definition = boneDefs.get(name)!;
      if (definition.bindPosition) {
        const parent = definition.parent ? worldPivot(definition.parent) : null;
        const parentRotation = definition.parent ? worldRotations[definition.parent] : new THREE.Quaternion();
        const localRotation = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(...(definition.bindRotation ?? [0, 0, 0])),
        );
        const position = new THREE.Vector3(...definition.bindPosition);
        if (parent) position.applyQuaternion(parentRotation).add(parent);
        pivots[name] = position;
        worldRotations[name] = parentRotation.clone().multiply(localRotation);
        return position;
      }
      const bVoxels = this.voxels.filter((v) => v.bone === name);
      const box = new THREE.Box3();
      bVoxels.forEach((v) => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
      const pivot = bVoxels.length ? box.getCenter(new THREE.Vector3()) : modelCenter.clone();
      if (bVoxels.length && definition.pivotType === 'bottom') pivot.y = box.min.y;
      else if (bVoxels.length && definition.pivotType === 'top') pivot.y = box.max.y;
      else if (bVoxels.length && definition.pivotType === 'left') pivot.x = box.min.x;
      else if (bVoxels.length && definition.pivotType === 'right') pivot.x = box.max.x;
      else if (bVoxels.length && definition.pivotType === 'front') pivot.z = box.max.z;
      else if (bVoxels.length && definition.pivotType === 'back') pivot.z = box.min.z;
      pivots[name] = pivot;
      const parentRotation = definition.parent ? worldRotations[definition.parent] : undefined;
      worldRotations[name] = parentRotation
        ? parentRotation
            .clone()
            .multiply(
              new THREE.Quaternion().setFromEuler(new THREE.Euler(...(definition.bindRotation ?? [0, 0, 0]))),
            )
        : new THREE.Quaternion().setFromEuler(new THREE.Euler(...(definition.bindRotation ?? [0, 0, 0])));
      return pivot;
    };
    skeletonDef.bones.forEach((bDef) => {
      const pivot = worldPivot(bDef.name);
      this.bonePivots[bDef.name] = pivot.clone();
      const bone = new THREE.Bone();
      bone.name = bDef.name;
      this.boneGroups[bDef.name] = bone;
    });

    const allBones: THREE.Bone[] = [];
    const boneIndexMap: Record<string, number> = {};
    skeletonDef.bones.forEach((bDef) => {
      const bone = this.boneGroups[bDef.name];
      if (!bone) return;
      boneIndexMap[bDef.name] = allBones.length;
      allBones.push(bone);
      if (bDef.parent && this.boneGroups[bDef.parent]) {
        this.boneGroups[bDef.parent].add(bone);
        if (bDef.bindPosition) bone.position.set(...bDef.bindPosition);
        else bone.position.subVectors(pivots[bDef.name], pivots[bDef.parent]);
      } else {
        this.rigGroup!.add(bone);
        if (bDef.bindPosition) bone.position.set(...bDef.bindPosition);
        else bone.position.copy(pivots[bDef.name]);
      }
      if (bDef.bindRotation) bone.rotation.set(...bDef.bindRotation);
      this.boneRestRotations[bDef.name] = bone.quaternion.clone();
    });

    this.scene.add(this.rigGroup);
    this.rigGroup.updateMatrixWorld(true);

    this.boneIndexMap = boneIndexMap;

    this.rigSkeleton = new THREE.Skeleton(allBones);
    const hasEmissiveVoxels = this.voxels.some((v) => v.materialType === VoxelMaterial.EMISSIVE);
    const geo = this.buildSkinnedGeo(
      this.solidPreviewEnabled,
      hasEmissiveVoxels ? 'non-emissive' : undefined,
    );
    const skinnedMesh = new THREE.SkinnedMesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    );
    skinnedMesh.name = 'skinned_standard';
    skinnedMesh.bind(this.rigSkeleton);
    this.rigGroup.add(skinnedMesh);
    if (hasEmissiveVoxels) {
      const emissiveGeo = this.buildSkinnedGeo(this.solidPreviewEnabled, 'emissive');
      const emissiveSkinnedMesh = new THREE.SkinnedMesh(
        emissiveGeo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          emissive: new THREE.Color(1, 1, 1),
          emissiveIntensity: 1,
        }),
      );
      emissiveSkinnedMesh.name = 'skinned_emissive';
      emissiveSkinnedMesh.bind(this.rigSkeleton);
      this.rigGroup.add(emissiveSkinnedMesh);
    }

    this.applyDisplayState();
  }

  public async exportVOX() {
    const voxels = this.getVoxelDataForSave().map((v) => ({
      ...v,
      color: new THREE.Color(v.color).getHex(),
    }));
    const bytes = encodeVOX(voxels);
    if (!bytes) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    link.download = 'model.vox';
    link.click();
  }

  public async exportQB() {
    const voxels = this.getVoxelDataForSave().map((v) => ({
      ...v,
      color: new THREE.Color(v.color).getHex(),
    }));
    const bytes = encodeQB(voxels);
    if (!bytes) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    link.download = 'model.qb';
    link.click();
  }

  public async exportMinecraft(format: 'nbt' | 'schematic' | 'litematic') {
    const voxels = this.getVoxelDataForSave().map((v) => ({
      ...v,
      color: new THREE.Color(v.color).getHex(),
    }));
    const compressed = await encodeMinecraft(voxels, format);
    if (!compressed) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([compressed], { type: 'application/octet-stream' }));
    link.download =
      'model.' + (format === 'litematic' ? 'litematic' : format === 'schematic' ? 'schematic' : 'nbt');
    link.click();
  }

  public importVOX(buffer: ArrayBuffer): VoxelData[] {
    return decodeVOX(buffer);
  }

  public importQB(buffer: ArrayBuffer): VoxelData[] {
    return decodeQB(buffer);
  }

  public flipModel(axis: 'x' | 'y' | 'z') {
    this.transformModel(flipVoxels(this.getVoxelDataForSave(), axis));
  }

  public rotateModel90(direction: 'cw' | 'ccw') {
    this.transformModel(rotateVoxels90(this.getVoxelDataForSave(), direction));
  }

  private transformModel(data: VoxelData[]) {
    this.deselectEditVoxel();
    const command = replaceModelCommand(this.getVoxelDataForSave(), normalizeVoxels(data), 'transform');
    this.applyDelta(command, false, false);
    this.commitChange(command);
  }

  public async importMinecraft(buffer: ArrayBuffer): Promise<VoxelData[]> {
    return decodeMinecraft(buffer);
  }

  public playAnimation(skeletonDef: SkeletonDef, animName: string, loop: boolean = true) {
    if (!this.rigGroup) return;
    const animDef = skeletonDef.animations.find((a) => a.name === animName);
    if (!animDef) return;

    if (animName === 'Death') {
      this.createSnapshot();
      loop = false;
    }

    const tracks: THREE.KeyframeTrack[] = [];
    Object.entries(animDef.tracks).forEach(([boneName, kfs]) => {
      const group = this.boneGroups[boneName];
      if (!group) return;
      const times = kfs.map((k) => k.time);
      if (kfs.some((k) => k.rot)) {
        const vals: number[] = [];
        kfs.forEach((k) => {
          const q = (this.boneRestRotations[boneName]?.clone() ?? new THREE.Quaternion()).multiply(
            new THREE.Quaternion().setFromEuler(
              new THREE.Euler(k.rot?.[0] || 0, k.rot?.[1] || 0, k.rot?.[2] || 0),
            ),
          );
          vals.push(q.x, q.y, q.z, q.w);
        });
        const track = new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, vals);
        if (kfs.every((keyframe) => keyframe.interpolation === 'step'))
          track.setInterpolation(THREE.InterpolateDiscrete);
        tracks.push(track);
      }
      if (kfs.some((k) => k.pos)) {
        const vals: number[] = [];
        const base = group.position.clone();
        kfs.forEach((k) =>
          vals.push(base.x + (k.pos?.[0] || 0), base.y + (k.pos?.[1] || 0), base.z + (k.pos?.[2] || 0)),
        );
        const track = new THREE.VectorKeyframeTrack(`${boneName}.position`, times, vals);
        if (kfs.every((keyframe) => keyframe.interpolation === 'step'))
          track.setInterpolation(THREE.InterpolateDiscrete);
        tracks.push(track);
      }
    });
    const clip = new THREE.AnimationClip(animName, animDef.duration, tracks);
    if (!this.mixer) {
      this.mixer = new THREE.AnimationMixer(this.rigGroup);
    }
    if (this.currentAction) this.currentAction.stop();
    this.currentAction = this.mixer.clipAction(clip);
    this.currentAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    this.currentAction.clampWhenFinished = !loop;

    if (animName === 'Death') {
      const onFinished = (e: any) => {
        if (e.action === this.currentAction) {
          this.mixer?.removeEventListener('finished', onFinished);
          this.explodeFromRig(true);
        }
      };
      this.mixer.addEventListener('finished', onFinished);
    }

    this.currentAction.play();
  }

  private clearRig() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
      this.currentAction = null;
    }
    if (this.rigGroup) {
      this.scene.remove(this.rigGroup);
      this.rigGroup.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      this.rigSkeleton?.dispose();
      this.rigGroup = null;
      this.boneGroups = {};
      this.bonePivots = {};
      this.boneRestRotations = {};
      this.rigSkeleton = null;
    }
  }

  public exitAnimationPreview() {
    this.clearRig();
    this.applyDisplayState();
  }

  public resetCamera() {
    this.camera.position.set(30, 30, 60);
    this.controls.target.set(0, 5, 0);
    this.controls.update();
  }

  public setBackgroundColor(hex: string): void {
    const c = new THREE.Color(hex);
    this.scene.background = c;
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.set(c);
  }

  public setGridColor(hex: string): void {
    if (!this.gridHelper) return;
    const vis = this.gridHelper.visible;
    this.scene.remove(this.gridHelper);
    const colorHex = new THREE.Color(hex).getHex();
    this.gridHelper = new THREE.GridHelper(64, 64, colorHex, colorHex);
    this.gridHelper.position.y = CONFIG.FLOOR_Y + 0.01;
    this.gridHelper.visible = vis;
    this.scene.add(this.gridHelper);
  }

  public placeInScene(obj: SceneObject): void {
    this.removeFromScene(obj.id);
    const geometry = new THREE.BoxGeometry(
      CONFIG.VOXEL_SIZE - 0.05,
      CONFIG.VOXEL_SIZE - 0.05,
      CONFIG.VOXEL_SIZE - 0.05,
    );
    const count = Math.max(obj.data.length + 50, 200);
    const meshes: THREE.InstancedMesh[] = [
      new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 }),
        count,
      ),
      new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0.9 }),
        count,
      ),
      new THREE.InstancedMesh(
        geometry,
        new THREE.MeshPhysicalMaterial({ transmission: 0.9, thickness: 0.5, transparent: true } as any),
        count,
      ),
      new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ emissiveIntensity: 2, roughness: 0.5 }),
        count,
      ),
    ];
    const matOrder = [
      VoxelMaterial.STANDARD,
      VoxelMaterial.METALLIC,
      VoxelMaterial.GLASS,
      VoxelMaterial.EMISSIVE,
    ];
    const counts = [0, 0, 0, 0];
    const dummy = new THREE.Object3D();
    obj.data.forEach((v) => {
      const mi = matOrder.indexOf(v.materialType || VoxelMaterial.STANDARD);
      const matIdx = mi < 0 ? 0 : mi;
      const idx = counts[matIdx]++;
      if (idx >= meshes[matIdx].count) return;
      dummy.position.set(v.x + obj.offsetX, v.y, v.z + obj.offsetZ);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      meshes[matIdx].setMatrixAt(idx, dummy.matrix);
      meshes[matIdx].setColorAt(idx, new THREE.Color(v.color));
    });
    meshes.forEach((mesh, i) => {
      mesh.count = counts[i];
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
    });
    this.sceneObjectMeshes.set(obj.id, meshes);
  }

  public removeFromScene(id: string): void {
    const meshes = this.sceneObjectMeshes.get(id);
    if (meshes) {
      meshes.forEach((m) => {
        this.scene.remove(m);
        m.dispose();
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      });
      this.sceneObjectMeshes.delete(id);
    }
  }

  public clearScene(): void {
    const ids = [...this.sceneObjectMeshes.keys()];
    ids.forEach((id) => this.removeFromScene(id));
  }

  public cleanup() {
    this.documentVersion = this.documentRevision + 1;
    this.replayVersion++;
    this.replaySource = null;
    cancelAnimationFrame(this.animationId);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.clearEditSelection();
    this.transformControl.dispose();
    this.clearRig();
    this.composer.passes.forEach((pass) => pass.dispose());
    this.composer.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      const renderable = object as THREE.Mesh;
      if (object instanceof THREE.InstancedMesh) object.dispose();
      if (renderable.geometry) geometries.add(renderable.geometry);
      if (renderable.material) {
        (Array.isArray(renderable.material) ? renderable.material : [renderable.material]).forEach(
          (material) => materials.add(material),
        );
      }
      if (
        object instanceof THREE.DirectionalLight ||
        object instanceof THREE.PointLight ||
        object instanceof THREE.SpotLight
      )
        object.shadow.dispose();
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.renderer.domElement.remove();
    this.renderer.dispose();
  }
}
