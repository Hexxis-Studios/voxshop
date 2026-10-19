import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ProjectDocument, SceneNode } from '../services/projectDocument';
import { createNodeVisual, disposeObject, type AssetVisual } from './assetMesh';
import { GameSimulation, FIXED_DELTA, type GameInput } from './GameSimulation';

export class GameViewport {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  simulation: GameSimulation | null = null;
  private visuals = new Map<string, AssetVisual>();
  private project: ProjectDocument;
  private frame = 0;
  private last = 0;
  private elapsed = 0;
  private accumulator = 0;
  private keys = new Set<string>();
  private pending: GameInput = {};
  private observer: ResizeObserver;
  private selected: THREE.BoxHelper | null = null;
  private stateStamp = '';
  onState?: (state: ReturnType<GameSimulation['inspect']>) => void;
  constructor(
    private container: HTMLElement,
    project: ProjectDocument,
    private onSelect?: (id: string) => void,
  ) {
    this.project = project;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);
    this.camera.position.set(15, 14, 20);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1, 0);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xc5e3ff, 0x334025, 2));
    const sun = new THREE.DirectionalLight(0xffe8ce, 3);
    sun.position.set(12, 24, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    this.scene.add(sun);
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Scene viewport. Select objects with a click. In Play mode use WASD, Space, E and F.',
    );
    this.renderer.domElement.addEventListener('pointerup', this.pointer);
    this.renderer.domElement.addEventListener('keydown', this.keyDown);
    this.renderer.domElement.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.load(project);
    this.frame = requestAnimationFrame(this.render);
  }
  private keyDown = (event: KeyboardEvent) => {
    if (!this.simulation) return;
    if (
      [
        'KeyW',
        'KeyA',
        'KeyS',
        'KeyD',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Space',
        'KeyE',
        'KeyF',
      ].includes(event.code)
    ) {
      event.preventDefault();
      if (!this.keys.has(event.code)) {
        if (event.code === 'Space') this.pending.jump = true;
        if (event.code === 'KeyE') this.pending.interact = true;
        if (event.code === 'KeyF') this.pending.attack = true;
      }
      this.keys.add(event.code);
    }
  };
  private keyUp = (event: KeyboardEvent) => this.keys.delete(event.code);
  private blur = () => {
    this.keys.clear();
    this.pending = {};
  };
  private pointer = (event: PointerEvent) => {
    if (this.simulation) {
      this.pending.attack = true;
      this.renderer.domElement.focus();
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect(),
      ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const hits = ray.intersectObjects(
      [...this.visuals.values()].map((v) => v.group),
      true,
    );
    if (hits.length) {
      let obj: THREE.Object3D | null = hits[0].object;
      while (obj && !obj.userData.nodeId) obj = obj.parent;
      if (obj) this.onSelect?.(obj.userData.nodeId);
    }
  };
  resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  load(project: ProjectDocument) {
    this.stop();
    this.project = project;
    this.select(null);
    for (const v of this.visuals.values()) disposeObject(v.group);
    this.visuals.clear();
    const previous = this.scene.getObjectByName('ground');
    if (previous) disposeObject(previous);
    const scene = project.scenes.find((s) => s.id === project.activeSceneId)!;
    this.scene.background = new THREE.Color(scene.background);
    this.scene.fog = new THREE.Fog(scene.background, 80, 250);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(scene.bounds * 2, scene.bounds * 2),
      new THREE.MeshStandardMaterial({ color: scene.groundColor, roughness: 1 }),
    );
    ground.name = 'ground';
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.position.y = -0.015;
    this.scene.add(ground);
    const assets = new Map(project.assets.map((a) => [a.id, a]));
    for (const node of scene.nodes) {
      const v = createNodeVisual(node, assets);
      v.group.userData.nodeId = node.id;
      this.visuals.set(node.id, v);
    }
    for (const node of scene.nodes) {
      const v = this.visuals.get(node.id)!;
      const parent = node.parentId ? this.visuals.get(node.parentId)!.group : this.scene;
      parent.add(v.group);
      this.transform(v.group, node);
    }
  }
  private transform(object: THREE.Object3D, node: SceneNode) {
    object.position.set(...node.transform.position);
    object.rotation.set(...node.transform.rotation);
    object.scale.set(...node.transform.scale);
    object.visible = node.enabled;
  }
  select(id: string | null) {
    if (this.selected) {
      this.scene.remove(this.selected);
      this.selected.geometry.dispose();
      (this.selected.material as THREE.Material).dispose();
      this.selected = null;
    }
    if (id && this.visuals.has(id)) {
      this.selected = new THREE.BoxHelper(this.visuals.get(id)!.group, 0x67e8f9);
      this.scene.add(this.selected);
    }
  }
  play() {
    this.select(null);
    this.simulation = new GameSimulation(this.project);
    this.controls.enabled = false;
    this.accumulator = 0;
    this.blur();
    this.renderer.domElement.focus();
    this.onState?.(this.simulation.inspect());
  }
  stop() {
    if (!this.simulation) return;
    this.simulation = null;
    this.controls.enabled = true;
    this.blur();
    const scene = this.project.scenes.find((s) => s.id === this.project.activeSceneId)!;
    for (const n of scene.nodes) this.transform(this.visuals.get(n.id)!.group, n);
    this.camera.position.set(15, 14, 20);
    this.controls.target.set(0, 1, 0);
  }
  capture() {
    return this.renderer.domElement.toDataURL('image/png');
  }
  private render = (now: number) => {
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    this.elapsed += dt;
    const sim = this.simulation;
    if (sim) {
      this.accumulator += dt;
      while (this.accumulator >= FIXED_DELTA) {
        const input = {
          moveX:
            (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
            (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0),
          moveZ:
            (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) -
            (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0),
          ...this.pending,
        };
        sim.step(input);
        this.pending = {};
        this.accumulator -= FIXED_DELTA;
      }
      for (const n of sim.nodes.values()) {
        const visual = this.visuals.get(n.id)!;
        this.transform(visual.group, n);
        visual.group.visible = sim.enabled(n);
        const animation = sim.animationState(n.id);
        visual.animate(animation?.clip ?? 'idle', animation?.time ?? 0);
      }
      const player = [...sim.nodes.values()].find((n) => sim.component(n, 'player'));
      if (player) {
        const target = sim.worldPosition(player),
          c = sim.component(player, 'player')!;
        target.y += 1;
        const offset = c.style === 'top-down' ? new THREE.Vector3(0, 20, 12) : new THREE.Vector3(0, 6, 10);
        this.camera.position.lerp(target.clone().add(offset), 1 - Math.exp(-dt * 6));
        this.camera.lookAt(target);
      }
      const stamp = `${sim.frame}:${sim.status}`;
      if ((sim.frame % 6 === 0 || sim.status !== 'playing') && stamp !== this.stateStamp) {
        this.stateStamp = stamp;
        this.onState?.(sim.inspect());
      }
    } else {
      this.controls.update();
      for (const v of this.visuals.values()) v.animate('idle', this.elapsed);
      this.selected?.update();
    }
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.render);
  };
  dispose() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    window.removeEventListener('blur', this.blur);
    this.renderer.domElement.removeEventListener('pointerup', this.pointer);
    this.renderer.domElement.removeEventListener('keydown', this.keyDown);
    this.renderer.domElement.removeEventListener('keyup', this.keyUp);
    this.controls.dispose();
    this.select(null);
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
