/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import type {CdpSessionProvider} from '../src/CdpSessionProvider.js';
import {parseSseEvents, StreamCollector} from '../src/StreamCollector.js';
import type {
  BrowserContext,
  CDPSession,
  Page,
} from '../src/third_party/index.js';

function createFixture(
  options: {
    streamResourceContent?: (
      requestId: string,
    ) => Promise<{bufferedData?: string}>;
  } = {},
) {
  const cdpHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const pageHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const contextHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const session = {
    on(event: string, listener: (payload: unknown) => void) {
      let listeners = cdpHandlers.get(event);
      if (!listeners) {
        listeners = new Set();
        cdpHandlers.set(event, listeners);
      }
      listeners.add(listener);
      return session;
    },
    off(event: string, listener: (payload: unknown) => void) {
      cdpHandlers.get(event)?.delete(listener);
      return session;
    },
    async send(method: string, params?: {requestId?: string}) {
      if (method === 'Network.enable') {
        return {};
      }
      if (method === 'Network.streamResourceContent') {
        return (
          options.streamResourceContent?.(params?.requestId ?? '') ??
          Promise.resolve({bufferedData: ''})
        );
      }
      return {};
    },
    emit(event: string, payload: unknown) {
      for (const listener of cdpHandlers.get(event) ?? []) {
        listener(payload);
      }
    },
  };
  const mainFrame = {};
  const page = {
    on(event: string, listener: (payload: unknown) => void) {
      let listeners = pageHandlers.get(event);
      if (!listeners) {
        listeners = new Set();
        pageHandlers.set(event, listeners);
      }
      listeners.add(listener);
      return page;
    },
    off(event: string, listener: (payload: unknown) => void) {
      pageHandlers.get(event)?.delete(listener);
      return page;
    },
    mainFrame: () => mainFrame,
  } as unknown as Page;
  const context = {
    pages: () => [page],
    on(event: string, listener: (payload: unknown) => void) {
      let listeners = contextHandlers.get(event);
      if (!listeners) {
        listeners = new Set();
        contextHandlers.set(event, listeners);
      }
      listeners.add(listener);
    },
    off(event: string, listener: (payload: unknown) => void) {
      contextHandlers.get(event)?.delete(listener);
    },
  } as unknown as BrowserContext;
  const collector = new StreamCollector(
    context,
    {
      getSession: async () => session as unknown as CDPSession,
    } as unknown as CdpSessionProvider,
    {
      maxCaptures: 5,
      maxBytesPerCapture: 1024 * 1024,
      maxChunksPerCapture: 100,
    },
  );
  return {cdpHandlers, collector, page, session};
}

function emitRequestStart(
  session: {emit(event: string, payload: unknown): void},
  options: {
    requestId?: string;
    url?: string;
    method?: string;
    type?: string;
    mimeType?: string;
  } = {},
): string {
  const requestId = options.requestId ?? 'stream-1';
  const url = options.url ?? 'https://example.test/api/stream';
  const method = options.method ?? 'POST';
  const type = options.type ?? 'Fetch';
  session.emit('Network.requestWillBeSent', {
    requestId,
    timestamp: 1,
    type,
    request: {url, method},
  });
  session.emit('Network.responseReceived', {
    requestId,
    timestamp: 2,
    type,
    response: {
      url,
      mimeType: options.mimeType ?? 'text/event-stream',
    },
  });
  return requestId;
}

function emitBytes(
  session: {emit(event: string, payload: unknown): void},
  requestId: string,
  bytes: Uint8Array,
  timestamp: number,
): void {
  const data = Buffer.from(bytes).toString('base64');
  session.emit('Network.dataReceived', {
    requestId,
    timestamp,
    dataLength: bytes.length,
    encodedDataLength: bytes.length,
    data,
  });
}

function emitText(
  session: {emit(event: string, payload: unknown): void},
  requestId: string,
  text: string,
  timestamp: number,
): void {
  emitBytes(session, requestId, Buffer.from(text, 'utf8'), timestamp);
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function createOutputDir(): Promise<{root: string; outputDir: string}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-collector-'));
  const outputDir = path.join(root, 'capture');
  await fs.mkdir(outputDir);
  return {root, outputDir};
}

