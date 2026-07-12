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
import {
  parseSseEvents,
  StreamCollector,
  type StreamCaptureLocation,
} from '../src/StreamCollector.js';
import type {
  BrowserContext,
  CDPSession,
  Page,
} from '../src/third_party/index.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

interface MockSession {
  emit(event: string, payload: unknown): void;
}

interface MockPageControl {
  page: Page;
  session: MockSession;
  close(): void;
}

function createFixture(
  options: {
    streamResourceContent?: (
      requestId: string,
      pageIndex: number,
    ) => Promise<{bufferedData?: string}>;
    maxDiskBytesPerCapture?: number;
  } = {},
) {
  const pages: Page[] = [];
  const pageSessions = new Map<Page, CDPSession>();
  const contextHandlers = new Map<string, Set<(payload: unknown) => void>>();

  const context = {
    pages: () => [...pages],
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
      getSession: async (page: Page) => pageSessions.get(page)!,
    } as unknown as CdpSessionProvider,
    {
      maxCaptures: 20,
      maxDiskBytesPerCapture: options.maxDiskBytesPerCapture ?? 1024 * 1024,
      maxRecentChunksPerRequest: 10,
      maxRecentEventsPerRequest: 10,
    },
  );

  function addPage(
    url = `https://example.test/page-${pages.length + 1}`,
  ): MockPageControl {
    const pageIndex = pages.length;
    const pageHandlers = new Map<string, Set<(payload: unknown) => void>>();
    const cdpHandlers = new Map<string, Set<(payload: unknown) => void>>();
    let closed = false;
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
      url: () => url,
      title: async () => `Page ${pageIndex + 1}`,
      isClosed: () => closed,
      mainFrame: () => ({}),
    } as unknown as Page;
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
            options.streamResourceContent?.(
              params?.requestId ?? '',
              pageIndex,
            ) ?? Promise.resolve({bufferedData: ''})
          );
        }
        return {};
      },
      emit(event: string, payload: unknown) {
        for (const listener of cdpHandlers.get(event) ?? []) {
          listener(payload);
        }
      },
    } as unknown as CDPSession & MockSession;
    pages.push(page);
    pageSessions.set(page, session);
    for (const listener of contextHandlers.get('page') ?? []) {
      listener(page);
    }
    return {
      page,
      session,
      close() {
        closed = true;
        for (const listener of pageHandlers.get('close') ?? []) {
          listener(undefined);
        }
      },
    };
  }

  return {collector, addPage};
}

function emitRequestStart(
  session: MockSession,
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
    response: {url, mimeType: options.mimeType ?? 'text/event-stream'},
  });
  return requestId;
}

function emitBytes(
  session: MockSession,
  requestId: string,
  bytes: Uint8Array,
  timestamp: number,
): void {
  session.emit('Network.dataReceived', {
    requestId,
    timestamp,
    dataLength: bytes.length,
    encodedDataLength: bytes.length,
    data: Buffer.from(bytes).toString('base64'),
  });
}

function emitText(
  session: MockSession,
  requestId: string,
  text: string,
  timestamp: number,
): void {
  emitBytes(session, requestId, Buffer.from(text, 'utf8'), timestamp);
}

