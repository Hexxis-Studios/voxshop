import path from 'node:path';
import { newProject, applyProjectOperations } from '../services/projectDocument';
import { buildGame } from '../server/gameBuild';

const base = newProject('standalone-throughput', 'Standalone throughput check');
const nodes = Array.from({ length: 1000 }, (_, i) => ({
  id: `prop-${i}`,
  name: `Prop ${i}`,
  assetId: 'block',
  transform: { position: [(i % 32) * 2 - 31, 0, Math.floor(i / 32) * 2 - 31] },
}));
const project = applyProjectOperations(base, [
  {
    type: 'asset.generate',
    id: 'block',
    name: 'Shared voxel block',
    voxelSize: 0.1,
    recipe: {
      version: 1,
      seed: 0,
      shapes: [{ kind: 'box', center: [0, 8, 0], size: [16, 16, 16], color: 0x69944e }],
    },
  },
  { type: 'scene.put', scene: { ...base.scenes[0], bounds: 100, nodes } },
]);
const result = await buildGame(project, 'main', {
  root: process.cwd(),
  directory: path.resolve('.voxshop/engine-development/standalone-throughput'),
});
console.log(
  JSON.stringify({ ...result, instances: nodes.length, geometry: 'One shared 1.6 m voxel cube.' }, null, 2),
);
