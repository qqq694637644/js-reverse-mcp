/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {zod} from '../../src/third_party/index.js';
import {
  exportStreamCapture,
  getStreamChunks,
  startStreamCapture,
  stopStreamCapture,
} from '../../src/tools/stream.js';

test('stream capture schemas choose safe and useful defaults', () => {
  const start = zod.object(startStreamCapture.schema).parse({});
  assert.equal(start.urlFilter, undefined);
  assert.equal(start.mimeTypes, undefined);

  const get = zod
    .object(getStreamChunks.schema)
    .parse({captureId: 1, requestId: 'req-1'});
  assert.equal(get.view, 'events');
  assert.equal(get.pageIdx, 0);
  assert.equal(get.pageSize, 100);

  const exported = zod.object(exportStreamCapture.schema).parse({
    captureId: 1,
    outputFile: 'capture.json',
  });
  assert.equal(exported.format, 'json');
  assert.equal(exported.confirmOverwrite, false);
});

test('stream tools declare the stream capability', () => {
  for (const tool of [
    startStreamCapture,
    getStreamChunks,
    stopStreamCapture,
    exportStreamCapture,
  ]) {
    assert.deepEqual(tool.capabilities, ['stream']);
  }
});

test('raw stream export requires an unambiguous request id', async () => {
  await assert.rejects(
    exportStreamCapture.handler(
      {
        params: {
          captureId: 1,
          format: 'raw',
          outputFile: 'capture.bin',
          confirmOverwrite: false,
        },
      },
      {} as never,
      {
        getStreamCapture: () => ({
          id: 1,
          status: 'stopped',
          filter: {},
          createdAt: 0,
          requests: [],
          totalBytes: 0,
          totalChunks: 0,
          truncated: false,
          version: 0,
        }),
      } as never,
    ),
    /Raw export requires requestId/,
  );
});
