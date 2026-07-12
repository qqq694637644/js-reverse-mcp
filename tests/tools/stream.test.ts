/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import type {StreamCapture} from '../../src/StreamCollector.js';
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

test('filter arrays reject empty values', () => {
  for (const field of ['methods', 'resourceTypes', 'mimeTypes'] as const) {
    assert.throws(
      () =>
        zod.object(startStreamCapture.schema).parse({
          [field]: [],
        }),
      /too_small|at least 1|array/i,
    );
  }
});

test('stop runtime validation returns only capture and request metadata artifacts', async () => {
  const metadata = {
    artifactId: 'stream-1-capture-metadata',
    kind: 'capture_metadata',
    rootIndex: 0,
    relativePath: 'captures/one/capture.json',
    bytes: 10,
    sha256: 'a'.repeat(64),
    writeStatus: 'written',
  } as const;
  const requestMetadata = {
    artifactId: 'stream-1-request-1-metadata',
    kind: 'request_metadata',
    rootIndex: 0,
    relativePath: 'captures/one/request-0001/metadata.json',
    bytes: 10,
    sha256: 'b'.repeat(64),
    writeStatus: 'written',
  } as const;
  const payload = {
    artifactId: 'stream-1-request-1-payload-1',
    kind: 'payload',
    rootIndex: 0,
    relativePath: 'captures/one/request-0001/payloads/one.bin',
    bytes: 20,
    sha256: 'c'.repeat(64),
    writeStatus: 'written',
  } as const;
  const capture = {
    id: 1,
    status: 'stopped',
    integrityStatus: 'complete',
    filter: {mimeTypes: ['text/event-stream']},
    artifactRootIndex: 0,
    relativeDir: 'captures/one',
    metadataArtifact: metadata,
    pageUrl: 'https://example.test',
    createdWallTimeMs: 1,
    stoppedWallTimeMs: 2,
    requests: [{artifacts: [requestMetadata, payload]}],
    totalRawBytes: 10,
    diskBytesReserved: 30,
    chunkCount: 1,
    rawEventCount: 1,
    semanticEventCount: 0,
    quotaBytes: 1000,
    errors: [],
    version: 1,
  } as unknown as StreamCapture;
  let structured: Record<string, unknown> | undefined;
  await stopStreamCapture.handler(
    {params: {captureId: 1}},
    {
      appendResponseLine: () => undefined,
      setStructuredContent: (value: Record<string, unknown>) => {
        structured = value;
      },
    } as never,
    {stopStreamCapture: async () => capture} as never,
  );
  assert.ok(structured);
  assert.deepEqual(structured.requestMetadataArtifacts, [requestMetadata]);
  assert.equal(JSON.stringify(structured).includes('payloads/one.bin'), false);
});
