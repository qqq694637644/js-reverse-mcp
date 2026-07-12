/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import {ToolError} from './ToolError.js';

let allowedRoots: string[] | undefined;

function canonicalRealPath(value: string): string {
  return fs.realpathSync.native(path.resolve(value));
}

export interface SecureArtifactDirectory {
  rootIndex: number;
  rootPath: string;
  absoluteDir: string;
  relativeDir: string;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function assertWithinAllowedRoots(candidate: string): void {
  if (!allowedRoots) {
    return;
  }
  if (allowedRoots.some(root => isWithinRoot(candidate, root))) {
    return;
  }
  throw new ToolError(
    'PERMISSION_DENIED',
    `Local file access is outside the configured allowed roots: ${candidate}`,
  );
}

/**
 * Configure the optional local-file sandbox. Roots must already exist so their
 * real paths can be pinned before any tool call follows symlinks.
 */
export function configureAllowedRoots(roots?: readonly string[]): void {
  if (!roots?.length) {
    allowedRoots = undefined;
    return;
  }

  allowedRoots = [...new Set(roots.map(root => canonicalRealPath(root)))];
  for (const root of allowedRoots) {
    if (!fs.statSync(root).isDirectory()) {
      throw new Error(`Allowed root is not a directory: ${root}`);
    }
  }
}

export function getAllowedRoots(): readonly string[] | undefined {
  return allowedRoots;
}

export function resolveAllowedRootSelector(selector: string | undefined): {
  rootIndex: number;
  rootPath: string;
} {
  if (!allowedRoots?.length) {
    throw new ToolError(
      'PERMISSION_DENIED',
      'This operation requires at least one configured --allowedRoots directory.',
    );
  }
  if (!selector?.trim()) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'A deployment-controlled stream artifact root must be configured.',
    );
  }
  const trimmed = selector.trim();
  if (/^\d+$/.test(trimmed)) {
    const rootIndex = Number(trimmed);
    const rootPath = allowedRoots[rootIndex];
    if (!rootPath) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `Allowed-root index ${rootIndex} does not exist.`,
      );
    }
    return {rootIndex, rootPath};
  }
  let resolved: string;
  try {
    resolved = canonicalRealPath(trimmed);
  } catch (error) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `Stream artifact root does not exist: ${trimmed}`,
      {cause: error},
    );
  }
  const rootIndex = allowedRoots.indexOf(resolved);
  if (rootIndex === -1) {
    throw new ToolError(
      'PERMISSION_DENIED',
      'The configured stream artifact root must exactly match one configured allowed root.',
    );
  }
  return {rootIndex, rootPath: resolved};
}

