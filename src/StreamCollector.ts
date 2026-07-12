/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';

import type {Protocol} from 'devtools-protocol';

import {addCdpEventListener, removeCdpEventListener} from './CdpEvents.js';
import type {CdpSessionProvider} from './CdpSessionProvider.js';
import {logger} from './logger.js';
import type {BrowserContext, Page} from './third_party/index.js';

export type StreamCaptureStatus = 'armed' | 'capturing' | 'stopped';
export type StreamRequestStatus =
  | 'streaming'
  | 'finished'
  | 'failed'
  | 'stopped';

export interface StreamCaptureFilter {
  urlFilter?: string;
  methods?: string[];
  resourceTypes?: string[];
  mimeTypes?: string[];
}

export interface StreamChunk {
  index: number;
  requestId: string;
  timestamp: number;
  dataLength: number;
  encodedDataLength: number;
  dataBase64?: string;
  payloadBytes: number;
  source: 'buffered' | 'network';
}

export interface EventSourceMessage {
  index: number;
  requestId: string;
  timestamp: number;
  eventName: string;
  eventId: string;
  data: string;
}

export interface SseEvent {
  index: number;
  eventName: string;
  eventId?: string;
  data: string;
  retry?: number;
  comments: string[];
  raw: string;
  done: boolean;
  source: 'raw-stream' | 'eventsource';
  timestamp?: number;
}

export interface StreamRequest {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  mimeType?: string;
  status: StreamRequestStatus;
  startedAt: number;
  endedAt?: number;
  failure?: {
    errorText: string;
    canceled: boolean;
    blockedReason?: string;
  };
  streamResourceContentEnabled: boolean;
  streamResourceContentError?: string;
  chunks: StreamChunk[];
  eventSourceMessages: EventSourceMessage[];
}

export interface StreamCapture {
  id: number;
  status: StreamCaptureStatus;
  filter: StreamCaptureFilter;
  createdAt: number;
  stoppedAt?: number;
  requests: StreamRequest[];
  totalBytes: number;
  totalChunks: number;
  truncated: boolean;
  version: number;
}

interface RequestMetadata {
  url: string;
  method: string;
  resourceType?: string;
}

interface StreamCollectorLimits {
  maxCaptures: number;
  maxBytesPerCapture: number;
  maxChunksPerCapture: number;
}

export const MAX_RETAINED_STREAM_CAPTURES = 20;
export const MAX_RETAINED_STREAM_BYTES = 32 * 1024 * 1024;
export const MAX_RETAINED_STREAM_CHUNKS = 20_000;

function createIdGenerator() {
  let id = 1;
  return () => {
    if (id === Number.MAX_SAFE_INTEGER) {
      id = 1;
    }
    return id++;
  };
}

function normalizedList(values?: string[]): string[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  return values.map(value => value.toLowerCase());
}

function matchesFilter(
  filter: StreamCaptureFilter,
  metadata: RequestMetadata,
  mimeType?: string,
): boolean {
  if (filter.urlFilter && !metadata.url.includes(filter.urlFilter)) {
    return false;
  }
  const methods = normalizedList(filter.methods);
  if (methods && !methods.includes(metadata.method.toLowerCase())) {
    return false;
  }
  const resourceTypes = normalizedList(filter.resourceTypes);
  if (
    resourceTypes &&
    !resourceTypes.includes((metadata.resourceType ?? '').toLowerCase())
  ) {
    return false;
  }
  const mimeTypes = normalizedList(filter.mimeTypes);
  if (
    mimeTypes &&
    !mimeTypes.some(expected =>
      (mimeType ?? '').toLowerCase().startsWith(expected),
    )
  ) {
    return false;
  }
  return true;
}

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitSseBlocks(text: string): {
  blocks: string[];
  incompleteTail: string;
} {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const pieces = normalized.split('\n\n');
  const complete = normalized.endsWith('\n\n');
  const incompleteTail = complete ? '' : (pieces.pop() ?? '');
  return {blocks: pieces.filter(block => block.length > 0), incompleteTail};
}

