/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
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

function emitData(
  session: {emit(event: string, payload: unknown): void},
  requestId: string,
  text: string,
  timestamp: number,
): void {
  const data = Buffer.from(text, 'utf8').toString('base64');
  session.emit('Network.dataReceived', {
    requestId,
    timestamp,
    dataLength: Buffer.byteLength(text),
    encodedDataLength: Buffer.byteLength(text),
    data,
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
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

test('captures fetch SSE bytes before response-body eviction', async () => {
  const first = 'event: message\ndata: {"sequence":1}\n\n';
  const {collector, page, session} = createFixture({
    streamResourceContent: async () => ({
      bufferedData: Buffer.from(first, 'utf8').toString('base64'),
    }),
  });
  await collector.addPage(page);
  const capture = collector.startCapture(page, {
    urlFilter: '/api/stream',
    methods: ['POST'],
  });

  const requestId = emitRequestStart(session);
  await flushMicrotasks();
  emitData(session, requestId, 'event: message\ndata: {"sequence":2}\n\n', 3);
  emitData(session, requestId, 'event: done\ndata: [DONE]\n\n', 4);
  session.emit('Network.loadingFinished', {
    requestId,
    timestamp: 5,
    encodedDataLength: 100,
  });

  const request = capture.requests[0];
  assert.equal(request.status, 'finished');
  assert.equal(request.streamResourceContentEnabled, true);
  assert.equal(request.chunks.length, 3);
  assert.equal(
    collector.getRawBody(request).toString('utf8'),
    first +
      'event: message\ndata: {"sequence":2}\n\n' +
      'event: done\ndata: [DONE]\n\n',
  );
  assert.deepEqual(
    collector.getSseEvents(request).events.map(event => event.data),
    ['{"sequence":1}', '{"sequence":2}', '[DONE]'],
  );
  assert.equal(collector.getSseEvents(request).events.at(-1)?.done, true);
});

test('falls back to native EventSource messages when raw streaming is unavailable', async () => {
  const {collector, page, session} = createFixture({
    streamResourceContent: async () => {
      throw new Error('Method not found');
    },
  });
  await collector.addPage(page);
  const capture = collector.startCapture(page, {
    resourceTypes: ['EventSource'],
  });

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

  const request = capture.requests[0];
  assert.equal(request.streamResourceContentEnabled, false);
  assert.match(request.streamResourceContentError ?? '', /Method not found/);
  const parsed = collector.getSseEvents(request);
  assert.deepEqual(
    parsed.events.map(event => ({
      name: event.eventName,
      data: event.data,
      source: event.source,
    })),
    [
      {name: 'message', data: '{"sequence":1}', source: 'eventsource'},
      {name: 'done', data: '[DONE]', source: 'eventsource'},
    ],
  );
  assert.equal(parsed.events.at(-1)?.done, true);
});

test('records cancellation and freezes active requests on stop', async () => {
  const {collector, page, session} = createFixture();
  await collector.addPage(page);
  const capture = collector.startCapture(page, {});
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
  emitData(session, openRequestId, 'data: partial\n\n', 4);
  const stopped = collector.stopCapture(page, capture.id);

  const canceled = stopped.requests.find(item => item.requestId === 'canceled');
  const open = stopped.requests.find(item => item.requestId === 'open');
  assert.equal(canceled?.status, 'failed');
  assert.equal(canceled?.failure?.canceled, true);
  assert.equal(canceled?.failure?.errorText, 'net::ERR_ABORTED');
  assert.equal(open?.status, 'stopped');
  assert.equal(stopped.status, 'stopped');
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
