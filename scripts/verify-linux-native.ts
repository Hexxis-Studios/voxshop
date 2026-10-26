import assert from 'node:assert/strict';
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

const dataHome = process.argv[2] && path.resolve(process.argv[2]);
const evidenceDirectory = process.argv[3] && path.resolve(process.argv[3]);
if (!dataHome || !evidenceDirectory)
  throw new Error('Pass the isolated XDG data home and a separate evidence output directory.');

const deadline = Date.now() + 90_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function findAccessFile(directory: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === 'access.json') return target;
    if (entry.isDirectory()) {
      const result = await findAccessFile(target, depth + 1);
      if (result) return result;
    }
  }
  return null;
}

async function waitForAccessFile() {
  while (Date.now() < deadline) {
    const file = await findAccessFile(dataHome!);
    if (file) {
      try {
        const access = JSON.parse(await fs.readFile(file, 'utf8')) as { url?: unknown; token?: unknown };
        if (typeof access.url === 'string' && typeof access.token === 'string') return access;
      } catch {
        // The sidecar may be midway through writing its startup record.
      }
    }
    await sleep(250);
  }
  throw new Error(`The installed app did not write access.json under isolated XDG_DATA_HOME: ${dataHome}`);
}

function decodeCanvasPng(png: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.subarray(0, 8).equals(signature), 'Viewport returned an invalid PNG signature.');
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const imageData: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    assert.ok(end + 4 <= png.length, `PNG ${kind} chunk exceeds the image length.`);
    if (kind === 'IHDR') {
      assert.equal(length, 13, 'PNG IHDR chunk must be 13 bytes.');
      width = png.readUInt32BE(start);
      height = png.readUInt32BE(start + 4);
      bitDepth = png[start + 8]!;
      colorType = png[start + 9]!;
      interlace = png[start + 12]!;
    } else if (kind === 'IDAT') imageData.push(png.subarray(start, end));
    offset = end + 4;
    if (kind === 'IEND') break;
  }
  assert.ok(width > 0 && height > 0, 'PNG dimensions must be positive.');
  assert.equal(bitDepth, 8, 'Native viewport PNG must use 8-bit channels.');
  assert.ok(colorType === 6 || colorType === 2, `Unsupported viewport PNG color type ${colorType}.`);
  assert.equal(interlace, 0, 'Native viewport PNG must not be interlaced.');
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(imageData));
  assert.equal(
    raw.length,
    height * (rowBytes + 1),
    'Decoded PNG scanline size does not match its dimensions.',
  );

  const pixels = Buffer.alloc(height * rowBytes);
  const paeth = (left: number, up: number, upLeft: number) => {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const diagonalDistance = Math.abs(estimate - upLeft);
    return leftDistance <= upDistance && leftDistance <= diagonalDistance
      ? left
      : upDistance <= diagonalDistance
        ? up
        : upLeft;
  };
  for (let y = 0; y < height; y++) {
    const sourceStart = y * (rowBytes + 1);
    const filter = raw[sourceStart]!;
    const targetStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[sourceStart + x + 1]!;
      const left = x >= bytesPerPixel ? pixels[targetStart + x - bytesPerPixel]! : 0;
      const up = y > 0 ? pixels[targetStart + x - rowBytes]! : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[targetStart + x - rowBytes - bytesPerPixel]! : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, upLeft)
                  : -1;
      assert.ok(predictor >= 0, `Unsupported PNG filter ${filter}.`);
      pixels[targetStart + x] = (value + predictor) & 0xff;
    }
  }

  const colors = new Set<number>();
  let sampled = 0,
    opaque = 0;
  const sampleStride = Math.max(1, Math.floor(Math.sqrt((width * height) / 20_000)));
  for (let y = 0; y < height; y += sampleStride) {
    for (let x = 0; x < width; x += sampleStride) {
      const index = (y * width + x) * bytesPerPixel;
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      const alpha = colorType === 6 ? pixels[index + 3]! : 255;
      sampled++;
      if (alpha > 240) opaque++;
      if (colors.size < 256) colors.add((red << 16) | (green << 8) | blue);
    }
  }
  assert.ok(colors.size >= 8, `Viewport PNG looks blank or uniform (${colors.size} sampled colors).`);
  assert.ok(opaque / sampled > 0.5, 'Viewport PNG has too few opaque pixels.');
  return { width, height, sampledColors: colors.size, opaqueFraction: opaque / sampled };
}

