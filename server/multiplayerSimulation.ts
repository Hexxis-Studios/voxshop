import { GameSimulation, FIXED_DELTA } from '../runtime/GameSimulation';
import type { ProjectDocument } from '../services/projectDocument';
import {
  multiplayerGameStateSchema,
  type MultiplayerGameState,
  type MultiplayerPlayerSnapshot,
  type MultiplayerProjectBinding,
} from '../services/multiplayerProtocol';
import type { AcceptedPlayerIntent } from '../services/multiplayerRoom';

const MAX_SCENE_TRANSITIONS_PER_TICK = 16;

function reachableScenes(project: ProjectDocument, entrySceneId: string) {
  const byId = new Map(project.scenes.map((scene) => [scene.id, scene])),
    visited = new Set([entrySceneId]),
    pending = [entrySceneId];
  while (pending.length) {
    const scene = byId.get(pending.shift()!);
    for (const node of scene?.nodes ?? [])
      for (const component of node.components)
        if (component.type === 'rules')
          for (const rule of component.rules)
            for (const action of rule.actions)
              if (action.type === 'transition' && byId.has(action.sceneId) && !visited.has(action.sceneId)) {
                visited.add(action.sceneId);
                pending.push(action.sceneId);
              }
  }
  return visited;
}

/** One shared authoritative simulation and a bounded set of ephemeral room actors. */
export class MultiplayerSimulationHost {
  private current: GameSimulation;
  private readonly reachableSceneIds: Set<string>;
  readonly ready: Promise<void>;

  get simulation() {
    return this.current;
  }

  constructor(
    private readonly project: ProjectDocument,
    private readonly binding: MultiplayerProjectBinding,
    initialState?: MultiplayerGameState,
  ) {
    if (
      project.id !== binding.projectId ||
      project.revision !== binding.revision ||
      !project.scenes.some((scene) => scene.id === binding.sceneId)
    )
      throw new Error('The multiplayer project snapshot does not match its room binding.');
    this.reachableSceneIds = reachableScenes(project, binding.sceneId);
    if (
      initialState &&
      (initialState.projectId !== binding.projectId ||
        initialState.revision !== binding.revision ||
        (initialState.entrySceneId ?? initialState.sceneId) !== binding.sceneId ||
        !this.reachableSceneIds.has(initialState.sceneId))
    )
      throw new Error('The saved multiplayer scene state does not match its room binding.');
    this.current = new GameSimulation(
      structuredClone(project),
      initialState?.sceneId ?? binding.sceneId,
      undefined,
      undefined,
      undefined,
      !!initialState,
    );
    this.ready = this.current.ready.then(() => {
      if (initialState && !this.current.applyMultiplayerState(initialState))
        throw new Error('The saved multiplayer scene state does not match its bound project.');
    });
  }

  async synchronizePlayers(activePlayerIds: readonly string[], retainedPlayerIds: readonly string[]) {
    await this.ready;
    const retained = new Set(retainedPlayerIds),
      active = new Set(activePlayerIds);
    for (const playerId of this.current.multiplayerPlayerIds())
      if (!retained.has(playerId)) this.current.removeMultiplayerPlayer(playerId);
    for (const playerId of retained) {
      this.current.addMultiplayerPlayer(playerId);
      this.current.setMultiplayerPlayerConnected(playerId, active.has(playerId));
    }
  }

  async tick(
    activePlayerIds: readonly string[],
    retainedPlayerIds: readonly string[],
    inputs: readonly AcceptedPlayerIntent[],
  ): Promise<{ players: MultiplayerPlayerSnapshot[]; game: MultiplayerGameState }> {
    await this.synchronizePlayers(activePlayerIds, retainedPlayerIds);
    const switchedAtTickStart = await this.consumeSceneTransitions(activePlayerIds, retainedPlayerIds);
    if (!switchedAtTickStart && activePlayerIds.length && this.current.status === 'playing') {
      this.current.stepMultiplayer(inputs, FIXED_DELTA);
      await this.consumeSceneTransitions(activePlayerIds, retainedPlayerIds);
    }
    const game = this.current.captureMultiplayerState([...retainedPlayerIds], [...activePlayerIds]);
    return {
      players: this.current.captureMultiplayerPlayerSnapshots([...activePlayerIds]),
      game: multiplayerGameStateSchema.parse({ ...game, entrySceneId: this.binding.sceneId }),
    };
  }

  private async consumeSceneTransitions(
    activePlayerIds: readonly string[],
    retainedPlayerIds: readonly string[],
  ) {
    let switched = false;
    for (let count = 0; count < MAX_SCENE_TRANSITIONS_PER_TICK; count++) {
      const nextSceneId = this.current.takeSceneTransition();
      if (!nextSceneId) return switched;
      const destination = this.project.scenes.find((scene) => scene.id === nextSceneId);
      if (
        !destination ||
        !this.reachableSceneIds.has(nextSceneId) ||
        !destination.nodes.some((node) => node.components.some((component) => component.type === 'player'))
      ) {
        this.current.status = 'stopped';
        this.current.errors.push(`Scene transition target ${nextSceneId} does not contain a player.`);
        return switched;
      }

      const previous = this.current,
        previousState = previous.captureMultiplayerState([...retainedPlayerIds], [...activePlayerIds]),
        previousPlayers = new Map(previousState.players.map((player) => [player.playerId, player])),
        next = new GameSimulation(structuredClone(this.project), nextSceneId, undefined, undefined, {
          ...previousState.campaignVariables,
        });
      try {
        await next.ready;
        for (const playerId of retainedPlayerIds) {
          next.addMultiplayerPlayer(playerId);
          next.setMultiplayerPlayerConnected(playerId, activePlayerIds.includes(playerId));
          const player = previousPlayers.get(playerId);
          if (
            player &&
            !next.restoreMultiplayerPlayerState(playerId, {
              inventory: player.inventory,
              health: player.health,
              attackCooldown: player.attackCooldown,
              damageCooldown: player.damageCooldown,
            })
          )
            throw new Error(`Scene ${nextSceneId} cannot accept ${playerId}'s campaign inventory.`);
        }
        multiplayerGameStateSchema.parse({
          ...next.captureMultiplayerState([...retainedPlayerIds], [...activePlayerIds]),
          entrySceneId: this.binding.sceneId,
        });
        this.current = next;
        previous.dispose();
        switched = true;
      } catch (error) {
        next.dispose();
        previous.status = 'stopped';
        previous.errors.push((error as Error).message);
        return switched;
      }
    }
    if (this.current.takeSceneTransition()) {
      this.current.status = 'stopped';
      this.current.errors.push(
        `Gameplay exceeded ${MAX_SCENE_TRANSITIONS_PER_TICK} scene transitions in one tick.`,
      );
    }
    return switched;
  }

  dispose() {
    this.current.dispose();
  }
}
