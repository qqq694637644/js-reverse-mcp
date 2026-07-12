/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';
import {createHash, randomUUID, type Hash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import type {Protocol} from 'devtools-protocol';

import {addCdpEventListener, removeCdpEventListener} from './CdpEvents.js';
import type {CdpSessionProvider} from './CdpSessionProvider.js';
import {logger, redactLogValue} from './logger.js';
import type {BrowserContext, Page} from './third_party/index.js';

export type StreamCaptureStatus = 'armed' | 'capturing' | 'stopped' | 'failed';
export type StreamRequestStatus =
  | 'activating'
  | 'streaming'
  | 'finished'
  | 'stopped'
  | 'failed';
export type StreamEventSource = 'raw-stream' | 'eventsource';
export type StreamEventRecordType = 'event' | 'heartbeat';

export interface StreamCaptureFilter {
  urlFilter?: string;
  methods?: string[];
  resourceTypes?: string[];
  mimeTypes?: string[];
}

export interface StreamCaptureLocation {
  rootIndex: number;
  absoluteDir: string;
  relativeDir: string;
}

export interface StreamArtifactFile {
  artifactId: string;
  kind:
    | 'capture_metadata'
    | 'request_metadata'
    | 'raw_bytes'
    | 'raw_text'
    | 'chunks'
    | 'events'
    | 'eventsource_events'
    | 'payload';
  rootIndex: number;
  relativePath: string;
  bytes: number;
  sha256?: string;
  mimeType?: string;
  writeStatus: 'pending' | 'written' | 'failed';
  error?: string;
}

export interface StreamChunkOffset {
  index: number;
  timestamp: number;
  dataLength: number;
  encodedDataLength: number;
  payloadBytes: number;
  source: 'buffered' | 'network';
  fileOffsetStart: number;
  fileOffsetEnd: number;
  eventIndexes: number[];
}

export interface StreamEventSummary {
  index: number;
  recordType: StreamEventRecordType;
  eventName?: string;
  done: boolean;
  timestamp?: number;
  source: StreamEventSource;
  dataLength: number;
  payloadCount: number;
}

export interface StreamTruncation {
  truncatedAt: number;
  reason: 'disk_quota_exceeded';
  quotaBytes: number;
  droppedChunkCount: number;
  droppedBytes: number;
}

export interface StreamFailure {
  errorText: string;
  canceled: boolean;
  blockedReason?: string;
  code?: 'DISK_QUOTA_EXCEEDED' | 'PAGE_CLOSED' | 'STREAM_ERROR';
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
  failure?: StreamFailure;
  streamResourceContentEnabled: boolean;
  streamResourceContentError?: string;
  relativeDir: string;
  chunkCount: number;
  recentChunks: StreamChunkOffset[];
  rawEventCount: number;
  semanticEventCount: number;
  primaryEventSource: StreamEventSource | 'none';
  doneMarkerObserved: boolean;
  parseErrors: number;
  incompleteTailChars: number;
  rawBytes: number;
  diskBytesReserved: number;
  truncation?: StreamTruncation;
  writeErrors: string[];
  artifacts: StreamArtifactFile[];
  recentRawEvents: StreamEventSummary[];
  recentSemanticEvents: StreamEventSummary[];
}

export interface StreamCapture {
  id: number;
  status: StreamCaptureStatus;
  filter: StreamCaptureFilter;
  artifactRootIndex: number;
  relativeDir: string;
  metadataArtifact: StreamArtifactFile;
  pageUrl: string;
  pageTitle?: string;
  createdAt: number;
  stoppedAt?: number;
  requests: StreamRequest[];
  totalRawBytes: number;
  diskBytesReserved: number;
  chunkCount: number;
  rawEventCount: number;
  semanticEventCount: number;
  quotaBytes: number;
  truncation?: StreamTruncation;
  errors: string[];
  version: number;
}

export interface SseEvent {
  index: number;
  recordType: StreamEventRecordType;
  eventName?: string;
  eventId?: string;
  data: string;
  retry?: number;
  comments: string[];
  done: boolean;
  source: StreamEventSource;
  timestamp?: number;
}

interface RequestMetadata {
  url: string;
  method: string;
  resourceType?: string;
}

interface StreamCollectorLimits {
  maxCaptures: number;
  maxDiskBytesPerCapture: number;
  maxRecentChunksPerRequest: number;
  maxRecentEventsPerRequest: number;
}

interface PendingChunk {
  timestamp: number;
  dataLength: number;
  encodedDataLength: number;
  payload: Buffer;
  source: 'buffered' | 'network';
}

interface RequestTerminal {
  status: 'finished' | 'stopped' | 'failed';
  endedAt: number;
  failure?: StreamFailure;
}

interface ArtifactRuntime {
  descriptor: StreamArtifactFile;
  absolutePath: string;
  hash: Hash;
}

interface CaptureRuntime {
  page: Page;
  absoluteDir: string;
  metadataAbsolutePath: string;
  metadataChain: Promise<void>;
  closePromise?: Promise<void>;
}

interface RequestRuntime {
  capture: StreamCapture;
  absoluteDir: string;
  decoder: TextDecoder;
  parser: IncrementalSseParser;
  rawOffset: number;
  payloadIndex: number;
  nextSemanticEventIndex: number;
  writeChain: Promise<void>;
  activationPromise: Promise<void>;
  activationResolved: boolean;
  pendingChunks: PendingChunk[];
  terminal?: RequestTerminal;
  finalized: boolean;
  finalizePromise?: Promise<void>;
  artifacts: Map<StreamArtifactFile['kind'], ArtifactRuntime>;
}

interface MaterializedPayload {
  descriptor: Record<string, unknown>;
  artifact: StreamArtifactFile;
  absolutePath: string;
  bytes: Buffer;
}

interface MaterializedEvent {
  record: Record<string, unknown>;
  payloads: MaterializedPayload[];
  summary: StreamEventSummary;
}

export const DEFAULT_STREAM_DISK_QUOTA_BYTES = 512 * 1024 * 1024;
export const MAX_RETAINED_STREAM_CAPTURES = 100;
export const MAX_RECENT_STREAM_CHUNKS = 100;
export const MAX_RECENT_STREAM_EVENTS = 20;

const MAX_INLINE_EVENT_DATA_CHARS = 64 * 1024;
const MIN_BASE64_ARTIFACT_CHARS = 4 * 1024;

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
  return (
    !mimeTypes ||
    mimeTypes.some(expected =>
      (mimeType ?? '').toLowerCase().startsWith(expected),
    )
  );
}

function getErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactLogValue(message));
}

function toJsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join('/');
}

function parseSseBlock(
  block: string,
  index: number,
  source: StreamEventSource,
  timestamp?: number,
): SseEvent | undefined {
  const normalized = block.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const dataLines: string[] = [];
  const comments: string[] = [];
  let eventName: string | undefined;
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
  const recordType: StreamEventRecordType =
    dataLines.length === 0 && comments.length > 0 ? 'heartbeat' : 'event';
  return {
    index,
    recordType,
    eventName: recordType === 'event' ? (eventName ?? 'message') : undefined,
    eventId,
    data,
    retry,
    comments,
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

function parseBase64Candidate(value: string):
  | {
      bytes: Buffer;
      mimeType?: string;
      extension: string;
      confidence: 'high' | 'medium';
    }
  | undefined {
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
  const canonical = bytes.toString('base64').replaceAll(/=+$/g, '');
  if (canonical !== compact.replaceAll(/=+$/g, '')) {
    return undefined;
  }
  const detected = detectMimeType(bytes);
  return {
    bytes,
    mimeType: declaredMimeType ?? detected.mimeType,
    extension: detected.extension,
    confidence: dataUri || detected.mimeType ? 'high' : 'medium',
  };
}

function createArtifact(
  capture: StreamCapture,
  kind: StreamArtifactFile['kind'],
  relativePath: string,
  suffix: string,
): StreamArtifactFile {
  return {
    artifactId: `stream-${capture.id}-${suffix}`,
    kind,
    rootIndex: capture.artifactRootIndex,
    relativePath: toPortablePath(relativePath),
    bytes: 0,
    writeStatus: 'pending',
  };
}

function atomicWriteFile(filename: string, data: Buffer): Promise<void> {
  return (async () => {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, data, {flag: 'wx', mode: 0o600});
    try {
      await fs.rename(temporary, filename);
    } catch (error) {
      await fs.rm(temporary, {force: true}).catch(() => undefined);
      throw error;
    }
  })();
}

function materializeJsonValue(
  value: unknown,
  keyPath: string[],
  event: SseEvent,
  request: StreamRequest,
  runtime: RequestRuntime,
  payloads: MaterializedPayload[],
): unknown {
  if (typeof value === 'string') {
    const candidate = parseBase64Candidate(value);
    if (!candidate) {
      if (value.length <= MAX_INLINE_EVENT_DATA_CHARS) {
        return value;
      }
      return {
        $largeText: true,
        chars: value.length,
        sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
        sourceArtifactId: request.artifacts.find(
          file => file.kind === 'raw_text',
        )?.artifactId,
      };
    }

    const payloadIndex = runtime.payloadIndex++;
    const pointer = `/${keyPath.map(item => item.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
    const pointerHash = createHash('sha256')
      .update(pointer, 'utf8')
      .digest('hex')
      .slice(0, 12);
    const relativePath = path.join(
      request.relativeDir,
      'payloads',
      `payload-${String(payloadIndex).padStart(6, '0')}-${pointerHash}.${candidate.extension}`,
    );
    const capture = runtime.capture;
    const artifact = createArtifact(
      capture,
      'payload',
      relativePath,
      `request-${request.requestIndex + 1}-payload-${payloadIndex}`,
    );
    artifact.mimeType = candidate.mimeType;
    artifact.bytes = candidate.bytes.length;
    artifact.sha256 = createHash('sha256')
      .update(candidate.bytes)
      .digest('hex');
    const absolutePath = path.join(
      runtime.absoluteDir,
      'payloads',
      path.basename(relativePath),
    );
    const descriptor: Record<string, unknown> = {
      $artifact: artifact,
      encoding: 'base64',
      encodedChars: value.length,
      decodedBytes: candidate.bytes.length,
      detectionConfidence: candidate.confidence,
      jsonPointerSha256: pointerHash,
    };
    payloads.push({descriptor, artifact, absolutePath, bytes: candidate.bytes});
    return descriptor;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      materializeJsonValue(
        item,
        [...keyPath, String(index)],
        event,
        request,
        runtime,
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
          event,
          request,
          runtime,
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
  runtime: RequestRuntime,
): MaterializedEvent {
  const payloads: MaterializedPayload[] = [];
  const record: Record<string, unknown> = {
    index: event.index,
    recordType: event.recordType,
    eventName: event.eventName,
    eventId: event.eventId,
    retry: event.retry,
    comments: event.comments,
    done: event.done,
    source: event.source,
    timestamp: event.timestamp,
    dataLength: event.data.length,
  };
  if (event.recordType === 'event') {
    try {
      const parsed = JSON.parse(event.data) as unknown;
      record.dataType = 'json';
      record.dataJson = materializeJsonValue(
        parsed,
        ['data'],
        event,
        request,
        runtime,
        payloads,
      );
    } catch {
      const materialized = materializeJsonValue(
        event.data,
        ['data'],
        event,
        request,
        runtime,
        payloads,
      );
      record.dataType = 'text';
      if (typeof materialized === 'string') {
        record.data = materialized;
      } else {
        record.dataArtifact = materialized;
      }
    }
  }
  return {
    record,
    payloads,
    summary: {
      index: event.index,
      recordType: event.recordType,
      eventName: event.eventName,
      done: event.done,
      timestamp: event.timestamp,
      source: event.source,
      dataLength: event.data.length,
      payloadCount: payloads.length,
    },
  };
}

export class StreamCollector {
  #context: BrowserContext;
  #sessionProvider: CdpSessionProvider;
  #limits: StreamCollectorLimits;
  #captures = new Map<number, StreamCapture>();
  #captureRuntime = new WeakMap<StreamCapture, CaptureRuntime>();
  #activeCaptureByPage = new WeakMap<Page, StreamCapture>();
  #requestRuntime = new WeakMap<StreamRequest, RequestRuntime>();
  #requestOwners = new WeakMap<Page, Map<string, StreamRequest>>();
  #requestMetadata = new WeakMap<Page, Map<string, RequestMetadata>>();
  #cdpCleanup = new WeakMap<Page, () => void>();
  #pageCloseListeners = new WeakMap<Page, () => void>();
  #pageInitializations = new WeakMap<Page, Promise<void>>();
  #pendingInitializations = new Set<Promise<void>>();
  #pageClosePromises = new WeakMap<Page, Promise<void>>();
  #initialization?: Promise<void>;
  #nextCaptureId = 1;
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
      maxDiskBytesPerCapture:
        limits.maxDiskBytesPerCapture ?? DEFAULT_STREAM_DISK_QUOTA_BYTES,
      maxRecentChunksPerRequest:
        limits.maxRecentChunksPerRequest ?? MAX_RECENT_STREAM_CHUNKS,
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
    while (this.#pendingInitializations.size > 0) {
      const results = await Promise.allSettled([
        ...this.#pendingInitializations,
      ]);
      const rejection = results.find(result => result.status === 'rejected');
      if (rejection?.status === 'rejected') {
        throw rejection.reason;
      }
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
    this.#requestMetadata.set(page, new Map());
    this.#requestOwners.set(page, new Map());
    const onClose = () => {
      const closePromise = this.#handlePageClosed(page);
      this.#pageClosePromises.set(page, closePromise);
      void closePromise.catch(error => {
        logger('Failed to finalize stream captures after page close', error);
      });
    };
    this.#pageCloseListeners.set(page, onClose);
    page.on('close', onClose);
    try {
      await this.#setupCdpListeners(page);
    } catch (error) {
      this.#removePageListeners(page);
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
      const capture = this.#activeCaptureByPage.get(page);
      if (!capture || !['armed', 'capturing'].includes(capture.status)) {
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
      const request = this.#createRequest(
        capture,
        metadata,
        event.requestId,
        event.response.mimeType,
        event.timestamp * 1000,
      );
      ownerMap.set(event.requestId, request);
      capture.requests.push(request);
      capture.status = 'capturing';
      capture.version++;
      const runtime = this.#requestRuntime.get(request)!;
      runtime.activationPromise = this.#activateRequest(
        client,
        request,
        runtime,
        event.timestamp * 1000,
      );
    };

    const onDataReceived = (
      event: Protocol.Network.DataReceivedEvent,
    ): void => {
      const request = ownerMap.get(event.requestId);
      if (!request) {
        return;
      }
      const runtime = this.#requestRuntime.get(request);
      if (!runtime) {
        return;
      }
      const chunk: PendingChunk = {
        timestamp: event.timestamp * 1000,
        dataLength: event.dataLength,
        encodedDataLength: event.encodedDataLength,
        payload: event.data
          ? Buffer.from(event.data, 'base64')
          : Buffer.alloc(0),
        source: 'network',
      };
      if (!runtime.activationResolved) {
        runtime.pendingChunks.push(chunk);
        return;
      }
      this.#processChunk(request, runtime, chunk);
    };

    const onEventSourceMessage = (
      event: Protocol.Network.EventSourceMessageReceivedEvent,
    ): void => {
      const request = ownerMap.get(event.requestId);
      const runtime = request ? this.#requestRuntime.get(request) : undefined;
      if (!request || !runtime) {
        return;
      }
      const semanticEvent: SseEvent = {
        index: runtime.nextSemanticEventIndex++,
        recordType: 'event',
        eventName: event.eventName || 'message',
        eventId: event.eventId || undefined,
        data: event.data,
        comments: [],
        done: event.data.trim() === '[DONE]',
        source: 'eventsource',
        timestamp: event.timestamp * 1000,
      };
      this.#enqueueEventWrite(request, runtime, semanticEvent, 'semantic');
    };

    const onLoadingFinished = (
      event: Protocol.Network.LoadingFinishedEvent,
    ): void => {
      metadataMap.delete(event.requestId);
      const request = ownerMap.get(event.requestId);
      if (!request) {
        return;
      }
      this.#setTerminal(request, {
        status: 'finished',
        endedAt: event.timestamp * 1000,
      });
    };

    const onLoadingFailed = (
      event: Protocol.Network.LoadingFailedEvent,
    ): void => {
      metadataMap.delete(event.requestId);
      const request = ownerMap.get(event.requestId);
      if (!request) {
        return;
      }
      this.#setTerminal(request, {
        status: 'failed',
        endedAt: event.timestamp * 1000,
        failure: {
          errorText: event.errorText,
          canceled: Boolean(event.canceled),
          blockedReason: event.blockedReason,
          code: 'STREAM_ERROR',
        },
      });
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
      this.#cdpCleanup.set(page, cleanup);
    } catch (error) {
      if (attached) {
        cleanup();
      }
      throw error;
    }
  }

  #createRequest(
    capture: StreamCapture,
    metadata: RequestMetadata,
    requestId: string,
    mimeType: string,
    startedAt: number,
  ): StreamRequest {
    const captureRuntime = this.#captureRuntime.get(capture)!;
    const requestIndex = capture.requests.length;
    const requestDirName = `request-${String(requestIndex + 1).padStart(4, '0')}`;
    const relativeDir = toPortablePath(
      path.join(capture.relativeDir, requestDirName),
    );
    const absoluteDir = path.join(captureRuntime.absoluteDir, requestDirName);
    const request: StreamRequest = {
      requestId,
      requestIndex,
      url: metadata.url,
      method: metadata.method,
      resourceType: metadata.resourceType,
      mimeType,
      status: 'activating',
      startedAt,
      streamResourceContentEnabled: false,
      relativeDir,
      chunkCount: 0,
      recentChunks: [],
      rawEventCount: 0,
      semanticEventCount: 0,
      primaryEventSource: 'none',
      doneMarkerObserved: false,
      parseErrors: 0,
      incompleteTailChars: 0,
      rawBytes: 0,
      diskBytesReserved: 0,
      writeErrors: [],
      artifacts: [],
      recentRawEvents: [],
      recentSemanticEvents: [],
    };
    const artifacts = this.#createRequestArtifacts(
      capture,
      request,
      absoluteDir,
    );
    request.artifacts.push(
      ...[...artifacts.values()].map(item => item.descriptor),
    );
    const runtime: RequestRuntime = {
      capture,
      absoluteDir,
      decoder: new TextDecoder('utf-8'),
      parser: new IncrementalSseParser(),
      rawOffset: 0,
      payloadIndex: 1,
      nextSemanticEventIndex: 0,
      writeChain: this.#initializeRequestFiles(absoluteDir, artifacts, request),
      activationPromise: Promise.resolve(),
      activationResolved: false,
      pendingChunks: [],
      finalized: false,
      artifacts,
    };
    this.#requestRuntime.set(request, runtime);
    return request;
  }

  #createRequestArtifacts(
    capture: StreamCapture,
    request: StreamRequest,
    absoluteDir: string,
  ): Map<StreamArtifactFile['kind'], ArtifactRuntime> {
    const result = new Map<StreamArtifactFile['kind'], ArtifactRuntime>();
    const definitions: Array<[StreamArtifactFile['kind'], string, string]> = [
      ['request_metadata', 'metadata.json', 'metadata'],
      ['raw_bytes', 'raw.bin', 'raw'],
      ['raw_text', 'raw.sse', 'text'],
      ['chunks', 'chunks.jsonl', 'chunks'],
      ['events', 'events.jsonl', 'events'],
      ['eventsource_events', 'eventsource.jsonl', 'eventsource'],
    ];
    for (const [kind, filename, suffix] of definitions) {
      const descriptor = createArtifact(
        capture,
        kind,
        path.join(request.relativeDir, filename),
        `request-${request.requestIndex + 1}-${suffix}`,
      );
      result.set(kind, {
        descriptor,
        absolutePath: path.join(absoluteDir, filename),
        hash: createHash('sha256'),
      });
    }
    return result;
  }

  async #initializeRequestFiles(
    absoluteDir: string,
    artifacts: Map<StreamArtifactFile['kind'], ArtifactRuntime>,
    request: StreamRequest,
  ): Promise<void> {
    try {
      await fs.mkdir(absoluteDir, {mode: 0o700});
      await fs.mkdir(path.join(absoluteDir, 'payloads'), {mode: 0o700});
      for (const artifact of artifacts.values()) {
        if (artifact.descriptor.kind === 'request_metadata') {
          continue;
        }
        await fs.writeFile(artifact.absolutePath, Buffer.alloc(0), {
          flag: 'wx',
          mode: 0o600,
        });
        artifact.descriptor.writeStatus = 'written';
        artifact.descriptor.sha256 = artifact.hash.copy().digest('hex');
      }
    } catch (error) {
      request.writeErrors.push(getErrorText(error));
      for (const artifact of artifacts.values()) {
        if (artifact.descriptor.writeStatus === 'pending') {
          artifact.descriptor.writeStatus = 'failed';
          artifact.descriptor.error = getErrorText(error);
        }
      }
    }
  }

  async #activateRequest(
    client: Awaited<ReturnType<CdpSessionProvider['getSession']>>,
    request: StreamRequest,
    runtime: RequestRuntime,
    timestamp: number,
  ): Promise<void> {
    try {
      const result = await client.send('Network.streamResourceContent', {
        requestId: request.requestId,
      });
      request.streamResourceContentEnabled = true;
      if (result.bufferedData) {
        const payload = Buffer.from(result.bufferedData, 'base64');
        this.#processChunk(request, runtime, {
          timestamp,
          dataLength: payload.length,
          encodedDataLength: 0,
          payload,
          source: 'buffered',
        });
      }
    } catch (error) {
      request.streamResourceContentError = getErrorText(error);
    } finally {
      runtime.activationResolved = true;
      request.status =
        request.status === 'activating' ? 'streaming' : request.status;
      for (const pending of runtime.pendingChunks) {
        this.#processChunk(request, runtime, pending);
      }
      runtime.pendingChunks.length = 0;
    }
  }

  #reserveDisk(
    request: StreamRequest,
    runtime: RequestRuntime,
    bytes: number,
    reason: string,
    options: {droppedChunk?: boolean; droppedBytes?: number} = {},
  ): boolean {
    const capture = runtime.capture;
    if (capture.diskBytesReserved + bytes <= capture.quotaBytes) {
      capture.diskBytesReserved += bytes;
      request.diskBytesReserved += bytes;
      return true;
    }
    const now = Date.now();
    const truncation = capture.truncation ?? {
      truncatedAt: now,
      reason: 'disk_quota_exceeded' as const,
      quotaBytes: capture.quotaBytes,
      droppedChunkCount: 0,
      droppedBytes: 0,
    };
    capture.truncation = truncation;
    request.truncation ??= {
      ...truncation,
      droppedChunkCount: 0,
      droppedBytes: 0,
    };
    const droppedBytes = options.droppedBytes ?? bytes;
    capture.truncation.droppedBytes += droppedBytes;
    request.truncation.droppedBytes += droppedBytes;
    if (options.droppedChunk) {
      capture.truncation.droppedChunkCount++;
      request.truncation.droppedChunkCount++;
    }
    capture.status = 'failed';
    request.status = 'failed';
    request.failure = {
      errorText: `Stream capture disk quota exceeded while writing ${reason}`,
      canceled: false,
      code: 'DISK_QUOTA_EXCEEDED',
    };
    const page = this.#captureRuntime.get(capture)?.page;
    if (page && this.#activeCaptureByPage.get(page) === capture) {
      this.#activeCaptureByPage.delete(page);
    }
    return false;
  }

  #recordDroppedChunk(
    request: StreamRequest,
    runtime: RequestRuntime,
    payloadBytes: number,
  ): void {
    const capture = runtime.capture;
    const now = Date.now();
    capture.truncation ??= {
      truncatedAt: now,
      reason: 'disk_quota_exceeded',
      quotaBytes: capture.quotaBytes,
      droppedChunkCount: 0,
      droppedBytes: 0,
    };
    request.truncation ??= {
      truncatedAt: now,
      reason: 'disk_quota_exceeded',
      quotaBytes: capture.quotaBytes,
      droppedChunkCount: 0,
      droppedBytes: 0,
    };
    capture.truncation.droppedChunkCount++;
    capture.truncation.droppedBytes += payloadBytes;
    request.truncation.droppedChunkCount++;
    request.truncation.droppedBytes += payloadBytes;
  }

  #processChunk(
    request: StreamRequest,
    runtime: RequestRuntime,
    pending: PendingChunk,
  ): void {
    if (runtime.finalized) {
      return;
    }
    if (runtime.capture.status === 'failed' && runtime.capture.truncation) {
      this.#recordDroppedChunk(request, runtime, pending.payload.length);
      return;
    }

    const decodedText = runtime.decoder.decode(pending.payload, {stream: true});
    const parsedEvents = runtime.parser.push(decodedText, pending.timestamp);
    const chunk: StreamChunkOffset = {
      index: request.chunkCount,
      timestamp: pending.timestamp,
      dataLength: pending.dataLength,
      encodedDataLength: pending.encodedDataLength,
      payloadBytes: pending.payload.length,
      source: pending.source,
      fileOffsetStart: runtime.rawOffset,
      fileOffsetEnd: runtime.rawOffset + pending.payload.length,
      eventIndexes: parsedEvents.map(event => event.index),
    };
    const chunkLine = toJsonLine(chunk);
    const textBytes = Buffer.byteLength(decodedText, 'utf8');
    const requiredBytes = pending.payload.length + textBytes + chunkLine.length;
    if (
      !this.#reserveDisk(request, runtime, requiredBytes, 'stream chunk', {
        droppedChunk: true,
        droppedBytes: pending.payload.length,
      })
    ) {
      return;
    }

    runtime.rawOffset += pending.payload.length;
    request.rawBytes += pending.payload.length;
    request.chunkCount++;
    request.recentChunks.push(chunk);
    if (request.recentChunks.length > this.#limits.maxRecentChunksPerRequest) {
      request.recentChunks.splice(
        0,
        request.recentChunks.length - this.#limits.maxRecentChunksPerRequest,
      );
    }
    runtime.capture.totalRawBytes += pending.payload.length;
    runtime.capture.chunkCount++;
    runtime.capture.version++;

    this.#queueArtifactAppend(request, runtime, 'raw_bytes', pending.payload);
    this.#queueArtifactAppend(
      request,
      runtime,
      'raw_text',
      Buffer.from(decodedText, 'utf8'),
    );
    this.#queueArtifactAppend(request, runtime, 'chunks', chunkLine);
    for (const event of parsedEvents) {
      this.#enqueueEventWrite(request, runtime, event, 'raw');
    }
  }

  #queueArtifactAppend(
    request: StreamRequest,
    runtime: RequestRuntime,
    kind: StreamArtifactFile['kind'],
    data: Buffer,
  ): void {
    if (data.length === 0) {
      return;
    }
    const artifact = runtime.artifacts.get(kind);
    if (!artifact) {
      request.writeErrors.push(`Missing ${kind} artifact`);
      return;
    }
    runtime.writeChain = runtime.writeChain.then(async () => {
      try {
        await fs.appendFile(artifact.absolutePath, data);
        artifact.hash.update(data);
        artifact.descriptor.bytes += data.length;
        artifact.descriptor.sha256 = artifact.hash.copy().digest('hex');
        artifact.descriptor.writeStatus = 'written';
      } catch (error) {
        artifact.descriptor.writeStatus = 'failed';
        artifact.descriptor.error = getErrorText(error);
        request.writeErrors.push(
          `Could not append ${kind}: ${getErrorText(error)}`,
        );
      }
    });
  }

  #enqueueEventWrite(
    request: StreamRequest,
    runtime: RequestRuntime,
    event: SseEvent,
    destination: 'raw' | 'semantic',
  ): void {
    const materialized = materializeEvent(event, request, runtime);
    const targetKind: StreamArtifactFile['kind'] =
      destination === 'raw' ? 'events' : 'eventsource_events';
    const targetArtifact = runtime.artifacts.get(targetKind);
    if (!targetArtifact) {
      request.writeErrors.push(`Missing ${targetKind} artifact`);
      return;
    }
    const estimatedRecordBytes =
      Buffer.byteLength(JSON.stringify(materialized.record), 'utf8') + 1;
    const payloadBytes = materialized.payloads.reduce(
      (sum, payload) => sum + payload.bytes.length,
      0,
    );
    if (
      !this.#reserveDisk(
        request,
        runtime,
        estimatedRecordBytes + payloadBytes,
        'SSE event',
      )
    ) {
      return;
    }

    runtime.writeChain = runtime.writeChain.then(async () => {
      for (const payload of materialized.payloads) {
        request.artifacts.push(payload.artifact);
        try {
          await fs.writeFile(payload.absolutePath, payload.bytes, {
            flag: 'wx',
            mode: 0o600,
          });
          payload.artifact.bytes = payload.bytes.length;
          payload.artifact.sha256 = createHash('sha256')
            .update(payload.bytes)
            .digest('hex');
          payload.artifact.writeStatus = 'written';
          const descriptor = materialized.record;
          void descriptor;
        } catch (error) {
          payload.artifact.writeStatus = 'failed';
          payload.artifact.error = getErrorText(error);
          request.writeErrors.push(
            `Could not write payload ${payload.artifact.relativePath}: ${getErrorText(error)}`,
          );
        }
      }

      try {
        const line = toJsonLine(materialized.record);
        await fs.appendFile(targetArtifact.absolutePath, line);
        targetArtifact.hash.update(line);
        targetArtifact.descriptor.bytes += line.length;
        targetArtifact.descriptor.sha256 = targetArtifact.hash
          .copy()
          .digest('hex');
        targetArtifact.descriptor.writeStatus = 'written';
        if (destination === 'raw') {
          request.rawEventCount++;
          request.primaryEventSource = 'raw-stream';
          runtime.capture.rawEventCount++;
          request.recentRawEvents.push(materialized.summary);
          this.#trimRecent(request.recentRawEvents);
        } else {
          request.semanticEventCount++;
          runtime.capture.semanticEventCount++;
          if (request.primaryEventSource === 'none') {
            request.primaryEventSource = 'eventsource';
          }
          request.recentSemanticEvents.push(materialized.summary);
          this.#trimRecent(request.recentSemanticEvents);
        }
        request.doneMarkerObserved ||= event.done;
      } catch (error) {
        targetArtifact.descriptor.writeStatus = 'failed';
        targetArtifact.descriptor.error = getErrorText(error);
        request.writeErrors.push(
          `Could not write ${targetKind}: ${getErrorText(error)}`,
        );
      }
    });
  }

  #trimRecent(events: StreamEventSummary[]): void {
    if (events.length > this.#limits.maxRecentEventsPerRequest) {
      events.splice(0, events.length - this.#limits.maxRecentEventsPerRequest);
    }
  }

  #setTerminal(request: StreamRequest, terminal: RequestTerminal): void {
    const runtime = this.#requestRuntime.get(request);
    if (!runtime || runtime.finalized) {
      return;
    }
    runtime.terminal ??= terminal;
    void this.#finalizeRequest(request);
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
      try {
        await runtime.activationPromise;
        if (!runtime.finalized) {
          const finalText = runtime.decoder.decode();
          const finalEvents = runtime.parser.push(
            finalText,
            runtime.terminal?.endedAt,
          );
          request.incompleteTailChars = runtime.parser.incompleteTail.length;
          if (finalText.length > 0) {
            const bytes = Buffer.from(finalText, 'utf8');
            if (
              this.#reserveDisk(
                request,
                runtime,
                bytes.length,
                'final UTF-8 decoder output',
              )
            ) {
              this.#queueArtifactAppend(request, runtime, 'raw_text', bytes);
            }
          }
          for (const event of finalEvents) {
            this.#enqueueEventWrite(request, runtime, event, 'raw');
          }
          runtime.finalized = true;
        }
        await runtime.writeChain;
      } catch (error) {
        request.writeErrors.push(`Finalize error: ${getErrorText(error)}`);
      }

      const terminal = runtime.terminal;
      if (request.failure?.code !== 'DISK_QUOTA_EXCEEDED' && terminal) {
        request.status = terminal.status;
        request.endedAt = terminal.endedAt;
        request.failure = terminal.failure;
      } else if (!request.endedAt) {
        request.endedAt = terminal?.endedAt ?? Date.now();
      }

      try {
        await this.#writeRequestMetadata(request, runtime);
      } catch (error) {
        request.writeErrors.push(
          `Could not write final request metadata: ${getErrorText(error)}`,
        );
        await this.#writeRequestMetadata(request, runtime).catch(
          () => undefined,
        );
      }
      await this.#queueCaptureMetadata(runtime.capture);
    })();
    await runtime.finalizePromise;
  }

  async #writeRequestMetadata(
    request: StreamRequest,
    runtime: RequestRuntime,
  ): Promise<void> {
    const artifact = runtime.artifacts.get('request_metadata');
    if (!artifact) {
      return;
    }
    const content = Buffer.from(
      `${JSON.stringify(this.#requestManifest(request), null, 2)}\n`,
      'utf8',
    );
    try {
      await atomicWriteFile(artifact.absolutePath, content);
      artifact.descriptor.bytes = content.length;
      artifact.descriptor.sha256 = createHash('sha256')
        .update(content)
        .digest('hex');
      artifact.descriptor.writeStatus = 'written';
    } catch (error) {
      artifact.descriptor.writeStatus = 'failed';
      artifact.descriptor.error = getErrorText(error);
      throw error;
    }
  }

  #requestManifest(request: StreamRequest): Record<string, unknown> {
    return {
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
      relativeDir: request.relativeDir,
      chunkCount: request.chunkCount,
      rawEventCount: request.rawEventCount,
      semanticEventCount: request.semanticEventCount,
      primaryEventSource: request.primaryEventSource,
      doneMarkerObserved: request.doneMarkerObserved,
      parseErrors: request.parseErrors,
      incompleteTailChars: request.incompleteTailChars,
      rawBytes: request.rawBytes,
      diskBytesReserved: request.diskBytesReserved,
      truncation: request.truncation,
      artifacts: request.artifacts,
      writeErrors: request.writeErrors,
    };
  }

  #captureManifest(capture: StreamCapture): Record<string, unknown> {
    return {
      captureId: capture.id,
      status: capture.status,
      filter: capture.filter,
      artifactRootIndex: capture.artifactRootIndex,
      relativeDir: capture.relativeDir,
      pageUrl: capture.pageUrl,
      pageTitle: capture.pageTitle,
      createdAt: capture.createdAt,
      stoppedAt: capture.stoppedAt,
      requestCount: capture.requests.length,
      totalRawBytes: capture.totalRawBytes,
      diskBytesReserved: capture.diskBytesReserved,
      metadataArtifact: capture.metadataArtifact,
      chunkCount: capture.chunkCount,
      rawEventCount: capture.rawEventCount,
      semanticEventCount: capture.semanticEventCount,
      quotaBytes: capture.quotaBytes,
      truncation: capture.truncation,
      errors: capture.errors,
      requests: capture.requests.map(request => ({
        requestId: request.requestId,
        requestIndex: request.requestIndex,
        url: request.url,
        method: request.method,
        resourceType: request.resourceType,
        mimeType: request.mimeType,
        status: request.status,
        relativeDir: request.relativeDir,
        chunkCount: request.chunkCount,
        rawEventCount: request.rawEventCount,
        semanticEventCount: request.semanticEventCount,
        primaryEventSource: request.primaryEventSource,
        doneMarkerObserved: request.doneMarkerObserved,
        rawBytes: request.rawBytes,
        truncation: request.truncation,
        metadataArtifactId: request.artifacts.find(
          artifact => artifact.kind === 'request_metadata',
        )?.artifactId,
        artifacts: request.artifacts,
      })),
    };
  }

  #queueCaptureMetadata(capture: StreamCapture): Promise<void> {
    const runtime = this.#captureRuntime.get(capture);
    if (!runtime) {
      return Promise.resolve();
    }
    runtime.metadataChain = runtime.metadataChain.then(async () => {
      const content = Buffer.from(
        `${JSON.stringify(this.#captureManifest(capture), null, 2)}\n`,
        'utf8',
      );
      try {
        await atomicWriteFile(runtime.metadataAbsolutePath, content);
        capture.metadataArtifact.bytes = content.length;
        capture.metadataArtifact.sha256 = createHash('sha256')
          .update(content)
          .digest('hex');
        capture.metadataArtifact.writeStatus = 'written';
      } catch (error) {
        capture.metadataArtifact.writeStatus = 'failed';
        capture.metadataArtifact.error = getErrorText(error);
        capture.errors.push(
          `Could not update capture metadata: ${getErrorText(error)}`,
        );
      }
    });
    return runtime.metadataChain;
  }

  async startCapture(
    page: Page,
    filter: StreamCaptureFilter,
    location: StreamCaptureLocation,
  ): Promise<StreamCapture> {
    const active = this.#activeCaptureByPage.get(page);
    if (active && ['armed', 'capturing'].includes(active.status)) {
      throw new Error(
        `Stream capture ${active.id} is already active for the selected page`,
      );
    }
    const id = this.#nextCaptureId++;
    const metadataArtifact: StreamArtifactFile = {
      artifactId: `stream-${id}-capture-metadata`,
      kind: 'capture_metadata',
      rootIndex: location.rootIndex,
      relativePath: toPortablePath(
        path.join(location.relativeDir, 'capture.json'),
      ),
      bytes: 0,
      writeStatus: 'pending',
    };
    const capture: StreamCapture = {
      id,
      status: 'armed',
      filter: {
        ...filter,
        mimeTypes:
          filter.mimeTypes?.length === 0
            ? undefined
            : (filter.mimeTypes ?? ['text/event-stream']),
      },
      artifactRootIndex: location.rootIndex,
      relativeDir: toPortablePath(location.relativeDir),
      metadataArtifact,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => undefined),
      createdAt: Date.now(),
      requests: [],
      totalRawBytes: 0,
      diskBytesReserved: 0,
      chunkCount: 0,
      rawEventCount: 0,
      semanticEventCount: 0,
      quotaBytes: this.#limits.maxDiskBytesPerCapture,
      errors: [],
      version: 0,
    };
    this.#captures.set(id, capture);
    this.#captureRuntime.set(capture, {
      page,
      absoluteDir: location.absoluteDir,
      metadataAbsolutePath: path.join(location.absoluteDir, 'capture.json'),
      metadataChain: Promise.resolve(),
    });
    this.#activeCaptureByPage.set(page, capture);
    this.#requestOwners.get(page)?.clear();
    await this.#queueCaptureMetadata(capture);
    this.#evictOldCaptures();
    return capture;
  }

  #evictOldCaptures(): void {
    if (this.#captures.size <= this.#limits.maxCaptures) {
      return;
    }
    for (const [id, capture] of this.#captures) {
      const runtime = this.#captureRuntime.get(capture);
      const active = runtime
        ? this.#activeCaptureByPage.get(runtime.page) === capture
        : false;
      const settled = capture.requests.every(request => {
        const requestRuntime = this.#requestRuntime.get(request);
        return (
          ['finished', 'stopped', 'failed'].includes(request.status) &&
          requestRuntime?.finalized === true
        );
      });
      if (
        ['stopped', 'failed'].includes(capture.status) &&
        settled &&
        !active
      ) {
        this.#captures.delete(id);
        if (this.#captures.size <= this.#limits.maxCaptures) {
          break;
        }
      }
    }
  }

  getById(captureId: number): StreamCapture {
    const capture = this.#captures.get(captureId);
    if (!capture) {
      throw new Error(`Stream capture ${captureId} was not found`);
    }
    return capture;
  }

  async stopCapture(captureId: number): Promise<StreamCapture> {
    const capture = this.getById(captureId);
    const runtime = this.#captureRuntime.get(capture);
    if (!runtime) {
      return capture;
    }
    if (!['stopped', 'failed'].includes(capture.status)) {
      capture.status = 'stopped';
      capture.stoppedAt = Date.now();
    } else {
      capture.stoppedAt ??= Date.now();
    }
    if (this.#activeCaptureByPage.get(runtime.page) === capture) {
      this.#activeCaptureByPage.delete(runtime.page);
    }
    for (const request of capture.requests) {
      const requestRuntime = this.#requestRuntime.get(request);
      if (requestRuntime && !requestRuntime.terminal) {
        requestRuntime.terminal = {
          status: 'stopped',
          endedAt: capture.stoppedAt,
        };
      }
    }
    await Promise.all(
      capture.requests.map(request => this.#finalizeRequest(request)),
    );
    await this.#queueCaptureMetadata(capture);
    return capture;
  }

  async #handlePageClosed(page: Page): Promise<void> {
    const captures = [...this.#captures.values()].filter(
      capture => this.#captureRuntime.get(capture)?.page === page,
    );
    for (const capture of captures) {
      if (!['stopped', 'failed'].includes(capture.status)) {
        capture.status = 'failed';
        capture.stoppedAt = Date.now();
        capture.errors.push('Owning page closed before capture was stopped.');
      }
      for (const request of capture.requests) {
        const runtime = this.#requestRuntime.get(request);
        if (runtime && !runtime.terminal) {
          runtime.terminal = {
            status: 'failed',
            endedAt: capture.stoppedAt ?? Date.now(),
            failure: {
              errorText: 'Owning page closed during stream capture.',
              canceled: false,
              code: 'PAGE_CLOSED',
            },
          };
        }
      }
      await Promise.all(
        capture.requests.map(request => this.#finalizeRequest(request)),
      );
      await this.#queueCaptureMetadata(capture);
    }
    this.#removePageListeners(page);
  }

  async waitForPageCloseFinalization(page: Page): Promise<void> {
    await this.#pageClosePromises.get(page);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#listeningForPages) {
      this.#context.off('page', this.#onPageCreated);
      this.#listeningForPages = false;
    }
    for (const capture of this.#captures.values()) {
      if (!['stopped', 'failed'].includes(capture.status)) {
        void this.stopCapture(capture.id).catch(() => undefined);
      }
    }
    for (const page of this.#context.pages()) {
      this.#removePageListeners(page);
    }
  }

  #removePageListeners(page: Page): void {
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
      this.#cdpCleanup.delete(page);
    }
    this.#requestMetadata.delete(page);
    this.#requestOwners.delete(page);
    this.#activeCaptureByPage.delete(page);
  }
}
