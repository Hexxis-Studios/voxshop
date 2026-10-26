const LOCAL_RESOURCE_ORIGIN = 'https://voxshop-local-import.invalid/';

export type GltfImportFile = Pick<File, 'name'> & { webkitRelativePath?: string };

function normalizeRelativePath(value: string) {
  const parts = value.replaceAll('\\', '/').split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (normalized.length) normalized.pop();
      else normalized.push('..');
      continue;
    }
    normalized.push(part);
  }
  return normalized.join('/');
}

function importPath(file: GltfImportFile) {
  const path = normalizeRelativePath(file.webkitRelativePath || file.name);
  if (!path || path.startsWith('../') || path === '..' || /^[a-zA-Z]:/.test(path))
    throw new Error(`Could not determine a safe local path for "${file.name}".`);
  return path;
}

/** Maps glTF references to files the user selected, and rejects every unselected or remote URL. */
export function createGltfFileResolver(
  mainFile: GltfImportFile,
  selectedFiles: readonly GltfImportFile[],
  createObjectUrl: (file: GltfImportFile) => string = (file) => URL.createObjectURL(file as unknown as Blob),
) {
  const mainPath = importPath(mainFile);
  const directory = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
  const baseUrl = new URL(directory, LOCAL_RESOURCE_ORIGIN).href;
  const filesByPath = new Map<string, GltfImportFile[]>();
  const filesByName = new Map<string, GltfImportFile[]>();
  for (const file of selectedFiles) {
    const path = importPath(file);
    const pathMatches = filesByPath.get(path) ?? [];
    pathMatches.push(file);
    filesByPath.set(path, pathMatches);
    const name = path.split('/').at(-1)!;
    const nameMatches = filesByName.get(name) ?? [];
    nameMatches.push(file);
    filesByName.set(name, nameMatches);
  }

  const urls = new Map<GltfImportFile, string>();
  let disposed = false;
  const resolve = (requestedUrl: string) => {
    if (/^data:/i.test(requestedUrl)) return requestedUrl;
    let resolved: URL;
    try {
      resolved = new URL(requestedUrl, baseUrl);
    } catch {
      throw new Error(`glTF contains an invalid resource URL: "${requestedUrl}".`);
    }
    if (resolved.origin !== new URL(LOCAL_RESOURCE_ORIGIN).origin)
      throw new Error(
        `glTF references a remote resource ("${requestedUrl}"). Select the local files it uses; remote resources are not loaded.`,
      );

    let resourcePath: string;
    try {
      resourcePath = normalizeRelativePath(decodeURIComponent(resolved.pathname.replace(/^\/+/, '')));
    } catch {
      throw new Error(`glTF contains an invalid resource path: "${requestedUrl}".`);
    }
    const exactMatches = filesByPath.get(resourcePath) ?? [];
    const filename = resourcePath.split('/').at(-1) ?? '';
    const matches = exactMatches.length ? exactMatches : (filesByName.get(filename) ?? []);
    if (matches.length > 1)
      throw new Error(
        `glTF resource "${resourcePath}" matches more than one selected file. Import the containing folder to preserve subfolders.`,
      );
    const file = matches[0];
    if (!file)
      throw new Error(
        `glTF references "${resourcePath}", but that file was not selected. Choose the glTF with its referenced files, or import the containing folder.`,
      );
    let objectUrl = urls.get(file);
    if (!objectUrl) {
      if (disposed) throw new Error('glTF resource resolver was already disposed.');
      objectUrl = createObjectUrl(file);
      if (!/^(blob|data):/i.test(objectUrl))
        throw new Error('Local glTF resources must be loaded from a browser object URL.');
      urls.set(file, objectUrl);
    }
    return objectUrl;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const url of urls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    urls.clear();
  };

  return { baseUrl, resolve, dispose };
}
