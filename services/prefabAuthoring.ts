import type { Prefab, SceneNode } from './projectDocument';

type SceneNodes = { id: string; nodes: SceneNode[] }[];

export function createPrefabFromSubtree(
  sceneNodes: SceneNode[],
  rootId: string,
  id: string,
  name: string,
): Prefab {
  if (!sceneNodes.some((node) => node.id === rootId)) throw new Error('Prefab root node does not exist.');
  const included = new Set([rootId]);
  let previousSize = -1;
  while (included.size !== previousSize) {
    previousSize = included.size;
    for (const node of sceneNodes) if (node.parentId && included.has(node.parentId)) included.add(node.id);
  }
  const root = sceneNodes.find((node) => node.id === rootId)!;
  return {
    id,
    name,
    rootId,
    attachmentParentId: root.parentId,
    nodes: sceneNodes
      .filter((node) => included.has(node.id))
      .map((node) => ({
        ...structuredClone(node),
        parentId: node.id === rootId ? null : node.parentId,
        scatterGroupId: null,
        prefabLink: undefined,
      })),
  };
}

/** Builds a prefab update from one of its placed instances, preserving source IDs for linked nodes. */
export function createPrefabFromInstance(
  sceneNodes: SceneNode[],
  instanceRootId: string,
  source: Prefab,
): { prefab: Prefab; sourceInstanceNodeIds: Record<string, string> } {
  const root = sceneNodes.find((node) => node.id === instanceRootId);
  if (
    !root?.prefabLink ||
    root.prefabLink.instanceId !== root.id ||
    root.prefabLink.prefabId !== source.id ||
    root.prefabLink.sourceNodeId !== source.rootId
  )
    throw new Error('Select a node from an instance of this prefab.');

  const included = new Set([instanceRootId]);
  let previousSize = -1;
  while (included.size !== previousSize) {
    previousSize = included.size;
    for (const node of sceneNodes) if (node.parentId && included.has(node.parentId)) included.add(node.id);
  }
  const linked = new Map(
    sceneNodes
      .filter((node) => included.has(node.id) && node.prefabLink?.instanceId === instanceRootId)
      .map((node) => [node.id, node.prefabLink!.sourceNodeId]),
  );
  linked.set(instanceRootId, source.rootId);
  const sourceIds = new Map<string, string>();
  const used = new Set<string>();
  for (const node of sceneNodes.filter((entry) => included.has(entry.id))) {
    let sourceId = linked.get(node.id) ?? node.id;
    if (used.has(sourceId)) {
      const base = `node_${shortHash(`${instanceRootId}:${node.id}`)}`;
      let suffix = 2;
      sourceId = base;
      while (used.has(sourceId)) sourceId = `${base}_${suffix++}`;
    }
    used.add(sourceId);
    sourceIds.set(node.id, sourceId);
  }
  const sourceRootId = sourceIds.get(instanceRootId)!;
  const nodes = sceneNodes
    .filter((node) => included.has(node.id))
    .map((node) => {
      const clone = structuredClone(node);
      const oldId = clone.id;
      clone.id = sourceIds.get(oldId)!;
      clone.parentId = oldId === instanceRootId ? null : (sourceIds.get(node.parentId!) ?? node.parentId);
      clone.scatterGroupId = null;
      delete clone.prefabLink;
      clone.components = clone.components.map((component) => {
        if (component.type === 'joint')
          return {
            ...component,
            connectedNodeId: sourceIds.get(component.connectedNodeId) ?? component.connectedNodeId,
          };
        if (component.type !== 'rules') return component;
        return {
          ...component,
          rules: component.rules.map((rule) => ({
            ...rule,
            actions: rule.actions.map((action) =>
              'target' in action && action.target
                ? { ...action, target: sourceIds.get(action.target) ?? action.target }
                : action,
            ),
          })),
        };
      });
      return clone;
    });
  return {
    prefab: {
      id: source.id,
      name: source.name,
      rootId: sourceRootId,
      attachmentParentId: root.parentId,
      nodes,
    },
    sourceInstanceNodeIds: Object.fromEntries(
      [...sourceIds].map(([sceneId, sourceId]) => [sourceId, sceneId]),
    ),
  };
}

