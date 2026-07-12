/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

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
  payloadBytes: number;
  source: 'buffered' | 'network';
  fileOffsetStart: number;
  fileOffsetEnd: number;
  eventIndexes: number[];
}

export interface StreamArtifactFile {
  kind:
    | 'capture_metadata'
    | 'request_metadata'
    | 'raw_bytes'
    | 'raw_text'
    | 'chunks'
    | 'events'
    | 'eventsource_events'
    | 'payload';
  path: string;
  bytes?: number;
  sha256?: string;
  mimeType?: string;
}

export interface StreamEventSummary {
  index: number;
  eventName: string;
  done: boolean;
  timestamp?: number;
  source: 'raw-stream' | 'eventsource';
  dataLength: number;
  payloadCount: number;
}

export interface StreamRequest {
  requestId: string;
  requestIndex: number;
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
  outputDir: string;
  chunks: StreamChunk[];
  eventCount: number;
  eventSourceMessageCount: number;
  doneMarkerObserved: boolean;
  parseErrors: number;
  incompleteTailChars: number;
  totalBytes: number;
  writeErrors: string[];
  files: StreamArtifactFile[];
  recentEvents: StreamEventSummary[];
}

export interface StreamCapture {
  id: number;
  status: StreamCaptureStatus;
  filter: StreamCaptureFilter;
  outputDir: string;
  metadataFile: string;
  createdAt: number;
  stoppedAt?: number;
  requests: StreamRequest[];
  totalBytes: number;
  totalChunks: number;
  totalEvents: number;
  truncated: boolean;
  writeErrors: string[];
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
  maxRecentEventsPerRequest: number;
}

interface MaterializedPayload {
  descriptor: Record<string, unknown>;
  relativePath: string;
  absolutePath: string;
  bytes: Buffer;
  mimeType?: string;
  sha256: string;
}

interface MaterializedEvent {
  record: Record<string, unknown>;
  payloads: MaterializedPayload[];
  summary: StreamEventSummary;
}

interface RequestRuntime {
  writeChain: Promise<void>;
  decoder: TextDecoder;
  parser: IncrementalSseParser;
  rawOffset: number;
  finalized: boolean;
  finalizePromise?: Promise<void>;
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

export const MAX_RETAINED_STREAM_CAPTURES = 20;
export const MAX_RETAINED_STREAM_BYTES = 32 * 1024 * 1024;
export const MAX_RETAINED_STREAM_CHUNKS = 20_000;
export const MAX_RECENT_STREAM_EVENTS = 20;

const MAX_INLINE_EVENT_DATA_CHARS = 64 * 1024;
const MIN_BASE64_ARTIFACT_CHARS = 4 * 1024;

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

function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parseSseBlock(
  block: string,
  index: number,
  source: SseEvent['source'],
  timestamp?: number,
): SseEvent | undefined {
  const normalized = block.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const dataLines: string[] = [];
  const comments: string[] = [];
  let eventName = 'message';
  let eventId: string | undefined;
  let retry: number | undefined;

  for (const line of normalized.split('\n')) {
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

  if (dataLines.length === 0 && comments.length === 0) {
    return undefined;
  }
  const data = dataLines.join('\n');
  return {
    index,
    eventName,
    eventId,
    data,
    retry,
    comments,
    raw: normalized,
    done: data.trim() === '[DONE]',
    source,
    timestamp,
  };
}

function findSseSeparator(
  text: string,
): {index: number; length: number} | undefined {
  const separators = ['\r\n\r\n', '\n\n', '\r\r'];
  let found: {index: number; length: number} | undefined;
  for (const separator of separators) {
    const index = text.indexOf(separator);
    if (index === -1) {
      continue;
    }
    if (
      !found ||
      index < found.index ||
      (index === found.index && separator.length > found.length)
    ) {
      found = {index, length: separator.length};
    }
  }
  return found;
}

class IncrementalSseParser {
  #buffer = '';
  #nextIndex = 0;

  push(text: string, timestamp?: number): SseEvent[] {
    this.#buffer += text;
    const events: SseEvent[] = [];
    while (true) {
      const separator = findSseSeparator(this.#buffer);
      if (!separator) {
        break;
      }
      const block = this.#buffer.slice(0, separator.index);
      this.#buffer = this.#buffer.slice(separator.index + separator.length);
      const event = parseSseBlock(
        block,
        this.#nextIndex,
        'raw-stream',
        timestamp,
      );
      if (event) {
        events.push(event);
        this.#nextIndex++;
      }
    }
    return events;
  }

  get incompleteTail(): string {
    return this.#buffer;
  }
}

export function parseSseEvents(data: Uint8Array): {
  events: SseEvent[];
  incompleteTail: string;
} {
  const parser = new IncrementalSseParser();
  const events = parser.push(Buffer.from(data).toString('utf8'));
  return {events, incompleteTail: parser.incompleteTail};
}

function detectMimeType(data: Buffer): {mimeType?: string; extension: string} {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return {mimeType: 'image/png', extension: 'png'};
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return {mimeType: 'image/jpeg', extension: 'jpg'};
  }
  if (
    data.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))
  ) {
    return {mimeType: 'image/gif', extension: 'gif'};
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return {mimeType: 'image/webp', extension: 'webp'};
  }
  if (data.length >= 5 && data.subarray(0, 5).toString('ascii') === '%PDF-') {
    return {mimeType: 'application/pdf', extension: 'pdf'};
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return {mimeType: 'audio/wav', extension: 'wav'};
  }
  if (data.length >= 3 && data.subarray(0, 3).toString('ascii') === 'ID3') {
    return {mimeType: 'audio/mpeg', extension: 'mp3'};
  }
  return {extension: 'bin'};
}

function sanitizePathSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80) || 'data';
}

function parseBase64Candidate(
  value: string,
): {bytes: Buffer; mimeType?: string; extension: string} | undefined {
  let encoded = value;
  let declaredMimeType: string | undefined;
  const dataUri = /^data:([^;,]+)?;base64,(.*)$/s.exec(value);
  if (dataUri) {
    declaredMimeType = dataUri[1] || undefined;
    encoded = dataUri[2];
  }
  const compact = encoded.replaceAll(/\s+/g, '');
  if (
    compact.length < MIN_BASE64_ARTIFACT_CHARS ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0) {
    return undefined;
  }
  const detected = detectMimeType(bytes);
  return {
    bytes,
    mimeType: declaredMimeType ?? detected.mimeType,
    extension: detected.extension,
  };
}

function materializeJsonValue(
  value: unknown,
  keyPath: string[],
  eventIndex: number,
  eventSource: SseEvent['source'],
  request: StreamRequest,
  payloads: MaterializedPayload[],
): unknown {
  if (typeof value === 'string') {
    const candidate = parseBase64Candidate(value);
    if (!candidate) {
      return value.length <= MAX_INLINE_EVENT_DATA_CHARS
        ? value
        : {
            $largeText: true,
            chars: value.length,
            preview: value.slice(0, 512),
            source: request.files.find(file => file.kind === 'raw_text')?.path,
          };
    }
    const key = keyPath.at(-1) ?? 'data';
    const explicitBinaryKey =
      /(?:base64|b64|image|audio|blob|binary|file)/i.test(key);
    const magicDetected = candidate.mimeType !== undefined;
    if (!explicitBinaryKey && !magicDetected) {
      return {
        $possibleBase64: true,
        encodedChars: value.length,
        decodedBytes: candidate.bytes.length,
        preview: value.slice(0, 80),
        source: request.files.find(file => file.kind === 'raw_text')?.path,
      };
    }
    const relativePath = path.join(
      'payloads',
      `event-${String(eventIndex).padStart(6, '0')}-${eventSource}-${sanitizePathSegment(keyPath.join('-'))}.${candidate.extension}`,
    );
    const absolutePath = path.join(request.outputDir, relativePath);
    const sha256 = createHash('sha256').update(candidate.bytes).digest('hex');
    const descriptor: Record<string, unknown> = {
      $artifact: relativePath,
      encoding: 'base64',
      decodedBytes: candidate.bytes.length,
      sha256,
    };
    if (candidate.mimeType) {
      descriptor.mimeType = candidate.mimeType;
    }
    payloads.push({
      descriptor,
      relativePath,
      absolutePath,
      bytes: candidate.bytes,
      mimeType: candidate.mimeType,
      sha256,
    });
    return descriptor;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      materializeJsonValue(
        item,
        [...keyPath, String(index)],
        eventIndex,
        eventSource,
        request,
        payloads,
      ),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        materializeJsonValue(
          item,
          [...keyPath, key],
          eventIndex,
          eventSource,
          request,
          payloads,
        ),
      ]),
    );
  }
  return value;
}

