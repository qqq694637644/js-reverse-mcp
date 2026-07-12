/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {constants as fsConstants} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';

import {
  allocateSecureArtifactDirectory,
  assertBrowserUrlAllowed,
  assertLocalFileReadAllowed,
  assertLocalFileWriteAllowed,
  configureAllowedRoots,
  getAllowedRoots,
  openSecureArtifactFile,
} from '../src/LocalFileAccess.js';
import {McpContext} from '../src/McpContext.js';
import {ToolError} from '../src/ToolError.js';

afterEach(() => configureAllowedRoots());

test('allowed roots permit contained reads and writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-root-'));
  const input = path.join(root, 'input.txt');
  await fs.writeFile(input, 'ok');

  try {
    const realRoot = await fs.realpath(root);
    configureAllowedRoots([root]);
    assert.equal(assertLocalFileReadAllowed(input), await fs.realpath(input));
    assert.equal(
      assertLocalFileWriteAllowed(path.join(root, 'output.txt')),
      path.join(realRoot, 'output.txt'),
    );
    assert.deepEqual(getAllowedRoots(), [realRoot]);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('allowed roots reject direct and symlink escapes', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-roots-'));
  const root = path.join(parent, 'allowed');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'secret');
  await fs.symlink(outside, path.join(root, 'escape'));

  try {
    configureAllowedRoots([root]);
    for (const candidate of [secret, path.join(root, 'escape', 'secret.txt')]) {
      assert.throws(
        () => assertLocalFileReadAllowed(candidate),
        (error: unknown) =>
          error instanceof ToolError && error.code === 'PERMISSION_DENIED',
      );
    }
    assert.throws(
      () => assertLocalFileWriteAllowed(path.join(root, 'escape', 'new.txt')),
      (error: unknown) =>
        error instanceof ToolError && error.code === 'PERMISSION_DENIED',
    );
  } finally {
    await fs.rm(parent, {recursive: true, force: true});
  }
});

test('allowed roots reject a dangling symlink that targets outside', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-dangling-'));
  const root = path.join(parent, 'allowed');
  const outside = path.join(parent, 'outside');
  const outsideFile = path.join(outside, 'created.txt');
  const link = path.join(root, 'output.txt');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(outsideFile, link);

  try {
    configureAllowedRoots([root]);
    assert.throws(
      () => assertLocalFileWriteAllowed(link),
      (error: unknown) =>
        error instanceof ToolError && error.code === 'PERMISSION_DENIED',
    );
    await assert.rejects(
      McpContext.prototype.saveFile.call(
        {logger: () => undefined} as unknown as McpContext,
        new TextEncoder().encode('escape'),
        link,
        {confirmOverwrite: true},
      ),
      (error: unknown) =>
        error instanceof ToolError && error.code === 'PERMISSION_DENIED',
    );
    await assert.rejects(fs.stat(outsideFile), {code: 'ENOENT'});
  } finally {
    await fs.rm(parent, {recursive: true, force: true});
  }
});

test('omitting allowed roots preserves unrestricted compatibility', () => {
  configureAllowedRoots();
  assert.equal(
    assertLocalFileReadAllowed(import.meta.filename),
    import.meta.filename,
  );
});

test('secure stream artifact allocation requires an allowed root', async () => {
  configureAllowedRoots();
  await assert.rejects(
    allocateSecureArtifactDirectory('0'),
    (error: unknown) =>
      error instanceof ToolError && error.code === 'PERMISSION_DENIED',
  );
});

test('stream artifact root selector chooses an explicit allowed root', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-stream-roots-'));
  const first = path.join(parent, 'first');
  const second = path.join(parent, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  try {
    configureAllowedRoots([first, second]);
    const allocated = await allocateSecureArtifactDirectory('1');
    assert.equal(allocated.rootIndex, 1);
    assert.equal(allocated.rootPath, (await getAllowedRoots())?.[1]);
    assert.equal(
      allocated.absoluteDir.startsWith(await fs.realpath(second)),
      true,
    );
  } finally {
    await fs.rm(parent, {recursive: true, force: true});
  }
});

test('stream artifact allocation rejects a symlink parent', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-stream-link-'));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'js-reverse-streams'), 'junction');
  try {
    configureAllowedRoots([root]);
    await assert.rejects(
      allocateSecureArtifactDirectory('0'),
      (error: unknown) =>
        error instanceof ToolError && error.code === 'PERMISSION_DENIED',
    );
  } finally {
    await fs.rm(parent, {recursive: true, force: true});
  }
});

test('secure artifact open rejects a capture directory replaced by a symlink', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-stream-swap-'));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  try {
    configureAllowedRoots([root]);
    const allocated = await allocateSecureArtifactDirectory('0');
    const original = `${allocated.absoluteDir}.original`;
    await fs.rename(allocated.absoluteDir, original);
    await fs.symlink(outside, allocated.absoluteDir, 'junction');
    await assert.rejects(
      openSecureArtifactFile(
        allocated.rootPath,
        allocated.absoluteDir,
        'escape.bin',
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      ),
      (error: unknown) =>
        error instanceof ToolError && error.code === 'PERMISSION_DENIED',
    );
  } finally {
    await fs.rm(parent, {recursive: true, force: true});
  }
});

test('allowed roots disable browser file and view-source:file pages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-browser-root-'));
  try {
    configureAllowedRoots([root]);
    for (const url of [
      'file:///tmp/secret.txt',
      'view-source:file:///tmp/secret.txt',
      'VIEW-SOURCE: view-source:file:///tmp/secret.txt',
      'filesystem:file:///tmp/secret.txt',
    ]) {
      assert.throws(
        () => assertBrowserUrlAllowed(url),
        (error: unknown) =>
          error instanceof ToolError && error.code === 'PERMISSION_DENIED',
      );
    }
    assert.doesNotThrow(() => assertBrowserUrlAllowed('https://example.test'));
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