async function readJsonLines(
  filename: string,
): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(filename, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

test('parseSseEvents preserves event order and the done marker', () => {
  const raw = Buffer.from(
    'event: message\ndata: {"sequence":1}\n\n' +
      'data: line one\ndata: line two\n\n' +
      ': heartbeat\n\n' +
      'event: done\ndata: [DONE]\n\n' +
      'data: incomplete',
    'utf8',
  );

  const parsed = parseSseEvents(raw);

  assert.deepEqual(
    parsed.events.map(event => ({
      index: event.index,
      name: event.eventName,
      data: event.data,
      done: event.done,
      comments: event.comments,
    })),
    [
      {
        index: 0,
        name: 'message',
        data: '{"sequence":1}',
        done: false,
        comments: [],
      },
      {
        index: 1,
        name: 'message',
        data: 'line one\nline two',
        done: false,
        comments: [],
      },
      {
        index: 2,
        name: 'message',
        data: '',
        done: false,
        comments: ['heartbeat'],
      },
      {
        index: 3,
        name: 'done',
        data: '[DONE]',
        done: true,
        comments: [],
      },
    ],
  );
  assert.equal(parsed.incompleteTail, 'data: incomplete');
});

test('decodes CDP Base64 immediately and writes analysis files without Base64', async () => {
  const first = 'event: message\ndata: {"sequence":1}\n\n';
  const {root, outputDir} = await createOutputDir();
  const {collector, page, session} = createFixture({
    streamResourceContent: async () => ({
      bufferedData: Buffer.from(first, 'utf8').toString('base64'),
    }),
  });
  try {
    await collector.addPage(page);
    const capture = collector.startCapture(
      page,
      {urlFilter: '/api/stream', methods: ['POST']},
      outputDir,
    );

    const requestId = emitRequestStart(session);
    await flushMicrotasks();
    emitText(session, requestId, 'event: message\ndata: {"sequence":2}\n\n', 3);
    emitText(session, requestId, 'event: done\ndata: [DONE]\n\n', 4);
    session.emit('Network.loadingFinished', {
      requestId,
      timestamp: 5,
      encodedDataLength: 100,
    });
    const stopped = await collector.stopCapture(page, capture.id);

    const request = stopped.requests[0];
    const rawFile = request.files.find(file => file.kind === 'raw_bytes')!.path;
    const rawTextFile = request.files.find(
      file => file.kind === 'raw_text',
    )!.path;
    const eventsFile = request.files.find(file => file.kind === 'events')!.path;
    const chunksFile = request.files.find(file => file.kind === 'chunks')!.path;
    const expected =
      first +
      'event: message\ndata: {"sequence":2}\n\n' +
      'event: done\ndata: [DONE]\n\n';
    const secondChunk = 'event: message\ndata: {"sequence":2}\n\n';

    assert.equal((await fs.readFile(rawFile)).toString('utf8'), expected);
    assert.equal(await fs.readFile(rawTextFile, 'utf8'), expected);
    const events = await readJsonLines(eventsFile);
    assert.deepEqual(
      events.map(event => ({
        index: event.index,
        done: event.done,
        dataJson: event.dataJson,
        data: event.data,
      })),
      [
        {index: 0, done: false, dataJson: {sequence: 1}, data: undefined},
        {index: 1, done: false, dataJson: {sequence: 2}, data: undefined},
        {index: 2, done: true, dataJson: undefined, data: '[DONE]'},
      ],
    );
    const chunks = await readJsonLines(chunksFile);
    assert.equal(chunks.length, 3);
    assert.equal('dataBase64' in chunks[0], false);
    assert.deepEqual(
      chunks.map(chunk => [chunk.fileOffsetStart, chunk.fileOffsetEnd]),
      [
        [0, Buffer.byteLength(first)],
        [
          Buffer.byteLength(first),
          Buffer.byteLength(first) + Buffer.byteLength(secondChunk),
        ],
        [
          Buffer.byteLength(first) + Buffer.byteLength(secondChunk),
          Buffer.byteLength(expected),
        ],
      ],
    );
    assert.equal(request.doneMarkerObserved, true);
    assert.equal(request.writeErrors.length, 0);
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('incremental UTF-8 decoding preserves characters split across chunks', async () => {
  const {root, outputDir} = await createOutputDir();
  const {collector, page, session} = createFixture();
  try {
    await collector.addPage(page);
    const capture = collector.startCapture(page, {}, outputDir);
    const requestId = emitRequestStart(session);
    await flushMicrotasks();
    const bytes = Buffer.from('data: {"text":"你好"}\n\n', 'utf8');
    const split = bytes.indexOf(Buffer.from('你', 'utf8')) + 1;
    emitBytes(session, requestId, bytes.subarray(0, split), 3);
    emitBytes(session, requestId, bytes.subarray(split), 4);
    session.emit('Network.loadingFinished', {
      requestId,
      timestamp: 5,
      encodedDataLength: bytes.length,
    });
    const stopped = await collector.stopCapture(page, capture.id);
    const eventsFile = stopped.requests[0].files.find(
      file => file.kind === 'events',
    )!.path;
    const [event] = await readJsonLines(eventsFile);
    assert.deepEqual(event.dataJson, {text: '你好'});
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('extracts large business Base64 into a payload artifact', async () => {
  const {root, outputDir} = await createOutputDir();
  const {collector, page, session} = createFixture();
  try {
    await collector.addPage(page);
    const capture = collector.startCapture(page, {}, outputDir);
    const requestId = emitRequestStart(session);
    await flushMicrotasks();
    const png = Buffer.alloc(5000);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    const encoded = png.toString('base64');
    emitText(
      session,
      requestId,
      `data: ${JSON.stringify({type: 'image', image: encoded})}\n\n`,
      3,
    );
    session.emit('Network.loadingFinished', {
      requestId,
      timestamp: 4,
      encodedDataLength: encoded.length,
    });
    const stopped = await collector.stopCapture(page, capture.id);
    const request = stopped.requests[0];
    const eventsFile = request.files.find(file => file.kind === 'events')!.path;
    const [event] = await readJsonLines(eventsFile);
    const dataJson = event.dataJson as {
      type: string;
      image: {$artifact: string; decodedBytes: number; mimeType: string};
    };
    assert.equal(dataJson.type, 'image');
    assert.equal(dataJson.image.decodedBytes, png.length);
    assert.equal(dataJson.image.mimeType, 'image/png');
    assert.doesNotMatch(
      JSON.stringify(event),
      new RegExp(encoded.slice(0, 100)),
    );
    const payloadFile = request.files.find(file => file.kind === 'payload');
    assert.ok(payloadFile);
    assert.deepEqual(await fs.readFile(payloadFile.path), png);
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('writes native EventSource messages to a fallback JSONL file', async () => {
  const {root, outputDir} = await createOutputDir();
  const {collector, page, session} = createFixture({
    streamResourceContent: async () => {
      throw new Error('Method not found');
    },
  });
  try {
    await collector.addPage(page);
    const capture = collector.startCapture(
      page,
      {resourceTypes: ['EventSource']},
      outputDir,
    );
    const requestId = emitRequestStart(session, {
      method: 'GET',
      type: 'EventSource',
    });
    await flushMicrotasks();
    session.emit('Network.eventSourceMessageReceived', {
      requestId,
      timestamp: 3,
      eventName: 'message',
      eventId: '1',
      data: '{"sequence":1}',
    });
    session.emit('Network.eventSourceMessageReceived', {
      requestId,
      timestamp: 4,
      eventName: 'done',
      eventId: '2',
      data: '[DONE]',
    });
    session.emit('Network.loadingFinished', {
      requestId,
      timestamp: 5,
      encodedDataLength: 0,
    });
    const stopped = await collector.stopCapture(page, capture.id);
    const request = stopped.requests[0];
    const eventSourceFile = request.files.find(
      file => file.kind === 'eventsource_events',
    )!.path;
    const events = await readJsonLines(eventSourceFile);
    assert.equal(events.length, 2);
    assert.equal(events[1].done, true);
    assert.equal(request.eventCount, 0);
    assert.equal(request.eventSourceMessageCount, 2);
    assert.equal(request.doneMarkerObserved, true);
    assert.match(request.streamResourceContentError ?? '', /Method not found/);
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('records cancellation and freezes active requests on stop', async () => {
  const {root, outputDir} = await createOutputDir();
  const {collector, page, session} = createFixture();
  try {
    await collector.addPage(page);
    const capture = collector.startCapture(page, {}, outputDir);
    const canceledRequestId = emitRequestStart(session, {
      requestId: 'canceled',
    });
    await flushMicrotasks();
    session.emit('Network.loadingFailed', {
      requestId: canceledRequestId,
      timestamp: 3,
      type: 'Fetch',
      errorText: 'net::ERR_ABORTED',
      canceled: true,
    });

    const openRequestId = emitRequestStart(session, {requestId: 'open'});
    await flushMicrotasks();
    emitText(session, openRequestId, 'data: partial\n\n', 4);
    const stopped = await collector.stopCapture(page, capture.id);

    const canceled = stopped.requests.find(
      item => item.requestId === 'canceled',
    );
    const open = stopped.requests.find(item => item.requestId === 'open');
    assert.equal(canceled?.status, 'failed');
    assert.equal(canceled?.failure?.canceled, true);
    assert.equal(canceled?.failure?.errorText, 'net::ERR_ABORTED');
    assert.equal(open?.status, 'stopped');
    assert.equal(stopped.status, 'stopped');
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('disposing removes stream CDP listeners', async () => {
  const {cdpHandlers, collector, page} = createFixture();
  await collector.addPage(page);
  assert.equal(cdpHandlers.get('Network.dataReceived')?.size, 1);
  assert.equal(cdpHandlers.get('Network.eventSourceMessageReceived')?.size, 1);

  collector.dispose();

  assert.equal(cdpHandlers.get('Network.dataReceived')?.size ?? 0, 0);
  assert.equal(
    cdpHandlers.get('Network.eventSourceMessageReceived')?.size ?? 0,
    0,
  );
});
