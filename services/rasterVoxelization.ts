import type { VoxelData } from '../types';

/** Shared image/text conversion; transparent images can become solid extruded sprites. */
export function rasterVoxels(
  { data, width, height }: Pick<ImageData, 'data' | 'width' | 'height'>,
  extrusion = 0,
): VoxelData[] {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  )
    throw new Error('Invalid raster dimensions or pixel data.');
  const transparent = data.some((alpha, index) => index % 4 === 3 && alpha < 128);
  const depth = transparent ? extrusion : 0,
    voxels: VoxelData[] = [],
    cx = Math.floor(width / 2),
    cy = Math.floor(height / 2);
  if (!Number.isInteger(extrusion) || extrusion < 0 || extrusion > 64)
    throw new Error('Invalid sprite extrusion.');
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] <= 128) continue;
      const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      for (let z = 0; z <= depth; z++) voxels.push({ x: x - cx, y: cy - y, z, color });
      if (voxels.length > 250000)
        throw new Error('Raster conversion exceeds 250,000 voxels. Reduce its size or extrusion.');
    }
  return voxels;
}
export function loadRasterImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(),
      reader = new FileReader();
    reader.onload = () => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The image could not be decoded.'));
      image.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('The image file could not be read.'));
    reader.readAsDataURL(file);
  });
}
export function imageVoxels(image: HTMLImageElement) {
  const ratio = Math.min(1, 64 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(image.width * ratio));
  canvas.height = Math.max(1, Math.floor(image.height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not open the image conversion canvas.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return rasterVoxels(context.getImageData(0, 0, canvas.width, canvas.height), 8);
}
export function textVoxels(text: string, fontSize = 32, color = 0x3b82f6) {
  if (text.length > 256) throw new Error('Text generation supports up to 256 characters.');
  if (!Number.isFinite(fontSize) || fontSize < 1 || fontSize > 256)
    throw new Error('Text size must be between 1 and 256.');
  const canvas = document.createElement('canvas'),
    context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not open the text conversion canvas.');
  context.font = `bold ${fontSize}px sans-serif`;
  canvas.width = Math.ceil(context.measureText(text).width) + 4;
  canvas.height = Math.ceil(fontSize * 1.2);
  if (canvas.width > 8192) throw new Error('Text is too wide. Use a smaller font or fewer characters.');
  context.font = `bold ${fontSize}px sans-serif`;
  context.textBaseline = 'middle';
  context.fillStyle = 'white';
  context.fillText(text, 2, canvas.height / 2);
  return rasterVoxels(context.getImageData(0, 0, canvas.width, canvas.height)).map((voxel) => ({
    ...voxel,
    color,
  }));
}