async function assertDirectoryPathHasNoSymlink(
  rootPath: string,
  directoryPath: string,
): Promise<string> {
  const resolvedRoot = canonicalRealPath(rootPath);
  const requested = canonicalRealPath(directoryPath);
  if (!isWithinRoot(requested, resolvedRoot)) {
    throw new ToolError(
      'PERMISSION_DENIED',
      `Directory is outside the configured artifact root: ${requested}`,
    );
  }
  const relative = path.relative(resolvedRoot, requested);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fsPromises.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new ToolError(
        'PERMISSION_DENIED',
        `Refusing to use a symbolic-link directory for stream artifacts: ${current}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `Stream artifact path component is not a directory: ${current}`,
      );
    }
  }
  const realDirectory = canonicalRealPath(requested);
  if (!isWithinRoot(realDirectory, resolvedRoot)) {
    throw new ToolError(
      'PERMISSION_DENIED',
      `Stream artifact directory escaped the configured root: ${requested}`,
    );
  }
  return realDirectory;
}

export async function allocateSecureArtifactDirectory(
  selector: string | undefined,
  options: {parentName?: string; prefix?: string} = {},
): Promise<SecureArtifactDirectory> {
  const {rootIndex, rootPath} = resolveAllowedRootSelector(selector);
  const parentName = options.parentName ?? 'js-reverse-streams';
  const prefix = options.prefix ?? 'capture';
  if (!/^[a-zA-Z0-9_.-]+$/.test(parentName)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'Stream artifact parentName contains unsupported characters.',
    );
  }
  const parent = path.join(rootPath, parentName);
  try {
    await fsPromises.mkdir(parent, {mode: 0o700});
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error;
    }
  }
  const realParent = await assertDirectoryPathHasNoSymlink(rootPath, parent);
  const childName = `${prefix}-${Date.now()}-${randomUUID()}`;
  const candidate = path.join(realParent, childName);
  await fsPromises.mkdir(candidate, {mode: 0o700});
  const realCandidate = await assertDirectoryPathHasNoSymlink(
    rootPath,
    candidate,
  );
  if (path.dirname(realCandidate) !== realParent) {
    throw new ToolError(
      'PERMISSION_DENIED',
      'Stream artifact directory parent changed during allocation.',
    );
  }
  return {
    rootIndex,
    rootPath,
    absoluteDir: realCandidate,
    relativeDir: path.relative(rootPath, realCandidate),
  };
}

export async function createSecureSubdirectory(
  rootPath: string,
  parentDirectory: string,
  childName: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(childName)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `Unsupported stream artifact directory name: ${childName}`,
    );
  }
  const realParent = await assertDirectoryPathHasNoSymlink(
    rootPath,
    parentDirectory,
  );
  const parentBefore = await fsPromises.stat(realParent);
  const child = path.join(realParent, childName);
  await fsPromises.mkdir(child, {mode: 0o700});
  const parentAfter = await fsPromises.stat(realParent);
  if (
    parentBefore.dev !== parentAfter.dev ||
    parentBefore.ino !== parentAfter.ino
  ) {
    throw new ToolError(
      'PERMISSION_DENIED',
      'Stream artifact parent directory changed during creation.',
    );
  }
  const realChild = await assertDirectoryPathHasNoSymlink(rootPath, child);
  if (path.dirname(realChild) !== realParent) {
    throw new ToolError(
      'PERMISSION_DENIED',
      'Stream artifact subdirectory parent changed during creation.',
    );
  }
  return realChild;
}

export async function openSecureArtifactFile(
  rootPath: string,
  baseDirectory: string,
  relativeFilePath: string,
  flags: number,
  mode = 0o600,
) {
  const normalized = path.normalize(relativeFilePath);
  if (
    path.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new ToolError(
      'PERMISSION_DENIED',
      `Artifact file path escapes its capture directory: ${relativeFilePath}`,
    );
  }
  const realBase = await assertDirectoryPathHasNoSymlink(
    rootPath,
    baseDirectory,
  );
  const parent = path.join(realBase, path.dirname(normalized));
  const realParent = await assertDirectoryPathHasNoSymlink(rootPath, parent);
  const parentBefore = await fsPromises.stat(realParent);
  const filename = path.join(parent, path.basename(normalized));
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await fsPromises.open(
      filename,
      flags | fs.constants.O_NOFOLLOW,
      mode,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `Stream artifact target is not a regular file: ${relativeFilePath}`,
      );
    }
    const parentAfter = await fsPromises.stat(realParent);
    if (
      parentBefore.dev !== parentAfter.dev ||
      parentBefore.ino !== parentAfter.ino
    ) {
      throw new ToolError(
        'PERMISSION_DENIED',
        'Stream artifact parent directory changed while opening a file.',
      );
    }
    const verifiedParent = canonicalRealPath(parent);
    if (verifiedParent !== realParent) {
      throw new ToolError(
        'PERMISSION_DENIED',
        'Stream artifact parent path changed while opening a file.',
      );
    }
    return {handle, absolutePath: filename};
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ELOOP' || error.code === 'EMLINK')
    ) {
      throw new ToolError(
        'PERMISSION_DENIED',
        `Refusing to open a symbolic-link artifact: ${relativeFilePath}`,
        {cause: error},
      );
    }
    throw error;
  }
}

export async function writeSecureAtomicArtifactFile(
  rootPath: string,
  baseDirectory: string,
  relativeFilePath: string,
  data: Uint8Array<ArrayBufferLike>,
): Promise<void> {
  const directory = path.dirname(relativeFilePath);
  const basename = path.basename(relativeFilePath);
  const temporaryName = path.join(
    directory,
    `.${basename}.${randomUUID()}.tmp`,
  );
  const targetDirectory = path.join(baseDirectory, directory);
  await assertDirectoryPathHasNoSymlink(rootPath, targetDirectory);
  const temporary = await openSecureArtifactFile(
    rootPath,
    baseDirectory,
    temporaryName,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  );
  try {
    await temporary.handle.writeFile(data);
    await temporary.handle.sync();
  } finally {
    await temporary.handle.close();
  }
  const targetPath = path.join(baseDirectory, relativeFilePath);
  try {
    await fsPromises.rename(temporary.absolutePath, targetPath);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'EEXIST' || error.code === 'EPERM')
    ) {
      const backupPath = `${targetPath}.${randomUUID()}.previous`;
      let backupCreated = false;
      try {
        await fsPromises.rename(targetPath, backupPath);
        backupCreated = true;
      } catch (backupError) {
        if (
          typeof backupError !== 'object' ||
          backupError === null ||
          !('code' in backupError) ||
          backupError.code !== 'ENOENT'
        ) {
          throw backupError;
        }
      }
      try {
        await fsPromises.rename(temporary.absolutePath, targetPath);
        if (backupCreated) {
          await fsPromises.rm(backupPath, {force: true}).catch(() => undefined);
        }
      } catch (replacementError) {
        await fsPromises
          .rm(temporary.absolutePath, {force: true})
          .catch(() => undefined);
        if (backupCreated) {
          await fsPromises
            .rename(backupPath, targetPath)
            .catch(() => undefined);
        }
        throw replacementError;
      }
    } else {
      await fsPromises
        .rm(temporary.absolutePath, {force: true})
        .catch(() => undefined);
      throw error;
    }
  }
  const realTarget = canonicalRealPath(targetPath);
  const realBase = canonicalRealPath(baseDirectory);
  if (!isWithinRoot(realTarget, realBase)) {
    throw new ToolError(
      'PERMISSION_DENIED',
      'Atomic artifact update escaped the capture directory.',
    );
  }
}

export function assertLocalFileReadAllowed(filePath: string): string {
  const resolved = canonicalRealPath(filePath);
  assertWithinAllowedRoots(resolved);
  return resolved;
}

export async function openLocalFileReadAllowed(filePath: string) {
  const resolved = assertLocalFileReadAllowed(filePath);
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await fsPromises.open(
      resolved,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      throw new ToolError(
        'INVALID_ARGUMENT',
        `Local file input must be a regular file: ${resolved}`,
      );
    }
    return {handle, resolvedPath: resolved, stat};
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ELOOP' || error.code === 'EMLINK')
    ) {
      throw new ToolError(
        'PERMISSION_DENIED',
        `Refusing to read through a symbolic link: ${resolved}`,
        {cause: error},
      );
    }
    throw error;
  }
}

export function assertLocalFileWriteAllowed(filePath: string): string {
  const resolved = path.resolve(filePath);
  let candidate: string;
  let targetExists = false;
  try {
    const stat = fs.lstatSync(resolved);
    targetExists = true;
    if (stat.isSymbolicLink()) {
      try {
        candidate = canonicalRealPath(resolved);
      } catch (error) {
        throw new ToolError(
          'PERMISSION_DENIED',
          `Refusing to write through an unresolved symbolic link: ${resolved}`,
          {cause: error},
        );
      }
    } else {
      candidate = canonicalRealPath(resolved);
    }
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
    const parent = canonicalRealPath(path.dirname(resolved));
    candidate = path.join(parent, path.basename(resolved));
  }
  assertWithinAllowedRoots(candidate);
  if (targetExists && !fs.statSync(candidate).isFile()) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `Local file output must target a regular file: ${candidate}`,
    );
  }
  return candidate;
}

function unwrapViewSource(url: string): string {
  let result = url.trim();
  while (/^view-source:/i.test(result)) {
    result = result.slice('view-source:'.length).trimStart();
  }
  return result;
}

export function isBlockedLocalBrowserUrl(url: string): boolean {
  if (!allowedRoots) {
    return false;
  }
  const unwrapped = unwrapViewSource(url);
  try {
    const parsed = new URL(unwrapped);
    return parsed.protocol === 'file:' || /^filesystem:file:/i.test(unwrapped);
  } catch {
    return false;
  }
}

export function assertBrowserUrlAllowed(url: string): void {
  if (!isBlockedLocalBrowserUrl(url)) {
    return;
  }
  throw new ToolError(
    'PERMISSION_DENIED',
    'file: browser pages are disabled while --allowedRoots is configured.',
  );
}

export function formatBrowserUrlForOutput(url: string): string {
  return isBlockedLocalBrowserUrl(url)
    ? '[blocked local file page: --allowedRoots is configured]'
    : url;
}
