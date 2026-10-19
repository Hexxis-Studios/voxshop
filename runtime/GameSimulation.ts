import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type {
  Asset,
  Component,
  GameScene,
  ProjectDocument,
  Rule,
  SceneNode,
} from '../services/projectDocument';

export type GameInput = {
  moveX?: number;
  moveZ?: number;
  jump?: boolean;
  interact?: boolean;
  attack?: boolean;
};
export type RuntimeEvent = { frame: number; type: string; nodeId?: string; data?: unknown };
export const FIXED_DELTA = 1 / 60;
export class GameSimulation {
  readonly scene: GameScene;
  readonly assets: Map<string, Asset>;
  readonly nodes: Map<string, SceneNode>;
  readonly variables: Record<string, number>;
  readonly health: Record<string, number> = {};
  readonly events: RuntimeEvent[] = [];
  readonly errors: string[] = [];
  readonly velocities = new Map<string, number>();
  readonly moving = new Set<string>();
  frame = 0;
  status: 'playing' | 'won' | 'lost' | 'stopped' = 'playing';
  message = '';
  private fired = new Set<string>();
  private timers = new Map<string, number>();
  private actionBudget = 4096;
  private attackCooldown = 0;
  private damageCooldown = 0;
  private previous: GameInput = {};
  private animationTimes = new Map<string, { clip: string; time: number }>();
  constructor(project: ProjectDocument, sceneId = project.activeSceneId) {
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new Error('Scene not found.');
    this.scene = structuredClone(scene);
    this.assets = new Map(project.assets.map((a) => [a.id, a]));
    this.nodes = new Map(this.scene.nodes.map((n) => [n.id, n]));
    this.variables = { ...scene.variables };
    for (const n of this.nodes.values()) {
      const hp = this.component(n, 'health');
      if (hp) this.health[n.id] = hp.maximum;
    }
    for (const n of this.nodes.values()) this.dispatch(n, 'start');
  }
  component<T extends Component['type']>(
    node: SceneNode,
    type: T,
  ): Extract<Component, { type: T }> | undefined {
    return node.components.find((c) => c.type === type) as any;
  }
  enabled(node: SceneNode): boolean {
    if (!node.enabled) return false;
    const gate = this.component(node, 'gate');
    if (gate && (this.variables[gate.variable] ?? 0) >= gate.required) return false;
    return node.parentId ? this.enabled(this.nodes.get(node.parentId)!) : true;
  }
  worldMatrix(node: SceneNode): Matrix4 {
    const t = node.transform;
    const matrix = new Matrix4().compose(
      new Vector3(...t.position),
      new Quaternion().setFromEuler(new Euler(...t.rotation)),
      new Vector3(...t.scale),
    );
    return node.parentId ? this.worldMatrix(this.nodes.get(node.parentId)!).multiply(matrix) : matrix;
  }
  worldPosition(node: SceneNode): Vector3 {
    return new Vector3().setFromMatrixPosition(this.worldMatrix(node));
  }
  private setWorldPosition(node: SceneNode, position: Vector3) {
    if (node.parentId) position.applyMatrix4(this.worldMatrix(this.nodes.get(node.parentId)!).invert());
    node.transform.position = position.toArray() as [number, number, number];
  }
  bounds(node: SceneNode): Box3 {
    const collider = this.component(node, 'collider');
    let min: Vector3, max: Vector3;
    if (collider) {
      const c = new Vector3(...collider.offset),
        half = new Vector3(...collider.size).multiplyScalar(0.5);
      min = c.clone().sub(half);
      max = c.clone().add(half);
    } else {
      const a = node.assetId && this.assets.get(node.assetId);
      min = new Vector3(Infinity, Infinity, Infinity);
      max = new Vector3(-Infinity, -Infinity, -Infinity);
      if (a && a.model.voxels.length) {
        for (const v of a.model.voxels) {
          min.min(new Vector3(v.x - 0.5, v.y - 0.5, v.z - 0.5));
          max.max(new Vector3(v.x + 0.5, v.y + 0.5, v.z + 0.5));
        }
        min.sub(new Vector3(...a.pivot)).multiplyScalar(a.voxelSize);
        max.sub(new Vector3(...a.pivot)).multiplyScalar(a.voxelSize);
      } else {
        min.set(-0.5, -0.5, -0.5);
        max.set(0.5, 0.5, 0.5);
      }
    }
    return new Box3(min, max).applyMatrix4(this.worldMatrix(node));
  }
  emit(type: string, nodeId?: string, data?: unknown) {
    this.events.push({ frame: this.frame, type, nodeId, data });
    if (this.events.length > 200) this.events.shift();
  }
  private dispatch(node: SceneNode, event: Rule['event'], marker?: string) {
    const c = this.component(node, 'rules');
    if (!c) return;
    for (let i = 0; i < c.rules.length; i++) {
      const rule = c.rules[i],
        key = `${node.id}:${i}`;
      if (
        rule.event !== event ||
        (rule.marker && rule.marker !== marker) ||
        (rule.once && this.fired.has(key))
      )
        continue;
      if (event === 'tick' && this.frame < (this.timers.get(key) ?? 0)) continue;
      if (rule.condition) {
        const c = rule.condition,
          v = this.variables[c.variable] ?? 0;
        const pass =
          c.op === '>='
            ? v >= c.value
            : c.op === '<='
              ? v <= c.value
              : c.op === '=='
                ? v === c.value
                : c.op === '>'
                  ? v > c.value
                  : v < c.value;
        if (!pass) continue;
      }
      this.fired.add(key);
      this.timers.set(key, this.frame + Math.ceil(rule.interval / FIXED_DELTA));
      for (const action of rule.actions) {
        if (--this.actionBudget < 0)
          throw new Error('Gameplay exceeded 4096 actions in a single simulation step.');
        const target = 'target' in action && action.target ? this.nodes.get(action.target) : node;
        switch (action.type) {
          case 'set':
            this.variables[action.variable] = action.value;
            break;
          case 'add':
            this.variables[action.variable] = (this.variables[action.variable] ?? 0) + action.value;
            break;
          case 'destroy':
            if (target) this.destroy(target);
            break;
          case 'enable':
            if (target) target.enabled = action.value;
            break;
          case 'message':
            this.message = action.text;
            this.emit('message', node.id, action.text);
            break;
          case 'win':
            this.status = 'won';
            this.emit('won', node.id);
            break;
          case 'lose':
            this.status = 'lost';
            this.emit('lost', node.id);
            break;
          case 'damage':
            if (target) this.damage(target, action.amount);
            break;
          case 'teleport':
            if (target) this.setWorldPosition(target, new Vector3(...action.position));
            break;
        }
      }
    }
  }
  private destroy(node: SceneNode) {
    if (!node.enabled) return;
    node.enabled = false;
    this.emit('destroyed', node.id);
    if (this.component(node, 'enemy')) this.variables.kills = (this.variables.kills ?? 0) + 1;
    this.dispatch(node, 'destroyed');
  }
  private damage(node: SceneNode, amount: number) {
    if (this.health[node.id] === undefined || !this.enabled(node)) return;
    this.health[node.id] = Math.max(0, this.health[node.id] - amount);
    this.emit('damage', node.id, { amount, remaining: this.health[node.id] });
    if (!this.health[node.id]) {
      this.destroy(node);
      if (this.component(node, 'player')) {
        this.status = 'lost';
        this.emit('lost', node.id);
      }
    }
  }
  private move(node: SceneNode, delta: Vector3): boolean {
    const steps = Math.max(1, Math.ceil(delta.length() / 0.2)),
      step = delta.clone().divideScalar(steps);
    let grounded = false;
    for (let n = 0; n < steps; n++)
      for (const axis of ['x', 'z', 'y'] as const) {
        if (!step[axis]) continue;
        const position = this.worldPosition(node);
        position[axis] += step[axis];
        this.setWorldPosition(node, position);
        let box = this.bounds(node);
        const offset = new Vector3();
        if (axis === 'y' && box.min.y < 0) {
          offset.y = -box.min.y;
          grounded = true;
          this.velocities.set(node.id, 0);
        }
        if (axis !== 'y') {
          const bound = this.scene.bounds;
          if (box.min[axis] < -bound) offset[axis] = -bound - box.min[axis];
          if (box.max[axis] > bound) offset[axis] = bound - box.max[axis];
        }
        for (const other of this.nodes.values()) {
          if (
            other.id === node.id ||
            !this.enabled(other) ||
            !this.component(other, 'collider')?.solid ||
            this.component(other, 'player') ||
            this.component(other, 'enemy')
          )
            continue;
          const solid = this.bounds(other);
          box = this.bounds(node);
          if (
            box.max.x <= solid.min.x + 1e-5 ||
            box.min.x >= solid.max.x - 1e-5 ||
            box.max.y <= solid.min.y + 1e-5 ||
            box.min.y >= solid.max.y - 1e-5 ||
            box.max.z <= solid.min.z + 1e-5 ||
            box.min.z >= solid.max.z - 1e-5
          )
            continue;
          const adjustment =
            step[axis] > 0 ? solid.min[axis] - box.max[axis] : solid.max[axis] - box.min[axis];
          offset[axis] += adjustment;
          if (axis === 'y') {
            if (step.y < 0) grounded = true;
            this.velocities.set(node.id, 0);
          }
        }
        this.setWorldPosition(node, this.worldPosition(node).add(offset));
      }
    return grounded;
  }
  step(input: GameInput = {}) {
    if (this.status !== 'playing') return;
    this.actionBudget = 4096;
    this.frame++;
    this.moving.clear();
    this.attackCooldown = Math.max(0, this.attackCooldown - FIXED_DELTA);
    this.damageCooldown = Math.max(0, this.damageCooldown - FIXED_DELTA);
    try {
      const player = [...this.nodes.values()].find((n) => this.component(n, 'player') && this.enabled(n));
      for (const node of this.nodes.values()) if (this.enabled(node)) this.dispatch(node, 'tick');
      if (player) {
        const c = this.component(player, 'player')!,
          direction = new Vector3(input.moveX ?? 0, 0, input.moveZ ?? 0);
        if (!Number.isFinite(direction.lengthSq())) throw new Error('Input axes must be finite.');
        if (direction.length() > 1) direction.normalize();
        if (direction.lengthSq() > 0.0001) {
          this.moving.add(player.id);
          player.transform.rotation[1] = Math.atan2(-direction.x, -direction.z);
        }
        let vy = this.velocities.get(player.id) ?? 0;
        const ground = this.bounds(player).min.y <= 0.02 || this.grounded(player);
        if (input.jump && !this.previous.jump && ground) vy = c.jump;
        vy = Math.max(-50, vy - 18 * FIXED_DELTA);
        this.velocities.set(player.id, vy);
        this.move(player, direction.multiplyScalar(c.speed * FIXED_DELTA).setY(vy * FIXED_DELTA));
        if (input.interact && !this.previous.interact)
          for (const n of this.nodes.values())
            if (
              n.id !== player.id &&
              this.enabled(n) &&
              this.worldPosition(n).distanceTo(this.worldPosition(player)) < 3
            )
              this.dispatch(n, 'interact');
        if (input.attack && !this.previous.attack && this.attackCooldown === 0) {
          this.attackCooldown = 0.35;
          this.dispatch(player, 'attack');
          for (const n of this.nodes.values())
            if (
              this.enabled(n) &&
              this.component(n, 'enemy') &&
              this.worldPosition(n).distanceTo(this.worldPosition(player)) < 3
            )
              this.damage(n, 25);
          this.emit('attack', player.id);
        }
        for (const n of this.nodes.values()) {
          if (n.id === player.id || !this.enabled(n)) continue;
          const enemy = this.component(n, 'enemy');
          if (enemy) {
            const d = this.worldPosition(player).sub(this.worldPosition(n));
            d.y = 0;
            const distance = d.length();
            if (distance > 0.1) {
              this.move(n, d.normalize().multiplyScalar(enemy.speed * FIXED_DELTA));
              this.moving.add(n.id);
              n.transform.rotation[1] = Math.atan2(-d.x, -d.z);
            }
            if (distance < enemy.range && this.damageCooldown === 0) {
              this.damage(player, enemy.damage);
              this.damageCooldown = 0.8;
            }
          }
          if (this.bounds(n).intersectsBox(this.bounds(player))) {
            const item = this.component(n, 'collectible');
            if (item) {
              this.variables[item.variable] = (this.variables[item.variable] ?? 0) + item.amount;
              n.enabled = false;
              this.emit('collected', n.id, { variable: item.variable, amount: item.amount });
            }
            this.dispatch(n, 'touch');
          }
        }
      }
      for (const n of this.nodes.values()) {
        const patrol = this.component(n, 'patrol');
        if (!patrol || !this.enabled(n)) continue;
        const key = `patrol:${n.id}`;
        let i = this.timers.get(key) ?? 0;
        const d = new Vector3(...patrol.points[i]).sub(this.worldPosition(n));
        if (d.length() < 0.1) {
          i = (i + 1) % patrol.points.length;
          this.timers.set(key, i);
        } else {
          this.move(n, d.normalize().multiplyScalar(patrol.speed * FIXED_DELTA));
          this.moving.add(n.id);
        }
      }
      for (const node of this.nodes.values()) {
        if (!this.enabled(node) || !node.assetId) continue;
        const rig = this.assets.get(node.assetId)?.rig;
        if (!rig) continue;
        const settings = this.component(node, 'animation'),
          moving = this.moving.has(node.id),
          name = moving ? (settings?.moving ?? 'walk') : (settings?.idle ?? 'idle');
        const clip = rig.clips.find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (!clip) continue;
        const previous = this.animationTimes.get(node.id),
          start = previous?.clip === clip.name ? previous.time : 0;
        const speed =
          this.component(node, 'player')?.speed ??
          this.component(node, 'enemy')?.speed ??
          this.component(node, 'patrol')?.speed ??
          3;
        const end = start + FIXED_DELTA * (moving && clip.speed > 0 ? speed / clip.speed : 1);
        for (const marker of clip.events) {
          const first = Math.floor((start - marker.time) / clip.duration) + 1,
            last = clip.loop
              ? Math.floor((end - marker.time) / clip.duration)
              : start < marker.time && end >= marker.time
                ? first
                : first - 1;
          if (last >= first) {
            this.emit('animation', node.id, { clip: clip.name, marker: marker.name });
            this.dispatch(node, 'animation', marker.name);
          }
        }
        this.animationTimes.set(node.id, {
          clip: clip.name,
          time: clip.loop ? end : Math.min(end, clip.duration),
        });
      }
      for (const value of Object.values(this.variables))
        if (!Number.isFinite(value)) throw new Error('Gameplay produced a non-finite variable.');
      this.previous = { ...input };
    } catch (e) {
      this.errors.push((e as Error).message);
      this.status = 'stopped';
      this.emit('error', undefined, (e as Error).message);
    }
  }
  animationState(id: string) {
    return this.animationTimes.get(id);
  }
  private grounded(node: SceneNode) {
    const box = this.bounds(node);
    return [...this.nodes.values()].some(
      (n) =>
        n.id !== node.id &&
        this.enabled(n) &&
        this.component(n, 'collider')?.solid &&
        (() => {
          const b = this.bounds(n);
          return (
            Math.abs(box.min.y - b.max.y) < 0.03 &&
            box.max.x > b.min.x &&
            box.min.x < b.max.x &&
            box.max.z > b.min.z &&
            box.min.z < b.max.z
          );
        })(),
    );
  }
  inspect() {
    return {
      frame: this.frame,
      seconds: this.frame * FIXED_DELTA,
      status: this.status,
      message: this.message,
      variables: { ...this.variables },
      health: { ...this.health },
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        enabled: this.enabled(n),
        position: this.worldPosition(n).toArray(),
      })),
      events: [...this.events],
      errors: [...this.errors],
    };
  }
}