const readJson = async (response: Response) => {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Expected JSON from VoxShop (${response.status} ${response.statusText}).`);
  }
  if (!response.ok) {
    const error = parsed as { error?: unknown };
    throw new Error(
      `VoxShop API returned ${response.status}: ${typeof error.error === 'string' ? error.error : response.statusText}`,
    );
  }
  return parsed as Record<string, any>;
};

const access = await waitForAccessFile();
const serviceUrl = new URL(access.url as string);
assert.ok(
  serviceUrl.protocol === 'http:' && ['127.0.0.1', '::1', '[::1]'].includes(serviceUrl.hostname),
  'Installed sidecar must expose a loopback HTTP URL.',
);
assert.ok((access.token as string).length >= 32, 'Installed sidecar must write a session token.');
const api = async (route: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(route, serviceUrl), {
    ...init,
    headers: {
      'X-VoxShop-Token': access.token as string,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  return readJson(response);
};

await fs.mkdir(evidenceDirectory, { recursive: true });
const session = await api('/api/session');
assert.ok(session.token === access.token, 'The sidecar session and app access file must agree.');
const project = await api('/api/examples', {
  method: 'POST',
  body: JSON.stringify({ kind: 'exploration', id: `linux-native-${Date.now()}` }),
});
assert.equal(typeof project.id, 'string');
assert.equal(typeof project.revision, 'number');
await api(`/api/projects/${encodeURIComponent(project.id)}/activate`, { method: 'POST', body: '{}' });

let editor: { id: string; origin?: string } | undefined;
const viewportDeadline = Date.now() + 90_000;
while (Date.now() < viewportDeadline) {
  const result = await api('/api/viewport/');
  const clients = Array.isArray(result.clients) ? result.clients : [];
  if (clients.length === 1) {
    editor = clients[0];
    break;
  }
  if (clients.length > 1)
    throw new Error(`Expected one native editor viewport client; found ${clients.length}.`);
  await sleep(250);
}
assert.ok(editor, 'The installed Tauri WebKitGTK editor did not register a viewport client.');
assert.equal(typeof editor.id, 'string');
assert.equal(typeof editor.origin, 'string', 'The actual editor must report its webview origin.');
assert.equal(
  editor.origin,
  serviceUrl.origin,
  'Viewport client must be the app-served Tauri webview origin.',
);

async function observe(label: string, command: { type: 'capture' | 'play' }) {
  let lastError = 'No request was made.';
  const retryDeadline = Date.now() + 90_000;
  while (Date.now() < retryDeadline) {
    const response = await fetch(new URL('/api/viewport/request', serviceUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VoxShop-Token': access.token as string },
      body: JSON.stringify({
        projectId: project.id,
        expectedRevision: project.revision,
        clientId: editor!.id,
        command,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(response).catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (body) {
      const image = typeof body.image === 'string' ? body.image : '';
      assert.match(image, /^data:image\/png;base64,/);
      assert.equal(body.projectId, project.id);
      assert.equal(body.revision, project.revision);
      const observation = body.observation as Record<string, any>;
      assert.equal(observation.projectId, project.id);
      assert.equal(observation.revision, project.revision);
      const png = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64');
      const imageStats = decodeCanvasPng(png);
      assert.equal(imageStats.width, observation.width);
      assert.equal(imageStats.height, observation.height);
      return { observation, imageStats, png };
    }
    if (!/still opening|does not match|Project changed/i.test(lastError)) throw new Error(lastError);
    await sleep(250);
  }
  throw new Error(`The native editor did not render ${label}: ${lastError}`);
}

const editorCapture = await observe('editor', { type: 'capture' });
assert.ok(
  editorCapture.observation.render.calls > 0,
  'Editor screenshot must have completed renderer calls.',
);
const playCapture = await observe('play', { type: 'play' });
assert.equal(
  playCapture.observation.state?.status,
  'playing',
  'Play viewport must report an active simulation.',
);
assert.ok(playCapture.observation.render.calls > 0, 'Play screenshot must have completed renderer calls.');
assert.ok(playCapture.observation.render.triangles > 0, 'Play screenshot must render scene triangles.');

const evidencePublicKeyPem = process.env.VOXSHOP_LINUX_EVIDENCE_PUBLIC_KEY_PEM?.trim();
if (evidencePublicKeyPem) {
  const publicPem =
    /^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END \1-----$/;
  assert.ok(
    publicPem.test(evidencePublicKeyPem),
    'evidence_public_key_pem must contain exactly one RSA public-key PEM; private keys are rejected.',
  );
  let publicKey;
  try {
    publicKey = createPublicKey(evidencePublicKeyPem);
  } catch {
    throw new Error('evidence_public_key_pem must be a valid RSA public key PEM.');
  }
  const modulusLength = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
  assert.ok(
    publicKey.asymmetricKeyType === 'rsa' && modulusLength >= 2048 && modulusLength <= 8192,
    'evidence_public_key_pem must be an RSA key between 2048 and 8192 bits.',
  );
  const bundle = {
    version: 1,
    summary: {
      product: 'VoxShop',
      runtime: 'Installed Tauri desktop shell with its WebKitGTK viewport',
      renderer: 'Mesa software renderer under Xvfb; this is visual evidence, not an FPS measurement.',
      captures: {
        editor: { ...editorCapture.imageStats, calls: editorCapture.observation.render.calls },
        play: {
          ...playCapture.imageStats,
          calls: playCapture.observation.render.calls,
          triangles: playCapture.observation.render.triangles,
          status: playCapture.observation.state.status,
        },
      },
      recordedAt: new Date().toISOString(),
    },
    screenshots: {
      'editor.png': editorCapture.png.toString('base64'),
      'play.png': playCapture.png.toString('base64'),
    },
  };
  const contentKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()]);
  const wrappedKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    contentKey,
  );
  const envelope = {
    format: 'voxshop-linux-native-evidence',
    version: 1,
    keyWrapping: 'RSA-OAEP-SHA256',
    contentEncryption: 'AES-256-GCM',
    wrappedKey: wrappedKey.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  await fs.writeFile(
    path.join(evidenceDirectory, 'linux-native-evidence-v1.sealed.json'),
    JSON.stringify(envelope) + '\n',
    { mode: 0o600 },
  );
  console.log('Encrypted native editor evidence is ready for private review.');
} else {
  console.log('Native editor acceptance passed; screenshot evidence was not saved or uploaded.');
}
console.log('Installed VoxShop Linux Tauri editor and Play viewport checks passed.');