export function instantiatePrefabNodes(
  prefab: Prefab,
  nodeIds: string[],
  options: {
    rootName?: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    rootParentId?: string | null;
  } = {},
): SceneNode[] {
  if (nodeIds.length !== prefab.nodes.length)
    throw new Error('Prefab instantiation needs one new node ID for each saved prefab node.');
  if (new Set(nodeIds).size !== nodeIds.length)
    throw new Error('Prefab instantiation needs unique node IDs.');
  const ids = new Map(prefab.nodes.map((node, index) => [node.id, nodeIds[index]]));
  return prefab.nodes.map((source) => {
    const clone = structuredClone(source);
    clone.id = ids.get(source.id)!;
    clone.scatterGroupId = null;
    clone.parentId = source.parentId
      ? ids.get(source.parentId)!
      : Object.hasOwn(options, 'rootParentId')
        ? (options.rootParentId ?? null)
        : prefab.attachmentParentId;
    if (source.id === prefab.rootId) {
      clone.name = options.rootName ?? clone.name;
      if (options.position) clone.transform.position = [...options.position];
      if (options.rotation) clone.transform.rotation = [...options.rotation];
      if (options.scale) clone.transform.scale = [...options.scale];
    }
    clone.components = clone.components.map((component) => {
      if (component.type === 'joint' && ids.has(component.connectedNodeId))
        return { ...component, connectedNodeId: ids.get(component.connectedNodeId)! };
      if (component.type !== 'rules') return component;
      return {
        ...component,
        rules: component.rules.map((rule) => ({
          ...rule,
          actions: rule.actions.map((action) =>
            'target' in action && action.target && ids.has(action.target)
              ? { ...action, target: ids.get(action.target)! }
              : action,
          ),
        })),
      };
    });
    return clone;
  });
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function linkedNodeId(instanceId: string, sourceNodeId: string, used: Set<string>) {
  const base = `pf_${shortHash(`${instanceId}:${sourceNodeId}`)}`;
  let id = base,
    suffix = 2;
  while (used.has(id)) id = `${base}_${suffix++}`;
  used.add(id);
  return id;
}

function shortHash(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function hasOverrides(actual: SceneNode, baseline: SceneNode) {
  return (
    actual.name !== baseline.name ||
    actual.assetId !== baseline.assetId ||
    actual.parentId !== baseline.parentId ||
    actual.enabled !== baseline.enabled ||
    !same(actual.scatterGroupId, baseline.scatterGroupId) ||
    !same(actual.components, baseline.components) ||
    !same(actual.attachments, baseline.attachments) ||
    (['position', 'rotation', 'scale'] as const).some((axis) =>
      actual.transform[axis].some((value, index) => value !== baseline.transform[axis][index]),
    )
  );
}

function mergeLinkedNode(
  actual: SceneNode,
  previous: SceneNode,
  next: SceneNode,
  link: NonNullable<SceneNode['prefabLink']>,
  force: boolean,
  preservePosition: boolean,
): SceneNode {
  const merged = structuredClone(next);
  merged.id = actual.id;
  merged.prefabLink = link;
  if (!force && actual.name !== previous.name) merged.name = actual.name;
  if (!force && actual.assetId !== previous.assetId) merged.assetId = actual.assetId;
  if (!force && actual.parentId !== previous.parentId) merged.parentId = actual.parentId;
  if (!force && actual.enabled !== previous.enabled) merged.enabled = actual.enabled;
  if (!force && !same(actual.scatterGroupId, previous.scatterGroupId))
    merged.scatterGroupId = actual.scatterGroupId;
  if (!force && !same(actual.components, previous.components))
    merged.components = structuredClone(actual.components);
  if (!force && !same(actual.attachments, previous.attachments))
    merged.attachments = structuredClone(actual.attachments);
  for (const axis of ['position', 'rotation', 'scale'] as const) {
    if (!force && actual.transform[axis].some((value, index) => value !== previous.transform[axis][index]))
      merged.transform[axis] = [...actual.transform[axis]] as [number, number, number];
  }
  if (preservePosition) merged.transform.position = [...actual.transform.position];
  return merged;
}

function nodeReferences(
  nodes: SceneNode[],
  id: string,
  sameInstanceSourceIds: Set<string>,
  instanceId: string,
) {
  return nodes.some((node) => {
    if (
      node.parentId === id &&
      !(node.prefabLink?.instanceId === instanceId && sameInstanceSourceIds.has(node.prefabLink.sourceNodeId))
    )
      return true;
    return node.components.some((component) =>
      component.type === 'joint'
        ? component.connectedNodeId === id
        : component.type === 'rules' &&
          component.rules.some((rule) =>
            rule.actions.some((action) => 'target' in action && action.target === id),
          ),
    );
  });
}

/** Propagates source edits while retaining fields that differ from the previous source as instance overrides. */
export function syncLinkedPrefabInstances(
  scenes: SceneNodes,
  previousPrefab: Prefab,
  nextPrefab: Prefab,
  options: {
    sourceInstanceRootId?: string;
    sourceInstanceNodeIds?: Record<string, string>;
    resetInstanceRootId?: string;
    preserveRootPosition?: boolean;
  } = {},
) {
  const hasLinkedInstances = scenes.some((scene) =>
    scene.nodes.some(
      (node) => node.prefabLink?.prefabId === previousPrefab.id && node.prefabLink.instanceId === node.id,
    ),
  );
  if (previousPrefab.rootId !== nextPrefab.rootId && hasLinkedInstances)
    throw new Error('A linked prefab cannot change its root ID; unlink instances before replacing the root.');
  if (
    options.sourceInstanceRootId &&
    !scenes.some((scene) =>
      scene.nodes.some(
        (node) =>
          node.id === options.sourceInstanceRootId &&
          node.prefabLink?.prefabId === previousPrefab.id &&
          node.prefabLink.sourceNodeId === previousPrefab.rootId,
      ),
    )
  )
    throw new Error('Source instance root does not belong to this prefab.');
  if (options.sourceInstanceNodeIds && !options.sourceInstanceRootId)
    throw new Error('Source instance node mappings need a source instance root ID.');

  const previousSources = new Set(previousPrefab.nodes.map((node) => node.id));
  const nextSources = new Set(nextPrefab.nodes.map((node) => node.id));
  for (const scene of scenes) {
    const roots = scene.nodes.filter(
      (node) =>
        node.prefabLink?.prefabId === previousPrefab.id &&
        node.prefabLink.instanceId === node.id &&
        node.prefabLink.sourceNodeId === previousPrefab.rootId,
    );
    for (const root of roots) {
      const instanceId = root.id;
      const force = options.sourceInstanceRootId === instanceId || options.resetInstanceRootId === instanceId;
      const preservePosition =
        options.resetInstanceRootId === instanceId && options.preserveRootPosition !== false;
      const removed = new Set(force ? [] : (root.prefabLink?.removedSourceIds ?? []));
      const currentBySource = new Map(
        scene.nodes
          .filter((node) => node.prefabLink?.instanceId === instanceId)
          .map((node) => [node.prefabLink!.sourceNodeId, node]),
      );
      if (force) {
        for (const [sourceNodeId, sceneNodeId] of Object.entries(options.sourceInstanceNodeIds ?? {})) {
          const node = scene.nodes.find((entry) => entry.id === sceneNodeId);
          if (
            !nextSources.has(sourceNodeId) ||
            !node ||
            (node.id !== instanceId && !isDescendant(scene.nodes, node.id, instanceId))
          )
            throw new Error(`Source instance mapping for ${sourceNodeId} is invalid.`);
          currentBySource.set(sourceNodeId, node);
        }
      }
      const used = new Set(scene.nodes.map((node) => node.id));
      const sceneIds = new Map<string, string>();
      for (const source of previousPrefab.nodes) {
        const current = currentBySource.get(source.id);
        sceneIds.set(source.id, current?.id ?? linkedNodeId(instanceId, source.id, used));
      }
      for (const source of nextPrefab.nodes) {
        const current = currentBySource.get(source.id);
        if (current) sceneIds.set(source.id, current.id);
        else if (!sceneIds.has(source.id)) sceneIds.set(source.id, linkedNodeId(instanceId, source.id, used));
      }
      const previousNodes = instantiatePrefabNodes(
        previousPrefab,
        previousPrefab.nodes.map((node) => sceneIds.get(node.id)!),
        {
          rootParentId: root.parentId,
        },
      );
      const nextNodes = instantiatePrefabNodes(
        nextPrefab,
        nextPrefab.nodes.map((node) => sceneIds.get(node.id)!),
        {
          rootParentId: root.parentId,
        },
      );
      const oldBySource = new Map(
        previousNodes.map((node, index) => [previousPrefab.nodes[index]!.id, node]),
      );
      const nextBySource = new Map(nextNodes.map((node, index) => [nextPrefab.nodes[index]!.id, node]));
      const oldInstanceSourceIds = new Set(previousSources);
      const additions: SceneNode[] = [];

      for (const source of nextPrefab.nodes) {
        if (removed.has(source.id)) continue;
        const nextNode = nextBySource.get(source.id)!;
        const actual = currentBySource.get(source.id);
        const previous = oldBySource.get(source.id);
        const link = {
          prefabId: nextPrefab.id,
          instanceId,
          sourceNodeId: source.id,
          ...(source.id === nextPrefab.rootId && root.prefabLink?.removedSourceIds?.length && !force
            ? { removedSourceIds: root.prefabLink.removedSourceIds.filter((id) => nextSources.has(id)) }
            : {}),
        };
        if (actual && previous) {
          const index = scene.nodes.findIndex((node) => node.id === actual.id);
          scene.nodes[index] = mergeLinkedNode(
            actual,
            previous,
            nextNode,
            link,
            force,
            preservePosition && source.id === nextPrefab.rootId,
          );
        } else if (actual && force) {
          const index = scene.nodes.findIndex((node) => node.id === actual.id);
          nextNode.prefabLink = link;
          scene.nodes[index] = nextNode;
        } else {
          const created = structuredClone(nextNode);
          created.prefabLink = link;
          additions.push(created);
        }
      }

      for (const oldSource of previousPrefab.nodes) {
        if (nextSources.has(oldSource.id)) continue;
        const actual = currentBySource.get(oldSource.id);
        const previous = oldBySource.get(oldSource.id);
        if (!actual || !previous) continue;
        const referenced = nodeReferences(scene.nodes, actual.id, oldInstanceSourceIds, instanceId);
        if (hasOverrides(actual, previous) || referenced) delete actual.prefabLink;
        else scene.nodes = scene.nodes.filter((node) => node.id !== actual.id);
      }

      const refreshedRoot = scene.nodes.find((node) => node.id === instanceId);
      if (refreshedRoot?.prefabLink) {
        const removedSourceIds = force
          ? []
          : (refreshedRoot.prefabLink.removedSourceIds ?? []).filter((id) => nextSources.has(id));
        refreshedRoot.prefabLink = {
          prefabId: nextPrefab.id,
          instanceId,
          sourceNodeId: nextPrefab.rootId,
          ...(removedSourceIds.length ? { removedSourceIds } : {}),
        };
      }
      scene.nodes.push(...additions);
    }
  }
}

function isDescendant(nodes: SceneNode[], nodeId: string, ancestorId: string) {
  let parentId = nodes.find((node) => node.id === nodeId)?.parentId ?? null;
  for (let depth = 0; parentId && depth < 5000; depth++) {
    if (parentId === ancestorId) return true;
    parentId = nodes.find((node) => node.id === parentId)?.parentId ?? null;
  }
  return false;
}

export function prefabSignature(prefab: Prefab) {
  const source = JSON.stringify({ rootId: prefab.rootId, nodes: prefab.nodes });
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index++) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
