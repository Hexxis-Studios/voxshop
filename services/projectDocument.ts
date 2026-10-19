import { z } from 'zod';
import { createModelDocument, type ModelDocument } from './modelDocument';
import { applyVoxelCommand, createVoxelEdit, type VoxelEdit } from './modelCommands';
import { generateRecipe, recipeSchema } from './recipeGenerator';
import { generateCharacter, fitEquipment } from './assetAssembly';

export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const label = z.string().trim().min(1).max(120);
const finite = z.number().finite().min(-100000).max(100000);
export const vectorSchema = z.tuple([finite, finite, finite]);
export const transformSchema = z.object({
  position: vectorSchema.default([0, 0, 0]),
  rotation: vectorSchema.default([0, 0, 0]),
  scale: z
    .tuple([
      z.number().positive().max(1000),
      z.number().positive().max(1000),
      z.number().positive().max(1000),
    ])
    .default([1, 1, 1]),
});
export type Transform = z.infer<typeof transformSchema>;
export const identityTransform = (): Transform => transformSchema.parse({});
export const rigSchema = z.object({
  profile: idSchema,
  version: z.literal(1),
  joints: z
    .array(z.object({ name: idSchema, parent: idSchema.nullable(), position: vectorSchema }))
    .min(1)
    .max(128),
  landmarks: z.record(idSchema, vectorSchema).default({}),
  sockets: z
    .array(z.object({ name: idSchema, joint: idSchema, transform: transformSchema }))
    .max(64)
    .default([]),
  clips: z
    .array(
      z.object({
        name: idSchema,
        duration: z.number().positive().max(3600),
        loop: z.boolean().default(true),
        speed: z.number().nonnegative().max(1000).default(0),
        tracks: z
          .array(
            z.object({
              joint: idSchema,
              keys: z
                .array(
                  z.object({
                    time: z.number().nonnegative(),
                    rotation: vectorSchema,
                    position: vectorSchema.optional(),
                  }),
                )
                .min(1)
                .max(2048),
            }),
          )
          .max(128),
        events: z
          .array(z.object({ time: z.number().nonnegative(), name: idSchema }))
          .max(256)
          .default([]),
      }),
    )
    .max(64)
    .default([]),
});
export type Rig = z.infer<typeof rigSchema>;
export const attachmentSchema = z.object({
  assetId: idSchema,
  socket: idSchema,
  transform: transformSchema,
  slot: idSchema,
  hiddenBones: z.array(idSchema).default([]),
});

