import type { VoxelData } from '../types';

export type MinecraftFormat = 'nbt' | 'schematic' | 'litematic';

function litematicBitsPerBlock(paletteSize: number) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(paletteSize, 2))));
}

function getBounds(voxels: VoxelData[]) {
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const voxel of voxels) {
    bounds.minX = Math.min(bounds.minX, voxel.x);
    bounds.maxX = Math.max(bounds.maxX, voxel.x);
    bounds.minY = Math.min(bounds.minY, voxel.y);
    bounds.maxY = Math.max(bounds.maxY, voxel.y);
    bounds.minZ = Math.min(bounds.minZ, voxel.z);
    bounds.maxZ = Math.max(bounds.maxZ, voxel.z);
  }
  return bounds;
}

export function encodeVOX(inputVoxels: VoxelData[]): Uint8Array | null {
  const voxels = inputVoxels;
  if (voxels.length === 0) return null;
  const { minX, maxX, minY, maxY, minZ, maxZ } = getBounds(voxels);
  const w = Math.ceil(maxX - minX) + 1,
    h = Math.ceil(maxY - minY) + 1,
    d = Math.ceil(maxZ - minZ) + 1;
  if (Math.max(w, h, d) > 256)
    throw new Error(
      'VOX coordinates support at most 256 cells per axis. Use native JSON or a smaller model.',
    );
  const colorMap = new Map<number, number>();
  voxels.forEach((v) => {
    const hex = v.color;
    if (!colorMap.has(hex) && colorMap.size < 255) colorMap.set(hex, colorMap.size + 1);
  });
  const pal = Array.from(colorMap.keys());
  while (pal.length < 256) pal.push(0);
  const buf: number[] = [];
  const ws = (s: string) => s.split('').forEach((c) => buf.push(c.charCodeAt(0)));
  const wi = (i: number) => {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, i, true);
    new Uint8Array(b).forEach((v) => buf.push(v));
  };
  const nv = voxels.length;
  const sc = 12,
    xc = 4 + nv * 4,
    rc = 256 * 4;
  const mcs = 12 + sc + (12 + xc) + (12 + rc);
  ws('VOX ');
  wi(150);
  ws('MAIN');
  wi(0);
  wi(mcs);
  ws('SIZE');
  wi(sc);
  wi(0);
  wi(w);
  wi(d);
  wi(h);
  ws('XYZI');
  wi(xc);
  wi(0);
  wi(nv);
  voxels.forEach((v) => {
    const ci = colorMap.get(v.color) ?? 1;
    buf.push(Math.round(v.x - minX), Math.round(v.z - minZ), Math.round(v.y - minY), ci);
  });
  ws('RGBA');
  wi(rc);
  wi(0);
  pal.forEach((hex) => buf.push((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff, 0xff));
  return new Uint8Array(buf);
}

export function encodeQB(inputVoxels: VoxelData[]): Uint8Array | null {
  const voxels = inputVoxels;
  if (voxels.length === 0) return null;
  const { minX, maxX, minY, maxY, minZ, maxZ } = getBounds(voxels);
  const w = Math.ceil(maxX - minX) + 1,
    h = Math.ceil(maxY - minY) + 1,
    d = Math.ceil(maxZ - minZ) + 1;
  const buffer: number[] = [];
  if (w * h * d > 4000000)
    throw new Error('QB export exceeds four million volume cells. Use native JSON or a smaller model.');
  const writeInt = (i: number) => {
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, i, true);
    new Uint8Array(b).forEach((v) => buffer.push(v));
  };

  writeInt(0x01010000);
  writeInt(1);
  writeInt(0);
  writeInt(0);
  writeInt(1);
  writeInt(1);
  buffer.push(5);
  'Model'.split('').forEach((c) => buffer.push(c.charCodeAt(0)));
  writeInt(w);
  writeInt(h);
  writeInt(d);
  writeInt(Math.round(minX));
  writeInt(Math.round(minY));
  writeInt(Math.round(minZ));

  const grid = new Array(w * h * d).fill(0);
  voxels.forEach((v) => {
    const x = Math.round(v.x - minX),
      y = Math.round(v.y - minY),
      z = Math.round(v.z - minZ);
    const color = v.color;
    grid[x + y * w + z * w * h] =
      ((color & 0xff) << 16) | (color & 0xff00) | ((color >> 16) & 0xff) | 0xff000000;
  });
  grid.forEach((c) => writeInt(c));

  return new Uint8Array(buffer);
}