export function parseSseEvents(data: Uint8Array): {
  events: SseEvent[];
  incompleteTail: string;
} {
  const text = Buffer.from(data).toString('utf8');
  const {blocks, incompleteTail} = splitSseBlocks(text);
  const events: SseEvent[] = [];

  for (const [index, block] of blocks.entries()) {
    const dataLines: string[] = [];
    const comments: string[] = [];
    let eventName = 'message';
    let eventId: string | undefined;
    let retry: number | undefined;

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        comments.push(line.slice(1).trimStart());
        continue;
      }
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      switch (field) {
        case 'data':
          dataLines.push(value);
          break;
        case 'event':
          eventName = value || 'message';
          break;
        case 'id':
          eventId = value;
          break;
        case 'retry': {
          const parsed = Number(value);
          if (Number.isSafeInteger(parsed) && parsed >= 0) {
            retry = parsed;
          }
          break;
        }
      }
    }

    const eventData = dataLines.join('\n');
    if (dataLines.length === 0 && comments.length === 0) {
      continue;
    }
    events.push({
      index,
      eventName,
      eventId,
      data: eventData,
      retry,
      comments,
      raw: block,
      done: eventData.trim() === '[DONE]',
      source: 'raw-stream',
    });
  }

  return {events, incompleteTail};
}

/**
 * Captures streaming HTTP response bytes without waiting for response.body().
 *
 * Network.streamResourceContent asks Chromium to include response bytes in
 * Network.dataReceived events. Network.eventSourceMessageReceived is retained
 * as a semantic fallback for native EventSource requests.
 */
export class StreamCollector {
  #context: BrowserContext;
  #sessionProvider: CdpSessionProvider;
  #limits: StreamCollectorLimits;
  #storage = new WeakMap<Page, StreamCapture[]>();
  #activeCapture = new WeakMap<Page, StreamCapture>();
  #requestMetadata = new WeakMap<Page, Map<string, RequestMetadata>>();
  #requestOwners = new WeakMap<Page, Map<string, StreamRequest>>();
  #idGenerators = new WeakMap<Page, () => number>();
  #cdpCleanup = new WeakMap<Page, () => void>();
  #pageCloseListeners = new WeakMap<Page, () => void>();
  #pageInitializations = new WeakMap<Page, Promise<void>>();
  #pendingInitializations = new Set<Promise<void>>();
  #initialization?: Promise<void>;
  #listeningForPages = false;
  #disposed = false;