function emitFinished(
  session: MockSession,
  requestId: string,
  timestamp = 5,
): void {
  session.emit('Network.loadingFinished', {
    requestId,
    timestamp,
    encodedDataLength: 100,
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function createLocation(name: string): Promise<{
  root: string;
  location: StreamCaptureLocation;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-collector-'));
  const relativeDir = path.join('captures', name);
  const absoluteDir = path.join(root, relativeDir);
  await fs.mkdir(absoluteDir, {recursive: true});
  return {root, location: {rootIndex: 0, absoluteDir, relativeDir}};
}

function artifactPath(root: string, artifact: {relativePath: string}): string {
  return path.join(root, ...artifact.relativePath.split('/'));
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

test('parseSseEvents distinguishes heartbeat records and preserves DONE', () => {
  const parsed = parseSseEvents(
    Buffer.from(
      ': heartbeat\n\n' +
        'event: message\ndata: {"sequence":1}\n\n' +
        'event: done\ndata: [DONE]\n\n' +
        'data: incomplete',
    ),
  );
  assert.deepEqual(
    parsed.events.map(event => ({
      index: event.index,
      recordType: event.recordType,
      eventName: event.eventName,
      data: event.data,
      done: event.done,
    })),
    [
      {
        index: 0,
        recordType: 'heartbeat',
        eventName: undefined,
        data: '',
        done: false,
      },
      {
        index: 1,
        recordType: 'event',
        eventName: 'message',
        data: '{"sequence":1}',
        done: false,
      },
      {
        index: 2,
        recordType: 'event',
        eventName: 'done',
        data: '[DONE]',
        done: true,
      },
    ],
  );
  assert.equal(parsed.incompleteTail, 'data: incomplete');
});

test('activation barrier writes bufferedData before chunks received while activation is pending', async () => {
  const activation = deferred<{bufferedData?: string}>();
  const {collector, addPage} = createFixture({
    streamResourceContent: () => activation.promise,
  });
  const control = addPage();
  const {root, location} = await createLocation('ordered');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    emitText(control.session, requestId, 'data: later\n\n', 3);
    activation.resolve({
      bufferedData: Buffer.from('data: earlier\n\n').toString('base64'),
    });
    emitFinished(control.session, requestId);
    await collector.stopCapture(capture.id);

    const raw = capture.requests[0].artifacts.find(
      artifact => artifact.kind === 'raw_bytes',
    )!;
    assert.equal(
      (await fs.readFile(artifactPath(root, raw))).toString('utf8'),
      'data: earlier\n\ndata: later\n\n',
    );
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('loadingFinished before activation waits for bufferedData and pending chunks', async () => {
  const activation = deferred<{bufferedData?: string}>();
  const {collector, addPage} = createFixture({
    streamResourceContent: () => activation.promise,
  });
  const control = addPage();
  const {root, location} = await createLocation('finish-before-activation');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    emitText(control.session, requestId, 'data: second\n\n', 3);
    emitFinished(control.session, requestId, 4);
    await flushMicrotasks();
    assert.equal(capture.requests[0].status, 'activating');
    activation.resolve({
      bufferedData: Buffer.from('data: first\n\n').toString('base64'),
    });
    await collector.stopCapture(capture.id);
    assert.equal(capture.requests[0].status, 'finished');
    assert.equal(capture.requests[0].rawEventCount, 2);
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('stop before activation waits for bufferedData and finalizes metadata', async () => {
  const activation = deferred<{bufferedData?: string}>();
  const {collector, addPage} = createFixture({
    streamResourceContent: () => activation.promise,
  });
  const control = addPage();
  const {root, location} = await createLocation('stop-before-activation');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    emitRequestStart(control.session);
    const stopPromise = collector.stopCapture(capture.id);
    activation.resolve({
      bufferedData: Buffer.from('data: captured-before-stop\n\n').toString(
        'base64',
      ),
    });
    const stopped = await stopPromise;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.requests[0].status, 'stopped');
    const manifest = JSON.parse(
      await fs.readFile(artifactPath(root, stopped.metadataArtifact), 'utf8'),
    ) as {status: string; requests: Array<{rawEventCount: number}>};
    assert.equal(manifest.status, 'stopped');
    assert.equal(manifest.requests[0].rawEventCount, 1);
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('incremental UTF-8 decoder preserves characters split across chunks', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('utf8');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    const bytes = Buffer.from('data: {"text":"你好"}\n\n', 'utf8');
    const split = bytes.indexOf(Buffer.from('你', 'utf8')) + 1;
    emitBytes(control.session, requestId, bytes.subarray(0, split), 3);
    emitBytes(control.session, requestId, bytes.subarray(split), 4);
    emitFinished(control.session, requestId);
    await collector.stopCapture(capture.id);
    const eventsArtifact = capture.requests[0].artifacts.find(
      artifact => artifact.kind === 'events',
    )!;
    const [event] = await readJsonLines(artifactPath(root, eventsArtifact));
    assert.deepEqual(event.dataJson, {text: '你好'});
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('all strict large Base64 candidates become unique payload artifacts without previews', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('payloads');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    const first = Buffer.alloc(5000, 1).toString('base64');
    const second = Buffer.alloc(5000, 2).toString('base64');
    emitText(
      control.session,
      requestId,
      `data: ${JSON.stringify({'a/b': first, 'a~b': second})}\n\n`,
      3,
    );
    emitFinished(control.session, requestId);
    await collector.stopCapture(capture.id);

    const request = capture.requests[0];
    const payloads = request.artifacts.filter(
      artifact => artifact.kind === 'payload',
    );
    assert.equal(payloads.length, 2);
    assert.notEqual(payloads[0].relativePath, payloads[1].relativePath);
    assert.ok(payloads.every(artifact => artifact.writeStatus === 'written'));
    const eventsArtifact = request.artifacts.find(
      artifact => artifact.kind === 'events',
    )!;
    const serialized = await fs.readFile(
      artifactPath(root, eventsArtifact),
      'utf8',
    );
    assert.doesNotMatch(serialized, /preview/);
    assert.doesNotMatch(serialized, new RegExp(first.slice(0, 80)));
    assert.match(serialized, /detectionConfidence/);
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('disk quota failure is explicit and never reported as a normal finish', async () => {
  const {collector, addPage} = createFixture({maxDiskBytesPerCapture: 40});
  const control = addPage();
  const {root, location} = await createLocation('quota');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    emitText(control.session, requestId, 'data: this-is-too-large\n\n', 3);
    emitText(control.session, requestId, 'data: dropped-too\n\n', 4);
    emitFinished(control.session, requestId, 5);
    const stopped = await collector.stopCapture(capture.id);
    const request = stopped.requests[0];
    assert.equal(stopped.status, 'failed');
    assert.equal(request.status, 'failed');
    assert.equal(request.failure?.code, 'DISK_QUOTA_EXCEEDED');
    assert.ok((request.truncation?.droppedChunkCount ?? 0) >= 1);
    assert.ok((request.truncation?.droppedBytes ?? 0) > 0);
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('capture IDs are global and remain queryable after another page becomes active', async () => {
  const {collector, addPage} = createFixture();
  const firstPage = addPage('https://example.test/first');
  const secondPage = addPage('https://example.test/second');
  const firstLocation = await createLocation('first-page');
  const secondLocation = await createLocation('second-page');
  try {
    await collector.addPage(firstPage.page);
    await collector.addPage(secondPage.page);
    const first = await collector.startCapture(
      firstPage.page,
      {},
      firstLocation.location,
    );
    const second = await collector.startCapture(
      secondPage.page,
      {},
      secondLocation.location,
    );
    assert.notEqual(first.id, second.id);
    assert.equal(
      collector.getById(first.id).pageUrl,
      'https://example.test/first',
    );
    await collector.stopCapture(first.id);
    assert.equal(collector.getById(first.id).status, 'stopped');
    await collector.stopCapture(second.id);
  } finally {
    collector.dispose();
    await fs.rm(firstLocation.root, {recursive: true, force: true});
    await fs.rm(secondLocation.root, {recursive: true, force: true});
  }
});

test('page close finalizes active capture and preserves its manifest', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('page-close');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    emitText(control.session, requestId, 'data: before-close\n\n', 3);
    control.close();
    await collector.waitForPageCloseFinalization(control.page);
    assert.equal(capture.status, 'failed');
    assert.equal(capture.requests[0].status, 'failed');
    assert.equal(capture.requests[0].failure?.code, 'PAGE_CLOSED');
    const manifest = JSON.parse(
      await fs.readFile(artifactPath(root, capture.metadataArtifact), 'utf8'),
    ) as {status: string; requests: Array<{status: string}>};
    assert.equal(manifest.status, 'failed');
    assert.equal(manifest.requests[0].status, 'failed');
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('EventSource semantic mirror uses separate counts and raw remains primary', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('semantic-mirror');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session, {
      method: 'GET',
      type: 'EventSource',
    });
    await flushMicrotasks();
    emitText(control.session, requestId, 'data: {"sequence":1}\n\n', 3);
    control.session.emit('Network.eventSourceMessageReceived', {
      requestId,
      timestamp: 3,
      eventName: 'message',
      eventId: '1',
      data: '{"sequence":1}',
    });
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.rawEventCount, 1);
    assert.equal(request.semanticEventCount, 1);
    assert.equal(request.primaryEventSource, 'raw-stream');
    assert.equal(capture.rawEventCount, 1);
    assert.equal(capture.semanticEventCount, 1);
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('capture manifest contains only relative artifact paths', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('relative-paths');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    await collector.stopCapture(capture.id);
    const manifestText = await fs.readFile(
      artifactPath(root, capture.metadataArtifact),
      'utf8',
    );
    assert.equal(manifestText.includes(root), false);
    assert.match(
      manifestText,
      /captures\/relative-paths|captures\\relative-paths/,
    );
  } finally {
    collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});