// A bounded event/action language is also the custom-logic extension API. No eval or shell.
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set'), variable: idSchema, value: z.number().finite() }),
  z.object({ type: z.literal('add'), variable: idSchema, value: z.number().finite() }),
  z.object({ type: z.literal('destroy'), target: idSchema.optional() }),
  z.object({ type: z.literal('enable'), target: idSchema, value: z.boolean() }),
  z.object({ type: z.literal('message'), text: z.string().max(500) }),
  z.object({ type: z.literal('win') }),
  z.object({ type: z.literal('lose') }),
  z.object({
    type: z.literal('damage'),
    target: idSchema.optional(),
    amount: z.number().positive().max(10000),
  }),
  z.object({ type: z.literal('teleport'), target: idSchema.optional(), position: vectorSchema }),
]);
export const ruleSchema = z.object({
  event: z.enum(['start', 'interact', 'touch', 'tick', 'destroyed', 'attack', 'animation']),
  marker: idSchema.optional(),
  interval: z.number().min(0.05).max(3600).default(1),
  once: z.boolean().default(false),
  condition: z
    .object({ variable: idSchema, op: z.enum(['>=', '<=', '==', '>', '<']), value: z.number().finite() })
    .optional(),
  actions: z.array(actionSchema).min(1).max(32),
});
export const componentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('player'),
    style: z.enum(['third-person', 'top-down']),
    speed: z.number().positive().max(100),
    jump: z.number().nonnegative().max(100).default(6),
  }),
  z.object({
    type: z.literal('collider'),
    size: vectorSchema,
    offset: vectorSchema.default([0, 0, 0]),
    solid: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('collectible'),
    variable: idSchema.default('score'),
    amount: z.number().finite().default(1),
  }),
  z.object({ type: z.literal('gate'), variable: idSchema, required: z.number().finite() }),
  z.object({ type: z.literal('health'), maximum: z.number().positive().max(100000) }),
  z.object({
    type: z.literal('enemy'),
    speed: z.number().positive().max(100),
    damage: z.number().positive().max(10000),
    range: z.number().positive().max(1000).default(1.5),
  }),
  z.object({
    type: z.literal('patrol'),
    points: z.array(vectorSchema).min(2).max(100),
    speed: z.number().positive().max(100),
  }),
  z.object({ type: z.literal('rules'), apiVersion: z.literal(1), rules: z.array(ruleSchema).max(64) }),
  z.object({ type: z.literal('animation'), idle: idSchema, moving: idSchema }),
]);
export type Component = z.infer<typeof componentSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export const nodeSchema = z.object({
  id: idSchema,
  name: label,
  assetId: idSchema.nullable().default(null),
  parentId: idSchema.nullable().default(null),
  transform: transformSchema,
  enabled: z.boolean().default(true),
  components: z.array(componentSchema).max(16).default([]),
  attachments: z.array(attachmentSchema).max(16).default([]),
});
export type SceneNode = z.infer<typeof nodeSchema>;
export const sceneSchema = z.object({
  id: idSchema,
  name: label,
  nodes: z.array(nodeSchema).max(5000).default([]),
  background: z.number().int().min(0).max(0xffffff).default(0x111827),
  groundColor: z.number().int().min(0).max(0xffffff).default(0x334155),
  bounds: z.number().positive().max(10000).default(40),
  variables: z.record(idSchema, z.number().finite()).default({}),
  instructions: z
    .string()
    .max(2000)
    .default('WASD / arrows to move. Space to jump. E to interact. Click or F to attack.'),
});
export type GameScene = z.infer<typeof sceneSchema>;
const modelSchema = z.unknown().transform((v, ctx): ModelDocument => {
  try {
    if (!v || typeof v !== 'object' || (v as any).format !== 'voxshop-model' || (v as any).version !== 1)
      throw new Error('Invalid model envelope.');
    const model = createModelDocument((v as any).voxels, (v as any).skeleton);
    if (model.voxels.length > 250000) throw new Error('An asset may contain at most 250,000 voxels.');
    return model;
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});
export const assetSchema = z.object({
  id: idSchema,
  name: label,
  model: modelSchema,
  voxelSize: z.number().positive().min(0.001).max(100).default(0.1),
  pivot: vectorSchema.default([0, 0, 0]),
  rig: rigSchema.nullable().default(null),
  recipe: recipeSchema.optional(),
  source: z
    .object({
      kind: z.enum(['authored', 'generated', 'imported']),
      description: z.string().max(2000).default(''),
      seed: z.number().int().optional(),
    })
    .default({ kind: 'authored', description: '' }),
  variantOf: idSchema.optional(),
  equipment: z
    .object({
      bodyAssetId: idSchema,
      profile: idSchema,
      profileVersion: z.literal(1),
      kind: z.enum(['shell', 'backpack', 'blade']),
      socket: idSchema,
      hiddenBones: z.array(idSchema),
    })
    .optional(),
});
export type Asset = z.infer<typeof assetSchema>;
export const projectSchema = z.object({
  format: z.literal('voxshop-project'),
  version: z.literal(1),
  id: idSchema,
  name: label,
  revision: z.number().int().nonnegative(),
  units: z.literal('meters'),
  upAxis: z.literal('Y'),
  assets: z.array(assetSchema).max(1000),
  scenes: z.array(sceneSchema).min(1).max(100),
  activeSceneId: idSchema,
  activeAssetId: idSchema.nullable(),
  editorDraft: modelSchema.nullable(),
});
export type ProjectDocument = z.infer<typeof projectSchema>;

function unique(values: string[], what: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${what} ID.`);
}
function hierarchy(entries: { name: string; parent: string | null }[], what: string) {
  unique(
    entries.map((e) => e.name),
    what,
  );
  const parents = new Map(entries.map((e) => [e.name, e.parent]));
  for (const e of entries) {
    let next: string | null = e.name;
    const seen = new Set<string>();
    while (next !== null) {
      if (!parents.has(next) || seen.has(next))
        throw new Error(`${what} hierarchy has a missing parent or cycle.`);
      seen.add(next);
      if (seen.size > 128) throw new Error(`${what} hierarchy exceeds 128 levels.`);
      next = parents.get(next)!;
    }
  }
}
export function validateProject(value: unknown): ProjectDocument {
  const p = projectSchema.parse(value);
  unique(
    p.assets.map((a) => a.id),
    'asset',
  );
  unique(
    p.scenes.map((s) => s.id),
    'scene',
  );
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  if (
    !p.scenes.some((s) => s.id === p.activeSceneId) ||
    (p.activeAssetId !== null && !assets.has(p.activeAssetId))
  )
    throw new Error('Active selection is missing.');
  if (p.assets.reduce((n, a) => n + a.model.voxels.length, 0) > 1000000)
    throw new Error('Project exceeds one million voxels.');
  for (const a of p.assets) {
    if (a.variantOf && (!assets.has(a.variantOf) || a.variantOf === a.id))
      throw new Error('Missing or invalid variant source.');
    if (a.equipment && !assets.has(a.equipment.bodyAssetId))
      throw new Error('Equipment body asset is missing.');
    if (!a.rig) continue;
    hierarchy(a.rig.joints, 'joint');
    const joints = new Set(a.rig.joints.map((j) => j.name));
    unique(
      a.rig.sockets.map((s) => s.name),
      'socket',
    );
    unique(
      a.rig.clips.map((c) => c.name),
      'clip',
    );
    if (a.rig.sockets.some((s) => !joints.has(s.joint)))
      throw new Error('Socket references a missing joint.');
    for (const c of a.rig.clips) {
      if (
        c.tracks.some((t) => !joints.has(t.joint) || t.keys.some((k) => k.time > c.duration)) ||
        c.events.some((e) => e.time > c.duration)
      )
        throw new Error('Invalid animation joint or key time.');
    }
    for (const v of a.model.voxels) {
      if (v.weights && v.weights.length > 4)
        throw new Error('Rigged voxels support up to four skin weights.');
      if ((v.bone && !joints.has(v.bone)) || v.weights?.some((w) => !joints.has(w.bone)))
        throw new Error('Voxel references a joint absent from its rig.');
      if (v.weights?.length && Math.abs(v.weights.reduce((s, w) => s + w.weight, 0) - 1) > 0.001)
        throw new Error('Skin weights must sum to one.');
    }
  }
  for (const scene of p.scenes) {
    if (scene.nodes.filter((n) => n.components.some((c) => c.type === 'player')).length > 1)
      throw new Error('A scene supports one player controller.');
    hierarchy(
      scene.nodes.map((n) => ({ name: n.id, parent: n.parentId })),
      'node',
    );
    const ids = new Set(scene.nodes.map((n) => n.id));
    for (const node of scene.nodes) {
      if (node.assetId && !assets.has(node.assetId)) throw new Error(`Missing asset on ${node.id}.`);
      unique(
        node.components.map((c) => c.type),
        'component',
      );
      const body = node.assetId && assets.get(node.assetId);
      unique(
        node.attachments.map((a) => a.slot),
        'equipment slot',
      );
      for (const a of node.attachments) {
        if (!assets.has(a.assetId) || !body || !body.rig?.sockets.some((s) => s.name === a.socket))
          throw new Error(`Invalid attachment on ${node.id}.`);
        if (a.hiddenBones.some((b) => !body.rig!.joints.some((j) => j.name === b)))
          throw new Error('Equipment mask references a missing bone.');
        const item = assets.get(a.assetId)!;
        if (
          item.equipment &&
          (item.equipment.bodyAssetId !== body.id || item.equipment.profile !== body.rig!.profile)
        )
          throw new Error('Equipment was fitted to a different body.');
        if (item.equipment && item.equipment.socket !== a.socket)
          throw new Error('Fitted equipment must use its declared socket.');
        if (
          item.equipment &&
          item.rig &&
          JSON.stringify(item.rig.joints) !== JSON.stringify(body.rig!.joints)
        )
          throw new Error('Body rig changed. Refit the equipment before attaching it.');
      }
      for (const c of node.components) {
        if (c.type === 'collider' && c.size.some((n) => n <= 0))
          throw new Error('Collider dimensions must be positive.');
        if (c.type === 'rules')
          for (const r of c.rules)
            for (const a of r.actions) {
              if ('target' in a && a.target && !ids.has(a.target))
                throw new Error('Rule references a missing node.');
            }
      }
    }
  }
  return p;
}
export function newProject(id: string, name: string): ProjectDocument {
  return validateProject({
    format: 'voxshop-project',
    version: 1,
    id,
    name,
    revision: 0,
    units: 'meters',
    upAxis: 'Y',
    assets: [],
    scenes: [{ id: 'main', name: 'Main scene' }],
    activeSceneId: 'main',
    activeAssetId: null,
    editorDraft: null,
  });
}

export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project.rename'), name: label }),
  z.object({ type: z.literal('asset.put'), asset: assetSchema }),
  z.object({ type: z.literal('asset.rename'), id: idSchema, name: label }),
  z.object({ type: z.literal('asset.delete'), id: idSchema }),
  z.object({
    type: z.literal('asset.generate'),
    id: idSchema,
    name: label,
    recipe: recipeSchema,
    voxelSize: z.number().positive().max(100).default(0.1),
  }),
  z.object({
    type: z.literal('asset.character'),
    id: idSchema,
    name: label,
    profile: z.enum(['biped', 'quadruped', 'machine']),
    height: z.number().min(12).max(80).default(24),
    width: z.number().min(6).max(30).default(10),
    color: z.number().int().min(0).max(0xffffff).default(0xe78b43),
    accent: z.number().int().min(0).max(0xffffff).default(0xf4d7b6),
  }),
  z.object({
    type: z.literal('equipment.fit'),
    bodyId: idSchema,
    id: idSchema,
    name: label,
    kind: z.enum(['shell', 'backpack', 'blade']),
    color: z.number().int().min(0).max(0xffffff).default(0x38bdf8),
  }),
  z.object({
    type: z.literal('asset.edit'),
    id: idSchema,
    edit: z.object({
      mode: z.enum(['add', 'delete', 'paint', 'lock', 'fill']),
      targets: z.array(z.object({ x: finite, y: finite, z: finite })).max(250000),
      color: z.number().int().min(0).max(0xffffff).optional(),
      materialType: z.enum(['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE']).optional(),
    }),
  }),
  z.object({ type: z.literal('asset.variant'), sourceId: idSchema, id: idSchema, name: label }),
  z.object({ type: z.literal('scene.put'), scene: sceneSchema }),
  z.object({ type: z.literal('scene.delete'), id: idSchema }),
  z.object({ type: z.literal('node.put'), sceneId: idSchema, node: nodeSchema }),
  z.object({ type: z.literal('node.delete'), sceneId: idSchema, id: idSchema }),
  z.object({
    type: z.literal('editor.set'),
    sceneId: idSchema.optional(),
    assetId: idSchema.nullable().optional(),
    draft: modelSchema.nullable().optional(),
  }),
]);
export type ProjectOperation = z.input<typeof operationSchema>;
export const transactionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  requestId: idSchema,
  label: label.default('Edit project'),
  operations: z.array(operationSchema).min(1).max(256),
});

/** Transaction: apply to a detached document; validate all references before committing anything. */
export function applyProjectOperations(input: ProjectDocument, operations: unknown[]): ProjectDocument {
  const p = structuredClone(input);
  const asset = (id: string) => {
    const a = p.assets.find((a) => a.id === id);
    if (!a) throw new Error(`Asset ${id} does not exist.`);
    return a;
  };
  const scene = (id: string) => {
    const s = p.scenes.find((s) => s.id === id);
    if (!s) throw new Error(`Scene ${id} does not exist.`);
    return s;
  };
  for (const raw of operations) {
    const op = operationSchema.parse(raw);
    switch (op.type) {
      case 'project.rename':
        p.name = op.name;
        break;
      case 'asset.put': {
        const i = p.assets.findIndex((a) => a.id === op.asset.id);
        if (i < 0) p.assets.push(op.asset);
        else p.assets[i] = op.asset;
        if (p.activeAssetId === op.asset.id) p.editorDraft = structuredClone(op.asset.model);
        break;
      }
      case 'asset.rename':
        asset(op.id).name = op.name;
        break;
      case 'asset.delete':
        asset(op.id);
        p.assets = p.assets.filter((a) => a.id !== op.id);
        if (p.activeAssetId === op.id) {
          p.activeAssetId = null;
          p.editorDraft = null;
        }
        break;
      case 'asset.generate':
        if (p.assets.some((a) => a.id === op.id))
          throw new Error('Generate uses a new ID; create a variant to preserve edits.');
        p.assets.push(
          assetSchema.parse({
            id: op.id,
            name: op.name,
            model: createModelDocument(generateRecipe(op.recipe)),
            voxelSize: op.voxelSize,
            recipe: op.recipe,
            source: { kind: 'generated', description: 'VoxShop recipe v1', seed: op.recipe.seed },
          }),
        );
        break;
      case 'asset.character':
        if (p.assets.some((a) => a.id === op.id)) throw new Error('Asset ID already exists.');
        p.assets.push(assetSchema.parse(generateCharacter(op)));
        break;
      case 'equipment.fit':
        if (p.assets.some((a) => a.id === op.id)) throw new Error('Equipment ID already exists.');
        p.assets.push(assetSchema.parse(fitEquipment(asset(op.bodyId), op)));
        break;
      case 'asset.edit': {
        const a = asset(op.id);
        a.model.voxels = applyVoxelCommand(
          a.model.voxels,
          createVoxelEdit(a.model.voxels, op.edit as VoxelEdit),
        );
        if (p.activeAssetId === op.id) p.editorDraft = structuredClone(a.model);
        break;
      }
      case 'asset.variant':
        if (p.assets.some((a) => a.id === op.id)) throw new Error('Variant ID already exists.');
        p.assets.push({
          ...structuredClone(asset(op.sourceId)),
          id: op.id,
          name: op.name,
          variantOf: op.sourceId,
        });
        break;
      case 'scene.put': {
        const i = p.scenes.findIndex((s) => s.id === op.scene.id);
        if (i < 0) p.scenes.push(op.scene);
        else p.scenes[i] = op.scene;
        break;
      }
      case 'scene.delete':
        scene(op.id);
        p.scenes = p.scenes.filter((s) => s.id !== op.id);
        if (p.activeSceneId === op.id) p.activeSceneId = p.scenes[0]?.id;
        break;
      case 'node.put': {
        const s = scene(op.sceneId);
        const i = s.nodes.findIndex((n) => n.id === op.node.id);
        if (i < 0) s.nodes.push(op.node);
        else s.nodes[i] = op.node;
        break;
      }
      case 'node.delete': {
        const s = scene(op.sceneId);
        if (!s.nodes.some((n) => n.id === op.id)) throw new Error('Node does not exist.');
        const removed = new Set([op.id]);
        let size = 0;
        while (removed.size !== size) {
          size = removed.size;
          for (const n of s.nodes) if (n.parentId && removed.has(n.parentId)) removed.add(n.id);
        }
        s.nodes = s.nodes.filter((n) => !removed.has(n.id));
        break;
      }
      case 'editor.set':
        if (op.sceneId !== undefined) p.activeSceneId = op.sceneId;
        if (op.assetId !== undefined) p.activeAssetId = op.assetId;
        if (op.draft !== undefined) p.editorDraft = op.draft;
        break;
    }
  }
  p.revision++;
  return validateProject(p);
}

export function projectSummary(p: ProjectDocument) {
  return {
    id: p.id,
    name: p.name,
    revision: p.revision,
    activeSceneId: p.activeSceneId,
    activeAssetId: p.activeAssetId,
    assets: p.assets.map((a) => ({
      id: a.id,
      name: a.name,
      voxels: a.model.voxels.length,
      voxelSize: a.voxelSize,
      rig: a.rig?.profile ?? null,
    })),
    scenes: p.scenes.map((s) => ({ id: s.id, name: s.name, nodes: s.nodes.length })),
  };
}
