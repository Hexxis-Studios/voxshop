import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(projectRoot, '.voxshop', 'desktop-runtime');
const stageRoot = path.join(desktopRoot, 'install');
const resourcesRoot = path.join(desktopRoot, 'resources');
const sidecarRoot = path.join(projectRoot, 'src-tauri', 'binaries');
const sidecarOnly = process.argv.includes('--sidecar-only');

function targetTriple() {
  const arch = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[process.arch];
  if (!arch) throw new Error(`Unsupported VoxShop desktop architecture: ${process.arch}`);
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`;
  throw new Error(`VoxShop desktop builds currently support Windows and Linux, not ${process.platform}.`);
}

async function prepareSidecar() {
  const triple = targetTriple();
  const extension = process.platform === 'win32' ? '.exe' : '';
  const output = path.join(sidecarRoot, `voxshop-node-${triple}${extension}`);
  await mkdir(sidecarRoot, { recursive: true });
  await mkdir(resourcesRoot, { recursive: true });
  await copyFile(process.execPath, output);
  if (process.platform !== 'win32') await chmod(output, 0o755);
  return output;
}

function assertInsideDesktopRoot(target) {
  const relative = path.relative(desktopRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Refusing to replace a path outside the desktop build directory: ${target}`);
}

async function prepareResources() {
  assertInsideDesktopRoot(stageRoot);
  assertInsideDesktopRoot(resourcesRoot);
  await rm(stageRoot, { recursive: true, force: true });
  await rm(resourcesRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });
  const runtimeManifest = path.join(projectRoot, 'desktop', 'runtime');
  await copyFile(path.join(runtimeManifest, 'package.json'), path.join(stageRoot, 'package.json'));
  await copyFile(path.join(runtimeManifest, 'package-lock.json'), path.join(stageRoot, 'package-lock.json'));

  const npmCli = process.env.npm_execpath;
  if (!npmCli)
    throw new Error('Run desktop packaging through an npm script so the locked npm CLI is available.');
  const install = spawnSync(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], {
    cwd: stageRoot,
    stdio: 'inherit',
  });
  if (install.error) throw install.error;
  if (install.status !== 0)
    throw new Error(`Production dependency install failed with status ${install.status}.`);

  const threeRoot = path.join(stageRoot, 'node_modules', 'three');
  assertInsideDesktopRoot(threeRoot);
  await rm(path.join(threeRoot, 'examples'), { recursive: true, force: true });
  await rm(path.join(threeRoot, 'src'), { recursive: true, force: true });
  const threeBuild = path.join(threeRoot, 'build');
  for (const entry of await readdir(threeBuild, { withFileTypes: true })) {
    if (entry.isFile() && !['three.module.js', 'three.core.js'].includes(entry.name))
      await rm(path.join(threeBuild, entry.name), { force: true });
  }

  await mkdir(resourcesRoot, { recursive: true });
  await cp(path.join(projectRoot, 'dist'), path.join(resourcesRoot, 'dist'), { recursive: true });
  await cp(path.join(projectRoot, 'dist-server'), path.join(resourcesRoot, 'dist-server'), {
    recursive: true,
  });
  await cp(path.join(projectRoot, 'skills'), path.join(resourcesRoot, 'skills'), { recursive: true });
  await cp(path.join(stageRoot, 'node_modules'), path.join(resourcesRoot, 'node_modules'), {
    recursive: true,
  });
  async function pruneDevelopmentFiles(directory) {
    assertInsideDesktopRoot(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^(?:tests?|__tests__|\.github|coverage|benchmarks?|examples?)$/i.test(entry.name))
          await rm(filename, { recursive: true, force: true });
        else await pruneDevelopmentFiles(filename);
      } else if (entry.isFile() && /\.(?:test|spec)\.[cm]?js$|\.map$/.test(entry.name))
        await rm(filename, { force: true });
    }
  }
  await pruneDevelopmentFiles(path.join(resourcesRoot, 'node_modules'));
  // npm's .bin links point back into this temporary install, which is removed below.
  // The packaged server imports dependencies directly and does not need CLI shims.
  await rm(path.join(resourcesRoot, 'node_modules', '.bin'), { recursive: true, force: true });
  // AppImage scans every native addon, so keep only the glibc-compatible resvg binding.
  if (process.platform === 'linux' && process.report?.getReport().header.glibcVersionRuntime) {
    await rm(path.join(resourcesRoot, 'node_modules', '@resvg', `resvg-js-linux-${process.arch}-musl`), {
      recursive: true,
      force: true,
    });
  }
  await copyFile(path.join(projectRoot, 'LICENSE'), path.join(resourcesRoot, 'LICENSE'));
  await copyFile(
    path.join(projectRoot, 'COMMERCIAL-LICENSE.md'),
    path.join(resourcesRoot, 'COMMERCIAL-LICENSE.md'),
  );
  await cp(path.join(projectRoot, 'licenses'), path.join(resourcesRoot, 'licenses'), { recursive: true });
  const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  await writeFile(
    path.join(resourcesRoot, 'package.json'),
    JSON.stringify({ name: 'voxshop-desktop-runtime', version, private: true, type: 'module' }, null, 2),
  );
  await rm(stageRoot, { recursive: true, force: true });
}

const sidecar = await prepareSidecar();
if (!sidecarOnly) {
  await prepareResources();
  const bootstrap = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      'build',
      '--config',
      'vite.desktop.config.ts',
    ],
    {
      cwd: projectRoot,
      stdio: 'inherit',
    },
  );
  if (bootstrap.error) throw bootstrap.error;
  if (bootstrap.status !== 0)
    throw new Error(`Desktop bootstrap build failed with status ${bootstrap.status}.`);
  const { size } = await stat(sidecar);
  console.log(
    `Prepared ${targetTriple()} Node sidecar (${(size / 1024 / 1024).toFixed(1)} MiB) and production resources.`,
  );
}
