import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMinecraft, encodeMinecraft, type MinecraftFormat } from '../services/voxelFormats';

test('Minecraft-family exports reopen with every voxel preserved for small palettes', async () => {
  const voxels = [
    { x: -2, y: 3, z: 5, color: 0x00ff00 },
    { x: 1, y: 4, z: 6, color: 0xff0000 },
  ];
  const positions = new Set(['-1,0,0', '2,1,1']);

  for (const format of ['nbt', 'schematic', 'litematic'] satisfies MinecraftFormat[]) {
    const encoded = await encodeMinecraft(voxels, format);
    assert.ok(encoded, `${format} should produce an export`);
    const serialized = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    const decoded = await decodeMinecraft(serialized);

    assert.equal(decoded.length, voxels.length, `${format} should preserve each voxel`);
    assert.deepEqual(new Set(decoded.map(({ x, y, z }) => `${x},${y},${z}`)), positions);
  }
});
