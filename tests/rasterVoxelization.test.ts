import test from 'node:test';
import assert from 'node:assert/strict';
import { rasterVoxels, textVoxels } from '../services/rasterVoxelization';
test('shared raster conversion keeps black, alpha cutoff, centering and sprite extrusion; rejects oversized input', () => {
  const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]);
  const flat = rasterVoxels({ data, width: 2, height: 2 });
  assert.deepEqual(flat, [
    { x: -1, y: 1, z: 0, color: 0 },
    { x: 0, y: 0, z: 0, color: 255 },
  ]);
  assert.equal(rasterVoxels({ data, width: 2, height: 2 }, 8).length, 18);
  assert.equal(
    rasterVoxels({ data: new Uint8ClampedArray([0, 0, 0, 255]), width: 1, height: 1 }, 8).length,
    1,
  );
  assert.throws(() => rasterVoxels({ data, width: 3, height: 2 }), /Invalid raster/);
  assert.throws(() => rasterVoxels({ data, width: 2, height: 2 }, -1), /extrusion/);
  assert.throws(() => textVoxels('a', Infinity), /size/);
});