function materializeEvent(
  event: SseEvent,
  request: StreamRequest,
): MaterializedEvent {
  const payloads: MaterializedPayload[] = [];
  const record: Record<string, unknown> = {
    index: event.index,
    eventName: event.eventName,
    eventId: event.eventId,
    retry: event.retry,
    comments: event.comments,
    done: event.done,
    source: event.source,
    timestamp: event.timestamp,
    dataLength: event.data.length,
  };
  try {
    const parsed = JSON.parse(event.data) as unknown;
    record.dataType = 'json';
    record.dataJson = materializeJsonValue(
      parsed,
      ['data'],
      event.index,
      event.source,
      request,
      payloads,
    );
  } catch {
    const materialized = materializeJsonValue(
      event.data,
      ['data'],
      event.index,
      event.source,
      request,
      payloads,
    );
    record.dataType = 'text';
    if (typeof materialized === 'string') {
      record.data = materialized;
    } else {
      record.dataArtifact = materialized;
    }
  }
  return {
    record,
    payloads,
    summary: {
      index: event.index,
      eventName: event.eventName,
      done: event.done,
      timestamp: event.timestamp,
      source: event.source,
      dataLength: event.data.length,
      payloadCount: payloads.length,
    },
  };
}

async function writeJsonFile(filename: string, value: unknown): Promise<void> {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Captures streaming HTTP response bytes without waiting for response.body().
 * Base64 from CDP is decoded immediately and never appears in tool output or
 * exported JSON. Raw bytes and analysis-friendly JSONL are written to disk.
 */
export class StreamCollector {
  #context: BrowserContext;
  #sessionProvider: CdpSessionProvider;
  #limits: StreamCollectorLimits;
  #storage = new WeakMap<Page, StreamCapture[]>();
  #activeCapture = new WeakMap<Page, StreamCapture>();
  #requestMetadata = new WeakMap<Page, Map<string, RequestMetadata>>();
  #requestOwners = new WeakMap<Page, Map<string, StreamRequest>>();
  #requestRuntime = new WeakMap<StreamRequest, RequestRuntime>();
  #requestCapture = new WeakMap<StreamRequest, StreamCapture>();
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
      maxRecentEventsPerRequest:
        limits.maxRecentEventsPerRequest ?? MAX_RECENT_STREAM_EVENTS,
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
      const requestIndex = capture.requests.length;
      const outputDir = path.join(
        capture.outputDir,
        `request-${String(requestIndex + 1).padStart(4, '0')}`,
      );
      const files: StreamArtifactFile[] = [
        {kind: 'request_metadata', path: path.join(outputDir, 'metadata.json')},
        {kind: 'raw_bytes', path: path.join(outputDir, 'raw.bin')},
        {kind: 'raw_text', path: path.join(outputDir, 'raw.sse')},
        {kind: 'chunks', path: path.join(outputDir, 'chunks.jsonl')},
        {kind: 'events', path: path.join(outputDir, 'events.jsonl')},
        {
          kind: 'eventsource_events',
          path: path.join(outputDir, 'eventsource.jsonl'),
        },
      ];
      const request: StreamRequest = {
        requestId: event.requestId,
        requestIndex,
        url: metadata.url,
        method: metadata.method,
        resourceType: metadata.resourceType,
        mimeType: event.response.mimeType,
        status: 'streaming',
        startedAt: event.timestamp * 1000,
        streamResourceContentEnabled: false,
        outputDir,
        chunks: [],
        eventCount: 0,
        eventSourceMessageCount: 0,
        doneMarkerObserved: false,
        parseErrors: 0,
        incompleteTailChars: 0,
        totalBytes: 0,
        writeErrors: [],
        files,
        recentEvents: [],
      };
      const runtime: RequestRuntime = {
        writeChain: this.#initializeRequestFiles(request),
        decoder: new TextDecoder('utf-8'),
        parser: new IncrementalSseParser(),
        rawOffset: 0,
        finalized: false,
      };
      this.#requestRuntime.set(request, runtime);
      this.#requestCapture.set(request, capture);
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
      const semanticEvent: SseEvent = {
        index: request.eventSourceMessageCount,
        eventName: event.eventName || 'message',
        eventId: event.eventId || undefined,
        data: event.data,
        comments: [],
        raw: '',
        done: event.data.trim() === '[DONE]',
        source: 'eventsource',
        timestamp: event.timestamp * 1000,
      };
      request.eventSourceMessageCount++;
      request.doneMarkerObserved ||= semanticEvent.done;
      this.#enqueueEventWrite(request, semanticEvent, 'eventsource');
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
      void this.#finalizeRequest(request);
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
      void this.#finalizeRequest(request);
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

  async #initializeRequestFiles(request: StreamRequest): Promise<void> {
    await fs.mkdir(request.outputDir, {mode: 0o700});
    await fs.mkdir(path.join(request.outputDir, 'payloads'), {mode: 0o700});
    await Promise.all(
      request.files
        .filter(file => file.kind !== 'request_metadata')
        .map(file =>
          fs.writeFile(file.path, Buffer.alloc(0), {flag: 'wx', mode: 0o600}),
        ),
    );
  }

  #queueWrite(request: StreamRequest, operation: () => Promise<void>): void {
    const runtime = this.#requestRuntime.get(request);
    if (!runtime) {
      return;
    }
    runtime.writeChain = runtime.writeChain.then(operation).catch(error => {
      request.writeErrors.push(getErrorText(error));
    });
  }

  #enqueueEventWrite(
    request: StreamRequest,
    event: SseEvent,
    destination: 'events' | 'eventsource',
  ): void {
    const materialized = materializeEvent(event, request);
    request.doneMarkerObserved ||= event.done;
    if (destination === 'events') {
      request.eventCount++;
    }
    const capture = this.#requestCapture.get(request);
    if (capture) {
      capture.totalEvents++;
    }
    request.recentEvents.push(materialized.summary);
    if (request.recentEvents.length > this.#limits.maxRecentEventsPerRequest) {
      request.recentEvents.splice(
        0,
        request.recentEvents.length - this.#limits.maxRecentEventsPerRequest,
      );
    }
    const targetKind =
      destination === 'events' ? 'events' : 'eventsource_events';
    const targetFile = request.files.find(
      file => file.kind === targetKind,
    )?.path;
    if (!targetFile) {
      request.writeErrors.push(`Missing ${targetKind} output file`);
      return;
    }
    this.#queueWrite(request, async () => {
      for (const payload of materialized.payloads) {
        await fs.writeFile(payload.absolutePath, payload.bytes, {
          flag: 'wx',
          mode: 0o600,
        });
        request.files.push({
          kind: 'payload',
          path: payload.absolutePath,
          bytes: payload.bytes.length,
          sha256: payload.sha256,
          mimeType: payload.mimeType,
        });
      }
      await fs.appendFile(targetFile, toJsonLine(materialized.record), {
        encoding: 'utf8',
      });
    });
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
    const runtime = this.#requestRuntime.get(request);
    if (!capture || capture.status === 'stopped' || !runtime) {
      return;
    }
    const payload = event.data
      ? Buffer.from(event.data, 'base64')
      : Buffer.alloc(0);
    const payloadBytes = payload.length;
    if (
      capture.totalChunks >= this.#limits.maxChunksPerCapture ||
      capture.totalBytes + payloadBytes > this.#limits.maxBytesPerCapture
    ) {
      capture.truncated = true;
      capture.version++;
      return;
    }

    const decodedText = runtime.decoder.decode(payload, {stream: true});
    const parsedEvents = runtime.parser.push(
      decodedText,
      event.timestamp * 1000,
    );
    const chunk: StreamChunk = {
      index: request.chunks.length,
      requestId: event.requestId,
      timestamp: event.timestamp * 1000,
      dataLength: event.dataLength,
      encodedDataLength: event.encodedDataLength,
      payloadBytes,
      source,
      fileOffsetStart: runtime.rawOffset,
      fileOffsetEnd: runtime.rawOffset + payloadBytes,
      eventIndexes: parsedEvents.map(item => item.index),
    };
    runtime.rawOffset += payloadBytes;
    request.chunks.push(chunk);
    request.totalBytes += payloadBytes;
    capture.totalBytes += payloadBytes;
    capture.totalChunks++;
    capture.version++;

    const rawFile = request.files.find(file => file.kind === 'raw_bytes')?.path;
    const textFile = request.files.find(file => file.kind === 'raw_text')?.path;
    const chunksFile = request.files.find(file => file.kind === 'chunks')?.path;
    this.#queueWrite(request, async () => {
      if (rawFile && payload.length > 0) {
        await fs.appendFile(rawFile, payload);
      }
      if (textFile && decodedText.length > 0) {
        await fs.appendFile(textFile, decodedText, {encoding: 'utf8'});
      }
      if (chunksFile) {
        await fs.appendFile(chunksFile, toJsonLine(chunk), {encoding: 'utf8'});
      }
    });
    for (const parsedEvent of parsedEvents) {
      this.#enqueueEventWrite(request, parsedEvent, 'events');
    }
  }

  async #finalizeRequest(request: StreamRequest): Promise<void> {
    const runtime = this.#requestRuntime.get(request);
    if (!runtime) {
      return;
    }
    if (runtime.finalizePromise) {
      await runtime.finalizePromise;
      return;
    }
    runtime.finalizePromise = (async () => {
      if (!runtime.finalized) {
        const finalText = runtime.decoder.decode();
        const finalEvents = runtime.parser.push(finalText, request.endedAt);
        request.incompleteTailChars = runtime.parser.incompleteTail.length;
        const textFile = request.files.find(
          file => file.kind === 'raw_text',
        )?.path;
        if (finalText.length > 0 && textFile) {
          this.#queueWrite(request, () =>
            fs.appendFile(textFile, finalText, {encoding: 'utf8'}),
          );
        }
        for (const event of finalEvents) {
          this.#enqueueEventWrite(request, event, 'events');
        }
        runtime.finalized = true;
      }
      await runtime.writeChain;
      await this.#refreshArtifactMetadata(request);
      await this.#writeRequestMetadata(request);
    })();
    await runtime.finalizePromise;
  }

  async #writeRequestMetadata(request: StreamRequest): Promise<void> {
    const metadataFile = request.files.find(
      file => file.kind === 'request_metadata',
    )?.path;
    if (!metadataFile) {
      return;
    }
    const primaryEventsFile =
      request.eventCount > 0
        ? request.files.find(file => file.kind === 'events')?.path
        : request.files.find(file => file.kind === 'eventsource_events')?.path;
    await writeJsonFile(metadataFile, {
      requestId: request.requestId,
      requestIndex: request.requestIndex,
      url: request.url,
      method: request.method,
      resourceType: request.resourceType,
      mimeType: request.mimeType,
      status: request.status,
      startedAt: request.startedAt,
      endedAt: request.endedAt,
      failure: request.failure,
      streamResourceContentEnabled: request.streamResourceContentEnabled,
      streamResourceContentError: request.streamResourceContentError,
      chunkCount: request.chunks.length,
      eventCount: request.eventCount,
      eventSourceMessageCount: request.eventSourceMessageCount,
      doneMarkerObserved: request.doneMarkerObserved,
      parseErrors: request.parseErrors,
      incompleteTailChars: request.incompleteTailChars,
      totalBytes: request.totalBytes,
      primaryEventsFile,
      files: request.files,
      writeErrors: request.writeErrors,
    });
  }

  async #refreshArtifactMetadata(request: StreamRequest): Promise<void> {
    for (const file of request.files) {
      if (file.kind === 'request_metadata') {
        continue;
      }
      try {
        const data = await fs.readFile(file.path);
        file.bytes = data.length;
        file.sha256 = createHash('sha256').update(data).digest('hex');
      } catch (error) {
        request.writeErrors.push(
          `Could not inspect artifact ${file.path}: ${getErrorText(error)}`,
        );
      }
    }
  }

  async #writeCaptureMetadata(capture: StreamCapture): Promise<void> {
    await writeJsonFile(capture.metadataFile, {
      captureId: capture.id,
      status: capture.status,
      filter: capture.filter,
      outputDir: capture.outputDir,
      createdAt: capture.createdAt,
      stoppedAt: capture.stoppedAt,
      requestCount: capture.requests.length,
      totalBytes: capture.totalBytes,
      totalChunks: capture.totalChunks,
      totalEvents: capture.totalEvents,
      truncated: capture.truncated,
      writeErrors: capture.writeErrors,
      requests: capture.requests.map(request => ({
        requestId: request.requestId,
        requestIndex: request.requestIndex,
        url: request.url,
        method: request.method,
        resourceType: request.resourceType,
        mimeType: request.mimeType,
        status: request.status,
        outputDir: request.outputDir,
        chunkCount: request.chunks.length,
        eventCount: request.eventCount,
        eventSourceMessageCount: request.eventSourceMessageCount,
        doneMarkerObserved: request.doneMarkerObserved,
        totalBytes: request.totalBytes,
        metadataFile: request.files.find(
          file => file.kind === 'request_metadata',
        )?.path,
      })),
    });
  }

  startCapture(
    page: Page,
    filter: StreamCaptureFilter,
    outputDir: string,
  ): StreamCapture {
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
      outputDir,
      metadataFile: path.join(outputDir, 'capture.json'),
      createdAt: Date.now(),
      requests: [],
      totalBytes: 0,
      totalChunks: 0,
      totalEvents: 0,
      truncated: false,
      writeErrors: [],
      version: 0,
    };
    storage.unshift(capture);
    storage.splice(this.#limits.maxCaptures);
    this.#activeCapture.set(page, capture);
    this.#requestOwners.get(page)?.clear();
    void this.#writeCaptureMetadata(capture).catch(error => {
      capture.writeErrors.push(getErrorText(error));
    });
    return capture;
  }

  async stopCapture(page: Page, captureId: number): Promise<StreamCapture> {
    const capture = this.getById(page, captureId);
    if (capture.status !== 'stopped') {
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
    }
    await Promise.all(
      capture.requests.map(request => this.#finalizeRequest(request)),
    );
    await this.#writeCaptureMetadata(capture);
    return capture;
  }

  async flushCapture(page: Page, captureId: number): Promise<StreamCapture> {
    const capture = this.getById(page, captureId);
    for (const request of capture.requests) {
      const runtime = this.#requestRuntime.get(request);
      if (runtime) {
        await runtime.writeChain;
      }
      if (request.status !== 'streaming') {
        await this.#finalizeRequest(request);
      } else {
        await this.#refreshArtifactMetadata(request);
        await this.#writeRequestMetadata(request);
      }
    }
    await this.#writeCaptureMetadata(capture);
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

  dispose(): void {
    this.#disposed = true;
    if (this.#listeningForPages) {
      this.#context.off('page', this.#onPageCreated);
      this.#listeningForPages = false;
    }
    for (const page of this.#context.pages()) {
      const active = this.#activeCapture.get(page);
      if (active) {
        void this.stopCapture(page, active.id).catch(() => undefined);
      }
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
