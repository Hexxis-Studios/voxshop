import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createNoise2D, createNoise3D } from 'simplex-noise';
import { AppState, SimulationVoxel, RebuildTarget, VoxelData, VoxelDelta, VoxelMaterial, VoxelWeight, SceneObject } from '../types';
import { CONFIG } from '../utils/voxelConstants';
import { SkeletonDef, SKELETONS } from '../utils/riggingConstants';
import { cloneSkeleton, cloneVoxel, createModelDocument, normalizeVoxels, parseModelDocument, serializeModelDocument, type ModelDocument } from './modelDocument';
import { applyVoxelCommand, createMoveCommand, createVoxelEdit, replaceModelCommand, type VoxelEdit } from './modelCommands';

export class VoxelEngine {
  public onDocumentChange?: (document: ModelDocument) => void;
  public active = true;
  private replayVersion = 0;
  private replaySource: VoxelData[] | null = null;
  private documentVersion = 0;
  public get documentRevision() { return this.documentVersion ?? 0; }
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
  private currentPaintBone: string | null = null;
  private currentPaintColor: THREE.Color = new THREE.Color();
  
  private currentSkeleton: SkeletonDef | null = null;
  private rigGroup: THREE.Group | null = null;
  private boneGroups: Record<string, THREE.Bone> = {};
  private bonePivots: Record<string, THREE.Vector3> = {};
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
    onCountChange: (count: number) => void
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

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.5, 0.1);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.controls.target.set(0, 5, 0);

    this.transformControl = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControl.addEventListener('dragging-changed', (e) => this.controls.enabled = !e.value);
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
        new THREE.MeshStandardMaterial({ color: 0x141922, roughness: 0.95, metalness: 0.05 })
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
    this.documentVersion = this.documentRevision + 1;
    this.replayVersion = (this.replayVersion ?? 0) + 1;
    this.replaySource = null;
    this.clearEditSelection();
    this.clearRig();
    this.currentSkeleton = document.skeleton;
    this.pendingRebuildModel = null;
    this.pendingRebuildCommand = null;
    this.rebuildTargets = [];
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

  private applyDelta(delta: VoxelDelta, isUndo: boolean) {
      this.cancelReplay();
      this.documentVersion = this.documentRevision + 1;
      const updated = applyVoxelCommand(this.getVoxelDataForSave(), delta, isUndo);
      this.clearRig();
      this.createVoxels(updated);
      this.applyDisplayState();
      this.onCountChange(this.voxels.length);
      this.onDocumentChange?.(this.getModelDocument());
  }

  public editVoxels(edit: VoxelEdit) {
      if (this.state === AppState.REBUILDING || this.state === AppState.DISMANTLING) return;
      const command = createVoxelEdit(this.getVoxelDataForSave(), edit);
      if (command.voxels.length === 0) return;
      this.applyDelta(command, false);
      this.commitChange(command);
  }

  private commitChange(delta: VoxelDelta) {
      this.undoStack.push(structuredClone(delta));
      this.redoStack = []; 
      this.onDocumentChange?.(this.getModelDocument());
  }

  public async playTimeLapse() {
      if (this.undoStack.length === 0 || this.state !== AppState.STABLE || this.replaySource) return;
      const commands = structuredClone(this.undoStack);
      const source = this.getVoxelDataForSave();
      const generation = this.replayVersion = (this.replayVersion ?? 0) + 1;
      this.replaySource = source;
      let preview = structuredClone(this.initialModelState);
      this.createVoxels(preview);
      try {
        for (const command of commands) {
          await new Promise(resolve => setTimeout(resolve, 50));
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
      const img = new Image();
      const reader = new FileReader();
      await new Promise((resolve, reject) => {
          reader.onload = (e) => {
              img.src = e.target?.result as string;
              img.onload = resolve;
              img.onerror = reject;
          };
          reader.onerror = () => reject(new Error('The image file could not be read.'));
          reader.readAsDataURL(imageFile);
      });
      if(this.documentRevision!==version)throw new Error('Image import cancelled because the active model changed.');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const maxDim = 64;
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.floor(w * ratio); h = Math.floor(h * ratio);
      }
      canvas.width = w; canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const voxelData: VoxelData[] = [];
      const centerX = Math.floor(w / 2), centerY = Math.floor(h / 2);

      let hasTransparency = false;
      for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 128) { hasTransparency = true; break; }
      }
      const EXTRUDE_DEPTH = 8;

      for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              if (data[i + 3] > 128) {
                  const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
                  if (hasTransparency) {
                      for (let z = 0; z <= EXTRUDE_DEPTH; z++) {
                          voxelData.push({ x: x - centerX, y: centerY - y, z, color });
                      }
                  } else {
                      voxelData.push({ x: x - centerX, y: centerY - y, z: 0, color });
                  }
              }
          }
      }
      this.loadInitialModel(voxelData);
  }

  public voxelizeText(text: string, fontSize: number = 32, color: number = 0x3b82f6) {
      if(text.length>256)throw new Error('Text generation supports up to 256 characters.');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.font = `bold ${fontSize}px sans-serif`;
      const metrics = ctx.measureText(text);
      const w = Math.ceil(metrics.width) + 4, h = Math.ceil(fontSize * 1.2);
      canvas.width = w; canvas.height = h;
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textBaseline = 'middle'; ctx.fillStyle = 'white';
      ctx.fillText(text, 2, h / 2);
      const data = ctx.getImageData(0, 0, w, h).data;
      const voxelData: VoxelData[] = [];
      const centerX = Math.floor(w / 2), centerY = Math.floor(h / 2);
      for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
              if (data[(y * w + x) * 4 + 3] > 128) {
                  voxelData.push({ x: x - centerX, y: centerY - y, z: 0, color });
              }
          }
      }
      this.loadInitialModel(voxelData);
  }

  public async voxelizeMesh(object: THREE.Object3D, resolution: number | null = null) {
      object.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim === 0) return;
      const res = resolution ?? Math.max(16, Math.min(96, Math.round(maxDim)));
      const voxelWorldSize = maxDim / res;
      const half = voxelWorldSize * 0.5;

      const texCache = new Map<string, ImageData | null>();
      const getTexData = (tex: THREE.Texture | null | undefined): ImageData | null => {
          if (!tex?.image) return null;
          if (texCache.has(tex.uuid)) return texCache.get(tex.uuid)!;
          try {
              const img = tex.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
              const w = (img as any).naturalWidth || (img as any).width || 1;
              const h = (img as any).naturalHeight || (img as any).height || 1;
              const c = document.createElement('canvas'); c.width = w; c.height = h;
              const ctx = c.getContext('2d')!;
              ctx.drawImage(img as any, 0, 0, w, h);
              const data = ctx.getImageData(0, 0, w, h);
              texCache.set(tex.uuid, data);
              return data;
          } catch { texCache.set(tex.uuid, null); return null; }
      };
      const sampleTex = (data: ImageData, u: number, v: number): number => {
          const w = data.width, h = data.height;
          const uw = ((u % 1) + 1) % 1;
          const vw = ((v % 1) + 1) % 1;
          const px = Math.min(w-1, Math.max(0, Math.floor(uw * w)));
          const py = Math.min(h-1, Math.max(0, Math.floor((1 - vw) * h)));
          const i = (py * w + px) * 4;
          return (data.data[i] << 16) | (data.data[i+1] << 8) | data.data[i+2];
      };

      const voxelMap = new Map<string, number>();
      let cellTests = 0;
      const tmpN = new THREE.Vector3();
      const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
      const tri = new THREE.Triangle();
      const voxelBox = new THREE.Box3();

      object.traverse(child => {
          if (!(child instanceof THREE.Mesh)) return;
          const geo = child.geometry as THREE.BufferGeometry;
          if (!geo.attributes.position) return;

          child.updateWorldMatrix(true, false);
          const matrix = child.matrixWorld;
          const posAttr = geo.attributes.position;
          const normalAttr = geo.attributes.normal;
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
          const colorAttr = geo.attributes.color;
          const uvAttr = geo.attributes.uv;
          const indexAttr = geo.index;
          const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

          const materials = Array.isArray(child.material) ? child.material : [child.material];

          const getWorldVert = (i: number, out: THREE.Vector3): THREE.Vector3 =>
              out.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(matrix);

          const groupForFace: number[] = [];
          if (geo.groups.length > 0) {
              for (const g of geo.groups) {
                  const fStart = g.start / 3, fEnd = fStart + g.count / 3;
                  for (let f = fStart; f < fEnd; f++) groupForFace[f] = g.materialIndex ?? 0;
              }
          }
          const texDataCache: (ImageData | null)[] = materials.map(m => getTexData((m as THREE.MeshStandardMaterial)?.map));
          const matColors: number[] = materials.map(m => (m as any)?.color?.getHex?.() ?? 0xCCCCCC);

          for (let t = 0; t < triCount; t++) {
              const i0 = indexAttr ? indexAttr.getX(t*3)   : t*3;
              const i1 = indexAttr ? indexAttr.getX(t*3+1) : t*3+1;
              const i2 = indexAttr ? indexAttr.getX(t*3+2) : t*3+2;

              getWorldVert(i0, pA);
              getWorldVert(i1, pB);
              getWorldVert(i2, pC);
              tri.set(pA, pB, pC);

              if (normalAttr) {
                  const nx_avg = (normalAttr.getX(i0) + normalAttr.getX(i1) + normalAttr.getX(i2)) / 3;
                  const ny_avg = (normalAttr.getY(i0) + normalAttr.getY(i1) + normalAttr.getY(i2)) / 3;
                  const nz_avg = (normalAttr.getZ(i0) + normalAttr.getZ(i1) + normalAttr.getZ(i2)) / 3;
                  if (nx_avg*nx_avg + ny_avg*ny_avg + nz_avg*nz_avg > 0.0001) {
                      tmpN.set(nx_avg, ny_avg, nz_avg).applyMatrix3(normalMatrix);
                  }
              }

              const matIdx = groupForFace[t] ?? 0;
              const texData = texDataCache[matIdx] ?? null;
              const matColor = matColors[matIdx] ?? 0xCCCCCC;

              let color: number;
              if (texData && uvAttr) {
                  const u = (uvAttr.getX(i0) + uvAttr.getX(i1) + uvAttr.getX(i2)) / 3;
                  const v = (uvAttr.getY(i0) + uvAttr.getY(i1) + uvAttr.getY(i2)) / 3;
                  color = sampleTex(texData, u, v);
                  if (matColor !== 0xFFFFFF && matColor !== 0xCCCCCC) {
                      const mr=(matColor>>16)&0xFF, mg=(matColor>>8)&0xFF, mb=matColor&0xFF;
                      const tr=(color>>16)&0xFF, tg=(color>>8)&0xFF, tb=color&0xFF;
                      color = (Math.round(tr*mr/255)<<16)|(Math.round(tg*mg/255)<<8)|Math.round(tb*mb/255);
                  }
              } else if (colorAttr) {
                  const r=(colorAttr.getX(i0)+colorAttr.getX(i1)+colorAttr.getX(i2))/3;
                  const g=(colorAttr.getY(i0)+colorAttr.getY(i1)+colorAttr.getY(i2))/3;
                  const b=(colorAttr.getZ(i0)+colorAttr.getZ(i1)+colorAttr.getZ(i2))/3;
                  color = (Math.round(r*255)<<16)|(Math.round(g*255)<<8)|Math.round(b*255);
              } else {
                  color = matColor;
              }

              const txMin=Math.min(pA.x,pB.x,pC.x), txMax=Math.max(pA.x,pB.x,pC.x);
              const tyMin=Math.min(pA.y,pB.y,pC.y), tyMax=Math.max(pA.y,pB.y,pC.y);
              const tzMin=Math.min(pA.z,pB.z,pC.z), tzMax=Math.max(pA.z,pB.z,pC.z);

              const ixMin=Math.max(0,Math.floor((txMin-box.min.x)/voxelWorldSize));
              const ixMax=Math.min(res,Math.ceil((txMax-box.min.x)/voxelWorldSize));
              const iyMin=Math.max(0,Math.floor((tyMin-box.min.y)/voxelWorldSize));
              const iyMax=Math.min(res,Math.ceil((tyMax-box.min.y)/voxelWorldSize));
              const izMin=Math.max(0,Math.floor((tzMin-box.min.z)/voxelWorldSize));
              const izMax=Math.min(res,Math.ceil((tzMax-box.min.z)/voxelWorldSize));

              for (let ix=ixMin; ix<=ixMax; ix++) {
                  for (let iy=iyMin; iy<=iyMax; iy++) {
                      for (let iz=izMin; iz<=izMax; iz++) {
                          if(++cellTests>50000000)throw new Error('Mesh conversion exceeded its work budget. Use a simpler mesh or lower resolution.');
                          const vcx=box.min.x+(ix+0.5)*voxelWorldSize;
                          const vcy=box.min.y+(iy+0.5)*voxelWorldSize;
                          const vcz=box.min.z+(iz+0.5)*voxelWorldSize;
                          voxelBox.min.set(vcx-half, vcy-half, vcz-half);
                          voxelBox.max.set(vcx+half, vcy+half, vcz+half);
                          if (tri.intersectsBox(voxelBox)) {
                              const key = `${ix},${iy},${iz}`;
                              if (!voxelMap.has(key)) voxelMap.set(key, color);
                              if(voxelMap.size>250000)throw new Error('Mesh conversion exceeds 250,000 voxels. Use a lower resolution.');
                          }
                      }
                  }
              }
          }
      });

      const nxHalf = Math.round(size.x / voxelWorldSize / 2);
      const nzHalf = Math.round(size.z / voxelWorldSize / 2);
      const yFloor = CONFIG.FLOOR_Y + 1;
      const voxelData: VoxelData[] = Array.from(voxelMap.entries()).map(([key, color]) => {
          const [ix, iy, iz] = key.split(',').map(Number);
          return { x: ix - nxHalf, y: iy + yFloor, z: iz - nzHalf, color };
      });

      this.loadInitialModel(voxelData);
  }

  public resample(scaleFactor: number) {
      if (this.voxels.length === 0) return;
      const newVoxelsMap = new Map<string, VoxelData>();
      this.getVoxelDataForSave().forEach(v => {
          const rx = Math.round(v.x * scaleFactor), ry = Math.round(v.y * scaleFactor), rz = Math.round(v.z * scaleFactor);
          const key = `${rx},${ry},${rz}`;
          if (!newVoxelsMap.has(key)) {
              newVoxelsMap.set(key, { ...v, x: rx, y: ry, z: rz });
          }
      });
      this.transformModel(Array.from(newVoxelsMap.values()));
  }

  private getAllMeshes(): THREE.InstancedMesh[] {
      return [this.standardMesh, this.metallicMesh, this.glassMesh, this.emissiveMesh].filter(m => m !== null) as THREE.InstancedMesh[];
  }

  private createVoxels(data: VoxelData[]) {
    this.voxels = normalizeVoxels(data).map((v, i) => {
        const c = new THREE.Color(v.color);
        return {
            id: i, x: v.x, y: v.y, z: v.z, color: v.isLocked ? c.clone().offsetHSL(0, 0, -0.2) : c.clone(), originalColor: c,
            materialType: v.materialType || VoxelMaterial.STANDARD,
            isLocked: !!v.isLocked, bone: v.bone, weights: v.weights || [],
            vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, rvx: 0, rvy: 0, rvz: 0, scale: 1
        };
    });
    this.rebuildInstancedMesh();
  }

  private initMaterialMeshes() {
      this.getAllMeshes().forEach(mesh => {
          if (mesh) { this.scene.remove(mesh); mesh.dispose(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
      });
      const geometry = new THREE.BoxGeometry(CONFIG.VOXEL_SIZE - 0.05, CONFIG.VOXEL_SIZE - 0.05, CONFIG.VOXEL_SIZE - 0.05);
      
      const count = Math.max(this.voxels.length + 1000, 5000);
      
      this.standardMesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 }), count);
      this.metallicMesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0.9 }), count);
      this.glassMesh = new THREE.InstancedMesh(geometry, new THREE.MeshPhysicalMaterial({ transmission: 0.9, thickness: 0.5, transparent: true }), count);
      this.emissiveMesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ emissiveIntensity: 2, roughness: 0.5 }), count);
      
      this.getAllMeshes().forEach(mesh => { mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh); });
  }

  private getMeshForMaterial(type: VoxelMaterial): THREE.InstancedMesh | null {
      switch (type) {
          case VoxelMaterial.METALLIC: return this.metallicMesh;
          case VoxelMaterial.GLASS: return this.glassMesh;
          case VoxelMaterial.EMISSIVE: return this.emissiveMesh;
          default: return this.standardMesh;
      }
  }

  private draw() {
      const counts = { [VoxelMaterial.STANDARD]: 0, [VoxelMaterial.METALLIC]: 0, [VoxelMaterial.GLASS]: 0, [VoxelMaterial.EMISSIVE]: 0 };
      this.voxels.forEach(v => {
          const matType = v.materialType || VoxelMaterial.STANDARD;
          const mesh = this.getMeshForMaterial(matType);
          if (!mesh) return;
          const idx = counts[matType]++;
          
          if (idx >= mesh.instanceMatrix.count) return;

          this.dummy.position.set(v.x, v.y, v.z);
          this.dummy.rotation.set(v.rx, v.ry, v.rz);
          this.dummy.scale.setScalar(v.scale !== undefined ? v.scale : 1);
          this.dummy.updateMatrix();
          mesh.setMatrixAt(idx, this.dummy.matrix);
          mesh.setColorAt(idx, v.color);
          if (matType === VoxelMaterial.EMISSIVE) (mesh.material as THREE.MeshStandardMaterial).emissive.copy(v.color);
      });
      const allMeshes = [this.standardMesh, this.metallicMesh, this.glassMesh, this.emissiveMesh];
      const matKeys = [VoxelMaterial.STANDARD, VoxelMaterial.METALLIC, VoxelMaterial.GLASS, VoxelMaterial.EMISSIVE];
      allMeshes.forEach((mesh, i) => {
          if (mesh) {
              mesh.count = counts[matKeys[i]];
              mesh.instanceMatrix.needsUpdate = true;
              if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          }
      });
  }

  private rebuildInstancedMesh() {
      const currentBufferCount = this.standardMesh?.instanceMatrix.count ?? 0;
      if (!this.standardMesh || this.voxels.length > currentBufferCount) {
          this.initMaterialMeshes();
      }

      this.voxelMap.clear();
      this.voxels.forEach((v, i) => {
          v.id = i;
          this.voxelMap.set(`${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`, v);
      });
      this.draw();
      this.getAllMeshes().forEach(mesh => { mesh.boundingSphere = null; });
  }

  public mergeAIGeneratedModel(newData: VoxelData[]) {
      const locked = this.getVoxelDataForSave().filter(v => v.isLocked);
      const preserved = new Set(locked.map(v => `${v.x},${v.y},${v.z}`));
      const generated = normalizeVoxels(newData).filter(v => !preserved.has(`${v.x},${v.y},${v.z}`));
      this.rebuild([...locked, ...generated]);
  }

  public explodeFromRig(preserveSnapshot = false) {
    if (!this.rigGroup || !this.rigSkeleton) return;

    if (!preserveSnapshot) this.createSnapshot();

    this.rigGroup.updateMatrixWorld(true);

    this.voxels.forEach(v => {
        if (!v.bone) return;
        const bone = this.boneGroups[v.bone];
        if (!bone) return;
        const boneIdx = this.rigSkeleton!.bones.indexOf(bone);
        if (boneIdx === -1) return;
        const skinMatrix = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, this.rigSkeleton!.boneInverses[boneIdx]);
        const pos = new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(skinMatrix);
        const worldQuat = new THREE.Quaternion();
        bone.getWorldQuaternion(worldQuat);
        const euler = new THREE.Euler().setFromQuaternion(worldQuat);
        v.x = pos.x; v.y = pos.y; v.z = pos.z;
        v.rx = euler.x; v.ry = euler.y; v.rz = euler.z;
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
    
    this.voxels.forEach(v => {
        v.vx = (Math.random() - 0.5) * 0.8; v.vy = Math.random() * 0.5; v.vz = (Math.random() - 0.5) * 0.8;
        v.rvx = (Math.random() - 0.5) * 0.2; v.rvy = (Math.random() - 0.5) * 0.2; v.rvz = (Math.random() - 0.5) * 0.2; v.scale = 1;
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
    const before = this.state === AppState.DISMANTLING && this.voxelSnapshot
      ? this.voxelSnapshot.map(cloneVoxel) : this.getVoxelDataForSave();
    this.pendingRebuildModel = target;
    this.pendingRebuildCommand = replaceModelCommand(before, target);
    this.clearRig();
    this.disposeSolidPreview();
    this.getAllMeshes().forEach(mesh => { mesh.visible = true; });

    const available = this.voxels.map((v, i) => ({ index: i, color: v.color, taken: false }));
    const mappings: RebuildTarget[] = new Array(this.voxels.length).fill(null);
    
    target.forEach(target => {
        let bestDist = 9999, bestIdx = -1;
        for (let i = 0; i < available.length; i++) {
            if (available[i].taken) continue;
            const c2 = new THREE.Color(target.color);
            const d = Math.sqrt(Math.pow((available[i].color.r - c2.r)*0.3, 2) + Math.pow((available[i].color.g - c2.g)*0.59, 2) + Math.pow((available[i].color.b - c2.b)*0.11, 2));
            if (d < bestDist) { bestDist = d; bestIdx = i; if (d < 0.01) break; }
        }
        if (bestIdx !== -1) {
            available[bestIdx].taken = true;
            mappings[available[bestIdx].index] = { 
                x: target.x, y: target.y, z: target.z, 
                delay: Math.max(0, (target.y - CONFIG.FLOOR_Y) / 15) * 800, 
                color: target.color 
            };
        } else {
            const newIdx = this.voxels.length;
            this.voxels.push({ 
                id: newIdx, x: (Math.random()-0.5)*10, y: CONFIG.FLOOR_Y+0.5, z: (Math.random()-0.5)*10, 
                color: new THREE.Color(target.color), originalColor: new THREE.Color(target.color), 
                weights: [], materialType: target.materialType || VoxelMaterial.STANDARD, 
                isLocked: false, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, rvx: 0, rvy: 0, rvz: 0, scale: 1 
            });
            mappings.push({ 
                x: target.x, y: target.y, z: target.z, 
                delay: Math.max(0, (target.y - CONFIG.FLOOR_Y) / 15) * 800,
                color: target.color
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
        this.voxels.forEach(v => {
            v.vy -= 0.025; v.x += v.vx; v.y += v.vy; v.z += v.vz; v.rx += v.rvx; v.ry += v.rvy; v.rz += v.rvz;
            if (v.y < CONFIG.FLOOR_Y + 0.5) { v.y = CONFIG.FLOOR_Y + 0.5; v.vy *= -0.5; v.vx *= 0.9; v.vz *= 0.9; }
            if (elapsed > 3000) v.scale = Math.max(0, 1 - Math.pow(Math.min(1, (elapsed-3000)/2000), 3));
        });
    } else if (this.state === AppState.REBUILDING) {
        const elapsed = Date.now() - this.rebuildStartTime; let allDone = true;
        this.voxels.forEach((v, i) => {
            const t = this.rebuildTargets[i]; if (!t || elapsed < t.delay) { if (t) allDone = false; return; }
            const speed = 0.12; v.x += (t.x - v.x)*speed; v.y += (t.y - v.y)*speed; v.z += (t.z - v.z)*speed; v.rx *= 0.9; v.ry *= 0.9; v.rz *= 0.9;
            if (Math.max(Math.abs(v.x-t.x), Math.abs(v.y-t.y), Math.abs(v.z-t.z)) > 0.01) allDone = false;
            else { v.x = t.x; v.y = t.y; v.z = t.z; v.rx = 0; v.ry = 0; v.rz = 0; if (t.color !== undefined) { v.color.set(t.color); v.originalColor = v.color.clone(); } }
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
    const delta = this.clock.getDelta(); if (this.mixer) this.mixer.update(delta);
    this.controls.update(); this.updatePhysics();
    this.draw();
    this.composer.render();
  }

  public handleResize() {
      if (this.camera && this.renderer && this.composer) {
        this.camera.aspect = window.innerWidth / window.innerHeight; this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight); this.composer.setSize(window.innerWidth, window.innerHeight);
      }
  }

  public setBloom(enabled: boolean, strength: number = 0.4) {
      this.bloomPass.enabled = enabled;
      this.bloomPass.strength = strength;
  }

  public setToneMapping(mode: 'none' | 'cinematic' | 'filmic') {
      if (mode === 'none') { this.renderer.toneMapping = THREE.NoToneMapping; this.renderer.toneMappingExposure = 1.0; }
      else if (mode === 'cinematic') { this.renderer.toneMapping = THREE.CineonToneMapping; this.renderer.toneMappingExposure = 1.2; }
      else { this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.1; }
  }


  public generateSphere(radius: number = 8) {
      const voxels: VoxelData[] = [];
      const r2 = radius * radius;
      const base = CONFIG.FLOOR_Y + 1;
      for (let x = -radius; x <= radius; x++)
          for (let y = 0; y <= radius * 2; y++)
              for (let z = -radius; z <= radius; z++)
                  if (x*x + (y-radius)*(y-radius) + z*z <= r2)
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
              const n = noise2D(x * 0.18, z * 0.18) * 0.5 + noise2D(x * 0.35, z * 0.35) * 0.3 + noise2D(x * 0.7, z * 0.7) * 0.2;
              const h = Math.max(1, Math.round(3 + (n + 1) * 5));
              for (let y = 0; y < h; y++) {
                  const col = y === h - 1 ? (h > 9 ? palette[5] : h > 6 ? palette[2] : palette[1]) : (y < 2 ? palette[3] : palette[0]);
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
                  const d = Math.sqrt(x*x + cy*cy + z*z) / size;
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
          const hasEmissiveVoxels = this.voxels.some(v => v.materialType === VoxelMaterial.EMISSIVE);
          (this.rigGroup.children.filter(c => c instanceof THREE.SkinnedMesh) as THREE.SkinnedMesh[]).forEach(sm => {
              const f = hasEmissiveVoxels ? (sm.name === 'skinned_emissive' ? 'emissive' : 'non-emissive') : undefined;
              const old = sm.geometry; sm.geometry = this.buildSkinnedGeo(this.solidPreviewEnabled, f); old.dispose();
          });
      } else if (this.solidPreviewEnabled) {
          this.refreshSolidPreview();
      }
  }

  private disposeSolidPreview() {
      if (this.solidPreviewMesh) { this.scene.remove(this.solidPreviewMesh); this.solidPreviewMesh.geometry.dispose(); (this.solidPreviewMesh.material as THREE.Material).dispose(); this.solidPreviewMesh = null; }
  }
  private applyDisplayState() {
      if (this.rigGroup) {
          this.disposeSolidPreview();
          this.getAllMeshes().forEach(m => m.visible = false);
      } else if (this.solidPreviewEnabled) {
          this.refreshSolidPreview();
          this.getAllMeshes().forEach(m => m.visible = false);
      } else {
          this.disposeSolidPreview();
          this.getAllMeshes().forEach(m => m.visible = true);
      }
  }

  private buildSkinnedGeo(hiddenFaceRemoval: boolean, filter?: 'emissive' | 'non-emissive'): THREE.BufferGeometry {
      const h = hiddenFaceRemoval ? CONFIG.VOXEL_SIZE / 2 : (CONFIG.VOXEL_SIZE - 0.05) / 2;
      const faceData = [
          { n: [0,0,-1] as [number,number,number], v: [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h]] as [number,number,number][] },
          { n: [0,0,1]  as [number,number,number], v: [[h,-h,h],[-h,-h,h],[-h,h,h],[h,h,h]] as [number,number,number][] },
          { n: [0,-1,0] as [number,number,number], v: [[-h,-h,h],[h,-h,h],[h,-h,-h],[-h,-h,-h]] as [number,number,number][] },
          { n: [0,1,0]  as [number,number,number], v: [[-h,h,-h],[h,h,-h],[h,h,h],[-h,h,h]] as [number,number,number][] },
          { n: [-1,0,0] as [number,number,number], v: [[-h,-h,h],[-h,h,h],[-h,h,-h],[-h,-h,-h]] as [number,number,number][] },
          { n: [1,0,0]  as [number,number,number], v: [[h,-h,-h],[h,h,-h],[h,h,h],[h,-h,h]] as [number,number,number][] },
      ];
      const positions: number[] = [], normals: number[] = [], colors: number[] = [];
      const skinIndices: number[] = [], skinWeights: number[] = [], indices: number[] = [];
      const voxelsToProcess = filter === 'emissive' ? this.voxels.filter(v => v.materialType === VoxelMaterial.EMISSIVE) : filter === 'non-emissive' ? this.voxels.filter(v => v.materialType !== VoxelMaterial.EMISSIVE) : this.voxels;
      voxelsToProcess.forEach(v => {
          const boneIdx = v.bone !== undefined ? (this.boneIndexMap[v.bone] ?? 0) : 0;
          const col = v.originalColor || v.color;
          const rx = Math.round(v.x), ry = Math.round(v.y), rz = Math.round(v.z);
          faceData.forEach(face => {
              if (hiddenFaceRemoval && this.voxelMap.has(`${rx+face.n[0]},${ry+face.n[1]},${rz+face.n[2]}`)) return;
              const base = positions.length / 3;
              const ni = face.n.findIndex(x => x !== 0);
              const tIdx = [0,1,2].filter(i => i !== ni);
              face.v.forEach(([ox, oy, oz]) => {
                  positions.push(v.x + ox, v.y + oy, v.z + oz);
                  normals.push(face.n[0], face.n[1], face.n[2]);
                  const vArr = [ox, oy, oz];
                  const sa = Math.sign(vArr[tIdx[0]]), sb = Math.sign(vArr[tIdx[1]]);
                  const ao = this.bakedAOEnabled ? this.computeVertexAO(rx, ry, rz, tIdx[0], tIdx[1], sa, sb) : 1;
                  colors.push(col.r * ao, col.g * ao, col.b * ao);
                  skinIndices.push(boneIdx, 0, 0, 0);
                  skinWeights.push(1, 0, 0, 0);
              });
              indices.push(base, base+1, base+2, base, base+2, base+3);
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
          const hasEmissiveVoxels = this.voxels.some(v => v.materialType === VoxelMaterial.EMISSIVE);
          (this.rigGroup.children.filter(c => c instanceof THREE.SkinnedMesh) as THREE.SkinnedMesh[]).forEach(sm => {
              const f = hasEmissiveVoxels ? (sm.name === 'skinned_emissive' ? 'emissive' : 'non-emissive') : undefined;
              const old = sm.geometry; sm.geometry = this.buildSkinnedGeo(enabled, f); old.dispose();
          });
      } else {
          this.applyDisplayState();
      }
  }

  private refreshSolidPreview() {
      if (this.solidPreviewMesh) { this.scene.remove(this.solidPreviewMesh); this.solidPreviewMesh.geometry.dispose(); (this.solidPreviewMesh.material as THREE.Material).dispose(); this.solidPreviewMesh = null; }
      if (this.voxels.length === 0) return;
      const mesh = this.generateOptimizedMesh();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.solidPreviewMesh = mesh;
  }

  private computeVertexAO(rx: number, ry: number, rz: number, tAxis0: number, tAxis1: number, sa: number, sb: number): number {
      const p = [rx, ry, rz];
      const e1 = [...p]; e1[tAxis0] += sa;
      const e2 = [...p]; e2[tAxis1] += sb;
      const c  = [...p]; c[tAxis0]  += sa; c[tAxis1] += sb;
      const s1 = this.voxelMap.has(`${e1[0]},${e1[1]},${e1[2]}`);
      const s2 = this.voxelMap.has(`${e2[0]},${e2[1]},${e2[2]}`);
      const cn = this.voxelMap.has(`${c[0]},${c[1]},${c[2]}`);
      if (s1 && s2) return Math.max(0, 1.0 - 0.5 * this.bakedAOStrength);
      const occ = (s1 ? 1 : 0) + (s2 ? 1 : 0) + (cn ? 1 : 0);
      return Math.max(0, 1.0 - occ * 0.2 * this.bakedAOStrength);
  }

  public setAutoRotate(enabled: boolean) { if (this.controls) this.controls.autoRotate = enabled; }

  public getVoxelDataForSave(): VoxelData[] {
      if (this.replaySource) return this.replaySource.map(cloneVoxel);
      if (this.state === AppState.REBUILDING && this.pendingRebuildModel) return this.pendingRebuildModel.map(cloneVoxel);
      if (this.state === AppState.DISMANTLING && this.voxelSnapshot) return this.voxelSnapshot.map(cloneVoxel);
      return this.voxels.map(v => ({
          x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z),
          color: (v.originalColor || v.color).getHex(),
          ...(v.materialType !== VoxelMaterial.STANDARD && { materialType: v.materialType }),
          ...(v.bone && { bone: v.bone }),
          ...(v.weights && v.weights.length > 0 && { weights: v.weights.map(w => ({ ...w })) }),
          ...(v.isLocked && { isLocked: true }),
      }));
  }

  public getJsonData(): string {
      return serializeModelDocument(this.getModelDocument());
  }

  public getModelDocument(): ModelDocument {
      return createModelDocument(this.getVoxelDataForSave(), this.currentSkeleton);
  }

  public importJsonData(json: string) {
      const document = parseModelDocument(json);
      this.loadInitialModel(document.voxels, document.skeleton);
  }
  
  public getUniqueColors(): string[] {
    const colors = new Set<string>(); this.voxels.forEach(v => colors.add('#' + (v.originalColor || v.color).getHexString())); return Array.from(colors);
  }

  private buildStaticEmissiveMesh(): THREE.Mesh {
      const h = (CONFIG.VOXEL_SIZE - 0.05) / 2;
      const faceData = [
          { n: [0,0,-1] as [number,number,number], v: [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h]] as [number,number,number][] },
          { n: [0,0,1]  as [number,number,number], v: [[h,-h,h],[-h,-h,h],[-h,h,h],[h,h,h]] as [number,number,number][] },
          { n: [0,-1,0] as [number,number,number], v: [[-h,-h,h],[h,-h,h],[h,-h,-h],[-h,-h,-h]] as [number,number,number][] },
          { n: [0,1,0]  as [number,number,number], v: [[-h,h,-h],[h,h,-h],[h,h,h],[-h,h,h]] as [number,number,number][] },
          { n: [-1,0,0] as [number,number,number], v: [[-h,-h,h],[-h,h,h],[-h,h,-h],[-h,-h,-h]] as [number,number,number][] },
          { n: [1,0,0]  as [number,number,number], v: [[h,-h,-h],[h,h,-h],[h,h,h],[h,-h,h]] as [number,number,number][] },
      ];
      const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
      this.voxels.filter(v => v.materialType === VoxelMaterial.EMISSIVE).forEach(v => {
          const col = v.originalColor || v.color;
          const rx = Math.round(v.x), ry = Math.round(v.y), rz = Math.round(v.z);
          faceData.forEach(face => {
              if (this.voxelMap.has(`${rx+face.n[0]},${ry+face.n[1]},${rz+face.n[2]}`)) return;
              const base = positions.length / 3;
              face.v.forEach(([ox,oy,oz]) => { positions.push(v.x+ox, v.y+oy, v.z+oz); normals.push(face.n[0],face.n[1],face.n[2]); colors.push(col.r,col.g,col.b); });
              indices.push(base,base+1,base+2,base,base+2,base+3);
          });
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1 }));
  }

  public async exportGLTF(includeAnimations: boolean = true) {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    let exportGroup: THREE.Object3D;
    if (this.rigGroup) {
        exportGroup = this.rigGroup;
    } else if (this.voxels.some(v => v.materialType === VoxelMaterial.EMISSIVE)) {
        const group = new THREE.Group();
        group.add(this.generateOptimizedMesh());
        group.add(this.buildStaticEmissiveMesh());
        exportGroup = group;
    } else {
        exportGroup = this.generateOptimizedMesh();
    }
    let animations: THREE.AnimationClip[] = [];
    if (includeAnimations && this.currentSkeleton && this.rigGroup) {
        this.currentSkeleton.animations.forEach(animDef => {
            const tracks: THREE.KeyframeTrack[] = [];
            Object.entries(animDef.tracks).forEach(([boneName, keyframes]) => {
                const boneGroup = this.boneGroups[boneName]; if (!boneGroup) return;
                const times = keyframes.map(k => k.time);
                if (keyframes.some(k => k.rot)) {
                    const values: number[] = []; keyframes.forEach(k => { const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(k.rot?.[0]||0, k.rot?.[1]||0, k.rot?.[2]||0)); values.push(quat.x, quat.y, quat.z, quat.w); });
                    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
                }
                if (keyframes.some(k => k.pos)) {
                    const values: number[] = []; const basePos = boneGroup.position.clone();
                    keyframes.forEach(k => values.push(basePos.x + (k.pos?.[0]||0), basePos.y + (k.pos?.[1]||0), basePos.z + (k.pos?.[2]||0)));
                    tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, times, values));
                }
            });
            animations.push(new THREE.AnimationClip(animDef.name, animDef.duration, tracks));
        });
    }
    exportGroup.userData.voxelData = this.voxels.map(v => ({
        x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z),
        c: '#' + (v.originalColor || v.color).getHexString(),
        ...(v.materialType !== VoxelMaterial.STANDARD && { m: v.materialType }),
        ...(v.bone && { b: v.bone }),
        ...(v.weights && v.weights.length > 0 && { w: v.weights }),
        ...(v.isLocked && { l: true })
    }));
    exportGroup.userData.voxshopSkeleton = cloneSkeleton(this.currentSkeleton);
    exporter.parse(exportGroup, (gltf) => {
        const blob = new Blob([gltf as ArrayBuffer], { type: 'application/octet-stream' });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'voxel_model.glb'; link.click();
    }, (err) => console.error(err), { binary: true, animations });
  }

  public generateOptimizedMesh(): THREE.Mesh {
      const box = new THREE.Box3(); this.voxels.forEach(v => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
      const min = { x: Math.floor(box.min.x), y: Math.floor(box.min.y), z: Math.floor(box.min.z) };
      const max = { x: Math.ceil(box.max.x), y: Math.ceil(box.max.y), z: Math.ceil(box.max.z) };
      const dims = [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1];
      const vertices: number[] = [], indices: number[] = [], normals: number[] = [], colors: number[] = [];
      for (let d = 0; d < 3; d++) {
          const u = (d + 1) % 3, v = (d + 2) % 3, x = [0, 0, 0], q = [0, 0, 0]; q[d] = 1;
          const mask = new Array(dims[u] * dims[v]);
          for (x[d] = -1; x[d] < dims[d]; ) {
              let n = 0;
              for (x[v] = 0; x[v] < dims[v]; x[v]++) {
                  for (x[u] = 0; x[u] < dims[u]; x[u]++, n++) {
                      const voxelA = this.voxelMap.get(`${x[0]+min.x},${x[1]+min.y},${x[2]+min.z}`);
                      const voxelB = this.voxelMap.get(`${x[0]+q[0]+min.x},${x[1]+q[1]+min.y},${x[2]+q[2]+min.z}`);
                      if (voxelA && voxelB && voxelA.color.getHex() === voxelB.color.getHex()) mask[n] = 0;
                      else mask[n] = voxelA ? { c: voxelA.color.getHex(), d: 1 } : (voxelB ? { c: voxelB.color.getHex(), d: -1 } : 0);
                  }
              }
              x[d]++; n = 0;
              for (let j = 0; j < dims[v]; j++) {
                  for (let i = 0; i < dims[u]; ) {
                      if (mask[n]) {
                          const cur = mask[n]; let w, h;
                          for (w = 1; i + w < dims[u] && mask[n + w] && mask[n+w].c === cur.c && mask[n+w].d === cur.d; w++);
                          let done = false;
                          for (h = 1; j + h < dims[v]; h++) {
                              for (let k = 0; k < w; k++) { const m = mask[n + k + h * dims[u]]; if (!m || m.c !== cur.c || m.d !== cur.d) { done = true; break; } }
                              if (done) break;
                          }
                          x[u] = i; x[v] = j; const du = [0,0,0], dv = [0,0,0]; du[u] = w; dv[v] = h;
                          const start = vertices.length / 3;
                          vertices.push(x[0]+min.x, x[1]+min.y, x[2]+min.z, x[0]+du[0]+min.x, x[1]+du[1]+min.y, x[2]+du[2]+min.z, x[0]+du[0]+dv[0]+min.x, x[1]+du[1]+dv[1]+min.y, x[2]+du[2]+dv[2]+min.z, x[0]+dv[0]+min.x, x[1]+dv[1]+min.y, x[2]+dv[2]+min.z);
                          if (cur.d === 1) { indices.push(start, start + 1, start + 2, start, start + 2, start + 3); }
                          else { indices.push(start + 2, start + 1, start, start + 3, start + 2, start); }
                          const norm = [0,0,0]; norm[d] = cur.d; normals.push(...norm,...norm,...norm,...norm);
                          const col = new THREE.Color(cur.c);
          if (this.bakedAOEnabled) {
              const rx = cur.d === 1 ? x[0]+min.x : x[0]+q[0]+min.x;
              const ry = cur.d === 1 ? x[1]+min.y : x[1]+q[1]+min.y;
              const rz = cur.d === 1 ? x[2]+min.z : x[2]+q[2]+min.z;
              const signs: [number,number][] = [[-1,-1],[1,-1],[1,1],[-1,1]];
              for (const [sa,sb] of signs) {
                  const ao = this.computeVertexAO(rx, ry, rz, u, v, sa, sb);
                  colors.push(col.r*ao, col.g*ao, col.b*ao);
              }
          } else {
              for (let k = 0; k < 4; k++) colors.push(col.r, col.g, col.b);
          }
                          for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * dims[u]] = 0;
                          i += w; n += w;
                      } else { i++; n++; }
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
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([result], { type: 'text/plain' })); link.download = 'voxel_model.obj'; link.click();
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

  public get hasRigData(): boolean { return this.voxels.some(v => !!v.bone); }
  public get currentSkeletonDef(): SkeletonDef | null { return this.currentSkeleton; }

  public enterRiggingMode() {
    this.state = AppState.RIGGING; this.onStateChange(this.state); this.controls.autoRotate = false; this.exitAnimationPreview();
  }

  public exitRiggingMode() {
    this.state = AppState.STABLE; this.onStateChange(this.state); this.controls.autoRotate = true; this.disablePainting(); this.exitAnimationPreview();
    this.voxels.forEach(v => { if (v.originalColor) v.color.copy(v.originalColor); });
    this.getAllMeshes().forEach(m => { if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  }

  public enablePainting(boneName: string, colorHex: string) { this.currentPaintBone = boneName; this.currentPaintColor.set(colorHex); this.controls.enableRotate = false; }
  public disablePainting() { this.currentPaintBone = null; this.controls.enableRotate = true; }

  private onPointerDown(event: PointerEvent) {
    if (this.state === AppState.EDITING) { this.handleEditClick(event); return; }
    if (this.state !== AppState.RIGGING || !this.currentPaintBone) return;
    this.isPainting = true; this.paintVoxel(event);
  }

  private onPointerMove(event: PointerEvent) { if (!this.isPainting || this.state !== AppState.RIGGING || !this.currentPaintBone) return; this.paintVoxel(event); }
  private onPointerUp() { this.isPainting = false; }

  private paintVoxel(event: PointerEvent) {
    this.cancelReplay();
    const allMeshes = this.getAllMeshes(); if (allMeshes.length === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1; this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(allMeshes);
    if (intersects.length > 0) {
        const intersect = intersects[0]; const instanceId = intersect.instanceId; const targetMesh = intersect.object as THREE.InstancedMesh;
        if (instanceId !== undefined) {
            const hitPos = new THREE.Vector3(), hitMatrix = new THREE.Matrix4();
            targetMesh.getMatrixAt(instanceId, hitMatrix); hitPos.setFromMatrixPosition(hitMatrix);
            const voxel = this.voxelMap.get(`${Math.round(hitPos.x)},${Math.round(hitPos.y)},${Math.round(hitPos.z)}`);
            if (voxel) {
                this.documentVersion = this.documentRevision + 1;
                voxel.bone = this.currentPaintBone!;
                voxel.weights = [{ bone: this.currentPaintBone!, weight: 1.0 }];
                this.onDocumentChange?.(this.getModelDocument());
                const mixedColor = (voxel.originalColor || voxel.color).clone().lerp(this.currentPaintColor, 0.6);
                voxel.color.copy(mixedColor);
                targetMesh.setColorAt(instanceId, voxel.color); if (targetMesh.instanceColor) targetMesh.instanceColor.needsUpdate = true;
            }
        }
    }
  }

  public enterEditingMode() {
      this.state = AppState.EDITING; this.onStateChange(this.state); this.controls.autoRotate = false;
  }

  public exitEditingMode() { this.state = AppState.STABLE; this.onStateChange(this.state); this.controls.autoRotate = true; this.deselectEditVoxel(); }
  public setEditColor(colorHex: string | null) { this.currentEditColor = colorHex; if (colorHex) this.deselectEditVoxel(); }
  public setEditMode(mode: 'move' | 'paint' | 'add' | 'delete' | 'lock' | 'fill') { this.editMode = mode; if (mode !== 'move') this.deselectEditVoxel(); }
  public setSymmetry(x: boolean, y: boolean, z: boolean) { this.symmetryX = x; this.symmetryY = y; this.symmetryZ = z; }
  public setEditMaterial(material: VoxelMaterial) { this.currentEditMaterial = material; }

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
      if (!mesh) { this.clearEditSelection(); return; }
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(this.editInstanceId, matrix);
      const from = new THREE.Vector3().setFromMatrixPosition(matrix);
      const to = {
          x: Math.round(this.editMesh.position.x),
          y: Math.round(this.editMesh.position.y),
          z: Math.round(this.editMesh.position.z),
      };
      const command = createMoveCommand(this.getVoxelDataForSave(), from, to);
      this.clearEditSelection();
      if (command.voxels.length > 0) {
          this.applyDelta(command, false);
          this.commitChange(command);
      }
  }

  private getVoxelPositionsInBrush(baseX: number, baseY: number, baseZ: number): { x: number, y: number, z: number }[] {
      const positions: { x: number, y: number, z: number }[] = []; const size = this.brushSize - 1;
      if (this.brushType === 'single') positions.push({ x: baseX, y: baseY, z: baseZ });
      else {
          for (let x = -size; x <= size; x++) for (let y = -size; y <= size; y++) for (let z = -size; z <= size; z++) {
              if (this.brushType === 'sphere' ? (x*x + y*y + z*z <= size*size) : true) positions.push({ x: baseX + x, y: baseY + y, z: baseZ + z });
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
                  this.editVoxels({ mode: 'add', targets: this.getBrushTargets(base).map(t => t.position),
                      color: new THREE.Color(this.currentEditColor).getHex(), materialType: this.currentEditMaterial });
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
          this.editMesh = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.95), (mesh.material as THREE.Material).clone());
          this.editMesh.position.copy(point);
          this.scene.add(this.editMesh);
          this.transformControl.attach(this.editMesh);
          return;
      }
      const targets = this.getBrushTargets(base, hit.face?.normal).flatMap(target => {
          if (this.editMode !== 'add') return [target.position];
          if (!target.normal) return [];
          return [target.position.clone().addScaledVector(target.normal, CONFIG.VOXEL_SIZE).round()];
      });
      this.editVoxels({ mode: this.editMode, targets,
          color: this.currentEditColor ? new THREE.Color(this.currentEditColor).getHex() : undefined,
          materialType: this.currentEditMaterial });
  }

  public autoRig(skeletonDef: SkeletonDef) {
    this.cancelReplay();
      if (this.state === AppState.DISMANTLING) this.exitRiggingMode();

      const box = new THREE.Box3();
      this.voxels.forEach(v => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
      const center = new THREE.Vector3(), size = new THREE.Vector3();
      box.getCenter(center); box.getSize(size);
      const cx = center.x, cz = center.z;
      const h = size.y, d = size.z;
      const yMin = box.min.y, zMin = box.min.z;
      const pct = (arr: number[], p: number): number => {
          if (!arr.length) return 0;
          const s = [...arr].sort((a, b) => a - b);
          return s[Math.floor((p / 100) * (s.length - 1))];
      };
      const countXZClusters = (yi: number): number => {
          const keys = new Set(
              this.voxels
                  .filter(v => Math.abs(v.y - yi) < 0.6)
                  .map(v => `${Math.round(v.x)},${Math.round(v.z)}`)
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
                  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                      const nk = `${x+dx},${z+dz}`;
                      if (keys.has(nk) && !visited.has(nk)) q.push(nk);
                  }
              }
          };
          keys.forEach(k => { if (!visited.has(k)) { count++; bfs(k); } });
          return count;
      };

      if (skeletonDef.id === 'humanoid') {
          let legZoneTop = yMin + h * 0.42;
          outer: for (let yi = Math.round(yMin + h * 0.55); yi >= Math.round(yMin + h * 0.15); yi--) {
              const xs = this.voxels
                  .filter(v => Math.abs(v.y - yi) < 0.6)
                  .map(v => v.x)
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

          const legVoxels   = this.voxels.filter(v => v.y <  legZoneTop);
          const upperVoxels = this.voxels.filter(v => v.y >= legZoneTop);

          legVoxels.forEach(v => { v.bone = v.x < cx ? 'LegL' : 'LegR'; });
          const hipXAbs = upperVoxels
              .filter(v => v.y <= legZoneTop + h * 0.10)
              .map(v => Math.abs(v.x - cx));
          const armThresh = (pct(hipXAbs, 90) || size.x * 0.3) + 1;
          upperVoxels.forEach(v => {
              const dx = Math.abs(v.x - cx);
              v.bone = dx > armThresh ? (v.x < cx ? 'ArmL' : 'ArmR') : 'Torso';
          });

      } else if (skeletonDef.id === 'quadruped') {
          let legZoneTop = yMin + h * 0.38;
          for (let yi = Math.round(yMin); yi <= Math.round(yMin + h * 0.50); yi++) {
              if (countXZClusters(yi) >= 2) legZoneTop = yi + 1;
          }

          const legXSplit = cx;
          const legZSplit = cz;

          this.voxels.forEach(v => {
              if (v.y < legZoneTop) {
                  const front = v.z > legZSplit, left = v.x < legXSplit;
                  v.bone = front ? (left ? 'LegFL' : 'LegFR') : (left ? 'LegBL' : 'LegBR');
              } else {
                  v.bone = 'Torso';
              }
          });

      } else if (skeletonDef.id === 'bird') {
          const bodyXAbs = this.voxels
              .filter(v => Math.abs(v.z - cz) <= size.z * 0.30)
              .map(v => Math.abs(v.x - cx));
          const wingThresh = (pct(bodyXAbs, 85) || size.x * 0.25) + 1;
          this.voxels.forEach(v => {
              const dx = Math.abs(v.x - cx);
              v.bone = dx > wingThresh ? (v.x < cx ? 'WingL' : 'WingR') : 'Torso';
          });

      } else if (skeletonDef.id === 'fish') {
          const tailZ = zMin + d * 0.20;
          const bodyXAbs = this.voxels
              .filter(v => v.z >= cz - d * 0.3 && v.z <= cz + d * 0.3 && v.z > tailZ)
              .map(v => Math.abs(v.x - cx));
          const finThresh = (pct(bodyXAbs, 85) || size.x * 0.3) + 1;
          this.voxels.forEach(v => {
              if (v.z <= tailZ) v.bone = 'Tail';
              else if (Math.abs(v.x - cx) > finThresh) v.bone = v.x < cx ? 'FinL' : 'FinR';
              else v.bone = 'Torso';
          });

      } else if (skeletonDef.id === 'insect') {
          const legTop = yMin + h * 0.35;
          const legXThresh = (pct(
              this.voxels.filter(v => v.y >= legTop).map(v => Math.abs(v.x - cx)), 80
          ) || size.x * 0.25) + 0.5;
          const z1 = zMin + d / 3, z2 = zMin + (d * 2) / 3;
          this.voxels.forEach(v => {
              if (v.y < legTop && Math.abs(v.x - cx) > legXThresh) {
                  const left = v.x < cx;
                  v.bone = v.z >= z2 ? (left ? 'Leg1L' : 'Leg1R')
                         : v.z >= z1 ? (left ? 'Leg2L' : 'Leg2R')
                         :             (left ? 'Leg3L' : 'Leg3R');
              } else {
                  v.bone = 'Torso';
              }
          });

      } else if (skeletonDef.id === 'cube_monster') {
          const splitY = yMin + h * 0.45;
          this.voxels.forEach(v => { v.bone = v.y < splitY ? 'Base' : 'Body'; });

      } else {
          this.voxels.forEach(v => { v.bone = skeletonDef.bones[0].name; });
      }

      this.voxels.forEach(v => {
          v.weights = v.bone ? [{ bone: v.bone, weight: 1.0 }] : [];
      });

      this.currentSkeleton = skeletonDef;
      this.state = AppState.RIGGING;
      this.onStateChange(this.state);
      this.buildRigAndPreview(skeletonDef);
  }

  public buildRigAndPreview(skeletonDef: SkeletonDef) {
    this.cancelReplay();
    this.documentVersion = this.documentRevision + 1;
    this.clearRig();
    this.currentSkeleton = skeletonDef;
    this.onDocumentChange?.(this.getModelDocument());
    this.rigGroup = new THREE.Group();
    this.boneGroups = {};
    this.bonePivots = {};

    const pivots: Record<string, THREE.Vector3> = {};
    skeletonDef.bones.forEach(bDef => {
        const bVoxels = this.voxels.filter(v => v.bone === bDef.name);
        if (bVoxels.length === 0) return;
        const box = new THREE.Box3();
        bVoxels.forEach(v => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
        const pivot = new THREE.Vector3();
        box.getCenter(pivot);
        if (bDef.pivotType === 'bottom') pivot.y = box.min.y;
        else if (bDef.pivotType === 'top') pivot.y = box.max.y;
        else if (bDef.pivotType === 'left') pivot.x = box.min.x;
        else if (bDef.pivotType === 'right') pivot.x = box.max.x;
        else if (bDef.pivotType === 'front') pivot.z = box.max.z;
        else if (bDef.pivotType === 'back') pivot.z = box.min.z;
        pivots[bDef.name] = pivot;
        this.bonePivots[bDef.name] = pivot.clone();
        const bone = new THREE.Bone();
        bone.name = bDef.name;
        this.boneGroups[bDef.name] = bone;
    });

    const allBones: THREE.Bone[] = [];
    const boneIndexMap: Record<string, number> = {};
    skeletonDef.bones.forEach(bDef => {
        const bone = this.boneGroups[bDef.name];
        if (!bone) return;
        boneIndexMap[bDef.name] = allBones.length;
        allBones.push(bone);
        if (bDef.parent && this.boneGroups[bDef.parent]) {
            this.boneGroups[bDef.parent].add(bone);
            bone.position.subVectors(pivots[bDef.name], pivots[bDef.parent]);
        } else {
            this.rigGroup!.add(bone);
            bone.position.copy(pivots[bDef.name]);
        }
    });

    this.scene.add(this.rigGroup);
    this.rigGroup.updateMatrixWorld(true);

    this.boneIndexMap = boneIndexMap;

    this.rigSkeleton = new THREE.Skeleton(allBones);
    const hasEmissiveVoxels = this.voxels.some(v => v.materialType === VoxelMaterial.EMISSIVE);
    const geo = this.buildSkinnedGeo(this.solidPreviewEnabled, hasEmissiveVoxels ? 'non-emissive' : undefined);
    const skinnedMesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    skinnedMesh.name = 'skinned_standard';
    skinnedMesh.bind(this.rigSkeleton);
    this.rigGroup.add(skinnedMesh);
    if (hasEmissiveVoxels) {
        const emissiveGeo = this.buildSkinnedGeo(this.solidPreviewEnabled, 'emissive');
        const emissiveSkinnedMesh = new THREE.SkinnedMesh(emissiveGeo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1 }));
        emissiveSkinnedMesh.name = 'skinned_emissive';
        emissiveSkinnedMesh.bind(this.rigSkeleton);
        this.rigGroup.add(emissiveSkinnedMesh);
    }

    this.applyDisplayState();
  }

  public async exportVOX() {
    const voxels = this.getVoxelDataForSave().map(v=>({...v,color:new THREE.Color(v.color)})); if (voxels.length === 0) return;
    const box = new THREE.Box3(); voxels.forEach(v => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
    const size = new THREE.Vector3(); box.getSize(size);
    const w = Math.ceil(size.x) + 1, h = Math.ceil(size.y) + 1, d = Math.ceil(size.z) + 1;
    if(Math.max(w,h,d)>256)throw new Error('VOX coordinates support at most 256 cells per axis. Use native JSON or a smaller model.');
    const colorMap = new Map<number, number>();
    voxels.forEach(v => { const hex = v.color.getHex(); if (!colorMap.has(hex) && colorMap.size < 255) colorMap.set(hex, colorMap.size + 1); });
    const pal = Array.from(colorMap.keys()); while (pal.length < 256) pal.push(0);
    const buf: number[] = [];
    const ws = (s: string) => s.split('').forEach(c => buf.push(c.charCodeAt(0)));
    const wi = (i: number) => { const b = new ArrayBuffer(4); new DataView(b).setInt32(0, i, true); new Uint8Array(b).forEach(v => buf.push(v)); };
    const nv = voxels.length;
    const sc = 12, xc = 4 + nv * 4, rc = 256 * 4;
    const mcs = (12 + sc) + (12 + xc) + (12 + rc);
    ws('VOX '); wi(150);
    ws('MAIN'); wi(0); wi(mcs);
    ws('SIZE'); wi(sc); wi(0); wi(w); wi(d); wi(h);
    ws('XYZI'); wi(xc); wi(0); wi(nv);
    voxels.forEach(v => { const ci = colorMap.get(v.color.getHex()) ?? 1; buf.push(Math.round(v.x - box.min.x), Math.round(v.z - box.min.z), Math.round(v.y - box.min.y), ci); });
    ws('RGBA'); wi(rc); wi(0);
    pal.forEach(hex => buf.push((hex >> 16) & 0xFF, (hex >> 8) & 0xFF, hex & 0xFF, 0xFF));
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' })); link.download = 'model.vox'; link.click();
  }

  public async exportQB() {
    const voxels = this.getVoxelDataForSave().map(v=>({...v,color:new THREE.Color(v.color)})); if (voxels.length === 0) return;
    const box = new THREE.Box3(); voxels.forEach(v => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
    const size = new THREE.Vector3(); box.getSize(size);
    const w = Math.ceil(size.x) + 1, h = Math.ceil(size.y) + 1, d = Math.ceil(size.z) + 1;
    const buffer: number[] = [];
    if(w*h*d>4000000)throw new Error('QB export exceeds four million volume cells. Use native JSON or a smaller model.');
    const writeInt = (i: number) => { const b = new ArrayBuffer(4); new DataView(b).setUint32(0, i, true); new Uint8Array(b).forEach(v => buffer.push(v)); };
    
    writeInt(0x01010000);
    writeInt(1);
    writeInt(0);
    writeInt(0);
    writeInt(1);
    writeInt(1);
    buffer.push(5); "Model".split('').forEach(c => buffer.push(c.charCodeAt(0)));
    writeInt(w); writeInt(h); writeInt(d);
    writeInt(Math.round(box.min.x)); writeInt(Math.round(box.min.y)); writeInt(Math.round(box.min.z));
    
    const grid = new Array(w * h * d).fill(0);
    voxels.forEach(v => {
        const x = Math.round(v.x - box.min.x), y = Math.round(v.y - box.min.y), z = Math.round(v.z - box.min.z);
        const color = v.color.getHex();
        grid[x + y*w + z*w*h] = ((color & 0xFF) << 16) | (color & 0xFF00) | ((color >> 16) & 0xFF) | 0xFF000000;
    });
    grid.forEach(c => writeInt(c));
    
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([new Uint8Array(buffer)], { type: 'application/octet-stream' })); link.download = 'model.qb'; link.click();
  }

  public async exportMinecraft(format: 'nbt' | 'schematic' | 'litematic') {
    const voxels = this.getVoxelDataForSave().map(v=>({...v,color:new THREE.Color(v.color)})); if (voxels.length === 0) return;
    const box = new THREE.Box3(); voxels.forEach(v => box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z)));
    const size = new THREE.Vector3(); box.getSize(size);
    const w = Math.ceil(size.x) + 1, h = Math.ceil(size.y) + 1, d = Math.ceil(size.z) + 1;

    if(w*h*d>4000000)throw new Error('Minecraft export exceeds four million volume cells. Use native JSON or a smaller model.');
    const PALETTE: { rgb: [number,number,number]; id: number; data: number; name: string }[] = [
      { rgb:[207,213,214], id:251, data:0,  name:'minecraft:white_concrete' },
      { rgb:[224, 97,  0], id:251, data:1,  name:'minecraft:orange_concrete' },
      { rgb:[169, 48,159], id:251, data:2,  name:'minecraft:magenta_concrete' },
      { rgb:[ 36,137,199], id:251, data:3,  name:'minecraft:light_blue_concrete' },
      { rgb:[240,175, 21], id:251, data:4,  name:'minecraft:yellow_concrete' },
      { rgb:[ 94,168, 24], id:251, data:5,  name:'minecraft:lime_concrete' },
      { rgb:[213,101,142], id:251, data:6,  name:'minecraft:pink_concrete' },
      { rgb:[ 54, 57, 61], id:251, data:7,  name:'minecraft:gray_concrete' },
      { rgb:[125,125,115], id:251, data:8,  name:'minecraft:light_gray_concrete' },
      { rgb:[ 21,119,136], id:251, data:9,  name:'minecraft:cyan_concrete' },
      { rgb:[100, 31,156], id:251, data:10, name:'minecraft:purple_concrete' },
      { rgb:[ 44, 46,143], id:251, data:11, name:'minecraft:blue_concrete' },
      { rgb:[ 96, 59, 31], id:251, data:12, name:'minecraft:brown_concrete' },
      { rgb:[ 72, 91, 36], id:251, data:13, name:'minecraft:green_concrete' },
      { rgb:[142, 32, 32], id:251, data:14, name:'minecraft:red_concrete' },
      { rgb:[  8, 10, 15], id:251, data:15, name:'minecraft:black_concrete' },
      { rgb:[221,221,221], id: 35, data:0,  name:'minecraft:white_wool' },
      { rgb:[219,125, 62], id: 35, data:1,  name:'minecraft:orange_wool' },
      { rgb:[179, 80,188], id: 35, data:2,  name:'minecraft:magenta_wool' },
      { rgb:[107,138,201], id: 35, data:3,  name:'minecraft:light_blue_wool' },
      { rgb:[177,166, 39], id: 35, data:4,  name:'minecraft:yellow_wool' },
      { rgb:[ 65,174, 56], id: 35, data:5,  name:'minecraft:lime_wool' },
      { rgb:[208,132,153], id: 35, data:6,  name:'minecraft:pink_wool' },
      { rgb:[ 64, 64, 64], id: 35, data:7,  name:'minecraft:gray_wool' },
      { rgb:[154,161,161], id: 35, data:8,  name:'minecraft:light_gray_wool' },
      { rgb:[ 46,110,137], id: 35, data:9,  name:'minecraft:cyan_wool' },
      { rgb:[126, 61,181], id: 35, data:10, name:'minecraft:purple_wool' },
      { rgb:[ 46, 56,141], id: 35, data:11, name:'minecraft:blue_wool' },
      { rgb:[ 79, 50, 31], id: 35, data:12, name:'minecraft:brown_wool' },
      { rgb:[ 54, 76, 24], id: 35, data:13, name:'minecraft:green_wool' },
      { rgb:[150, 51, 48], id: 35, data:14, name:'minecraft:red_wool' },
      { rgb:[ 25, 22, 22], id: 35, data:15, name:'minecraft:black_wool' },
      { rgb:[210,178,161], id:159, data:0,  name:'minecraft:white_terracotta' },
      { rgb:[162, 84, 38], id:159, data:1,  name:'minecraft:orange_terracotta' },
      { rgb:[149, 88,108], id:159, data:2,  name:'minecraft:magenta_terracotta' },
      { rgb:[113,108,137], id:159, data:3,  name:'minecraft:light_blue_terracotta' },
      { rgb:[186,133, 36], id:159, data:4,  name:'minecraft:yellow_terracotta' },
      { rgb:[103,117, 53], id:159, data:5,  name:'minecraft:lime_terracotta' },
      { rgb:[161, 78, 78], id:159, data:6,  name:'minecraft:pink_terracotta' },
      { rgb:[ 57, 42, 35], id:159, data:7,  name:'minecraft:gray_terracotta' },
      { rgb:[135,107, 98], id:159, data:8,  name:'minecraft:light_gray_terracotta' },
      { rgb:[ 87, 91, 91], id:159, data:9,  name:'minecraft:cyan_terracotta' },
      { rgb:[118, 70, 86], id:159, data:10, name:'minecraft:purple_terracotta' },
      { rgb:[ 74, 59, 91], id:159, data:11, name:'minecraft:blue_terracotta' },
      { rgb:[ 77, 51, 35], id:159, data:12, name:'minecraft:brown_terracotta' },
      { rgb:[ 76, 82, 42], id:159, data:13, name:'minecraft:green_terracotta' },
      { rgb:[143, 61, 46], id:159, data:14, name:'minecraft:red_terracotta' },
      { rgb:[ 37, 22, 16], id:159, data:15, name:'minecraft:black_terracotta' },
      { rgb:[125,125,125], id:  1, data:0,  name:'minecraft:stone' },
      { rgb:[219,207,163], id: 12, data:0,  name:'minecraft:sand' },
      { rgb:[162,130, 78], id:  5, data:0,  name:'minecraft:oak_planks' },
      { rgb:[134, 96, 67], id:  3, data:0,  name:'minecraft:dirt' },
      { rgb:[127,127,127], id:  4, data:0,  name:'minecraft:cobblestone' },
      { rgb:[150, 97, 83], id: 45, data:0,  name:'minecraft:bricks' },
      { rgb:[ 21, 18, 30], id: 49, data:0,  name:'minecraft:obsidian' },
      { rgb:[255,255,255], id: 80, data:0,  name:'minecraft:snow_block' },
      { rgb:[145,183,211], id: 79, data:0,  name:'minecraft:ice' },
      { rgb:[255,223,122], id: 89, data:0,  name:'minecraft:glowstone' },
      { rgb:[ 97, 41, 41], id: 87, data:0,  name:'minecraft:netherrack' },
    ];

    const nearestBlock = (hex: number) => {
      const r=(hex>>16)&0xFF, g=(hex>>8)&0xFF, b=hex&0xFF;
      let best=0, bd=Infinity;
      PALETTE.forEach((p,i) => { const dist=(r-p.rgb[0])**2+(g-p.rgb[1])**2+(b-p.rgb[2])**2; if(dist<bd){bd=dist;best=i;} });
      return PALETTE[best];
    };

    const enc = new TextEncoder();
    const buf: number[] = [];
    const push8  = (v: number) => buf.push(v & 0xFF);
    const push16 = (v: number) => { buf.push((v>>8)&0xFF, v&0xFF); };
    const push32 = (v: number) => { buf.push((v>>>24)&0xFF,(v>>>16)&0xFF,(v>>>8)&0xFF,v&0xFF); };
    const push64 = (v: bigint) => { push32(Number((v>>32n)&0xFFFFFFFFn)); push32(Number(v&0xFFFFFFFFn)); };
    const pushStr = (s: string) => { const e=enc.encode(s); push16(e.length); e.forEach(b=>buf.push(b)); };
    const tag = (type: number, name: string, payload: ()=>void) => { push8(type); pushStr(name); payload(); };

    if (format === 'litematic') {
      const paletteNames: string[] = ['minecraft:air'];
      const blockToPaletteIdx = new Map<string, number>();
      const voxelPaletteMap = new Map<string, number>();

      voxels.forEach(v => {
        const x=Math.round(v.x-box.min.x), y=Math.round(v.y-box.min.y), z=Math.round(v.z-box.min.z);
        const block = nearestBlock(v.color.getHex());
        if (!blockToPaletteIdx.has(block.name)) { blockToPaletteIdx.set(block.name, paletteNames.length); paletteNames.push(block.name); }
        voxelPaletteMap.set(`${x},${y},${z}`, blockToPaletteIdx.get(block.name)!);
      });

      const paletteSize = paletteNames.length;
      const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(Math.max(paletteSize, 2))));
      const valuesPerLong = Math.floor(64 / bitsPerBlock);
      const totalBlocks = w * h * d;
      const longCount = Math.ceil(totalBlocks / valuesPerLong);
      const blockStates = new Array(longCount).fill(0n) as bigint[];

      for (let y=0; y<h; y++) for (let z=0; z<d; z++) for (let x=0; x<w; x++) {
        const blockIdx = (y*d+z)*w+x;
        const pi = voxelPaletteMap.get(`${x},${y},${z}`) ?? 0;
        if (pi !== 0) {
          const li = Math.floor(blockIdx/valuesPerLong);
          const bitOff = (blockIdx%valuesPerLong)*bitsPerBlock;
          blockStates[li] |= BigInt(pi) << BigInt(bitOff);
        }
      }

      const ts = BigInt(Date.now());
      push8(10); pushStr('');
      tag(3, 'MinecraftDataVersion', () => push32(2860));
      tag(3, 'Version', () => push32(6));
      tag(3, 'SubVersion', () => push32(1));
      tag(10, 'Metadata', () => {
        tag(8, 'Name', () => pushStr('voxel_model'));
        tag(8, 'Author', () => pushStr('Voxel Builder'));
        tag(8, 'Description', () => pushStr(''));
        tag(4, 'TimeCreated', () => push64(ts));
        tag(4, 'TimeModified', () => push64(ts));
        tag(10, 'EnclosingSize', () => { tag(3,'x',()=>push32(w)); tag(3,'y',()=>push32(h)); tag(3,'z',()=>push32(d)); push8(0); });
        tag(3, 'TotalBlocks', () => push32(voxels.length));
        tag(3, 'TotalVolume', () => push32(w*h*d));
        tag(3, 'RegionCount', () => push32(1));
        push8(0);
      });
      tag(10, 'Regions', () => {
        tag(10, 'main', () => {
          tag(10, 'Position', () => { tag(3,'x',()=>push32(0)); tag(3,'y',()=>push32(0)); tag(3,'z',()=>push32(0)); push8(0); });
          tag(10, 'Size', () => { tag(3,'x',()=>push32(w)); tag(3,'y',()=>push32(h)); tag(3,'z',()=>push32(d)); push8(0); });
          tag(9, 'BlockStatePalette', () => {
            push8(10); push32(paletteNames.length);
            paletteNames.forEach(n => { tag(8,'Name',()=>pushStr(n)); push8(0); });
          });
          tag(12, 'BlockStates', () => { push32(blockStates.length); blockStates.forEach(v=>push64(v)); });
          tag(9,'Entities',()=>{push8(10);push32(0);});
          tag(9,'TileEntities',()=>{push8(10);push32(0);});
          tag(9,'PendingBlockTicks',()=>{push8(10);push32(0);});
          tag(9,'PendingFluidTicks',()=>{push8(10);push32(0);});
          push8(0);
        });
        push8(0);
      });
      push8(0);

    } else {
      const blocks = new Uint8Array(w * h * d);
      const blockData = new Uint8Array(w * h * d);
      voxels.forEach(v => {
        const x=Math.round(v.x-box.min.x), y=Math.round(v.y-box.min.y), z=Math.round(v.z-box.min.z);
        const block = nearestBlock(v.color.getHex());
        const idx = y*w*d + z*w + x;
        blocks[idx] = block.id;
        blockData[idx] = block.data;
      });
      const wi4 = (i: number) => push32(i);
      const wtag = (type: number, name: string, payload: ()=>void) => tag(type, name, payload);
      push8(10); pushStr('Schematic');
      wtag(2,'Width',()=>push16(w)); wtag(2,'Height',()=>push16(h)); wtag(2,'Length',()=>push16(d));
      wtag(8,'Materials',()=>pushStr('Alpha'));
      wtag(7,'Blocks',()=>{wi4(blocks.length);blocks.forEach(b=>push8(b));});
      wtag(7,'Data',()=>{wi4(blockData.length);blockData.forEach(b=>push8(b));});
      wtag(9,'Entities',()=>{push8(10);push32(0);});
      wtag(9,'TileEntities',()=>{push8(10);push32(0);});
      push8(0);
    }

    const raw = new Uint8Array(buf);
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(raw); writer.close();
    const compressed = await new Response(cs.readable).arrayBuffer();
    const ext = format === 'litematic' ? 'litematic' : format === 'schematic' ? 'schematic' : 'nbt';
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([compressed],{type:'application/octet-stream'})); link.download=`model.${ext}`; link.click();
  }

  public importVOX(buffer: ArrayBuffer): VoxelData[] {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'VOX ') throw new Error('Not a valid .vox file');

    const rawVoxels: { x: number; y: number; z: number; ci: number }[] = [];
    const palette = new Array(257).fill(0xCCCCCC);

    const walkChunks = (start: number, end: number) => {
      let off = start;
      while (off + 12 <= end) {
        const id = String.fromCharCode(view.getUint8(off), view.getUint8(off+1), view.getUint8(off+2), view.getUint8(off+3));
        const cs = view.getInt32(off+4, true);
        const ch = view.getInt32(off+8, true);
        const cStart = off + 12;
        if (id === 'XYZI') {
          const n = view.getInt32(cStart, true);
          for (let i = 0; i < n; i++) {
            const b = cStart + 4 + i*4;
            rawVoxels.push({ x: view.getUint8(b), y: view.getUint8(b+1), z: view.getUint8(b+2), ci: view.getUint8(b+3) });
          }
        } else if (id === 'RGBA') {
          for (let i = 0; i < 255; i++) {
            const b = cStart + i*4;
            palette[i+1] = (view.getUint8(b) << 16) | (view.getUint8(b+1) << 8) | view.getUint8(b+2);
          }
        }
        if (ch > 0) walkChunks(cStart + cs, cStart + cs + ch);
        off = cStart + cs + ch;
      }
    };
    walkChunks(8, buffer.byteLength);
    if (rawVoxels.length === 0) return [];
    const voxels = rawVoxels.map(v => ({ x: v.x, y: v.z, z: v.y, color: palette[v.ci] ?? 0xCCCCCC }));
    const minX = Math.min(...voxels.map(v=>v.x)), maxX = Math.max(...voxels.map(v=>v.x));
    const minZ = Math.min(...voxels.map(v=>v.z)), maxZ = Math.max(...voxels.map(v=>v.z));
    const minY = Math.min(...voxels.map(v=>v.y));
    const cx = (minX+maxX)/2, cz = (minZ+maxZ)/2;
    return voxels.map(v => ({ x: Math.round(v.x - cx), y: v.y - minY, z: Math.round(v.z - cz), color: v.color }));
  }

  public importQB(buffer: ArrayBuffer): VoxelData[] {
    const view = new DataView(buffer);
    let off = 0;
    const rU32 = () => { const v = view.getUint32(off, true); off+=4; return v; };
    const rI32 = () => { const v = view.getInt32(off, true); off+=4; return v; };

    rU32();
    const colorFormat = rU32();
    rU32();
    const compression = rU32();
    rU32();
    const numMatrices = rU32();

    const allVoxels: VoxelData[] = [];

    for (let m = 0; m < numMatrices; m++) {
      const nameLen = view.getUint8(off); off++;
      off += nameLen;
      const sizeX = rU32(), sizeY = rU32(), sizeZ = rU32();
      const posX = rI32(), posY = rI32(), posZ = rI32();

      if (compression === 0) {
        for (let z = 0; z < sizeZ; z++) {
          for (let y = 0; y < sizeY; y++) {
            for (let x = 0; x < sizeX; x++) {
              const raw = rU32();
              if (((raw >> 24) & 0xFF) === 0) continue;
              const r = colorFormat === 1 ? raw & 0xFF : (raw >> 16) & 0xFF;
              const g = (raw >> 8) & 0xFF;
              const b = colorFormat === 1 ? (raw >> 16) & 0xFF : raw & 0xFF;
              allVoxels.push({ x: posX+x, y: posY+y, z: posZ+z, color: (r<<16)|(g<<8)|b });
            }
          }
        }
      } else {
        for (let z = 0; z < sizeZ; z++) {
          for (let y = 0; y < sizeY; y++) {
            let x = 0;
            while (x < sizeX) {
              const data = rU32();
              if (data === 2) {
                const count = rU32(), raw = rU32();
                if (((raw >> 24) & 0xFF) > 0) {
                  const r = colorFormat === 1 ? raw & 0xFF : (raw >> 16) & 0xFF;
                  const g = (raw >> 8) & 0xFF;
                  const b = colorFormat === 1 ? (raw >> 16) & 0xFF : raw & 0xFF;
                  for (let i = 0; i < count && x < sizeX; i++, x++) allVoxels.push({ x: posX+x, y: posY+y, z: posZ+z, color: (r<<16)|(g<<8)|b });
                } else x += count;
              } else {
                if (((data >> 24) & 0xFF) > 0) {
                  const r = colorFormat === 1 ? data & 0xFF : (data >> 16) & 0xFF;
                  const g = (data >> 8) & 0xFF;
                  const b = colorFormat === 1 ? (data >> 16) & 0xFF : data & 0xFF;
                  allVoxels.push({ x: posX+x, y: posY+y, z: posZ+z, color: (r<<16)|(g<<8)|b });
                }
                x++;
              }
            }
          }
        }
      }
    }

    if (allVoxels.length === 0) return [];
    const minX = Math.min(...allVoxels.map(v=>v.x)), maxX = Math.max(...allVoxels.map(v=>v.x));
    const minZ = Math.min(...allVoxels.map(v=>v.z)), maxZ = Math.max(...allVoxels.map(v=>v.z));
    const minY = Math.min(...allVoxels.map(v=>v.y));
    const cx = (minX+maxX)/2, cz = (minZ+maxZ)/2;
    return allVoxels.map(v => ({ x: Math.round(v.x - cx), y: v.y - minY, z: Math.round(v.z - cz), color: v.color }));
  }

  public flipModel(axis: 'x' | 'y' | 'z') {
    const data: VoxelData[] = this.getVoxelDataForSave().map(v => ({
      ...v,
      x: axis === 'x' ? -Math.round(v.x) : Math.round(v.x),
      y: axis === 'y' ? -Math.round(v.y) : Math.round(v.y),
      z: axis === 'z' ? -Math.round(v.z) : Math.round(v.z),
    }));
    this.transformModel(data);
  }

  public rotateModel90(direction: 'cw' | 'ccw') {
    const data: VoxelData[] = this.getVoxelDataForSave().map(v => {
      const x = Math.round(v.x), z = Math.round(v.z);
      return {
        ...v,
        x: direction === 'cw' ? z : -z,
        y: Math.round(v.y),
        z: direction === 'cw' ? -x : x,
      };
    });
    this.transformModel(data);
  }

  private transformModel(data: VoxelData[]) {
    this.deselectEditVoxel();
    const command = replaceModelCommand(this.getVoxelDataForSave(), normalizeVoxels(data), 'transform');
    this.applyDelta(command, false);
    this.commitChange(command);
  }

  public async importMinecraft(buffer: ArrayBuffer): Promise<VoxelData[]> {
    let decompressed: ArrayBuffer;
    try {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(buffer));
      writer.close();
      decompressed = await new Response(ds.readable).arrayBuffer();
    } catch {
      decompressed = buffer;
    }

    const buf = new Uint8Array(decompressed);
    const dv = new DataView(decompressed);
    let pos = 0;

    const r8  = () => buf[pos++];
    const r16 = () => { const v = dv.getInt16(pos, false); pos += 2; return v; };
    const ru16 = () => { const v = dv.getUint16(pos, false); pos += 2; return v; };
    const r32 = () => { const v = dv.getInt32(pos, false); pos += 4; return v; };
    const r64 = () => { const hi = dv.getInt32(pos, false); const lo = dv.getUint32(pos + 4, false); pos += 8; return (BigInt(hi) << 32n) | BigInt(lo); };
    const rStr = () => { const len = ru16(); const s = new TextDecoder().decode(buf.slice(pos, pos + len)); pos += len; return s; };

    const readPayload = (type: number): any => {
      switch (type) {
        case 1: return r8();
        case 2: return r16();
        case 3: return r32();
        case 4: return r64();
        case 5: { const v = dv.getFloat32(pos, false); pos += 4; return v; }
        case 6: { const v = dv.getFloat64(pos, false); pos += 8; return v; }
        case 7: { const n = r32(); const arr = new Uint8Array(buf.buffer, buf.byteOffset + pos, n); pos += n; return arr; }
        case 8: return rStr();
        case 9: { const et = r8(); const n = r32(); const arr: any[] = []; for (let i = 0; i < n; i++) arr.push(readPayload(et)); return arr; }
        case 10: return readCompound();
        case 11: { const n = r32(); const arr: number[] = []; for (let i = 0; i < n; i++) arr.push(r32()); return arr; }
        case 12: { const n = r32(); const arr: bigint[] = []; for (let i = 0; i < n; i++) arr.push(r64()); return arr; }
        default: return null;
      }
    };

    const readCompound = (): Record<string, any> => {
      const out: Record<string, any> = {};
      while (pos < buf.length) {
        const type = r8();
        if (type === 0) break;
        const name = rStr();
        out[name] = readPayload(type);
      }
      return out;
    };

    if (r8() !== 10) throw new Error('Not a valid NBT compound file');
    rStr();
    const root = readCompound();

    const BLOCK_NAME_COLORS: Record<string, number> = {
      'minecraft:white_concrete':0xCFD5D6,'minecraft:orange_concrete':0xE06100,'minecraft:magenta_concrete':0xA9309F,
      'minecraft:light_blue_concrete':0x2489C7,'minecraft:yellow_concrete':0xF0AF15,'minecraft:lime_concrete':0x5EA818,
      'minecraft:pink_concrete':0xD5658E,'minecraft:gray_concrete':0x36393D,'minecraft:light_gray_concrete':0x7D7D73,
      'minecraft:cyan_concrete':0x157788,'minecraft:purple_concrete':0x64179C,'minecraft:blue_concrete':0x2C2E8F,
      'minecraft:brown_concrete':0x603B1F,'minecraft:green_concrete':0x485B24,'minecraft:red_concrete':0x8E2020,
      'minecraft:black_concrete':0x08090F,'minecraft:white_concrete_powder':0xE1E4E4,'minecraft:orange_concrete_powder':0xE7883B,
      'minecraft:white_wool':0xDDDDDD,'minecraft:orange_wool':0xDB7D3E,'minecraft:magenta_wool':0xB350BC,
      'minecraft:light_blue_wool':0x6B8AC9,'minecraft:yellow_wool':0xB1A627,'minecraft:lime_wool':0x41AE38,
      'minecraft:pink_wool':0xD08499,'minecraft:gray_wool':0x404040,'minecraft:light_gray_wool':0x9AA1A1,
      'minecraft:cyan_wool':0x2E6E89,'minecraft:purple_wool':0x7E3DB5,'minecraft:blue_wool':0x2E388D,
      'minecraft:brown_wool':0x4F321F,'minecraft:green_wool':0x364C18,'minecraft:red_wool':0x963330,
      'minecraft:black_wool':0x191616,'minecraft:white_terracotta':0xD2B2A1,'minecraft:orange_terracotta':0xA25426,
      'minecraft:magenta_terracotta':0x95585C,'minecraft:light_blue_terracotta':0x716C89,'minecraft:yellow_terracotta':0xBA8524,
      'minecraft:lime_terracotta':0x677535,'minecraft:pink_terracotta':0xA14E4E,'minecraft:gray_terracotta':0x392A23,
      'minecraft:light_gray_terracotta':0x876B62,'minecraft:cyan_terracotta':0x575B5B,'minecraft:purple_terracotta':0x764656,
      'minecraft:blue_terracotta':0x4A3B5B,'minecraft:brown_terracotta':0x4D3323,'minecraft:green_terracotta':0x4C522A,
      'minecraft:red_terracotta':0x8F3D2E,'minecraft:black_terracotta':0x251610,'minecraft:terracotta':0x985335,
      'minecraft:stone':0x7D7D7D,'minecraft:cobblestone':0x7F7F7F,'minecraft:smooth_stone':0x9A9A9A,
      'minecraft:stone_bricks':0x787878,'minecraft:mossy_stone_bricks':0x6A7A55,'minecraft:cracked_stone_bricks':0x747474,
      'minecraft:chiseled_stone_bricks':0x787878,'minecraft:granite':0xA0724A,'minecraft:polished_granite':0xA07247,
      'minecraft:diorite':0xC0C0C0,'minecraft:polished_diorite':0xC4C4C4,'minecraft:andesite':0x8C8C8C,
      'minecraft:polished_andesite':0x8E8E8E,'minecraft:oak_planks':0xA2824E,'minecraft:spruce_planks':0x7D5A2D,
      'minecraft:birch_planks':0xC8B577,'minecraft:jungle_planks':0xA07040,'minecraft:acacia_planks':0xBA6337,
      'minecraft:dark_oak_planks':0x4A2F14,'minecraft:mangrove_planks':0x8D3B2B,'minecraft:bamboo_planks':0xC0A84E,
      'minecraft:oak_log':0xA07040,'minecraft:spruce_log':0x3D2B0F,'minecraft:birch_log':0xD0D0D0,
      'minecraft:jungle_log':0x976B3A,'minecraft:acacia_log':0xA0A0A0,'minecraft:dark_oak_log':0x3A2A10,
      'minecraft:oak_leaves':0x3A8020,'minecraft:spruce_leaves':0x2D6618,'minecraft:birch_leaves':0x80A755,
      'minecraft:jungle_leaves':0x2E7B10,'minecraft:acacia_leaves':0x5A8020,'minecraft:dark_oak_leaves':0x2E6612,
      'minecraft:sand':0xDBCFA3,'minecraft:red_sand':0xBE6B26,'minecraft:gravel':0x8F8F8F,
      'minecraft:dirt':0x866043,'minecraft:coarse_dirt':0x7A5234,'minecraft:grass_block':0x5F9F35,
      'minecraft:mycelium':0x766676,'minecraft:podzol':0x6E4220,'minecraft:bricks':0x967053,
      'minecraft:obsidian':0x15121E,'minecraft:crying_obsidian':0x1B023D,'minecraft:ice':0x91B7D3,
      'minecraft:packed_ice':0x7DAAD4,'minecraft:blue_ice':0x5B9FD4,'minecraft:snow_block':0xFFFFFF,
      'minecraft:glowstone':0xFFDF7A,'minecraft:shroomlight':0xF0A030,'minecraft:sea_lantern':0xAFD8D8,
      'minecraft:netherrack':0x612929,'minecraft:nether_bricks':0x2C1515,'minecraft:soul_sand':0x5A4232,
      'minecraft:soul_soil':0x4A3828,'minecraft:basalt':0x474747,'minecraft:smooth_basalt':0x4A4A4A,
      'minecraft:blackstone':0x2A2226,'minecraft:deepslate':0x474747,'minecraft:cobbled_deepslate':0x494949,
      'minecraft:calcite':0xE0DDD8,'minecraft:tuff':0x7A7C6A,'minecraft:end_stone':0xDAD99B,
      'minecraft:purpur_block':0xA66FA6,'minecraft:prismarine':0x5A9E8B,'minecraft:dark_prismarine':0x305D46,
      'minecraft:prismarine_bricks':0x62B0A0,'minecraft:quartz_block':0xEEEEEE,'minecraft:smooth_quartz':0xECECEC,
      'minecraft:iron_block':0xD8D8D8,'minecraft:gold_block':0xF5D340,'minecraft:diamond_block':0x5DECF5,
      'minecraft:emerald_block':0x17DD62,'minecraft:redstone_block':0xC41B07,'minecraft:lapis_block':0x1B4BA4,
      'minecraft:coal_block':0x1A1A1A,'minecraft:copper_block':0xCB7248,'minecraft:cut_copper':0xC87249,
      'minecraft:exposed_copper':0xA08060,'minecraft:weathered_copper':0x5A8060,'minecraft:oxidized_copper':0x3A9070,
      'minecraft:amethyst_block':0x8060C0,'minecraft:budding_amethyst':0x7050B0,'minecraft:glass':0xB3D8E6,
      'minecraft:tinted_glass':0x4A3A50,'minecraft:hay_block':0xC0A820,'minecraft:bookshelf':0xA08040,
      'minecraft:crafting_table':0x9A7040,'minecraft:furnace':0x7A7A7A,'minecraft:chest':0xA08040,
      'minecraft:mud':0x4A3830,'minecraft:mud_bricks':0x8A6A50,'minecraft:packed_mud':0x7A5A40,
    };

    const getNameColor = (name: string): number | null => {
      if (!name || name.includes(':air') || name.includes('water') || name.includes('lava')) return null;
      if (BLOCK_NAME_COLORS[name] !== undefined) return BLOCK_NAME_COLORS[name];
      if (name.startsWith('minecraft:')) return 0x888888;
      return null;
    };

    const centerVoxels = (voxels: VoxelData[]) => {
      if (voxels.length === 0) return [];
      const minX = Math.min(...voxels.map(v => v.x)), maxX = Math.max(...voxels.map(v => v.x));
      const minZ = Math.min(...voxels.map(v => v.z)), maxZ = Math.max(...voxels.map(v => v.z));
      const minY = Math.min(...voxels.map(v => v.y));
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      return voxels.map(v => ({ ...v, x: Math.round(v.x - cx), y: v.y - minY, z: Math.round(v.z - cz) }));
    };

    if ('Regions' in root) {
      const regions = root['Regions'] as Record<string, any>;
      const regionName = Object.keys(regions)[0];
      if (!regionName) throw new Error('No regions found in litematic file');
      const region = regions[regionName];
      const size = region['Size'] as Record<string, number>;
      const sizeX = Math.abs(size['x']), sizeY = Math.abs(size['y']), sizeZ = Math.abs(size['z']);
      const paletteFull: Record<string, any>[] = region['BlockStatePalette'] || [];
      const palette: string[] = paletteFull.map((b: any) => b['Name'] || 'minecraft:air');
      const blockStates: bigint[] = region['BlockStates'] || [];
      const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(palette.length, 2))));
      const valuesPerLong = Math.floor(64 / bitsPerBlock);
      const mask = (1n << BigInt(bitsPerBlock)) - 1n;
      const getPI = (idx: number) => {
        const li = Math.floor(idx / valuesPerLong);
        const bit = (idx % valuesPerLong) * bitsPerBlock;
        return li < blockStates.length ? Number((blockStates[li] >> BigInt(bit)) & mask) : 0;
      };
      const voxels: VoxelData[] = [];
      for (let y = 0; y < sizeY; y++)
        for (let z = 0; z < sizeZ; z++)
          for (let x = 0; x < sizeX; x++) {
            const pi = getPI((y * sizeZ + z) * sizeX + x);
            const color = getNameColor(palette[pi] || 'minecraft:air');
            if (color !== null) voxels.push({ x, y, z, color });
          }
      return centerVoxels(voxels);
    }

    if ('blocks' in root && 'palette' in root) {
      const palette: string[] = (root['palette'] as Record<string, any>[]).map((b: any) => b['Name'] || 'minecraft:air');
      const blocks: Record<string, any>[] = root['blocks'] || [];
      const voxels: VoxelData[] = [];
      for (const block of blocks) {
        const blockName = palette[block['state'] as number] || 'minecraft:air';
        const pos: number[] = block['pos'];
        const color = getNameColor(blockName);
        if (color !== null && pos) voxels.push({ x: pos[0], y: pos[1], z: pos[2], color });
      }
      return centerVoxels(voxels);
    }

    const w = root['Width'], h = root['Height'], d = root['Length'];
    const blocks: Uint8Array = root['Blocks'], data: Uint8Array = root['Data'];
    if (!w || !h || !d || !blocks) throw new Error('Unrecognized Minecraft file format. Supported: .schematic, .litematic, .nbt (structure)');

    const BLOCK_COLORS: Record<number, Record<number, [number,number,number]>> = {
      35:  { 0:[221,221,221], 1:[219,125,62],  2:[179,80,188],  3:[107,138,201], 4:[177,166,39], 5:[65,174,56],   6:[208,132,153], 7:[64,64,64],    8:[154,161,161], 9:[46,110,137],  10:[126,61,181], 11:[46,56,141],  12:[79,50,31],  13:[54,76,24],  14:[150,51,48], 15:[25,22,22]  },
      251: { 0:[207,213,214], 1:[224,97,0],    2:[169,48,159],  3:[36,137,199],  4:[240,175,21], 5:[94,168,24],   6:[213,101,142], 7:[54,57,61],    8:[125,125,115], 9:[21,119,136],  10:[100,31,156], 11:[44,46,143],  12:[96,59,31],  13:[72,91,36],  14:[142,32,32], 15:[8,10,15]   },
      159: { 0:[210,178,161], 1:[162,84,38],   2:[149,88,108],  3:[113,108,137], 4:[186,133,36], 5:[103,117,53],  6:[161,78,78],   7:[57,42,35],    8:[135,107,98],  9:[87,91,91],    10:[118,70,86],  11:[74,59,91],   12:[77,51,35],  13:[76,82,42],  14:[143,61,46], 15:[37,22,16]  },
      1:{0:[125,125,125]}, 2:{0:[95,159,53]}, 3:{0:[134,96,67]}, 4:{0:[127,127,127]},
      5:{0:[162,130,78]}, 12:{0:[219,207,163]}, 13:{0:[136,126,126]}, 45:{0:[150,97,83]},
      49:{0:[21,18,30]}, 79:{0:[145,183,211]}, 80:{0:[255,255,255]}, 87:{0:[97,41,41]},
      88:{0:[81,62,50]}, 89:{0:[255,223,122]},
    };
    const voxels: VoxelData[] = [];
    for (let y = 0; y < h; y++)
      for (let z = 0; z < d; z++)
        for (let x = 0; x < w; x++) {
          const idx = y * w * d + z * w + x;
          const blockId = blocks[idx]; if (!blockId) continue;
          const meta = data ? Math.min(data[idx], 15) : 0;
          const blockColors = BLOCK_COLORS[blockId]; if (!blockColors) continue;
          const rgb = blockColors[meta] ?? blockColors[0]; if (!rgb) continue;
          voxels.push({ x, y, z, color: (rgb[0] << 16) | (rgb[1] << 8) | rgb[2] });
        }
    return centerVoxels(voxels);
  }

  public playAnimation(skeletonDef: SkeletonDef, animName: string, loop: boolean = true) {
    if (!this.rigGroup) return;
    const animDef = skeletonDef.animations.find(a => a.name === animName); if (!animDef) return;

    if (animName === 'Death') { this.createSnapshot(); loop = false; }

    const tracks: THREE.KeyframeTrack[] = [];
    Object.entries(animDef.tracks).forEach(([boneName, kfs]) => {
        const group = this.boneGroups[boneName]; if (!group) return;
        const times = kfs.map(k => k.time);
        if (kfs.some(k => k.rot)) {
            const vals: number[] = []; kfs.forEach(k => { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(k.rot?.[0]||0, k.rot?.[1]||0, k.rot?.[2]||0)); vals.push(q.x, q.y, q.z, q.w); });
            tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, vals));
        }
        if (kfs.some(k => k.pos)) {
            const vals: number[] = []; const base = group.position.clone();
            kfs.forEach(k => vals.push(base.x + (k.pos?.[0]||0), base.y + (k.pos?.[1]||0), base.z + (k.pos?.[2]||0)));
            tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, times, vals));
        }
    });
    const clip = new THREE.AnimationClip(animName, animDef.duration, tracks);
    if (!this.mixer) { this.mixer = new THREE.AnimationMixer(this.rigGroup); }
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
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; this.currentAction = null; }
    if (this.rigGroup) {
      this.scene.remove(this.rigGroup);
      this.rigGroup.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => material.dispose());
        }
      });
      this.rigSkeleton?.dispose();
      this.rigGroup = null;
      this.boneGroups = {};
      this.bonePivots = {};
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
    const geometry = new THREE.BoxGeometry(CONFIG.VOXEL_SIZE - 0.05, CONFIG.VOXEL_SIZE - 0.05, CONFIG.VOXEL_SIZE - 0.05);
    const count = Math.max(obj.data.length + 50, 200);
    const meshes: THREE.InstancedMesh[] = [
      new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 }), count),
      new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0.9 }), count),
      new THREE.InstancedMesh(geometry, new THREE.MeshPhysicalMaterial({ transmission: 0.9, thickness: 0.5, transparent: true } as any), count),
      new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ emissiveIntensity: 2, roughness: 0.5 }), count),
    ];
    const matOrder = [VoxelMaterial.STANDARD, VoxelMaterial.METALLIC, VoxelMaterial.GLASS, VoxelMaterial.EMISSIVE];
    const counts = [0, 0, 0, 0];
    const dummy = new THREE.Object3D();
    obj.data.forEach(v => {
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
      meshes.forEach(m => { this.scene.remove(m); m.dispose(); m.geometry.dispose(); (m.material as THREE.Material).dispose(); });
      this.sceneObjectMeshes.delete(id);
    }
  }

  public clearScene(): void {
    const ids = [...this.sceneObjectMeshes.keys()];
    ids.forEach(id => this.removeFromScene(id));
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
      this.composer.passes.forEach(pass => pass.dispose());
      this.composer.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      this.scene.traverse(object => {
          const renderable = object as THREE.Mesh;
          if (object instanceof THREE.InstancedMesh) object.dispose();
          if (renderable.geometry) geometries.add(renderable.geometry);
          if (renderable.material) {
              (Array.isArray(renderable.material) ? renderable.material : [renderable.material]).forEach(material => materials.add(material));
          }
          if (object instanceof THREE.DirectionalLight || object instanceof THREE.PointLight || object instanceof THREE.SpotLight) object.shadow.dispose();
      });
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material.dispose());
      this.renderer.domElement.remove();
      this.renderer.dispose();
  }
}