  constructor(
    context: BrowserContext,
    sessionProvider: CdpSessionProvider,
    limits: Partial<StreamCollectorLimits> = {},
  ) {
    this.#context = context;
    this.#sessionProvider = sessionProvider;
    this.#limits = {
      maxCaptures: limits.maxCaptures ?? MAX_RETAINED_STREAM_CAPTURES,
      maxBytesPerCapture:
        limits.maxBytesPerCapture ?? MAX_RETAINED_STREAM_BYTES,
      maxChunksPerCapture:
        limits.maxChunksPerCapture ?? MAX_RETAINED_STREAM_CHUNKS,
    };
  }

  async init(): Promise<void> {
    if (this.#disposed) {
      throw new Error('Stream collector has been disposed');
    }
    if (this.#initialization) {
      await this.#initialization;
      return;
    }
    const initialization = this.#initialize();
    this.#initialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.#initialization === initialization) {
        this.#initialization = undefined;
      }
    }
  }

  async #initialize(): Promise<void> {
    if (!this.#listeningForPages) {
      this.#context.on('page', this.#onPageCreated);
      this.#listeningForPages = true;
    }
    for (const page of this.#context.pages()) {
      void this.addPage(page).catch(() => undefined);
    }
    await this.#drainInitializations();
  }

  async #drainInitializations(): Promise<void> {
    let firstError: unknown;
    while (this.#pendingInitializations.size > 0) {
      const results = await Promise.allSettled([
        ...this.#pendingInitializations,
      ]);
      const rejection = results.find(result => result.status === 'rejected');
      if (firstError === undefined && rejection?.status === 'rejected') {
        firstError = rejection.reason;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  #onPageCreated = (page: Page) => {
    void this.addPage(page).catch(error => {
      logger('Failed to initialize stream collection for a new page', error);
    });
  };

  addPage(page: Page): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new Error('Stream collector has been disposed'));
    }
    if (this.#cdpCleanup.has(page)) {
      return Promise.resolve();
    }
    const pending = this.#pageInitializations.get(page);
    if (pending) {
      return pending;
    }
    const operation = this.#initializePage(page);
    const initialization = operation.finally(() => {
      if (this.#pageInitializations.get(page) === initialization) {
        this.#pageInitializations.delete(page);
      }
      this.#pendingInitializations.delete(initialization);
    });
    this.#pageInitializations.set(page, initialization);
    this.#pendingInitializations.add(initialization);
    return initialization;
  }

  async #initializePage(page: Page): Promise<void> {
    this.#storage.set(page, []);
    this.#requestMetadata.set(page, new Map());
    this.#requestOwners.set(page, new Map());
    this.#idGenerators.set(page, createIdGenerator());
    const onClose = () => this.#cleanupPage(page);
    this.#pageCloseListeners.set(page, onClose);
    page.on('close', onClose);
    try {
      await this.#setupCdpListeners(page);
    } catch (error) {
      this.#cleanupPage(page);
      throw error;
    }
  }

  async #setupCdpListeners(page: Page): Promise<void> {
    const client = await this.#sessionProvider.getSession(page);
    const metadataMap = this.#requestMetadata.get(page);
    const ownerMap = this.#requestOwners.get(page);
    if (!metadataMap || !ownerMap) {
      return;
    }

    const onRequestWillBeSent = (
      event: Protocol.Network.RequestWillBeSentEvent,
    ): void => {
      metadataMap.set(event.requestId, {
        url: event.request.url,
        method: event.request.method,
        resourceType: event.type,
      });
    };

    const onResponseReceived = (
      event: Protocol.Network.ResponseReceivedEvent,
    ): void => {
      const capture = this.#activeCapture.get(page);
      if (!capture || capture.status === 'stopped') {
        return;
      }
      const metadata = metadataMap.get(event.requestId) ?? {
        url: event.response.url,
        method: 'GET',
        resourceType: event.type,
      };
      metadata.resourceType ??= event.type;
      if (!matchesFilter(capture.filter, metadata, event.response.mimeType)) {
        return;
      }
      if (ownerMap.has(event.requestId)) {
        return;
      }
      const request: StreamRequest = {
        requestId: event.requestId,
        url: metadata.url,
        method: metadata.method,
        resourceType: metadata.resourceType,
        mimeType: event.response.mimeType,
        status: 'streaming',
        startedAt: event.timestamp * 1000,
        streamResourceContentEnabled: false,
        chunks: [],
        eventSourceMessages: [],
      };
      ownerMap.set(event.requestId, request);
      capture.requests.push(request);
      capture.status = 'capturing';
      capture.version++;

      void client
        .send('Network.streamResourceContent', {requestId: event.requestId})
        .then(result => {
          request.streamResourceContentEnabled = true;
          if (result.bufferedData) {
            this.#addChunk(
              page,
              request,
              {
                requestId: event.requestId,
                timestamp: event.timestamp,
                dataLength: Buffer.from(result.bufferedData, 'base64').length,
                encodedDataLength: 0,
                data: result.bufferedData,
              },
              'buffered',
            );
          }
        })
        .catch(error => {
          request.streamResourceContentError = getErrorText(error);
          capture.version++;
        });
    };

    const onDataReceived = (
      event: Protocol.Network.DataReceivedEvent,
    ): void => {
      const request = ownerMap.get(event.requestId);
      if (!request) {
        return;
      }
      this.#addChunk(page, request, event, 'network');
    };

    const onEventSourceMessage = (
      event: Protocol.Network.EventSourceMessageReceivedEvent,
    ): void => {
      const request = ownerMap.get(event.requestId);
      if (!request) {
        return;
      }
      const capture = this.#activeCapture.get(page);
      if (!capture || capture.status === 'stopped') {
        return;
      }
      request.eventSourceMessages.push({
        index: request.eventSourceMessages.length,
        requestId: event.requestId,
        timestamp: event.timestamp * 1000,
        eventName: event.eventName || 'message',
        eventId: event.eventId,
        data: event.data,
      });
      capture.version++;
    };

    const onLoadingFinished = (
      event: Protocol.Network.LoadingFinishedEvent,
    ): void => {
      const request = ownerMap.get(event.requestId);
      metadataMap.delete(event.requestId);
      if (!request) {
        return;
      }
      request.status = 'finished';
      request.endedAt = event.timestamp * 1000;
      const capture = this.#activeCapture.get(page);
      if (capture) {
        capture.version++;
      }
    };

    const onLoadingFailed = (
      event: Protocol.Network.LoadingFailedEvent,
    ): void => {
      const request = ownerMap.get(event.requestId);
      metadataMap.delete(event.requestId);
      if (!request) {
        return;
      }
      request.status = 'failed';
      request.endedAt = event.timestamp * 1000;
      request.failure = {
        errorText: event.errorText,
        canceled: Boolean(event.canceled),
        blockedReason: event.blockedReason,
      };
      const capture = this.#activeCapture.get(page);
      if (capture) {
        capture.version++;
      }
    };

    const cleanup = () => {
      removeCdpEventListener(
        client,
        'Network.requestWillBeSent',
        onRequestWillBeSent,
      );
      removeCdpEventListener(
        client,
        'Network.responseReceived',
        onResponseReceived,
      );
      removeCdpEventListener(client, 'Network.dataReceived', onDataReceived);
      removeCdpEventListener(
        client,
        'Network.eventSourceMessageReceived',
        onEventSourceMessage,
      );
      removeCdpEventListener(
        client,
        'Network.loadingFinished',
        onLoadingFinished,
      );
      removeCdpEventListener(client, 'Network.loadingFailed', onLoadingFailed);
    };

    let attached = false;
    try {
      addCdpEventListener(
        client,
        'Network.requestWillBeSent',
        onRequestWillBeSent,
      );
      addCdpEventListener(
        client,
        'Network.responseReceived',
        onResponseReceived,
      );
      addCdpEventListener(client, 'Network.dataReceived', onDataReceived);
      addCdpEventListener(
        client,
        'Network.eventSourceMessageReceived',
        onEventSourceMessage,
      );
      addCdpEventListener(client, 'Network.loadingFinished', onLoadingFinished);
      addCdpEventListener(client, 'Network.loadingFailed', onLoadingFailed);
      attached = true;
      await client.send('Network.enable');
      if (!this.#storage.has(page)) {
        cleanup();
        return;
      }
      this.#cdpCleanup.set(page, cleanup);
    } catch (error) {
      if (attached) {
        cleanup();
      }
      throw error;
    }
  }

  #addChunk(
    page: Page,
    request: StreamRequest,
    event: {
      requestId: string;
      timestamp: number;
      dataLength: number;
      encodedDataLength: number;
      data?: string;
    },
    source: StreamChunk['source'],
  ): void {
    const capture = this.#activeCapture.get(page);
    if (!capture || capture.status === 'stopped') {
      return;
    }
    const payloadBytes = event.data
      ? Buffer.from(event.data, 'base64').length
      : 0;
    if (
      capture.totalChunks >= this.#limits.maxChunksPerCapture ||
      capture.totalBytes + payloadBytes > this.#limits.maxBytesPerCapture
    ) {
      capture.truncated = true;
      capture.version++;
      return;
    }
    request.chunks.push({
      index: request.chunks.length,
      requestId: event.requestId,
      timestamp: event.timestamp * 1000,
      dataLength: event.dataLength,
      encodedDataLength: event.encodedDataLength,
      dataBase64: event.data,
      payloadBytes,
      source,
    });
    capture.totalBytes += payloadBytes;
    capture.totalChunks++;
    capture.version++;
  }

  startCapture(page: Page, filter: StreamCaptureFilter): StreamCapture {
    const active = this.#activeCapture.get(page);
    if (active && active.status !== 'stopped') {
      throw new Error(
        `Stream capture ${active.id} is already active for the selected page`,
      );
    }
    const idGenerator = this.#idGenerators.get(page);
    const storage = this.#storage.get(page);
    if (!idGenerator || !storage) {
      throw new Error('Stream collector is not initialized for selected page');
    }
    const capture: StreamCapture = {
      id: idGenerator(),
      status: 'armed',
      filter: {
        ...filter,
        mimeTypes:
          filter.mimeTypes?.length === 0
            ? undefined
            : (filter.mimeTypes ?? ['text/event-stream']),
      },
      createdAt: Date.now(),
      requests: [],
      totalBytes: 0,
      totalChunks: 0,
      truncated: false,
      version: 0,
    };
    storage.unshift(capture);
    storage.splice(this.#limits.maxCaptures);
    this.#activeCapture.set(page, capture);
    this.#requestOwners.get(page)?.clear();
    return capture;
  }

  stopCapture(page: Page, captureId: number): StreamCapture {
    const capture = this.getById(page, captureId);
    if (capture.status === 'stopped') {
      return capture;
    }
    capture.status = 'stopped';
    capture.stoppedAt = Date.now();
    for (const request of capture.requests) {
      if (request.status === 'streaming') {
        request.status = 'stopped';
        request.endedAt = capture.stoppedAt;
      }
    }
    capture.version++;
    if (this.#activeCapture.get(page) === capture) {
      this.#activeCapture.delete(page);
    }
    this.#requestOwners.get(page)?.clear();
    return capture;
  }

  getData(page: Page): StreamCapture[] {
    return this.#storage.get(page) ?? [];
  }

  getById(page: Page, captureId: number): StreamCapture {
    const capture = this.getData(page).find(item => item.id === captureId);
    if (!capture) {
      throw new Error(`Stream capture ${captureId} was not found`);
    }
    return capture;
  }

  getRawBody(request: StreamRequest): Buffer {
    const buffers = request.chunks
      .filter(chunk => chunk.dataBase64)
      .map(chunk => Buffer.from(chunk.dataBase64!, 'base64'));
    return Buffer.concat(buffers);
  }

  getSseEvents(request: StreamRequest): {
    events: SseEvent[];
    incompleteTail: string;
  } {
    const raw = this.getRawBody(request);
    if (raw.length > 0) {
      return parseSseEvents(raw);
    }
    return {
      events: request.eventSourceMessages.map(message => ({
        index: message.index,
        eventName: message.eventName || 'message',
        eventId: message.eventId || undefined,
        data: message.data,
        comments: [],
        raw: '',
        done: message.data.trim() === '[DONE]',
        source: 'eventsource',
        timestamp: message.timestamp,
      })),
      incompleteTail: '',
    };
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#listeningForPages) {
      this.#context.off('page', this.#onPageCreated);
      this.#listeningForPages = false;
    }
    for (const page of this.#context.pages()) {
      this.#cleanupPage(page);
    }
  }

  #cleanupPage(page: Page): void {
    const onClose = this.#pageCloseListeners.get(page);
    if (onClose) {
      page.off('close', onClose);
      this.#pageCloseListeners.delete(page);
    }
    const cleanup = this.#cdpCleanup.get(page);
    if (cleanup) {
      try {
        cleanup();
      } catch {
        // Page/session may already be closed.
      }
    }
    this.#cdpCleanup.delete(page);
    this.#storage.delete(page);
    this.#activeCapture.delete(page);
    this.#requestMetadata.delete(page);
    this.#requestOwners.delete(page);
    this.#idGenerators.delete(page);
  }
}
