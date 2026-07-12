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
  type StreamCollectorLimits,
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
    collectorOptions?: Partial<StreamCollectorLimits>;
    requestPostData?: string;
    resolveNetworkRequestId?: (
      page: Page,
      cdpRequestId: string,
    ) => number | undefined;
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
      resolveNetworkRequestId: options.resolveNetworkRequestId,
      ...options.collectorOptions,
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
        if (method === 'Network.getRequestPostData') {
          return {postData: options.requestPostData ?? ''};
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
    requestHeaders?: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
    initiator?: Record<string, unknown>;
    wallTime?: number;
    responseStatus?: number;
    responseStatusText?: string;
    responseHeaders?: Record<string, string>;
    redirectResponse?: {
      url: string;
      status: number;
      statusText: string;
      headers: Record<string, string>;
    };
    emitResponse?: boolean;
    frameId?: string;
    loaderId?: string;
  } = {},
): string {
  const requestId = options.requestId ?? 'stream-1';
  const url = options.url ?? 'https://example.test/api/stream';
  const method = options.method ?? 'POST';
  const type = options.type ?? 'Fetch';
  session.emit('Network.requestWillBeSent', {
    requestId,
    timestamp: 1,
    wallTime: options.wallTime ?? 1_700_000_000,
    type,
    frameId: options.frameId ?? 'frame-1',
    loaderId: options.loaderId ?? 'loader-1',
    initiator: options.initiator ?? {type: 'script'},
    redirectResponse: options.redirectResponse,
    request: {
      url,
      method,
      headers: options.requestHeaders ?? {'x-test': 'request'},
      postData: options.postData,
      hasPostData: options.hasPostData,
    },
  });
  if (options.emitResponse !== false) {
    emitResponse(session, requestId, {
      url,
      type,
      mimeType: options.mimeType,
      responseStatus: options.responseStatus,
      responseStatusText: options.responseStatusText,
      responseHeaders: options.responseHeaders,
      frameId: options.frameId,
      loaderId: options.loaderId,
    });
  }
  return requestId;
}

function emitResponse(
  session: MockSession,
  requestId: string,
  options: {
    url?: string;
    type?: string;
    mimeType?: string;
    responseStatus?: number;
    responseStatusText?: string;
    responseHeaders?: Record<string, string>;
    frameId?: string;
    loaderId?: string;
    fromServiceWorker?: boolean;
  } = {},
): void {
  session.emit('Network.responseReceived', {
    requestId,
    timestamp: 2,
    type: options.type ?? 'Fetch',
    frameId: options.frameId ?? 'frame-1',
    loaderId: options.loaderId ?? 'loader-1',
    response: {
      url: options.url ?? 'https://example.test/api/stream',
      mimeType: options.mimeType ?? 'text/event-stream',
      status: options.responseStatus ?? 200,
      statusText: options.responseStatusText ?? 'OK',
      headers: options.responseHeaders ?? {'content-type': 'text/event-stream'},
      fromServiceWorker: options.fromServiceWorker ?? false,
    },
  });
}

function emitRequestExtraInfo(
  session: MockSession,
  requestId: string,
  headers: Record<string, string>,
): void {
  session.emit('Network.requestWillBeSentExtraInfo', {
    requestId,
    associatedCookies: [
      {
        cookie: {
          name: 'session',
          value: 'secret-cookie',
          domain: 'example.test',
          path: '/',
          expires: -1,
          size: 20,
          httpOnly: true,
          secure: true,
          session: true,
          priority: 'Medium',
          sameParty: false,
          sourceScheme: 'Secure',
          sourcePort: 443,
        },
        blockedReasons: [],
        exemptionReason: 'None',
      },
    ],
    headers,
    connectTiming: {requestTime: 1},
    clientSecurityState: undefined,
    siteHasCookieInOtherPartition: false,
  });
}