export async function encodeMinecraft(
  inputVoxels: VoxelData[],
  format: MinecraftFormat,
): Promise<Uint8Array | null> {
  const voxels = inputVoxels;
  if (voxels.length === 0) return null;
  const { minX, maxX, minY, maxY, minZ, maxZ } = getBounds(voxels);
  const w = Math.ceil(maxX - minX) + 1,
    h = Math.ceil(maxY - minY) + 1,
    d = Math.ceil(maxZ - minZ) + 1;

  if (w * h * d > 4000000)
    throw new Error(
      'Minecraft export exceeds four million volume cells. Use native JSON or a smaller model.',
    );
  const PALETTE: { rgb: [number, number, number]; id: number; data: number; name: string }[] = [
    { rgb: [207, 213, 214], id: 251, data: 0, name: 'minecraft:white_concrete' },
    { rgb: [224, 97, 0], id: 251, data: 1, name: 'minecraft:orange_concrete' },
    { rgb: [169, 48, 159], id: 251, data: 2, name: 'minecraft:magenta_concrete' },
    { rgb: [36, 137, 199], id: 251, data: 3, name: 'minecraft:light_blue_concrete' },
    { rgb: [240, 175, 21], id: 251, data: 4, name: 'minecraft:yellow_concrete' },
    { rgb: [94, 168, 24], id: 251, data: 5, name: 'minecraft:lime_concrete' },
    { rgb: [213, 101, 142], id: 251, data: 6, name: 'minecraft:pink_concrete' },
    { rgb: [54, 57, 61], id: 251, data: 7, name: 'minecraft:gray_concrete' },
    { rgb: [125, 125, 115], id: 251, data: 8, name: 'minecraft:light_gray_concrete' },
    { rgb: [21, 119, 136], id: 251, data: 9, name: 'minecraft:cyan_concrete' },
    { rgb: [100, 31, 156], id: 251, data: 10, name: 'minecraft:purple_concrete' },
    { rgb: [44, 46, 143], id: 251, data: 11, name: 'minecraft:blue_concrete' },
    { rgb: [96, 59, 31], id: 251, data: 12, name: 'minecraft:brown_concrete' },
    { rgb: [72, 91, 36], id: 251, data: 13, name: 'minecraft:green_concrete' },
    { rgb: [142, 32, 32], id: 251, data: 14, name: 'minecraft:red_concrete' },
    { rgb: [8, 10, 15], id: 251, data: 15, name: 'minecraft:black_concrete' },
    { rgb: [221, 221, 221], id: 35, data: 0, name: 'minecraft:white_wool' },
    { rgb: [219, 125, 62], id: 35, data: 1, name: 'minecraft:orange_wool' },
    { rgb: [179, 80, 188], id: 35, data: 2, name: 'minecraft:magenta_wool' },
    { rgb: [107, 138, 201], id: 35, data: 3, name: 'minecraft:light_blue_wool' },
    { rgb: [177, 166, 39], id: 35, data: 4, name: 'minecraft:yellow_wool' },
    { rgb: [65, 174, 56], id: 35, data: 5, name: 'minecraft:lime_wool' },
    { rgb: [208, 132, 153], id: 35, data: 6, name: 'minecraft:pink_wool' },
    { rgb: [64, 64, 64], id: 35, data: 7, name: 'minecraft:gray_wool' },
    { rgb: [154, 161, 161], id: 35, data: 8, name: 'minecraft:light_gray_wool' },
    { rgb: [46, 110, 137], id: 35, data: 9, name: 'minecraft:cyan_wool' },
    { rgb: [126, 61, 181], id: 35, data: 10, name: 'minecraft:purple_wool' },
    { rgb: [46, 56, 141], id: 35, data: 11, name: 'minecraft:blue_wool' },
    { rgb: [79, 50, 31], id: 35, data: 12, name: 'minecraft:brown_wool' },
    { rgb: [54, 76, 24], id: 35, data: 13, name: 'minecraft:green_wool' },
    { rgb: [150, 51, 48], id: 35, data: 14, name: 'minecraft:red_wool' },
    { rgb: [25, 22, 22], id: 35, data: 15, name: 'minecraft:black_wool' },
    { rgb: [210, 178, 161], id: 159, data: 0, name: 'minecraft:white_terracotta' },
    { rgb: [162, 84, 38], id: 159, data: 1, name: 'minecraft:orange_terracotta' },
    { rgb: [149, 88, 108], id: 159, data: 2, name: 'minecraft:magenta_terracotta' },
    { rgb: [113, 108, 137], id: 159, data: 3, name: 'minecraft:light_blue_terracotta' },
    { rgb: [186, 133, 36], id: 159, data: 4, name: 'minecraft:yellow_terracotta' },
    { rgb: [103, 117, 53], id: 159, data: 5, name: 'minecraft:lime_terracotta' },
    { rgb: [161, 78, 78], id: 159, data: 6, name: 'minecraft:pink_terracotta' },
    { rgb: [57, 42, 35], id: 159, data: 7, name: 'minecraft:gray_terracotta' },
    { rgb: [135, 107, 98], id: 159, data: 8, name: 'minecraft:light_gray_terracotta' },
    { rgb: [87, 91, 91], id: 159, data: 9, name: 'minecraft:cyan_terracotta' },
    { rgb: [118, 70, 86], id: 159, data: 10, name: 'minecraft:purple_terracotta' },
    { rgb: [74, 59, 91], id: 159, data: 11, name: 'minecraft:blue_terracotta' },
    { rgb: [77, 51, 35], id: 159, data: 12, name: 'minecraft:brown_terracotta' },
    { rgb: [76, 82, 42], id: 159, data: 13, name: 'minecraft:green_terracotta' },
    { rgb: [143, 61, 46], id: 159, data: 14, name: 'minecraft:red_terracotta' },
    { rgb: [37, 22, 16], id: 159, data: 15, name: 'minecraft:black_terracotta' },
    { rgb: [125, 125, 125], id: 1, data: 0, name: 'minecraft:stone' },
    { rgb: [219, 207, 163], id: 12, data: 0, name: 'minecraft:sand' },
    { rgb: [162, 130, 78], id: 5, data: 0, name: 'minecraft:oak_planks' },
    { rgb: [134, 96, 67], id: 3, data: 0, name: 'minecraft:dirt' },
    { rgb: [127, 127, 127], id: 4, data: 0, name: 'minecraft:cobblestone' },
    { rgb: [150, 97, 83], id: 45, data: 0, name: 'minecraft:bricks' },
    { rgb: [21, 18, 30], id: 49, data: 0, name: 'minecraft:obsidian' },
    { rgb: [255, 255, 255], id: 80, data: 0, name: 'minecraft:snow_block' },
    { rgb: [145, 183, 211], id: 79, data: 0, name: 'minecraft:ice' },
    { rgb: [255, 223, 122], id: 89, data: 0, name: 'minecraft:glowstone' },
    { rgb: [97, 41, 41], id: 87, data: 0, name: 'minecraft:netherrack' },
  ];

  const nearestBlock = (hex: number) => {
    const r = (hex >> 16) & 0xff,
      g = (hex >> 8) & 0xff,
      b = hex & 0xff;
    let best = 0,
      bd = Infinity;
    PALETTE.forEach((p, i) => {
      const dist = (r - p.rgb[0]) ** 2 + (g - p.rgb[1]) ** 2 + (b - p.rgb[2]) ** 2;
      if (dist < bd) {
        bd = dist;
        best = i;
      }
    });
    return PALETTE[best];
  };

  const enc = new TextEncoder();
  const buf: number[] = [];
  const push8 = (v: number) => buf.push(v & 0xff);
  const push16 = (v: number) => {
    buf.push((v >> 8) & 0xff, v & 0xff);
  };
  const push32 = (v: number) => {
    buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  const push64 = (v: bigint) => {
    push32(Number((v >> 32n) & 0xffffffffn));
    push32(Number(v & 0xffffffffn));
  };
  const pushStr = (s: string) => {
    const e = enc.encode(s);
    push16(e.length);
    e.forEach((b) => buf.push(b));
  };
  const tag = (type: number, name: string, payload: () => void) => {
    push8(type);
    pushStr(name);
    payload();
  };

  if (format === 'litematic') {
    const paletteNames: string[] = ['minecraft:air'];
    const blockToPaletteIdx = new Map<string, number>();
    const voxelPaletteMap = new Map<string, number>();

    voxels.forEach((v) => {
      const x = Math.round(v.x - minX),
        y = Math.round(v.y - minY),
        z = Math.round(v.z - minZ);
      const block = nearestBlock(v.color);
      if (!blockToPaletteIdx.has(block.name)) {
        blockToPaletteIdx.set(block.name, paletteNames.length);
        paletteNames.push(block.name);
      }
      voxelPaletteMap.set(`${x},${y},${z}`, blockToPaletteIdx.get(block.name)!);
    });

    const paletteSize = paletteNames.length;
    const bitsPerBlock = litematicBitsPerBlock(paletteSize);
    const valuesPerLong = Math.floor(64 / bitsPerBlock);
    const totalBlocks = w * h * d;
    const longCount = Math.ceil(totalBlocks / valuesPerLong);
    const blockStates = new Array(longCount).fill(0n) as bigint[];

    for (let y = 0; y < h; y++)
      for (let z = 0; z < d; z++)
        for (let x = 0; x < w; x++) {
          const blockIdx = (y * d + z) * w + x;
          const pi = voxelPaletteMap.get(`${x},${y},${z}`) ?? 0;
          if (pi !== 0) {
            const li = Math.floor(blockIdx / valuesPerLong);
            const bitOff = (blockIdx % valuesPerLong) * bitsPerBlock;
            blockStates[li] |= BigInt(pi) << BigInt(bitOff);
          }
        }

    const ts = BigInt(Date.now());
    push8(10);
    pushStr('');
    tag(3, 'MinecraftDataVersion', () => push32(2860));
    tag(3, 'Version', () => push32(6));
    tag(3, 'SubVersion', () => push32(1));
    tag(10, 'Metadata', () => {
      tag(8, 'Name', () => pushStr('voxel_model'));
      tag(8, 'Author', () => pushStr('Voxel Builder'));
      tag(8, 'Description', () => pushStr(''));
      tag(4, 'TimeCreated', () => push64(ts));
      tag(4, 'TimeModified', () => push64(ts));
      tag(10, 'EnclosingSize', () => {
        tag(3, 'x', () => push32(w));
        tag(3, 'y', () => push32(h));
        tag(3, 'z', () => push32(d));
        push8(0);
      });
      tag(3, 'TotalBlocks', () => push32(voxels.length));
      tag(3, 'TotalVolume', () => push32(w * h * d));
      tag(3, 'RegionCount', () => push32(1));
      push8(0);
    });
    tag(10, 'Regions', () => {
      tag(10, 'main', () => {
        tag(10, 'Position', () => {
          tag(3, 'x', () => push32(0));
          tag(3, 'y', () => push32(0));
          tag(3, 'z', () => push32(0));
          push8(0);
        });
        tag(10, 'Size', () => {
          tag(3, 'x', () => push32(w));
          tag(3, 'y', () => push32(h));
          tag(3, 'z', () => push32(d));
          push8(0);
        });
        tag(9, 'BlockStatePalette', () => {
          push8(10);
          push32(paletteNames.length);
          paletteNames.forEach((n) => {
            tag(8, 'Name', () => pushStr(n));
            push8(0);
          });
        });
        tag(12, 'BlockStates', () => {
          push32(blockStates.length);
          blockStates.forEach((v) => push64(v));
        });
        tag(9, 'Entities', () => {
          push8(10);
          push32(0);
        });
        tag(9, 'TileEntities', () => {
          push8(10);
          push32(0);
        });
        tag(9, 'PendingBlockTicks', () => {
          push8(10);
          push32(0);
        });
        tag(9, 'PendingFluidTicks', () => {
          push8(10);
          push32(0);
        });
        push8(0);
      });
      push8(0);
    });
    push8(0);
  } else {
    const blocks = new Uint8Array(w * h * d);
    const blockData = new Uint8Array(w * h * d);
    voxels.forEach((v) => {
      const x = Math.round(v.x - minX),
        y = Math.round(v.y - minY),
        z = Math.round(v.z - minZ);
      const block = nearestBlock(v.color);
      const idx = y * w * d + z * w + x;
      blocks[idx] = block.id;
      blockData[idx] = block.data;
    });
    const wi4 = (i: number) => push32(i);
    const wtag = (type: number, name: string, payload: () => void) => tag(type, name, payload);
    push8(10);
    pushStr('Schematic');
    wtag(2, 'Width', () => push16(w));
    wtag(2, 'Height', () => push16(h));
    wtag(2, 'Length', () => push16(d));
    wtag(8, 'Materials', () => pushStr('Alpha'));
    wtag(7, 'Blocks', () => {
      wi4(blocks.length);
      blocks.forEach((b) => push8(b));
    });
    wtag(7, 'Data', () => {
      wi4(blockData.length);
      blockData.forEach((b) => push8(b));
    });
    wtag(9, 'Entities', () => {
      push8(10);
      push32(0);
    });
    wtag(9, 'TileEntities', () => {
      push8(10);
      push32(0);
    });
    push8(0);
  }

  const raw = new Uint8Array(buf);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(compressed);
}

export function decodeVOX(buffer: ArrayBuffer): VoxelData[] {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'VOX ') throw new Error('Not a valid .vox file');

  const rawVoxels: { x: number; y: number; z: number; ci: number }[] = [];
  const palette = new Array(257).fill(0xcccccc);

  const walkChunks = (start: number, end: number) => {
    let off = start;
    while (off + 12 <= end) {
      const id = String.fromCharCode(
        view.getUint8(off),
        view.getUint8(off + 1),
        view.getUint8(off + 2),
        view.getUint8(off + 3),
      );
      const cs = view.getInt32(off + 4, true);
      const ch = view.getInt32(off + 8, true);
      const cStart = off + 12;
      if (id === 'XYZI') {
        const n = view.getInt32(cStart, true);
        for (let i = 0; i < n; i++) {
          const b = cStart + 4 + i * 4;
          rawVoxels.push({
            x: view.getUint8(b),
            y: view.getUint8(b + 1),
            z: view.getUint8(b + 2),
            ci: view.getUint8(b + 3),
          });
        }
      } else if (id === 'RGBA') {
        for (let i = 0; i < 255; i++) {
          const b = cStart + i * 4;
          palette[i + 1] = (view.getUint8(b) << 16) | (view.getUint8(b + 1) << 8) | view.getUint8(b + 2);
        }
      }
      if (ch > 0) walkChunks(cStart + cs, cStart + cs + ch);
      off = cStart + cs + ch;
    }
  };
  walkChunks(8, buffer.byteLength);
  if (rawVoxels.length === 0) return [];
  const voxels = rawVoxels.map((v) => ({ x: v.x, y: v.z, z: v.y, color: palette[v.ci] ?? 0xcccccc }));
  const minX = Math.min(...voxels.map((v) => v.x)),
    maxX = Math.max(...voxels.map((v) => v.x));
  const minZ = Math.min(...voxels.map((v) => v.z)),
    maxZ = Math.max(...voxels.map((v) => v.z));
  const minY = Math.min(...voxels.map((v) => v.y));
  const cx = (minX + maxX) / 2,
    cz = (minZ + maxZ) / 2;
  return voxels.map((v) => ({
    x: Math.round(v.x - cx),
    y: v.y - minY,
    z: Math.round(v.z - cz),
    color: v.color,
  }));
}

