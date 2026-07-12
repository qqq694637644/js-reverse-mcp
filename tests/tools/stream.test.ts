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
  getStreamStatus,
  startStreamCapture,
  stopStreamCapture,
} from '../../src/tools/stream.js';

test('stream capture schemas require an output directory and use small status defaults', () => {
  assert.throws(
    () => zod.object(startStreamCapture.schema).parse({}),
    /outputDir/,
  );
  const start = zod.object(startStreamCapture.schema).parse({
    outputDir: 'captures/exp-1/stream-1',
  });
  assert.equal(start.urlFilter, undefined);
  assert.equal(start.mimeTypes, undefined);

  const status = zod
    .object(getStreamStatus.schema)
    .parse({captureId: 1, requestId: 'req-1'});
  assert.equal(status.includeChunks, false);
  assert.equal(status.pageIdx, 0);
  assert.equal(status.pageSize, 100);

  const exported = zod.object(exportStreamCapture.schema).parse({
    captureId: 1,
  });
  assert.equal(exported.requestId, undefined);
});

test('stream tools declare the stream capability', () => {
  for (const tool of [
    startStreamCapture,
    getStreamStatus,
    stopStreamCapture,
    exportStreamCapture,
  ]) {
    assert.deepEqual(tool.capabilities, ['stream']);
  }
});

test('stream status and export descriptions forbid large Base64 MCP output', () => {
  assert.match(getStreamStatus.description, /never returns CDP Base64/i);
  assert.match(exportStreamCapture.description, /never returns.*Base64/i);
  assert.match(startStreamCapture.description, /decoded immediately/i);
});
