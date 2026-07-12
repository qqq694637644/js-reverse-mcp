/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {zod} from '../../src/third_party/index.js';
import {
  assertSafeStreamToolOutput,
  getStreamStatus,
  startStreamCapture,
  stopStreamCapture,
} from '../../src/tools/stream.js';

test('stream start schema does not accept a caller-provided output directory', () => {
  const parsed = zod
    .object(startStreamCapture.schema)
    .strict()
    .parse({
      urlFilter: '/conversation',
      methods: ['POST'],
      resourceTypes: ['fetch'],
    });
  assert.deepEqual(parsed, {
    urlFilter: '/conversation',
    methods: ['POST'],
    resourceTypes: ['fetch'],
  });
  assert.throws(
    () =>
      zod.object(startStreamCapture.schema).strict().parse({
        outputDir: '/tmp/user-controlled',
      }),
    /Unrecognized key|unrecognized key/i,
  );
});

test('stream tools expose only start, status, and stop responsibilities', () => {
  assert.equal(startStreamCapture.name, 'start_stream_capture');
  assert.equal(getStreamStatus.name, 'get_stream_status');
  assert.equal(stopStreamCapture.name, 'stop_stream_capture');
  for (const tool of [startStreamCapture, getStreamStatus, stopStreamCapture]) {
    assert.deepEqual(tool.capabilities, ['stream']);
  }
});

test('status schema defaults to bounded summaries', () => {
  const parsed = zod.object(getStreamStatus.schema).parse({captureId: 1});
  assert.equal(parsed.includeRecentChunks, false);
  assert.equal(parsed.pageIdx, 0);
  assert.equal(parsed.pageSize, 20);
});

test('recursive stream output guard rejects body and Base64 fields', () => {
  assert.doesNotThrow(() =>
    assertSafeStreamToolOutput({
      captureId: 1,
      relativePath: 'js-reverse-streams/capture-1/capture.json',
      recentEvents: [{index: 1, dataLength: 42}],
    }),
  );
  assert.throws(
    () => assertSafeStreamToolOutput({request: {dataBase64: 'AAAA'}}),
    /forbidden field/i,
  );
  assert.throws(
    () => assertSafeStreamToolOutput({request: {body: 'secret'}}),
    /forbidden field/i,
  );
  assert.throws(
    () => assertSafeStreamToolOutput({request: {data: 'event body'}}),
    /forbidden field/i,
  );
  assert.throws(
    () => assertSafeStreamToolOutput({request: {base64: 'AAAA'}}),
    /forbidden field/i,
  );
});

test('recursive stream output guard rejects overlong strings', () => {
  assert.throws(
    () => assertSafeStreamToolOutput({value: 'x'.repeat(8193)}),
    /overlong string/i,
  );
});