export function decodeQB(buffer: ArrayBuffer): VoxelData[] {
  const view = new DataView(buffer);
  let off = 0;
  const rU32 = () => {
    const v = view.getUint32(off, true);
    off += 4;
    return v;
  };
  const rI32 = () => {
    const v = view.getInt32(off, true);
    off += 4;
    return v;
  };

  rU32();
  const colorFormat = rU32();
  rU32();
  const compression = rU32();
  rU32();
  const numMatrices = rU32();

  const allVoxels: VoxelData[] = [];

  for (let m = 0; m < numMatrices; m++) {
    const nameLen = view.getUint8(off);
    off++;
    off += nameLen;
    const sizeX = rU32(),
      sizeY = rU32(),
      sizeZ = rU32();
    const posX = rI32(),
      posY = rI32(),
      posZ = rI32();

    if (compression === 0) {
      for (let z = 0; z < sizeZ; z++) {
        for (let y = 0; y < sizeY; y++) {
          for (let x = 0; x < sizeX; x++) {
            const raw = rU32();
            if (((raw >> 24) & 0xff) === 0) continue;
            const r = colorFormat === 1 ? raw & 0xff : (raw >> 16) & 0xff;
            const g = (raw >> 8) & 0xff;
            const b = colorFormat === 1 ? (raw >> 16) & 0xff : raw & 0xff;
            allVoxels.push({ x: posX + x, y: posY + y, z: posZ + z, color: (r << 16) | (g << 8) | b });
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
              const count = rU32(),
                raw = rU32();
              if (((raw >> 24) & 0xff) > 0) {
                const r = colorFormat === 1 ? raw & 0xff : (raw >> 16) & 0xff;
                const g = (raw >> 8) & 0xff;
                const b = colorFormat === 1 ? (raw >> 16) & 0xff : raw & 0xff;
                for (let i = 0; i < count && x < sizeX; i++, x++)
                  allVoxels.push({ x: posX + x, y: posY + y, z: posZ + z, color: (r << 16) | (g << 8) | b });
              } else x += count;
            } else {
              if (((data >> 24) & 0xff) > 0) {
                const r = colorFormat === 1 ? data & 0xff : (data >> 16) & 0xff;
                const g = (data >> 8) & 0xff;
                const b = colorFormat === 1 ? (data >> 16) & 0xff : data & 0xff;
                allVoxels.push({ x: posX + x, y: posY + y, z: posZ + z, color: (r << 16) | (g << 8) | b });
              }
              x++;
            }
          }
        }
      }
    }
  }

  if (allVoxels.length === 0) return [];
  const minX = Math.min(...allVoxels.map((v) => v.x)),
    maxX = Math.max(...allVoxels.map((v) => v.x));
  const minZ = Math.min(...allVoxels.map((v) => v.z)),
    maxZ = Math.max(...allVoxels.map((v) => v.z));
  const minY = Math.min(...allVoxels.map((v) => v.y));
  const cx = (minX + maxX) / 2,
    cz = (minZ + maxZ) / 2;
  return allVoxels.map((v) => ({
    x: Math.round(v.x - cx),
    y: v.y - minY,
    z: Math.round(v.z - cz),
    color: v.color,
  }));
}