function emitResponseExtraInfo(
  session: MockSession,
  requestId: string,
  headers: Record<string, string>,
): void {
  session.emit('Network.responseReceivedExtraInfo', {
    requestId,
    blockedCookies: [],
    headers,
    resourceIPAddressSpace: 'Loopback',
    statusCode: 200,
    cookiePartitionKeyOpaque: false,
  });
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

function emitFailed(
  session: MockSession,
  requestId: string,
  options: {
    timestamp?: number;
    canceled?: boolean;
    errorText?: string;
  } = {},
): void {
  session.emit('Network.loadingFailed', {
    requestId,
    timestamp: options.timestamp ?? 5,
    type: 'Fetch',
    canceled: options.canceled ?? false,
    errorText: options.errorText ?? 'net::ERR_FAILED',
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
  const rootPath = await fs.realpath(root);
  const relativeDir = path.join('captures', name);
  const absoluteDir = path.join(rootPath, relativeDir);
  await fs.mkdir(absoluteDir, {recursive: true});
  return {
    root: rootPath,
    location: {rootIndex: 0, rootPath, absoluteDir, relativeDir},
  };
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
      done: event.defaultDoneMarker,
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

test('stop interrupts an unfinished activation and still finalizes metadata', async () => {
  const {collector, addPage} = createFixture({
    streamResourceContent: () => new Promise(() => undefined),
    collectorOptions: {activationTimeoutMs: 10_000},
  });
  const control = addPage();
  const {root, location} = await createLocation('stop-before-activation');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    emitRequestStart(control.session);
    const stopped = await collector.stopCapture(capture.id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.requests[0].status, 'failed');
    assert.equal(stopped.requests[0].integrityStatus, 'failed');
    assert.equal(stopped.requests[0].terminalReason, 'collector_stop');
    const manifest = JSON.parse(
      await fs.readFile(artifactPath(root, stopped.metadataArtifact), 'utf8'),
    ) as {
      status: string;
      requests: Array<{status: string; integrityStatus: string}>;
    };
    assert.equal(manifest.status, 'stopped');
    assert.equal(manifest.requests[0].integrityStatus, 'failed');
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
  const {collector, addPage} = createFixture({maxDiskBytesPerCapture: 16_000});
  const control = addPage();
  const {root, location} = await createLocation('quota');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    emitText(control.session, requestId, `data: ${'x'.repeat(20_000)}\n\n`, 3);
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

test('activation timeout finalizes a failed fetch request instead of hanging', async () => {
  const {collector, addPage} = createFixture({
    streamResourceContent: () => new Promise(() => undefined),
    collectorOptions: {activationTimeoutMs: 20},
  });
  const control = addPage();
  const {root, location} = await createLocation('activation-timeout');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    emitFinished(control.session, requestId, 4);
    const stopped = await collector.stopCapture(capture.id);
    const request = stopped.requests[0];
    assert.equal(request.status, 'failed');
    assert.equal(request.integrityStatus, 'failed');
    assert.equal(request.terminalReason, 'activation_timeout');
    assert.equal(request.failure?.code, 'ACTIVATION_TIMEOUT');
    assert.match(request.streamResourceContentError ?? '', /timed out/i);
    await fs.stat(artifactPath(root, stopped.metadataArtifact));
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('pending chunks are bounded while activation is unresolved', async () => {
  const {collector, addPage} = createFixture({
    streamResourceContent: () => new Promise(() => undefined),
    collectorOptions: {
      activationTimeoutMs: 10_000,
      maxPendingBytesPerRequest: 16,
    },
  });
  const control = addPage();
  const {root, location} = await createLocation('pending-limit');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    emitBytes(control.session, requestId, Buffer.alloc(12, 1), 3);
    emitBytes(control.session, requestId, Buffer.alloc(12, 2), 4);
    await flushMicrotasks();
    emitFinished(control.session, requestId, 5);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.status, 'failed');
    assert.equal(request.failure?.code, 'PENDING_BUFFER_LIMIT');
    assert.equal(request.pendingBytesPeak, 12);
    assert.ok((request.truncation?.droppedChunkCount ?? 0) >= 1);
    assert.ok((request.truncation?.droppedBytes ?? 0) >= 12);
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('fetch activation failure cannot be reported as a successful finish', async () => {
  const {collector, addPage} = createFixture({
    streamResourceContent: async () => {
      throw new Error('Method unavailable');
    },
  });
  const control = addPage();
  const {root, location} = await createLocation('activation-failed');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session, {type: 'Fetch'});
    await flushMicrotasks();
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.status, 'failed');
    assert.equal(request.integrityStatus, 'failed');
    assert.equal(request.failure?.code, 'ACTIVATION_ERROR');
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('EventSource activation failure becomes semantic-only when mirror events exist', async () => {
  const {collector, addPage} = createFixture({
    streamResourceContent: async () => {
      throw new Error('Method unavailable');
    },
  });
  const control = addPage();
  const {root, location} = await createLocation('semantic-only');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session, {
      method: 'GET',
      type: 'EventSource',
    });
    await flushMicrotasks();
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
    assert.equal(request.status, 'finished');
    assert.equal(request.integrityStatus, 'semantic-only');
    assert.equal(request.primaryEventSource, 'eventsource');
    assert.equal(request.semanticEventCount, 1);
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('user cancellation is a distinct terminal state', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('canceled');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    emitText(control.session, requestId, 'data: partial\n\n', 3);
    emitFailed(control.session, requestId, {
      timestamp: 4,
      canceled: true,
      errorText: 'net::ERR_ABORTED',
    });
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.status, 'canceled');
    assert.equal(request.terminalReason, 'network_canceled');
    assert.equal(request.failure, undefined);
    assert.equal(request.rawCaptureIntegrity, 'complete');
    assert.equal(request.requestSnapshotIntegrity, 'partial');
    assert.equal(request.integrityStatus, 'partial');
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('request replay snapshot contains headers, body, response, initiator, redirects, and reqid correlation', async () => {
  const {collector, addPage} = createFixture({
    requestPostData: '{"from":"cdp"}',
    resolveNetworkRequestId: (_page, requestId) =>
      requestId === 'stream-1' ? 77 : undefined,
  });
  const control = addPage();
  const {root, location} = await createLocation('request-snapshot');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session, {
      requestHeaders: {authorization: 'Bearer local-test', 'x-client': 'test'},
      hasPostData: true,
      initiator: {type: 'script', url: 'https://example.test/app.js'},
      responseStatus: 201,
      responseStatusText: 'Created',
      responseHeaders: {
        'content-type': 'text/event-stream',
        'x-server': 'test',
      },
      redirectResponse: {
        url: 'https://example.test/old',
        status: 307,
        statusText: 'Temporary Redirect',
        headers: {location: '/api/stream'},
      },
    });
    await flushMicrotasks();
    emitText(control.session, requestId, 'data: [DONE]\n\n', 3);
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.networkRequestId, 77);
    assert.equal(request.responseStatus, 201);
    const byKind = (kind: string) =>
      request.artifacts.find(artifact => artifact.kind === kind)!;
    const headers = JSON.parse(
      await fs.readFile(artifactPath(root, byKind('request_headers')), 'utf8'),
    ) as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer local-test');
    assert.equal(
      await fs.readFile(
        artifactPath(root, byKind('request_body_text')),
        'utf8',
      ),
      '{"from":"cdp"}',
    );
    const response = JSON.parse(
      await fs.readFile(artifactPath(root, byKind('response_headers')), 'utf8'),
    ) as {status: number; headers: Record<string, string>};
    assert.equal(response.status, 201);
    assert.equal(response.headers['x-server'], 'test');
    const initiator = JSON.parse(
      await fs.readFile(artifactPath(root, byKind('initiator')), 'utf8'),
    ) as {url: string};
    assert.equal(initiator.url, 'https://example.test/app.js');
    const redirects = JSON.parse(
      await fs.readFile(artifactPath(root, byKind('redirects')), 'utf8'),
    ) as Array<{status: number}>;
    assert.equal(redirects[0].status, 307);
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('events include byte ranges, chunk ranges, and monotonic/wall times', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('event-ranges');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session, {
      wallTime: 1_700_000_000,
    });
    await flushMicrotasks();
    emitText(control.session, requestId, 'data: hel', 3);
    emitText(control.session, requestId, 'lo\n\n', 4);
    emitFinished(control.session, requestId, 5);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.startedMonotonicTimeSeconds, 1);
    assert.equal(request.startedWallTimeMs, 1_700_000_000_000);
    assert.equal(request.endedMonotonicTimeSeconds, 5);
    assert.equal(request.endedWallTimeMs, 1_700_000_004_000);
    const eventsArtifact = request.artifacts.find(
      artifact => artifact.kind === 'events',
    )!;
    const [event] = await readJsonLines(artifactPath(root, eventsArtifact));
    assert.equal(event.rawByteStart, 0);
    assert.equal(event.rawByteEnd, Buffer.byteLength('data: hello\n'));
    assert.equal(event.firstChunkIndex, 0);
    assert.equal(event.lastChunkIndex, 1);
    assert.equal(event.firstByteMonotonicTimeSeconds, 3);
    assert.equal(event.completedMonotonicTimeSeconds, 4);
    assert.equal(event.firstByteWallTimeMs, 1_700_000_002_000);
    assert.equal(event.completedWallTimeMs, 1_700_000_003_000);
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('bounded parser handles BOM and mixed newline styles', () => {
  const parsed = parseSseEvents(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('data: one\r\rdata: two\r\n\r\ndata: three\n\n'),
    ]),
  );
  assert.deepEqual(
    parsed.events.map(event => event.data),
    ['one', 'two', 'three'],
  );
});

test('oversized or unterminated SSE degrades semantic parsing but preserves raw bytes', async () => {
  const {collector, addPage} = createFixture({
    collectorOptions: {
      maxSseEventBytes: 32,
      maxIncompleteTailBytes: 32,
    },
  });
  const control = addPage();
  const {root, location} = await createLocation('parser-degraded');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    const raw = Buffer.from(`data: ${'x'.repeat(128)}`);
    emitBytes(control.session, requestId, raw, 3);
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.parseStatus, 'degraded');
    assert.equal(request.integrityStatus, 'partial');
    assert.match(request.parseDegradedReason ?? '', /exceeded/i);
    const rawArtifact = request.artifacts.find(
      artifact => artifact.kind === 'raw_bytes',
    )!;
    assert.deepEqual(await fs.readFile(artifactPath(root, rawArtifact)), raw);
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('invalid UTF-8 is recorded as parse degradation while raw bytes remain exact', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('invalid-utf8');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    const raw = Buffer.from([
      0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a,
    ]);
    emitBytes(control.session, requestId, raw, 3);
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.invalidUtf8Count, 1);
    assert.equal(request.parseStatus, 'degraded');
    assert.equal(request.integrityStatus, 'partial');
    const rawArtifact = request.artifacts.find(
      artifact => artifact.kind === 'raw_bytes',
    )!;
    assert.deepEqual(await fs.readFile(artifactPath(root, rawArtifact)), raw);
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('request and event count limits are explicit', async () => {
  const {collector, addPage} = createFixture({
    collectorOptions: {maxRequestsPerCapture: 1, maxEventsPerRequest: 1},
  });
  const control = addPage();
  const {root, location} = await createLocation('count-limits');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const first = emitRequestStart(control.session, {requestId: 'first'});
    await flushMicrotasks();
    emitText(control.session, first, 'data: one\n\ndata: two\n\n', 3);
    emitFinished(control.session, first, 4);
    emitRequestStart(control.session, {requestId: 'second'});
    await collector.stopCapture(capture.id);
    assert.equal(capture.requests.length, 1);
    assert.equal(capture.status, 'failed');
    assert.equal(capture.truncation?.reason, 'request_limit');
    assert.equal(capture.requests[0].parseStatus, 'raw-only');
    assert.equal(capture.requests[0].truncation?.reason, 'event_limit');
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('async dispose waits for active capture finalization', async () => {
  const {collector, addPage} = createFixture({
    streamResourceContent: () => new Promise(() => undefined),
    collectorOptions: {activationTimeoutMs: 10_000, shutdownTimeoutMs: 500},
  });
  const control = addPage();
  const {root, location} = await createLocation('dispose');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    emitRequestStart(control.session);
    await collector.dispose({timeoutMs: 500, reason: 'test shutdown'});
    assert.equal(capture.status, 'stopped');
    assert.equal(capture.requests[0].status, 'failed');
    await fs.stat(artifactPath(root, capture.metadataArtifact));
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('critical artifact initialization failure fails the request and capture', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('artifact-init-failure');
  try {
    await fs.writeFile(
      path.join(location.absoluteDir, 'request-0001'),
      'block',
    );
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.status, 'failed');
    assert.equal(request.integrityStatus, 'failed');
    assert.equal(request.terminalReason, 'artifact_error');
    assert.equal(request.failure?.code, 'ARTIFACT_ERROR');
    assert.ok(
      request.artifacts.some(artifact => artifact.writeStatus === 'failed'),
    );
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('payload and artifact limits omit extra payloads without leaking Base64', async () => {
  const {collector, addPage} = createFixture({
    collectorOptions: {
      maxPayloadsPerRequest: 1,
      maxArtifactsPerCapture: 20,
    },
  });
  const control = addPage();
  const {root, location} = await createLocation('payload-limit');
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
      `data: ${JSON.stringify({first, second})}\n\n`,
      3,
    );
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);
    const request = capture.requests[0];
    assert.equal(request.integrityStatus, 'partial');
    assert.equal(request.truncation?.reason, 'payload_limit');
    assert.equal(
      request.artifacts.filter(artifact => artifact.kind === 'payload').length,
      1,
    );
    const events = request.artifacts.find(
      artifact => artifact.kind === 'events',
    )!;
    const text = await fs.readFile(artifactPath(root, events), 'utf8');
    assert.match(text, /\$payloadOmitted/);
    assert.doesNotMatch(text, new RegExp(second.slice(0, 80)));
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('stopped capture remains immutable after its page closes', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('immutable-after-stop');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    await flushMicrotasks();
    emitText(control.session, requestId, 'data: [DONE]\n\n', 3);
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);
    const manifestPath = artifactPath(root, capture.metadataArtifact);
    const before = await fs.readFile(manifestPath);
    const beforeHash = capture.metadataArtifact.sha256;
    assert.equal(capture.status, 'stopped');

    control.close();
    await collector.waitForPageCloseFinalization(control.page);

    const after = await fs.readFile(manifestPath);
    assert.equal(capture.status, 'stopped');
    assert.equal(capture.metadataArtifact.sha256, beforeHash);
    assert.deepEqual(after, before);
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('matched request that fails before response still produces evidence', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('failure-before-response');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(
      control.page,
      {urlFilter: '/api/stream', methods: ['POST']},
      location,
    );
    const requestId = emitRequestStart(control.session, {emitResponse: false});
    emitFailed(control.session, requestId, {
      timestamp: 2,
      canceled: false,
      errorText: 'net::ERR_CONNECTION_REFUSED',
    });
    await collector.stopCapture(capture.id);
    assert.equal(capture.requests.length, 1);
    const request = capture.requests[0];
    assert.equal(request.responseObserved, false);
    assert.equal(request.streamActivationAttempted, false);
    assert.equal(request.failurePhase, 'before-response');
    assert.equal(request.status, 'failed');
    assert.equal(request.terminalReason, 'network_error');
    assert.equal(request.rawCaptureIntegrity, 'not-attempted');
    assert.equal(request.requestSnapshotIntegrity, 'partial');
    await fs.stat(
      artifactPath(
        root,
        request.artifacts.find(
          artifact => artifact.kind === 'request_metadata',
        )!,
      ),
    );
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('pre-arm requests are excluded unless includeInFlight is enabled', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const firstLocation = await createLocation('pre-arm-excluded');
  const secondLocation = await createLocation('pre-arm-included');
  try {
    await collector.addPage(control.page);
    const excludedId = emitRequestStart(control.session, {
      requestId: 'pre-arm-excluded',
      emitResponse: false,
    });
    const excludedCapture = await collector.startCapture(
      control.page,
      {},
      firstLocation.location,
    );
    emitResponse(control.session, excludedId);
    emitFinished(control.session, excludedId, 3);
    await collector.stopCapture(excludedCapture.id);
    assert.equal(excludedCapture.requests.length, 0);

    const includedId = emitRequestStart(control.session, {
      requestId: 'pre-arm-included',
      emitResponse: false,
    });
    const includedCapture = await collector.startCapture(
      control.page,
      {},
      secondLocation.location,
      {includeInFlight: true},
    );
    emitResponse(control.session, includedId);
    await flushMicrotasks();
    emitText(control.session, includedId, 'data: [DONE]\n\n', 3);
    emitFinished(control.session, includedId, 4);
    await collector.stopCapture(includedCapture.id);
    assert.equal(includedCapture.requests.length, 1);
    assert.equal(includedCapture.requests[0].requestStartedBeforeCapture, true);
  } finally {
    await collector.dispose();
    await fs.rm(firstLocation.root, {recursive: true, force: true});
    await fs.rm(secondLocation.root, {recursive: true, force: true});
  }
});

test('ExtraInfo snapshot records credentials privately and writes a redacted view', async () => {
  const {collector, addPage} = createFixture({requestPostData: '{"hello":1}'});
  const control = addPage();
  const {root, location} = await createLocation('extra-info');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session, {
      emitResponse: false,
      hasPostData: true,
      requestHeaders: {'x-client': 'test'},
    });
    emitRequestExtraInfo(control.session, requestId, {
      authorization: 'Bearer secret-token',
      cookie: 'session=secret-cookie',
      'x-client': 'test',
    });
    emitResponse(control.session, requestId);
    emitResponseExtraInfo(control.session, requestId, {
      'content-type': 'text/event-stream',
      'set-cookie': 'session=rotated',
    });
    await flushMicrotasks();
    emitText(control.session, requestId, 'data: [DONE]\n\n', 3);
    emitFinished(control.session, requestId, 4);
    await collector.stopCapture(capture.id);

    const request = capture.requests[0];
    assert.equal(request.headersCompleteness, 'complete');
    assert.equal(request.bodyCompleteness, 'partial');
    assert.equal(request.bodyCaptureSource, 'cdp-postData-utf8');
    assert.equal(request.requestSnapshotIntegrity, 'complete');
    const byKind = (kind: string) =>
      request.artifacts.find(artifact => artifact.kind === kind)!;
    const fullHeaders = byKind('request_headers');
    assert.equal(fullHeaders.sensitivity, 'credential');
    assert.equal(fullHeaders.containsCredentials, true);
    const extraText = await fs.readFile(
      artifactPath(root, byKind('request_headers_extra')),
      'utf8',
    );
    assert.match(extraText, /secret-cookie/);
    const redactedText = await fs.readFile(
      artifactPath(root, byKind('request_headers_redacted')),
      'utf8',
    );
    assert.doesNotMatch(redactedText, /secret-token|secret-cookie/);
    assert.match(redactedText, /\[REDACTED\]/);
    const bodyMeta = JSON.parse(
      await fs.readFile(
        artifactPath(root, byKind('request_body_metadata')),
        'utf8',
      ),
    ) as {wireBytes: boolean; captureSource: string; encoding: string};
    assert.equal(bodyMeta.wireBytes, false);
    assert.equal(bodyMeta.captureSource, 'cdp-postData-utf8');
    assert.equal(bodyMeta.encoding, 'utf-8');
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('persistent artifact IDs remain unique across collector restarts', async () => {
  const firstFixture = createFixture();
  const secondFixture = createFixture();
  const firstPage = firstFixture.addPage();
  const secondPage = secondFixture.addPage();
  const firstLocation = await createLocation('uuid-first');
  const secondLocation = await createLocation('uuid-second');
  try {
    await firstFixture.collector.addPage(firstPage.page);
    await secondFixture.collector.addPage(secondPage.page);
    const first = await firstFixture.collector.startCapture(
      firstPage.page,
      {},
      firstLocation.location,
    );
    const second = await secondFixture.collector.startCapture(
      secondPage.page,
      {},
      secondLocation.location,
    );
    assert.equal(first.id, 1);
    assert.equal(second.id, 1);
    assert.notEqual(first.uuid, second.uuid);
    assert.notEqual(
      first.metadataArtifact.artifactId,
      second.metadataArtifact.artifactId,
    );
    assert.match(first.metadataArtifact.artifactId, /^art_stream_/);
    await firstFixture.collector.stopCapture(first.id);
    await secondFixture.collector.stopCapture(second.id);
  } finally {
    await firstFixture.collector.dispose();
    await secondFixture.collector.dispose();
    await fs.rm(firstLocation.root, {recursive: true, force: true});
    await fs.rm(secondLocation.root, {recursive: true, force: true});
  }
});

test('capture explicitly reports page-target-only worker coverage', async () => {
  const {collector, addPage} = createFixture();
  const control = addPage();
  const {root, location} = await createLocation('coverage');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session, {
      frameId: 'frame-main',
      loaderId: 'loader-main',
    });
    await flushMicrotasks();
    emitFinished(control.session, requestId, 3);
    await collector.stopCapture(capture.id);
    assert.equal(capture.captureScope, 'page-target-only');
    assert.equal(capture.workerCoverage, false);
    assert.equal(capture.requests[0].targetType, 'page');
    assert.equal(capture.requests[0].frameId, 'frame-main');
    assert.equal(capture.requests[0].workerCoverage, false);
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('stop deadline force-finalizes an unresolved completed request', async () => {
  const {collector, addPage} = createFixture({
    streamResourceContent: () => new Promise(() => undefined),
    collectorOptions: {activationTimeoutMs: 60_000},
  });
  const control = addPage();
  const {root, location} = await createLocation('finalize-deadline');
  try {
    await collector.addPage(control.page);
    const capture = await collector.startCapture(control.page, {}, location);
    const requestId = emitRequestStart(control.session);
    emitFinished(control.session, requestId, 3);
    await collector.stopCapture(capture.id, {
      deadlineWallTimeMs: Date.now() + 25,
    });
    const request = capture.requests[0];
    assert.equal(capture.status, 'failed');
    assert.equal(request.status, 'failed');
    assert.equal(request.terminalReason, 'finalize_timeout');
    assert.equal(request.failure?.code, 'FINALIZE_TIMEOUT');
    await fs.stat(artifactPath(root, capture.metadataArtifact));
  } finally {
    await collector.dispose();
    await fs.rm(root, {recursive: true, force: true});
  }
});