export async function decodeMinecraft(buffer: ArrayBuffer): Promise<VoxelData[]> {
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

  const r8 = () => buf[pos++];
  const r16 = () => {
    const v = dv.getInt16(pos, false);
    pos += 2;
    return v;
  };
  const ru16 = () => {
    const v = dv.getUint16(pos, false);
    pos += 2;
    return v;
  };
  const r32 = () => {
    const v = dv.getInt32(pos, false);
    pos += 4;
    return v;
  };
  const r64 = () => {
    const hi = dv.getInt32(pos, false);
    const lo = dv.getUint32(pos + 4, false);
    pos += 8;
    return (BigInt(hi) << 32n) | BigInt(lo);
  };
  const rStr = () => {
    const len = ru16();
    const s = new TextDecoder().decode(buf.slice(pos, pos + len));
    pos += len;
    return s;
  };

  const readPayload = (type: number): any => {
    switch (type) {
      case 1:
        return r8();
      case 2:
        return r16();
      case 3:
        return r32();
      case 4:
        return r64();
      case 5: {
        const v = dv.getFloat32(pos, false);
        pos += 4;
        return v;
      }
      case 6: {
        const v = dv.getFloat64(pos, false);
        pos += 8;
        return v;
      }
      case 7: {
        const n = r32();
        const arr = new Uint8Array(buf.buffer, buf.byteOffset + pos, n);
        pos += n;
        return arr;
      }
      case 8:
        return rStr();
      case 9: {
        const et = r8();
        const n = r32();
        const arr: any[] = [];
        for (let i = 0; i < n; i++) arr.push(readPayload(et));
        return arr;
      }
      case 10:
        return readCompound();
      case 11: {
        const n = r32();
        const arr: number[] = [];
        for (let i = 0; i < n; i++) arr.push(r32());
        return arr;
      }
      case 12: {
        const n = r32();
        const arr: bigint[] = [];
        for (let i = 0; i < n; i++) arr.push(r64());
        return arr;
      }
      default:
        return null;
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
    'minecraft:white_concrete': 0xcfd5d6,
    'minecraft:orange_concrete': 0xe06100,
    'minecraft:magenta_concrete': 0xa9309f,
    'minecraft:light_blue_concrete': 0x2489c7,
    'minecraft:yellow_concrete': 0xf0af15,
    'minecraft:lime_concrete': 0x5ea818,
    'minecraft:pink_concrete': 0xd5658e,
    'minecraft:gray_concrete': 0x36393d,
    'minecraft:light_gray_concrete': 0x7d7d73,
    'minecraft:cyan_concrete': 0x157788,
    'minecraft:purple_concrete': 0x64179c,
    'minecraft:blue_concrete': 0x2c2e8f,
    'minecraft:brown_concrete': 0x603b1f,
    'minecraft:green_concrete': 0x485b24,
    'minecraft:red_concrete': 0x8e2020,
    'minecraft:black_concrete': 0x08090f,
    'minecraft:white_concrete_powder': 0xe1e4e4,
    'minecraft:orange_concrete_powder': 0xe7883b,
    'minecraft:white_wool': 0xdddddd,
    'minecraft:orange_wool': 0xdb7d3e,
    'minecraft:magenta_wool': 0xb350bc,
    'minecraft:light_blue_wool': 0x6b8ac9,
    'minecraft:yellow_wool': 0xb1a627,
    'minecraft:lime_wool': 0x41ae38,
    'minecraft:pink_wool': 0xd08499,
    'minecraft:gray_wool': 0x404040,
    'minecraft:light_gray_wool': 0x9aa1a1,
    'minecraft:cyan_wool': 0x2e6e89,
    'minecraft:purple_wool': 0x7e3db5,
    'minecraft:blue_wool': 0x2e388d,
    'minecraft:brown_wool': 0x4f321f,
    'minecraft:green_wool': 0x364c18,
    'minecraft:red_wool': 0x963330,
    'minecraft:black_wool': 0x191616,
    'minecraft:white_terracotta': 0xd2b2a1,
    'minecraft:orange_terracotta': 0xa25426,
    'minecraft:magenta_terracotta': 0x95585c,
    'minecraft:light_blue_terracotta': 0x716c89,
    'minecraft:yellow_terracotta': 0xba8524,
    'minecraft:lime_terracotta': 0x677535,
    'minecraft:pink_terracotta': 0xa14e4e,
    'minecraft:gray_terracotta': 0x392a23,
    'minecraft:light_gray_terracotta': 0x876b62,
    'minecraft:cyan_terracotta': 0x575b5b,
    'minecraft:purple_terracotta': 0x764656,
    'minecraft:blue_terracotta': 0x4a3b5b,
    'minecraft:brown_terracotta': 0x4d3323,
    'minecraft:green_terracotta': 0x4c522a,
    'minecraft:red_terracotta': 0x8f3d2e,
    'minecraft:black_terracotta': 0x251610,
    'minecraft:terracotta': 0x985335,
    'minecraft:stone': 0x7d7d7d,
    'minecraft:cobblestone': 0x7f7f7f,
    'minecraft:smooth_stone': 0x9a9a9a,
    'minecraft:stone_bricks': 0x787878,
    'minecraft:mossy_stone_bricks': 0x6a7a55,
    'minecraft:cracked_stone_bricks': 0x747474,
    'minecraft:chiseled_stone_bricks': 0x787878,
    'minecraft:granite': 0xa0724a,
    'minecraft:polished_granite': 0xa07247,
    'minecraft:diorite': 0xc0c0c0,
    'minecraft:polished_diorite': 0xc4c4c4,
    'minecraft:andesite': 0x8c8c8c,
    'minecraft:polished_andesite': 0x8e8e8e,
    'minecraft:oak_planks': 0xa2824e,
    'minecraft:spruce_planks': 0x7d5a2d,
    'minecraft:birch_planks': 0xc8b577,
    'minecraft:jungle_planks': 0xa07040,
    'minecraft:acacia_planks': 0xba6337,
    'minecraft:dark_oak_planks': 0x4a2f14,
    'minecraft:mangrove_planks': 0x8d3b2b,
    'minecraft:bamboo_planks': 0xc0a84e,
    'minecraft:oak_log': 0xa07040,
    'minecraft:spruce_log': 0x3d2b0f,
    'minecraft:birch_log': 0xd0d0d0,
    'minecraft:jungle_log': 0x976b3a,
    'minecraft:acacia_log': 0xa0a0a0,
    'minecraft:dark_oak_log': 0x3a2a10,
    'minecraft:oak_leaves': 0x3a8020,
    'minecraft:spruce_leaves': 0x2d6618,
    'minecraft:birch_leaves': 0x80a755,
    'minecraft:jungle_leaves': 0x2e7b10,
    'minecraft:acacia_leaves': 0x5a8020,
    'minecraft:dark_oak_leaves': 0x2e6612,
    'minecraft:sand': 0xdbcfa3,
    'minecraft:red_sand': 0xbe6b26,
    'minecraft:gravel': 0x8f8f8f,
    'minecraft:dirt': 0x866043,
    'minecraft:coarse_dirt': 0x7a5234,
    'minecraft:grass_block': 0x5f9f35,
    'minecraft:mycelium': 0x766676,
    'minecraft:podzol': 0x6e4220,
    'minecraft:bricks': 0x967053,
    'minecraft:obsidian': 0x15121e,
    'minecraft:crying_obsidian': 0x1b023d,
    'minecraft:ice': 0x91b7d3,
    'minecraft:packed_ice': 0x7daad4,
    'minecraft:blue_ice': 0x5b9fd4,
    'minecraft:snow_block': 0xffffff,
    'minecraft:glowstone': 0xffdf7a,
    'minecraft:shroomlight': 0xf0a030,
    'minecraft:sea_lantern': 0xafd8d8,
    'minecraft:netherrack': 0x612929,
    'minecraft:nether_bricks': 0x2c1515,
    'minecraft:soul_sand': 0x5a4232,
    'minecraft:soul_soil': 0x4a3828,
    'minecraft:basalt': 0x474747,
    'minecraft:smooth_basalt': 0x4a4a4a,
    'minecraft:blackstone': 0x2a2226,
    'minecraft:deepslate': 0x474747,
    'minecraft:cobbled_deepslate': 0x494949,
    'minecraft:calcite': 0xe0ddd8,
    'minecraft:tuff': 0x7a7c6a,
    'minecraft:end_stone': 0xdad99b,
    'minecraft:purpur_block': 0xa66fa6,
    'minecraft:prismarine': 0x5a9e8b,
    'minecraft:dark_prismarine': 0x305d46,
    'minecraft:prismarine_bricks': 0x62b0a0,
    'minecraft:quartz_block': 0xeeeeee,
    'minecraft:smooth_quartz': 0xececec,
    'minecraft:iron_block': 0xd8d8d8,
    'minecraft:gold_block': 0xf5d340,
    'minecraft:diamond_block': 0x5decf5,
    'minecraft:emerald_block': 0x17dd62,
    'minecraft:redstone_block': 0xc41b07,
    'minecraft:lapis_block': 0x1b4ba4,
    'minecraft:coal_block': 0x1a1a1a,
    'minecraft:copper_block': 0xcb7248,
    'minecraft:cut_copper': 0xc87249,
    'minecraft:exposed_copper': 0xa08060,
    'minecraft:weathered_copper': 0x5a8060,
    'minecraft:oxidized_copper': 0x3a9070,
    'minecraft:amethyst_block': 0x8060c0,
    'minecraft:budding_amethyst': 0x7050b0,
    'minecraft:glass': 0xb3d8e6,
    'minecraft:tinted_glass': 0x4a3a50,
    'minecraft:hay_block': 0xc0a820,
    'minecraft:bookshelf': 0xa08040,
    'minecraft:crafting_table': 0x9a7040,
    'minecraft:furnace': 0x7a7a7a,
    'minecraft:chest': 0xa08040,
    'minecraft:mud': 0x4a3830,
    'minecraft:mud_bricks': 0x8a6a50,
    'minecraft:packed_mud': 0x7a5a40,
  };

  const getNameColor = (name: string): number | null => {
    if (!name || name.includes(':air') || name.includes('water') || name.includes('lava')) return null;
    if (BLOCK_NAME_COLORS[name] !== undefined) return BLOCK_NAME_COLORS[name];
    if (name.startsWith('minecraft:')) return 0x888888;
    return null;
  };

  const centerVoxels = (voxels: VoxelData[]) => {
    if (voxels.length === 0) return [];
    const minX = Math.min(...voxels.map((v) => v.x)),
      maxX = Math.max(...voxels.map((v) => v.x));
    const minZ = Math.min(...voxels.map((v) => v.z)),
      maxZ = Math.max(...voxels.map((v) => v.z));
    const minY = Math.min(...voxels.map((v) => v.y));
    const cx = (minX + maxX) / 2,
      cz = (minZ + maxZ) / 2;
    return voxels.map((v) => ({ ...v, x: Math.round(v.x - cx), y: v.y - minY, z: Math.round(v.z - cz) }));
  };

  if ('Regions' in root) {
    const regions = root['Regions'] as Record<string, any>;
    const regionName = Object.keys(regions)[0];
    if (!regionName) throw new Error('No regions found in litematic file');
    const region = regions[regionName];
    const size = region['Size'] as Record<string, number>;
    const sizeX = Math.abs(size['x']),
      sizeY = Math.abs(size['y']),
      sizeZ = Math.abs(size['z']);
    const paletteFull: Record<string, any>[] = region['BlockStatePalette'] || [];
    const palette: string[] = paletteFull.map((b: any) => b['Name'] || 'minecraft:air');
    const blockStates: bigint[] = region['BlockStates'] || [];
    const bitsPerBlock = litematicBitsPerBlock(palette.length);
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
    const palette: string[] = (root['palette'] as Record<string, any>[]).map(
      (b: any) => b['Name'] || 'minecraft:air',
    );
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

  const w = root['Width'],
    h = root['Height'],
    d = root['Length'];
  const blocks: Uint8Array = root['Blocks'],
    data: Uint8Array = root['Data'];
  if (!w || !h || !d || !blocks)
    throw new Error(
      'Unrecognized Minecraft file format. Supported: .schematic, .litematic, .nbt (structure)',
    );

  const BLOCK_COLORS: Record<number, Record<number, [number, number, number]>> = {
    35: {
      0: [221, 221, 221],
      1: [219, 125, 62],
      2: [179, 80, 188],
      3: [107, 138, 201],
      4: [177, 166, 39],
      5: [65, 174, 56],
      6: [208, 132, 153],
      7: [64, 64, 64],
      8: [154, 161, 161],
      9: [46, 110, 137],
      10: [126, 61, 181],
      11: [46, 56, 141],
      12: [79, 50, 31],
      13: [54, 76, 24],
      14: [150, 51, 48],
      15: [25, 22, 22],
    },
    251: {
      0: [207, 213, 214],
      1: [224, 97, 0],
      2: [169, 48, 159],
      3: [36, 137, 199],
      4: [240, 175, 21],
      5: [94, 168, 24],
      6: [213, 101, 142],
      7: [54, 57, 61],
      8: [125, 125, 115],
      9: [21, 119, 136],
      10: [100, 31, 156],
      11: [44, 46, 143],
      12: [96, 59, 31],
      13: [72, 91, 36],
      14: [142, 32, 32],
      15: [8, 10, 15],
    },
    159: {
      0: [210, 178, 161],
      1: [162, 84, 38],
      2: [149, 88, 108],
      3: [113, 108, 137],
      4: [186, 133, 36],
      5: [103, 117, 53],
      6: [161, 78, 78],
      7: [57, 42, 35],
      8: [135, 107, 98],
      9: [87, 91, 91],
      10: [118, 70, 86],
      11: [74, 59, 91],
      12: [77, 51, 35],
      13: [76, 82, 42],
      14: [143, 61, 46],
      15: [37, 22, 16],
    },
    1: { 0: [125, 125, 125] },
    2: { 0: [95, 159, 53] },
    3: { 0: [134, 96, 67] },
    4: { 0: [127, 127, 127] },
    5: { 0: [162, 130, 78] },
    12: { 0: [219, 207, 163] },
    13: { 0: [136, 126, 126] },
    45: { 0: [150, 97, 83] },
    49: { 0: [21, 18, 30] },
    79: { 0: [145, 183, 211] },
    80: { 0: [255, 255, 255] },
    87: { 0: [97, 41, 41] },
    88: { 0: [81, 62, 50] },
    89: { 0: [255, 223, 122] },
  };
  const voxels: VoxelData[] = [];
  for (let y = 0; y < h; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) {
        const idx = y * w * d + z * w + x;
        const blockId = blocks[idx];
        if (!blockId) continue;
        const meta = data ? Math.min(data[idx], 15) : 0;
        const blockColors = BLOCK_COLORS[blockId];
        if (!blockColors) continue;
        const rgb = blockColors[meta] ?? blockColors[0];
        if (!rgb) continue;
        voxels.push({ x, y, z, color: (rgb[0] << 16) | (rgb[1] << 8) | rgb[2] });
      }
  return centerVoxels(voxels);
}
