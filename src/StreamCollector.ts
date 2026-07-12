/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';
import {createHash, randomUUID, type Hash} from 'node:crypto';
import {constants as fsConstants, createReadStream} from 'node:fs';
import type * as fs from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';

import type {Protocol} from 'devtools-protocol';

import {addCdpEventListener, removeCdpEventListener} from './CdpEvents.js';
import type {CdpSessionProvider} from './CdpSessionProvider.js';
import {
  createSecureSubdirectory,
  openSecureArtifactFile,
  writeSecureAtomicArtifactFile,
} from './LocalFileAccess.js';
import {logger, redactLogValue} from './logger.js';
import type {BrowserContext, Page} from './third_party/index.js';

export type StreamCaptureStatus = 'armed' | 'capturing' | 'stopped' | 'failed';
export type StreamRequestStatus =
  | 'activating'
  | 'streaming'
  | 'finished'
  | 'canceled'
  | 'stopped'
  | 'failed';
export type StreamIntegrityStatus =
  | 'complete'
  | 'semantic-only'
  | 'partial'
  | 'failed';
export type StreamParseStatus = 'complete' | 'degraded' | 'raw-only';
export type StreamEvidenceIntegrity =
  | 'complete'
  | 'partial'
  | 'failed'
  | 'not-attempted';
export type StreamSnapshotCompleteness =
  | 'complete'
  | 'partial'
  | 'none'
  | 'unknown';
export type StreamTerminalReason =
  | 'completed'
  | 'network_canceled'
  | 'page_close'
  | 'network_error'
  | 'quota'
  | 'collector_stop'
  | 'activation_timeout'
  | 'pending_limit'
  | 'activation_error'
  | 'artifact_error'
  | 'finalize_timeout'
  | 'shutdown_timeout';
export type StreamEventSource = 'raw-stream' | 'eventsource';
export type StreamEventRecordType = 'event' | 'heartbeat';

export interface StreamCaptureFilter {
  urlFilter?: string;
  methods?: string[];
  resourceTypes?: string[];
  mimeTypes?: string[];
}

export interface StreamCaptureOptions {
  includeInFlight?: boolean;
}

export type StreamEventPredicate =
  | {type: 'exact_data'; value: string}
  | {type: 'event_name'; value: string}
  | {type: 'json_path_equals'; path: string; value: unknown};

export interface StreamEventMatch {
  matched: boolean;
  matchedEventIndex?: number;
  matchedRequestId?: string;
  matchedSource?: StreamEventSource;
}

export interface StreamEventMatchQuery {
  requestId?: string;
  afterEventIndex?: number;
  predicate: StreamEventPredicate;
}

export interface StreamCaptureLocation {
  rootIndex: number;
  rootPath: string;
  absoluteDir: string;
  relativeDir: string;
}

export interface StreamArtifactFile {
  artifactId: string;
  kind:
    | 'capture_metadata'
    | 'request_metadata'
    | 'raw_bytes'
    | 'decoded_text'
    | 'chunks'
    | 'events'
    | 'eventsource_events'
    | 'request_headers'
    | 'request_headers_extra'
    | 'request_headers_redacted'
    | 'request_body_text'
    | 'request_body_metadata'
    | 'response_headers'
    | 'response_headers_extra'
    | 'response_headers_redacted'
    | 'initiator'
    | 'redirects'
    | 'payload';
  rootIndex: number;
  relativePath: string;
  bytes: number;
  sha256?: string;
  mimeType?: string;
  sensitivity?: 'public' | 'private' | 'credential';
  containsCredentials?: boolean;
  encoding?: string;
  captureSource?: string;
  redactedArtifactId?: string;
  writeStatus: 'pending' | 'written' | 'failed';
  error?: string;
}

export interface StreamChunkOffset {
  index: number;
  monotonicTimeSeconds: number;
  wallTimeMs?: number;
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
  defaultDoneMarker: boolean;
  source: StreamEventSource;
  dataLength: number;
  payloadCount: number;
  rawByteStart?: number;
  rawByteEnd?: number;
  completedWallTimeMs?: number;
}

export interface StreamTruncation {
  truncatedWallTimeMs: number;
  reason:
    | 'disk_quota_exceeded'
    | 'pending_buffer_limit'
    | 'request_limit'
    | 'artifact_limit'
    | 'payload_limit'
    | 'event_limit'
    | 'metadata_limit'
    | 'activation_failure';
  limit: number;
  droppedChunkCount: number;
  droppedBytes: number;
}

export interface StreamFailure {
  errorText: string;
  canceled: boolean;
  blockedReason?: string;
  code:
    | 'DISK_QUOTA_EXCEEDED'
    | 'PAGE_CLOSED'
    | 'NETWORK_ERROR'
    | 'ACTIVATION_TIMEOUT'
    | 'PENDING_BUFFER_LIMIT'
    | 'ACTIVATION_ERROR'
    | 'ARTIFACT_ERROR'
    | 'FINALIZE_TIMEOUT'
    | 'SHUTDOWN_TIMEOUT';
}

export interface StreamRequest {
  cdpRequestId: string;
  persistentRequestId: string;
  networkRequestId?: number;
  networkRequestIdLifetime: 'page-collector-generation';
  collectorGeneration: number;
  requestStartedBeforeCapture: boolean;
  responseObserved: boolean;
  streamActivationAttempted: boolean;
  failurePhase?: 'before-response' | 'activation' | 'streaming' | 'finalize';
  captureScope: 'page-target-only';
  workerCoverage: false;
  targetType: 'page';
  frameId?: string;
  loaderId?: string;
  fromServiceWorker?: boolean;
  requestIndex: number;
  url: string;
  method: string;
  resourceType?: string;
  mimeType?: string;
  responseStatus?: number;
  responseStatusText?: string;
  status: StreamRequestStatus;
  terminalReason?: StreamTerminalReason;
  integrityStatus: StreamIntegrityStatus;
  rawCaptureIntegrity: StreamEvidenceIntegrity;
  semanticParseIntegrity: StreamEvidenceIntegrity;
  requestSnapshotIntegrity: StreamEvidenceIntegrity;
  artifactIntegrity: StreamEvidenceIntegrity;
  headersCompleteness: StreamSnapshotCompleteness;
  bodyCompleteness: StreamSnapshotCompleteness;
  bodyCaptureSource: 'cdp-postData-utf8' | 'none' | 'unavailable';
  replayReadiness: 'ready' | 'partial' | 'not-ready';
  parseStatus: StreamParseStatus;
  parseDegradedReason?: string;
  startedMonotonicTimeSeconds: number;
  startedWallTimeMs?: number;
  endedMonotonicTimeSeconds?: number;
  endedWallTimeMs?: number;
  failure?: StreamFailure;
  streamResourceContentEnabled: boolean;
  streamResourceContentError?: string;
  relativeDir: string;
  chunkCount: number;
  recentChunks: StreamChunkOffset[];
  rawEventCount: number;
  semanticEventCount: number;
  primaryEventSource: StreamEventSource | 'none';
  defaultDoneMarkerObserved: boolean;
  invalidUtf8Count: number;
  incompleteTailBytes: number;
  rawBytes: number;
  diskBytesReserved: number;
  pendingBytesPeak: number;
  truncation?: StreamTruncation;
  writeErrors: string[];
  artifacts: StreamArtifactFile[];
  recentRawEvents: StreamEventSummary[];
  recentSemanticEvents: StreamEventSummary[];
}

export interface StreamCapture {
  id: number;
  uuid: string;
  status: StreamCaptureStatus;
  integrityStatus: StreamIntegrityStatus;
  collectorIntegrity: StreamIntegrityStatus;
  collectorGeneration: number;
  captureArmedWallTimeMs: number;
  captureArmedMonotonicTimeSeconds?: number;
  includeInFlight: boolean;
  captureScope: 'page-target-only';
  workerCoverage: false;
  filter: StreamCaptureFilter;
  artifactRootIndex: number;
  relativeDir: string;
  metadataArtifact: StreamArtifactFile;
  pageUrl: string;
  pageTitle?: string;
  createdWallTimeMs: number;
  stoppedWallTimeMs?: number;
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
  defaultDoneMarker: boolean;
  source: StreamEventSource;
  invalidUtf8: boolean;
  rawByteStart?: number;
  rawByteEnd?: number;
  decodedCharStart?: number;
  decodedCharEnd?: number;
  firstChunkIndex?: number;
  lastChunkIndex?: number;
  firstByteMonotonicTimeSeconds?: number;
  firstByteWallTimeMs?: number;
  completedMonotonicTimeSeconds?: number;
  completedWallTimeMs?: number;
}

export interface StreamCollectorLimits {
  maxCaptures: number;
  maxDiskBytesPerCapture: number;
  activationTimeoutMs: number;
  maxPendingBytesPerRequest: number;
  maxSseEventBytes: number;
  maxIncompleteTailBytes: number;
  maxRecentChunksPerRequest: number;
  maxRecentEventsPerRequest: number;
  maxRequestsPerCapture: number;
  maxArtifactsPerCapture: number;
  maxPayloadsPerRequest: number;
  maxEventsPerRequest: number;
  maxMetadataBytes: number;
  extraInfoWaitMs: number;
  shutdownTimeoutMs: number;
}

interface RequestMetadata {
  cdpRequestId: string;
  url: string;
  method: string;
  resourceType?: string;
  collectorGeneration: number;
  frameId?: string;
  loaderId?: string;
  headers: Protocol.Network.Headers;
  postData?: string;
  hasPostData?: boolean;
  initiator?: Protocol.Network.Initiator;
  requestExtraInfo: Protocol.Network.RequestWillBeSentExtraInfoEvent[];
  responseExtraInfo: Protocol.Network.ResponseReceivedExtraInfoEvent[];
  expectedRequestExtraInfoCount: number;
  expectedResponseExtraInfoCount: number;
  redirects: Array<{
    url: string;
    status: number;
    statusText: string;
    headers: Protocol.Network.Headers;
  }>;
  startedMonotonicTimeSeconds: number;
  startedWallTimeMs?: number;
  monotonicToWallOffsetMs?: number;
}

interface PendingChunk {
  monotonicTimeSeconds: number;
  wallTimeMs?: number;
  dataLength: number;
  encodedDataLength: number;
  payload: Buffer;
  source: 'buffered' | 'network';
}

interface RequestTerminal {
  status: 'finished' | 'canceled' | 'stopped' | 'failed';
  reason: StreamTerminalReason;
  endedMonotonicTimeSeconds?: number;
  endedWallTimeMs: number;
  failure?: StreamFailure;
}

interface ArtifactRuntime {
  descriptor: StreamArtifactFile;
  relativeToRequestDir: string;
  handle?: Awaited<ReturnType<typeof fs.open>>;
  hash: Hash;
  criticality: 'critical' | 'supporting' | 'payload';
}

interface CaptureRuntime {
  page: Page;
  location: StreamCaptureLocation;
  metadataChain: Promise<void>;
}

interface RequestRuntime {
  capture: StreamCapture;
  page: Page;
  client: Awaited<ReturnType<CdpSessionProvider['getSession']>>;
  metadata: RequestMetadata;
  responseEvent?: Protocol.Network.ResponseReceivedEvent;
  absoluteDir: string;
  initializationPromise: Promise<void>;
  snapshotPromise: Promise<void>;
  snapshotStarted: boolean;
  parser: BoundedSseParser;
  textDecoder: TextDecoder;
  rawOffset: number;
  payloadIndex: number;
  payloadCount: number;
  nextSemanticEventIndex: number;
  scheduledRawEvents: number;
  scheduledSemanticEvents: number;
  writeChain: Promise<void>;
  activationPromise: Promise<void>;
  activationAbort: AbortController;
  activationSettled: boolean;
  activationSucceeded: boolean;
  activationFailureReason?: StreamTerminalReason;
  pendingChunks: PendingChunk[];
  pendingBytes: number;
  terminal?: RequestTerminal;
  finalized: boolean;
  forceTerminated: boolean;
  finalizePromise?: Promise<void>;
  extraInfoWaiters: Set<() => void>;
  artifacts: Map<StreamArtifactFile['kind'], ArtifactRuntime>;
}

interface MaterializedPayload {
  artifact: StreamArtifactFile;
  relativeToRequestDir: string;
  bytes: Buffer;
}

interface MaterializedEvent {
  record: Record<string, unknown>;
  payloads: MaterializedPayload[];
  summary: StreamEventSummary;
}

interface ParserFeedContext {
  chunkIndex: number;
  rawByteStart: number;
  monotonicTimeSeconds: number;
  wallTimeMs?: number;
}

interface EventState {
  rawByteStart: number;
  decodedCharStart: number;
  firstChunkIndex: number;
  lastChunkIndex: number;
  firstByteMonotonicTimeSeconds: number;
  firstByteWallTimeMs?: number;
  completedMonotonicTimeSeconds: number;
  completedWallTimeMs?: number;
  rawBytes: number;
  dataLines: string[];
  comments: string[];
  eventName?: string;
  eventId?: string;
  retry?: number;
  invalidUtf8: boolean;
}

export const DEFAULT_STREAM_DISK_QUOTA_BYTES = 512 * 1024 * 1024;
export const DEFAULT_STREAM_ACTIVATION_TIMEOUT_MS = 10_000;
export const DEFAULT_STREAM_PENDING_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_STREAM_MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_STREAM_MAX_METADATA_BYTES = 8 * 1024 * 1024;
export const MAX_RETAINED_STREAM_CAPTURES = 100;
export const MAX_RECENT_STREAM_CHUNKS = 100;
export const MAX_RECENT_STREAM_EVENTS = 20;

const MAX_INLINE_EVENT_DATA_CHARS = 64 * 1024;
const MIN_BASE64_ARTIFACT_CHARS = 4 * 1024;
const DEFAULT_MAX_REQUESTS = 200;
const DEFAULT_MAX_ARTIFACTS = 2_000;
const DEFAULT_MAX_PAYLOADS = 500;
const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_EXTRA_INFO_WAIT_MS = 500;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_500;
const BASE_REQUEST_ARTIFACT_COUNT = 16;

function getErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactLogValue(message));
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join('/');
}

function toJsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function bounded(value: string | undefined, max = 4096): string | undefined {
  if (value === undefined || value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 32)}…[truncated ${value.length - max + 32} chars]`;
}

const CREDENTIAL_HEADER_PATTERN =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-csrf-token|x-xsrf-token)$/i;

function redactHeaders(
  headers: Protocol.Network.Headers,
): Protocol.Network.Headers {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      CREDENTIAL_HEADER_PATTERN.test(name) ? '[REDACTED]' : value,
    ]),
  );
}

function containsCredentialHeaders(headers: Protocol.Network.Headers): boolean {
  return Object.keys(headers).some(name =>
    CREDENTIAL_HEADER_PATTERN.test(name),
  );
}

function normalizedList(values?: string[]): string[] | undefined {
  if (!values) {
    return undefined;
  }
  if (values.length === 0) {
    throw new Error('Stream filter arrays must contain at least one value.');
  }
  return values.map(value => value.toLowerCase());
}

function normalizeFilter(filter: StreamCaptureFilter): StreamCaptureFilter {
  normalizedList(filter.methods);
  normalizedList(filter.resourceTypes);
  normalizedList(filter.mimeTypes);
  return {
    urlFilter: filter.urlFilter,
    methods: filter.methods,
    resourceTypes: filter.resourceTypes,
    mimeTypes: filter.mimeTypes ?? ['text/event-stream'],
  };
}

function matchesRequestFilter(
  filter: StreamCaptureFilter,
  metadata: RequestMetadata,
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
  return true;
}

function matchesFilter(
  filter: StreamCaptureFilter,
  metadata: RequestMetadata,
  mimeType?: string,
): boolean {
  if (!matchesRequestFilter(filter, metadata)) {
    return false;
  }
  const mimeTypes = normalizedList(filter.mimeTypes);
  return Boolean(
    mimeTypes?.some(expected =>
      (mimeType ?? '').toLowerCase().startsWith(expected),
    ),
  );
}

function wallTimeFromMonotonic(
  monotonicTimeSeconds: number,
  offsetMs?: number,
): number | undefined {
  return offsetMs === undefined
    ? undefined
    : monotonicTimeSeconds * 1000 + offsetMs;
}

function decodeUtf8Line(bytes: Buffer): {text: string; invalid: boolean} {
  try {
    return {
      text: new TextDecoder('utf-8', {fatal: true}).decode(bytes),
      invalid: false,
    };
  } catch {
    return {text: new TextDecoder('utf-8').decode(bytes), invalid: true};
  }
}

class BoundedSseParser {
  #maxEventBytes: number;
  #maxIncompleteTailBytes: number;
  #lineParts: Buffer[] = [];
  #lineBytes = 0;
  #lineStartOffset = 0;
  #lineFirstChunkIndex = 0;
  #lineFirstMonotonic = 0;
  #lineFirstWall?: number;
  #event?: EventState;
  #nextIndex = 0;
  #decodedCharCursor = 0;
  #absoluteOffset = 0;
  #pendingCr = false;
  #bomHandled = false;
  #degradedReason?: string;

  constructor(maxEventBytes: number, maxIncompleteTailBytes: number) {
    this.#maxEventBytes = maxEventBytes;
    this.#maxIncompleteTailBytes = maxIncompleteTailBytes;
  }

  get degradedReason(): string | undefined {
    return this.#degradedReason;
  }

  get incompleteTailBytes(): number {
    return this.#event?.rawBytes ?? this.#lineBytes;
  }

  push(payload: Buffer, context: ParserFeedContext): SseEvent[] {
    if (this.#degradedReason || payload.length === 0) {
      this.#absoluteOffset += payload.length;
      return [];
    }
    if (this.#absoluteOffset !== context.rawByteStart) {
      this.#degrade('raw byte offsets became non-contiguous');
      this.#absoluteOffset = context.rawByteStart + payload.length;
      return [];
    }
    const events: SseEvent[] = [];
    let index = 0;
    if (this.#pendingCr) {
      if (payload[0] === 0x0a) {
        index = 1;
        this.#absoluteOffset++;
      }
      this.#pendingCr = false;
    }
    while (index < payload.length && !this.#degradedReason) {
      let delimiter = index;
      while (
        delimiter < payload.length &&
        payload[delimiter] !== 0x0a &&
        payload[delimiter] !== 0x0d
      ) {
        delimiter++;
      }
      if (delimiter > index) {
        this.#appendLineBytes(payload.subarray(index, delimiter), context);
        this.#absoluteOffset += delimiter - index;
      }
      if (delimiter >= payload.length) {
        break;
      }
      const delimiterByte = payload[delimiter];
      const lineEndOffset = this.#absoluteOffset;
      this.#absoluteOffset++;
      const event = this.#finishLine(lineEndOffset, context);
      if (event) {
        events.push(event);
      }
      index = delimiter + 1;
      if (delimiterByte === 0x0d) {
        if (index < payload.length && payload[index] === 0x0a) {
          index++;
          this.#absoluteOffset++;
          this.#pendingCr = false;
        } else {
          this.#pendingCr = index >= payload.length;
        }
      }
    }
    return events;
  }

  #appendLineBytes(bytes: Buffer, context: ParserFeedContext): void {
    if (this.#lineBytes === 0) {
      this.#lineStartOffset = this.#absoluteOffset;
      this.#lineFirstChunkIndex = context.chunkIndex;
      this.#lineFirstMonotonic = context.monotonicTimeSeconds;
      this.#lineFirstWall = context.wallTimeMs;
    }
    this.#lineParts.push(bytes);
    this.#lineBytes += bytes.length;
    const total = (this.#event?.rawBytes ?? 0) + this.#lineBytes;
    if (total > this.#maxEventBytes) {
      this.#degrade(`SSE event exceeded ${this.#maxEventBytes} bytes`);
    } else if (total > this.#maxIncompleteTailBytes) {
      this.#degrade(
        `SSE incomplete tail exceeded ${this.#maxIncompleteTailBytes} bytes`,
      );
    }
  }

  #finishLine(
    lineEndOffset: number,
    context: ParserFeedContext,
  ): SseEvent | undefined {
    const lineBuffer = Buffer.concat(this.#lineParts, this.#lineBytes);
    this.#lineParts = [];
    this.#lineBytes = 0;
    const {text: decoded, invalid} = decodeUtf8Line(lineBuffer);
    let line = decoded;
    if (!this.#bomHandled) {
      this.#bomHandled = true;
      if (line.charCodeAt(0) === 0xfeff) {
        line = line.slice(1);
      }
    }
    if (line.length === 0) {
      const event = this.#finishEvent(this.#lineStartOffset, context);
      this.#decodedCharCursor++;
      this.#lineStartOffset = this.#absoluteOffset;
      return event;
    }
    if (!this.#event) {
      this.#event = {
        rawByteStart: this.#lineStartOffset,
        decodedCharStart: this.#decodedCharCursor,
        firstChunkIndex: this.#lineFirstChunkIndex,
        lastChunkIndex: context.chunkIndex,
        firstByteMonotonicTimeSeconds: this.#lineFirstMonotonic,
        firstByteWallTimeMs: this.#lineFirstWall,
        completedMonotonicTimeSeconds: context.monotonicTimeSeconds,
        completedWallTimeMs: context.wallTimeMs,
        rawBytes: 0,
        dataLines: [],
        comments: [],
        invalidUtf8: false,
      };
    }
    const state = this.#event;
    state.lastChunkIndex = context.chunkIndex;
    state.completedMonotonicTimeSeconds = context.monotonicTimeSeconds;
    state.completedWallTimeMs = context.wallTimeMs;
    state.rawBytes = lineEndOffset + 1 - state.rawByteStart;
    state.invalidUtf8 ||= invalid;
    this.#consumeField(line, state);
    this.#decodedCharCursor += line.length + 1;
    this.#lineStartOffset = this.#absoluteOffset;
    return undefined;
  }

  #consumeField(line: string, state: EventState): void {
    if (line.startsWith(':')) {
      state.comments.push(line.slice(1).trimStart());
      return;
    }
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'data':
        state.dataLines.push(value);
        break;
      case 'event':
        state.eventName = value || 'message';
        break;
      case 'id':
        state.eventId = value;
        break;
      case 'retry': {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && parsed >= 0) {
          state.retry = parsed;
        }
        break;
      }
    }
  }

  #finishEvent(
    rawByteEnd: number,
    context: ParserFeedContext,
  ): SseEvent | undefined {
    const state = this.#event;
    this.#event = undefined;
    if (!state) {
      return undefined;
    }
    if (state.dataLines.length === 0 && state.comments.length === 0) {
      return undefined;
    }
    const data = state.dataLines.join('\n');
    const recordType: StreamEventRecordType =
      state.dataLines.length === 0 ? 'heartbeat' : 'event';
    return {
      index: this.#nextIndex++,
      recordType,
      eventName:
        recordType === 'event' ? (state.eventName ?? 'message') : undefined,
      eventId: state.eventId,
      data,
      retry: state.retry,
      comments: state.comments,
      defaultDoneMarker: data.trim() === '[DONE]',
      source: 'raw-stream',
      invalidUtf8: state.invalidUtf8,
      rawByteStart: state.rawByteStart,
      rawByteEnd,
      decodedCharStart: state.decodedCharStart,
      decodedCharEnd: this.#decodedCharCursor,
      firstChunkIndex: state.firstChunkIndex,
      lastChunkIndex: context.chunkIndex,
      firstByteMonotonicTimeSeconds: state.firstByteMonotonicTimeSeconds,
      firstByteWallTimeMs: state.firstByteWallTimeMs,
      completedMonotonicTimeSeconds: context.monotonicTimeSeconds,
      completedWallTimeMs: context.wallTimeMs,
    };
  }

  #degrade(reason: string): void {
    this.#degradedReason ??= reason;
    this.#lineParts = [];
    this.#lineBytes = 0;
    this.#event = undefined;
  }
}

export function parseSseEvents(data: Uint8Array): {
  events: SseEvent[];
  incompleteTail: string;
} {
  const bytes = Buffer.from(data);
  const parser = new BoundedSseParser(
    Math.max(bytes.length + 1, DEFAULT_STREAM_MAX_SSE_EVENT_BYTES),
    Math.max(bytes.length + 1, DEFAULT_STREAM_MAX_SSE_EVENT_BYTES),
  );
  const events = parser.push(bytes, {
    chunkIndex: 0,
    rawByteStart: 0,
    monotonicTimeSeconds: 0,
    wallTimeMs: 0,
  });
  const normalized = bytes
    .toString('utf8')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n');
  const pieces = normalized.split('\n\n');
  const incompleteTail = normalized.endsWith('\n\n')
    ? ''
    : (pieces.at(-1) ?? '');
  return {events, incompleteTail};
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
  if (
    bytes.length === 0 ||
    bytes.toString('base64').replaceAll(/=+$/g, '') !==
      compact.replaceAll(/=+$/g, '')
  ) {
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
  criticality: ArtifactRuntime['criticality'],
  descriptorOptions: Pick<
    StreamArtifactFile,
    'sensitivity' | 'containsCredentials' | 'encoding' | 'captureSource'
  > = {},
): ArtifactRuntime {
  return {
    descriptor: {
      artifactId: `art_stream_${capture.uuid}_${suffix}`,
      kind,
      rootIndex: capture.artifactRootIndex,
      relativePath: toPortablePath(relativePath),
      bytes: 0,
      writeStatus: 'pending',
      ...descriptorOptions,
    },
    relativeToRequestDir: path.basename(relativePath),
    hash: createHash('sha256'),
    criticality,
  };
}

function severity(status: StreamIntegrityStatus): number {
  return {complete: 0, 'semantic-only': 1, partial: 2, failed: 3}[status];
}

export class StreamCollector {
  #context: BrowserContext;
  #sessionProvider: CdpSessionProvider;
  #limits: StreamCollectorLimits;
  #resolveNetworkRequestId?: (
    page: Page,
    cdpRequestId: string,
  ) => number | undefined;
  #captures = new Map<number, StreamCapture>();
  #captureRuntime = new WeakMap<StreamCapture, CaptureRuntime>();
  #activeCaptureByPage = new WeakMap<Page, StreamCapture>();
  #requestRuntime = new WeakMap<StreamRequest, RequestRuntime>();
  #requestOwners = new WeakMap<Page, Map<string, StreamRequest>>();
  #requestMetadata = new WeakMap<Page, Map<string, RequestMetadata>>();
  #pageGeneration = new WeakMap<Page, number>();
  #latestMonotonicTime = new WeakMap<Page, number>();
  #cdpCleanup = new WeakMap<Page, () => void>();
  #pageCloseListeners = new WeakMap<Page, () => void>();
  #pageInitializations = new WeakMap<Page, Promise<void>>();
  #pendingInitializations = new Set<Promise<void>>();
  #pageClosePromises = new WeakMap<Page, Promise<void>>();
  #initialization?: Promise<void>;
  #nextCaptureId = 1;
  #listeningForPages = false;
  #disposed = false;

  #touchCapture(capture: StreamCapture): void {
    capture.version++;
  }

  constructor(
    context: BrowserContext,
    sessionProvider: CdpSessionProvider,
    options: Partial<StreamCollectorLimits> & {
      resolveNetworkRequestId?: (
        page: Page,
        cdpRequestId: string,
      ) => number | undefined;
    } = {},
  ) {
    this.#context = context;
    this.#sessionProvider = sessionProvider;
    this.#resolveNetworkRequestId = options.resolveNetworkRequestId;
    this.#limits = {
      maxCaptures: options.maxCaptures ?? MAX_RETAINED_STREAM_CAPTURES,
      maxDiskBytesPerCapture:
        options.maxDiskBytesPerCapture ?? DEFAULT_STREAM_DISK_QUOTA_BYTES,
      activationTimeoutMs:
        options.activationTimeoutMs ?? DEFAULT_STREAM_ACTIVATION_TIMEOUT_MS,
      maxPendingBytesPerRequest:
        options.maxPendingBytesPerRequest ?? DEFAULT_STREAM_PENDING_MAX_BYTES,
      maxSseEventBytes:
        options.maxSseEventBytes ?? DEFAULT_STREAM_MAX_SSE_EVENT_BYTES,
      maxIncompleteTailBytes:
        options.maxIncompleteTailBytes ?? DEFAULT_STREAM_MAX_SSE_EVENT_BYTES,
      maxRecentChunksPerRequest:
        options.maxRecentChunksPerRequest ?? MAX_RECENT_STREAM_CHUNKS,
      maxRecentEventsPerRequest:
        options.maxRecentEventsPerRequest ?? MAX_RECENT_STREAM_EVENTS,
      maxRequestsPerCapture:
        options.maxRequestsPerCapture ?? DEFAULT_MAX_REQUESTS,
      maxArtifactsPerCapture:
        options.maxArtifactsPerCapture ?? DEFAULT_MAX_ARTIFACTS,
      maxPayloadsPerRequest:
        options.maxPayloadsPerRequest ?? DEFAULT_MAX_PAYLOADS,
      maxEventsPerRequest: options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS,
      maxMetadataBytes:
        options.maxMetadataBytes ?? DEFAULT_STREAM_MAX_METADATA_BYTES,
      extraInfoWaitMs: options.extraInfoWaitMs ?? DEFAULT_EXTRA_INFO_WAIT_MS,
      shutdownTimeoutMs:
        options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
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
    this.#pageGeneration.set(page, 0);
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
    const metadataMap = this.#requestMetadata.get(page)!;
    const ownerMap = this.#requestOwners.get(page)!;
    const requestExtraInfoMap = new Map<
      string,
      Protocol.Network.RequestWillBeSentExtraInfoEvent[]
    >();
    const responseExtraInfoMap = new Map<
      string,
      Protocol.Network.ResponseReceivedExtraInfoEvent[]
    >();

    const onRequestWillBeSent = (
      event: Protocol.Network.RequestWillBeSentEvent,
    ): void => {
      this.#latestMonotonicTime.set(page, event.timestamp);
      const previous = metadataMap.get(event.requestId);
      const redirects = previous?.redirects ?? [];
      if (event.redirectResponse) {
        redirects.push({
          url: event.redirectResponse.url,
          status: event.redirectResponse.status,
          statusText: event.redirectResponse.statusText,
          headers: event.redirectResponse.headers,
        });
      }
      metadataMap.set(event.requestId, {
        cdpRequestId: event.requestId,
        url: event.request.url,
        method: event.request.method,
        resourceType: event.type,
        collectorGeneration:
          previous?.collectorGeneration ?? this.#pageGeneration.get(page) ?? 0,
        frameId: event.frameId,
        loaderId: event.loaderId,
        headers: event.request.headers,
        postData: event.request.postData,
        hasPostData: event.request.hasPostData,
        initiator: event.initiator,
        requestExtraInfo:
          previous?.requestExtraInfo ??
          requestExtraInfoMap.get(event.requestId) ??
          [],
        responseExtraInfo:
          previous?.responseExtraInfo ??
          responseExtraInfoMap.get(event.requestId) ??
          [],
        expectedRequestExtraInfoCount:
          (previous?.expectedRequestExtraInfoCount ?? 0) + 1,
        expectedResponseExtraInfoCount:
          (previous?.expectedResponseExtraInfoCount ?? 0) +
          (event.redirectResponse && event.redirectHasExtraInfo ? 1 : 0),
        redirects,
        startedMonotonicTimeSeconds: event.timestamp,
        startedWallTimeMs: Number.isFinite(event.wallTime)
          ? event.wallTime * 1000
          : undefined,
        monotonicToWallOffsetMs: Number.isFinite(event.wallTime)
          ? event.wallTime * 1000 - event.timestamp * 1000
          : undefined,
      });
    };

    const onRequestWillBeSentExtraInfo = (
      event: Protocol.Network.RequestWillBeSentExtraInfoEvent,
    ): void => {
      const items = requestExtraInfoMap.get(event.requestId) ?? [];
      items.push(event);
      requestExtraInfoMap.set(event.requestId, items);
      const metadata = metadataMap.get(event.requestId);
      if (metadata) {
        metadata.requestExtraInfo = items;
      }
      const request = ownerMap.get(event.requestId);
      const runtime = request ? this.#requestRuntime.get(request) : undefined;
      if (runtime) {
        runtime.metadata.requestExtraInfo = items;
        this.#notifyExtraInfo(runtime);
        this.#touchCapture(runtime.capture);
      }
    };

    const onResponseReceivedExtraInfo = (
      event: Protocol.Network.ResponseReceivedExtraInfoEvent,
    ): void => {
      const items = responseExtraInfoMap.get(event.requestId) ?? [];
      items.push(event);
      responseExtraInfoMap.set(event.requestId, items);
      const metadata = metadataMap.get(event.requestId);
      if (metadata) {
        metadata.responseExtraInfo = items;
      }
      const request = ownerMap.get(event.requestId);
      const runtime = request ? this.#requestRuntime.get(request) : undefined;
      if (runtime) {
        runtime.metadata.responseExtraInfo = items;
        this.#notifyExtraInfo(runtime);
        this.#touchCapture(runtime.capture);
      }
    };

    const onResponseReceived = (
      event: Protocol.Network.ResponseReceivedEvent,
    ): void => {
      this.#latestMonotonicTime.set(page, event.timestamp);
      const capture = this.#activeCaptureByPage.get(page);
      if (!capture || !['armed', 'capturing'].includes(capture.status)) {
        return;
      }
      const metadata = metadataMap.get(event.requestId) ?? {
        cdpRequestId: event.requestId,
        url: event.response.url,
        method: 'GET',
        resourceType: event.type,
        collectorGeneration: this.#pageGeneration.get(page) ?? 0,
        frameId: event.frameId,
        loaderId: event.loaderId,
        headers: {},
        requestExtraInfo: requestExtraInfoMap.get(event.requestId) ?? [],
        responseExtraInfo: responseExtraInfoMap.get(event.requestId) ?? [],
        expectedRequestExtraInfoCount: 0,
        expectedResponseExtraInfoCount: 0,
        redirects: [],
        startedMonotonicTimeSeconds: event.timestamp,
      };
      metadata.resourceType ??= event.type;
      metadata.responseExtraInfo =
        responseExtraInfoMap.get(event.requestId) ?? metadata.responseExtraInfo;
      if (event.hasExtraInfo) {
        metadata.expectedResponseExtraInfoCount++;
      }
      if (
        !capture.includeInFlight &&
        metadata.collectorGeneration !== capture.collectorGeneration
      ) {
        return;
      }
      if (!matchesFilter(capture.filter, metadata, event.response.mimeType)) {
        return;
      }
      if (ownerMap.has(event.requestId)) {
        return;
      }
      if (capture.requests.length >= this.#limits.maxRequestsPerCapture) {
        this.#failCaptureLimit(
          capture,
          'request_limit',
          this.#limits.maxRequestsPerCapture,
          'Stream capture exceeded maxRequestsPerCapture.',
        );
        return;
      }
      if (
        this.#artifactCount(capture) + BASE_REQUEST_ARTIFACT_COUNT >
        this.#limits.maxArtifactsPerCapture
      ) {
        this.#failCaptureLimit(
          capture,
          'artifact_limit',
          this.#limits.maxArtifactsPerCapture,
          'Stream capture exceeded maxArtifactsPerCapture before creating a request.',
        );
        return;
      }
      const request = this.#createRequest(
        capture,
        page,
        client,
        metadata,
        event,
      );
      ownerMap.set(event.requestId, request);
      capture.requests.push(request);
      capture.status = 'capturing';
      capture.version++;
      const runtime = this.#requestRuntime.get(request)!;
      runtime.activationPromise = this.#activateRequest(
        request,
        runtime,
        event.timestamp,
      );
    };

    const onDataReceived = (
      event: Protocol.Network.DataReceivedEvent,
    ): void => {
      this.#latestMonotonicTime.set(page, event.timestamp);
      const request = ownerMap.get(event.requestId);
      const runtime = request ? this.#requestRuntime.get(request) : undefined;
      if (!request || !runtime || runtime.finalized) {
        return;
      }
      const payload = event.data
        ? Buffer.from(event.data, 'base64')
        : Buffer.alloc(0);
      const chunk: PendingChunk = {
        monotonicTimeSeconds: event.timestamp,
        wallTimeMs: wallTimeFromMonotonic(
          event.timestamp,
          runtime.metadata.monotonicToWallOffsetMs,
        ),
        dataLength: event.dataLength,
        encodedDataLength: event.encodedDataLength,
        payload,
        source: 'network',
      };
      if (!runtime.activationSettled) {
        if (
          runtime.pendingBytes + payload.length >
          this.#limits.maxPendingBytesPerRequest
        ) {
          this.#failPendingLimit(request, runtime, payload.length);
          return;
        }
        runtime.pendingChunks.push(chunk);
        runtime.pendingBytes += payload.length;
        request.pendingBytesPeak = Math.max(
          request.pendingBytesPeak,
          runtime.pendingBytes,
        );
        return;
      }
      if (!runtime.activationSucceeded) {
        this.#recordDroppedChunk(
          request,
          runtime,
          payload.length,
          'pending_buffer_limit',
          this.#limits.maxPendingBytesPerRequest,
        );
        return;
      }
      this.#processChunk(request, runtime, chunk);
    };

    const onEventSourceMessage = (
      event: Protocol.Network.EventSourceMessageReceivedEvent,
    ): void => {
      this.#latestMonotonicTime.set(page, event.timestamp);
      const request = ownerMap.get(event.requestId);
      const runtime = request ? this.#requestRuntime.get(request) : undefined;
      if (!request || !runtime || runtime.finalized) {
        return;
      }
      const semanticEvent: SseEvent = {
        index: runtime.nextSemanticEventIndex++,
        recordType: 'event',
        eventName: event.eventName || 'message',
        eventId: event.eventId || undefined,
        data: event.data,
        comments: [],
        defaultDoneMarker: event.data.trim() === '[DONE]',
        source: 'eventsource',
        invalidUtf8: false,
        completedMonotonicTimeSeconds: event.timestamp,
        completedWallTimeMs: wallTimeFromMonotonic(
          event.timestamp,
          runtime.metadata.monotonicToWallOffsetMs,
        ),
      };
      this.#enqueueEventWrite(request, runtime, semanticEvent, 'semantic');
    };

    const onLoadingFinished = (
      event: Protocol.Network.LoadingFinishedEvent,
    ): void => {
      this.#latestMonotonicTime.set(page, event.timestamp);
      this.#scheduleRequestMetadataCleanup(
        event.requestId,
        metadataMap,
        requestExtraInfoMap,
        responseExtraInfoMap,
      );
      const request = ownerMap.get(event.requestId);
      const runtime = request ? this.#requestRuntime.get(request) : undefined;
      if (!request || !runtime) {
        return;
      }
      this.#setTerminal(request, runtime, {
        status: 'finished',
        reason: 'completed',
        endedMonotonicTimeSeconds: event.timestamp,
        endedWallTimeMs:
          wallTimeFromMonotonic(
            event.timestamp,
            runtime.metadata.monotonicToWallOffsetMs,
          ) ?? Date.now(),
      });
    };

    const onLoadingFailed = (
      event: Protocol.Network.LoadingFailedEvent,
    ): void => {
      this.#latestMonotonicTime.set(page, event.timestamp);
      const capture = this.#activeCaptureByPage.get(page);
      const metadata = metadataMap.get(event.requestId);
      let request = ownerMap.get(event.requestId);
      if (
        !request &&
        capture &&
        ['armed', 'capturing'].includes(capture.status) &&
        metadata &&
        matchesRequestFilter(capture.filter, metadata) &&
        (capture.includeInFlight ||
          metadata.collectorGeneration === capture.collectorGeneration)
      ) {
        request = this.#createRequest(
          capture,
          page,
          client,
          metadata,
          undefined,
        );
        ownerMap.set(event.requestId, request);
        capture.requests.push(request);
        capture.status = 'capturing';
        capture.version++;
      }
      this.#scheduleRequestMetadataCleanup(
        event.requestId,
        metadataMap,
        requestExtraInfoMap,
        responseExtraInfoMap,
      );
      const runtime = request ? this.#requestRuntime.get(request) : undefined;
      if (!request || !runtime) {
        return;
      }
      const canceled = Boolean(event.canceled);
      request.failurePhase = request.responseObserved
        ? request.streamActivationAttempted
          ? 'streaming'
          : 'activation'
        : 'before-response';
      this.#setTerminal(request, runtime, {
        status: canceled ? 'canceled' : 'failed',
        reason: canceled ? 'network_canceled' : 'network_error',
        endedMonotonicTimeSeconds: event.timestamp,
        endedWallTimeMs:
          wallTimeFromMonotonic(
            event.timestamp,
            runtime.metadata.monotonicToWallOffsetMs,
          ) ?? Date.now(),
        failure: canceled
          ? undefined
          : {
              errorText: bounded(event.errorText) ?? 'Network error',
              canceled: false,
              blockedReason: bounded(event.blockedReason, 256),
              code: 'NETWORK_ERROR',
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
        'Network.requestWillBeSentExtraInfo',
        onRequestWillBeSentExtraInfo,
      );
      removeCdpEventListener(
        client,
        'Network.responseReceived',
        onResponseReceived,
      );
      removeCdpEventListener(
        client,
        'Network.responseReceivedExtraInfo',
        onResponseReceivedExtraInfo,
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
        'Network.requestWillBeSentExtraInfo',
        onRequestWillBeSentExtraInfo,
      );
      addCdpEventListener(
        client,
        'Network.responseReceived',
        onResponseReceived,
      );
      addCdpEventListener(
        client,
        'Network.responseReceivedExtraInfo',
        onResponseReceivedExtraInfo,
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
    page: Page,
    client: Awaited<ReturnType<CdpSessionProvider['getSession']>>,
    metadata: RequestMetadata,
    responseEvent?: Protocol.Network.ResponseReceivedEvent,
  ): StreamRequest {
    const captureRuntime = this.#captureRuntime.get(capture)!;
    const requestIndex = capture.requests.length;
    const requestDirName = `request-${String(requestIndex + 1).padStart(4, '0')}`;
    const relativeDir = toPortablePath(
      path.join(capture.relativeDir, requestDirName),
    );
    const absoluteDir = path.join(
      captureRuntime.location.absoluteDir,
      requestDirName,
    );
    const request: StreamRequest = {
      cdpRequestId: metadata.cdpRequestId,
      persistentRequestId: `req_stream_${capture.uuid}_${requestIndex + 1}`,
      networkRequestIdLifetime: 'page-collector-generation',
      collectorGeneration: metadata.collectorGeneration,
      requestStartedBeforeCapture:
        metadata.collectorGeneration !== capture.collectorGeneration,
      responseObserved: Boolean(responseEvent),
      streamActivationAttempted: false,
      captureScope: 'page-target-only',
      workerCoverage: false,
      targetType: 'page',
      frameId: metadata.frameId,
      loaderId: metadata.loaderId,
      fromServiceWorker: responseEvent?.response.fromServiceWorker,
      requestIndex,
      url: bounded(metadata.url, 8192) ?? metadata.url,
      method: metadata.method,
      resourceType: metadata.resourceType,
      mimeType: responseEvent?.response.mimeType,
      responseStatus: responseEvent?.response.status,
      responseStatusText: bounded(responseEvent?.response.statusText, 512),
      status: responseEvent ? 'activating' : 'failed',
      integrityStatus: 'failed',
      rawCaptureIntegrity: responseEvent ? 'not-attempted' : 'not-attempted',
      semanticParseIntegrity: 'not-attempted',
      requestSnapshotIntegrity: 'partial',
      artifactIntegrity: 'complete',
      headersCompleteness: 'partial',
      bodyCompleteness: metadata.hasPostData
        ? metadata.postData
          ? 'partial'
          : 'unknown'
        : 'none',
      bodyCaptureSource: metadata.hasPostData
        ? metadata.postData
          ? 'cdp-postData-utf8'
          : 'unavailable'
        : 'none',
      replayReadiness: 'partial',
      parseStatus: 'complete',
      startedMonotonicTimeSeconds: metadata.startedMonotonicTimeSeconds,
      startedWallTimeMs: metadata.startedWallTimeMs,
      streamResourceContentEnabled: false,
      relativeDir,
      chunkCount: 0,
      recentChunks: [],
      rawEventCount: 0,
      semanticEventCount: 0,
      primaryEventSource: 'none',
      defaultDoneMarkerObserved: false,
      invalidUtf8Count: 0,
      incompleteTailBytes: 0,
      rawBytes: 0,
      diskBytesReserved: 0,
      pendingBytesPeak: 0,
      writeErrors: [],
      artifacts: [],
      recentRawEvents: [],
      recentSemanticEvents: [],
    };
    const artifacts = this.#createRequestArtifacts(capture, request);
    request.artifacts.push(
      ...[...artifacts.values()].map(item => item.descriptor),
    );
    const runtime: RequestRuntime = {
      capture,
      page,
      client,
      metadata,
      responseEvent,
      absoluteDir,
      initializationPromise: Promise.resolve(),
      snapshotPromise: Promise.resolve(),
      snapshotStarted: false,
      parser: new BoundedSseParser(
        this.#limits.maxSseEventBytes,
        this.#limits.maxIncompleteTailBytes,
      ),
      textDecoder: new TextDecoder('utf-8'),
      rawOffset: 0,
      payloadIndex: 1,
      payloadCount: 0,
      nextSemanticEventIndex: 0,
      scheduledRawEvents: 0,
      scheduledSemanticEvents: 0,
      writeChain: Promise.resolve(),
      activationPromise: Promise.resolve(),
      activationAbort: new AbortController(),
      activationSettled: false,
      activationSucceeded: false,
      pendingChunks: [],
      pendingBytes: 0,
      finalized: false,
      forceTerminated: false,
      extraInfoWaiters: new Set(),
      artifacts,
    };
    const initializationPromise = this.#initializeRequestFiles(
      request,
      runtime,
    );
    void initializationPromise.catch(() => undefined);
    runtime.initializationPromise = initializationPromise;
    runtime.writeChain = initializationPromise;
    this.#requestRuntime.set(request, runtime);
    return request;
  }

  #createRequestArtifacts(
    capture: StreamCapture,
    request: StreamRequest,
  ): Map<StreamArtifactFile['kind'], ArtifactRuntime> {
    const definitions: Array<
      [
        StreamArtifactFile['kind'],
        string,
        string,
        ArtifactRuntime['criticality'],
      ]
    > = [
      ['request_metadata', 'metadata.json', 'metadata', 'critical'],
      ['raw_bytes', 'raw.bin', 'raw', 'critical'],
      ['decoded_text', 'decoded.sse', 'decoded-text', 'supporting'],
      ['chunks', 'chunks.jsonl', 'chunks', 'critical'],
      ['events', 'events.jsonl', 'events', 'supporting'],
      ['eventsource_events', 'eventsource.jsonl', 'eventsource', 'supporting'],
      [
        'request_headers',
        'request-headers.json',
        'request-headers',
        'supporting',
      ],
      [
        'request_headers_extra',
        'request-headers-extra.json',
        'request-headers-extra',
        'supporting',
      ],
      [
        'request_headers_redacted',
        'request-headers.redacted.json',
        'request-headers-redacted',
        'supporting',
      ],
      [
        'request_body_text',
        'request-body.txt',
        'request-body-text',
        'supporting',
      ],
      [
        'request_body_metadata',
        'request-body.meta.json',
        'request-body-metadata',
        'supporting',
      ],
      [
        'response_headers',
        'response-headers.json',
        'response-headers',
        'supporting',
      ],
      [
        'response_headers_extra',
        'response-headers-extra.json',
        'response-headers-extra',
        'supporting',
      ],
      [
        'response_headers_redacted',
        'response-headers.redacted.json',
        'response-headers-redacted',
        'supporting',
      ],
      ['initiator', 'initiator.json', 'initiator', 'supporting'],
      ['redirects', 'redirects.json', 'redirects', 'supporting'],
    ];
    const artifacts = new Map(
      definitions.map(([kind, filename, suffix, criticality]) => {
        const containsCredentials = [
          'request_headers',
          'request_headers_extra',
          'response_headers',
          'response_headers_extra',
        ].includes(kind);
        return [
          kind,
          createArtifact(
            capture,
            kind,
            path.join(request.relativeDir, filename),
            `request-${request.requestIndex + 1}-${suffix}`,
            criticality,
            {
              sensitivity: containsCredentials
                ? 'credential'
                : [
                      'request_headers_redacted',
                      'response_headers_redacted',
                    ].includes(kind)
                  ? 'public'
                  : 'private',
              containsCredentials,
              encoding:
                kind === 'request_body_text' || kind === 'decoded_text'
                  ? 'utf-8'
                  : undefined,
              captureSource:
                kind === 'request_body_text' ? 'cdp-postData' : undefined,
            },
          ),
        ];
      }),
    );
    const requestRedacted = artifacts.get(
      'request_headers_redacted',
    )?.descriptor;
    const responseRedacted = artifacts.get(
      'response_headers_redacted',
    )?.descriptor;
    for (const kind of ['request_headers', 'request_headers_extra'] as const) {
      if (requestRedacted) {
        artifacts.get(kind)!.descriptor.redactedArtifactId =
          requestRedacted.artifactId;
      }
    }
    for (const kind of [
      'response_headers',
      'response_headers_extra',
    ] as const) {
      if (responseRedacted) {
        artifacts.get(kind)!.descriptor.redactedArtifactId =
          responseRedacted.artifactId;
      }
    }
    return artifacts;
  }

  async #initializeRequestFiles(
    request: StreamRequest,
    runtime: RequestRuntime,
  ): Promise<void> {
    const captureRuntime = this.#captureRuntime.get(runtime.capture)!;
    try {
      runtime.absoluteDir = await createSecureSubdirectory(
        captureRuntime.location.rootPath,
        captureRuntime.location.absoluteDir,
        path.basename(runtime.absoluteDir),
      );
      await createSecureSubdirectory(
        captureRuntime.location.rootPath,
        runtime.absoluteDir,
        'payloads',
      );
      for (const artifact of runtime.artifacts.values()) {
        if (artifact.descriptor.kind === 'request_metadata') {
          continue;
        }
        const opened = await openSecureArtifactFile(
          captureRuntime.location.rootPath,
          runtime.absoluteDir,
          artifact.relativeToRequestDir,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        );
        artifact.handle = opened.handle;
        artifact.descriptor.writeStatus = 'written';
        artifact.descriptor.sha256 = artifact.hash.copy().digest('hex');
      }
    } catch (error) {
      this.#markCoreArtifactFailure(request, runtime, error);
      throw error;
    }
  }

  async #writeNetworkSnapshot(
    request: StreamRequest,
    runtime: RequestRuntime,
    responseEvent?: Protocol.Network.ResponseReceivedEvent,
  ): Promise<void> {
    await runtime.initializationPromise;
    let postData = runtime.metadata.postData;
    if (!postData && runtime.metadata.hasPostData) {
      try {
        const result = await runtime.client.send('Network.getRequestPostData', {
          requestId: request.cdpRequestId,
        });
        postData = result.postData;
      } catch (error) {
        request.writeErrors.push(
          bounded(
            `Could not obtain request post data: ${getErrorText(error)}`,
          ) ?? 'Could not obtain request post data.',
        );
        request.requestSnapshotIntegrity = 'partial';
        request.bodyCompleteness = 'unknown';
        request.bodyCaptureSource = 'unavailable';
      }
    }
    if (postData !== undefined) {
      request.bodyCompleteness = runtime.metadata.hasPostData
        ? 'partial'
        : 'complete';
      request.bodyCaptureSource = 'cdp-postData-utf8';
    }
    const requestHeaders = runtime.metadata.headers;
    const requestExtraInfos = runtime.metadata.requestExtraInfo;
    const responseExtraInfos = runtime.metadata.responseExtraInfo;
    const requestExtraHeaders = requestExtraInfos.map(item => item.headers);
    const responseHeaders = responseEvent?.response.headers ?? {};
    const responseExtraHeaders = responseExtraInfos.map(item => item.headers);
    request.headersCompleteness = this.#hasExpectedExtraInfo(runtime.metadata)
      ? 'complete'
      : 'partial';
    request.requestSnapshotIntegrity =
      request.headersCompleteness === 'complete' &&
      (request.bodyCompleteness === 'complete' ||
        request.bodyCompleteness === 'none')
        ? 'complete'
        : 'partial';
    request.replayReadiness =
      request.requestSnapshotIntegrity === 'complete'
        ? 'ready'
        : request.headersCompleteness === 'complete' &&
            request.bodyCompleteness === 'partial'
          ? 'partial'
          : 'not-ready';
    const credentialArtifact = runtime.artifacts.get('request_headers');
    if (credentialArtifact) {
      credentialArtifact.descriptor.containsCredentials =
        containsCredentialHeaders(requestHeaders) ||
        requestExtraHeaders.some(headers => containsCredentialHeaders(headers));
      credentialArtifact.descriptor.sensitivity = credentialArtifact.descriptor
        .containsCredentials
        ? 'credential'
        : 'private';
    }
    await Promise.all([
      this.#writeArtifactOnce(
        request,
        runtime,
        'request_headers',
        Buffer.from(
          `${JSON.stringify(runtime.metadata.headers, null, 2)}\n`,
          'utf8',
        ),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'request_headers_extra',
        Buffer.from(`${JSON.stringify(requestExtraInfos, null, 2)}\n`, 'utf8'),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'request_headers_redacted',
        Buffer.from(
          `${JSON.stringify(
            {
              headers: redactHeaders(requestHeaders),
              extraHeaders: requestExtraHeaders.map(headers =>
                redactHeaders(headers),
              ),
              associatedCookieCount: requestExtraInfos.reduce(
                (count, item) => count + item.associatedCookies.length,
                0,
              ),
            },
            null,
            2,
          )}\n`,
          'utf8',
        ),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'request_body_text',
        Buffer.from(postData ?? '', 'utf8'),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'request_body_metadata',
        Buffer.from(
          `${JSON.stringify(
            {
              encoding: 'utf-8',
              captureSource: request.bodyCaptureSource,
              completeness: request.bodyCompleteness,
              wireBytes: false,
              hasPostData: runtime.metadata.hasPostData ?? false,
              capturedChars: postData?.length ?? 0,
            },
            null,
            2,
          )}\n`,
          'utf8',
        ),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'response_headers',
        Buffer.from(
          `${JSON.stringify(
            {
              responseObserved: Boolean(responseEvent),
              status: responseEvent?.response.status,
              statusText: responseEvent?.response.statusText,
              headers: responseHeaders,
            },
            null,
            2,
          )}\n`,
          'utf8',
        ),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'response_headers_extra',
        Buffer.from(`${JSON.stringify(responseExtraInfos, null, 2)}\n`, 'utf8'),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'response_headers_redacted',
        Buffer.from(
          `${JSON.stringify(
            {
              responseObserved: Boolean(responseEvent),
              status: responseEvent?.response.status,
              statusText: responseEvent?.response.statusText,
              headers: redactHeaders(responseHeaders),
              extraHeaders: responseExtraHeaders.map(headers =>
                redactHeaders(headers),
              ),
            },
            null,
            2,
          )}\n`,
          'utf8',
        ),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'initiator',
        Buffer.from(
          `${JSON.stringify(runtime.metadata.initiator ?? null, null, 2)}\n`,
          'utf8',
        ),
      ),
      this.#writeArtifactOnce(
        request,
        runtime,
        'redirects',
        Buffer.from(
          `${JSON.stringify(runtime.metadata.redirects, null, 2)}\n`,
          'utf8',
        ),
      ),
    ]);
  }

  async #activateRequest(
    request: StreamRequest,
    runtime: RequestRuntime,
    responseMonotonicTimeSeconds: number,
  ): Promise<void> {
    request.streamActivationAttempted = true;
    request.failurePhase = 'activation';
    const cdpPromise = runtime.client.send('Network.streamResourceContent', {
      requestId: request.cdpRequestId,
    });
    void cdpPromise.catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('streamResourceContent activation timed out'));
      }, this.#limits.activationTimeoutMs);
    });
    const abortPromise = new Promise<never>((_, reject) => {
      if (runtime.activationAbort.signal.aborted) {
        reject(runtime.activationAbort.signal.reason);
        return;
      }
      runtime.activationAbort.signal.addEventListener(
        'abort',
        () => reject(runtime.activationAbort.signal.reason),
        {once: true},
      );
    });
    try {
      const result = await Promise.race([
        cdpPromise,
        timeoutPromise,
        abortPromise,
      ]);
      request.streamResourceContentEnabled = true;
      runtime.activationSucceeded = true;
      request.rawCaptureIntegrity = 'partial';
      if (result.bufferedData) {
        const payload = Buffer.from(result.bufferedData, 'base64');
        this.#processChunk(request, runtime, {
          monotonicTimeSeconds: responseMonotonicTimeSeconds,
          wallTimeMs: wallTimeFromMonotonic(
            responseMonotonicTimeSeconds,
            runtime.metadata.monotonicToWallOffsetMs,
          ),
          dataLength: payload.length,
          encodedDataLength: 0,
          payload,
          source: 'buffered',
        });
      }
    } catch (error) {
      if (runtime.forceTerminated) {
        return;
      }
      const reason =
        runtime.activationFailureReason ??
        (getErrorText(error).includes('timed out')
          ? 'activation_timeout'
          : 'activation_error');
      runtime.activationFailureReason = reason;
      request.streamResourceContentError = bounded(getErrorText(error));
      request.integrityStatus = 'failed';
      request.rawCaptureIntegrity = 'failed';
      request.terminalReason ??= reason;
      if (reason === 'activation_timeout') {
        request.failure = {
          errorText: 'streamResourceContent activation timed out.',
          canceled: false,
          code: 'ACTIVATION_TIMEOUT',
        };
      } else if (reason === 'pending_limit') {
        request.failure = {
          errorText:
            'Pending stream data exceeded the activation buffer limit.',
          canceled: false,
          code: 'PENDING_BUFFER_LIMIT',
        };
      } else {
        request.failure = {
          errorText: bounded(getErrorText(error)) ?? 'Activation failed',
          canceled: false,
          code: 'ACTIVATION_ERROR',
        };
      }
      for (const pending of runtime.pendingChunks) {
        this.#recordDroppedChunk(
          request,
          runtime,
          pending.payload.length,
          reason === 'pending_limit'
            ? 'pending_buffer_limit'
            : 'activation_failure',
          this.#limits.maxPendingBytesPerRequest,
        );
      }
      runtime.pendingChunks.length = 0;
      runtime.pendingBytes = 0;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      runtime.activationSettled = true;
      if (runtime.activationSucceeded) {
        request.status =
          request.status === 'activating' ? 'streaming' : request.status;
        request.failurePhase = 'streaming';
        for (const pending of runtime.pendingChunks) {
          this.#processChunk(request, runtime, pending);
        }
        runtime.pendingChunks.length = 0;
        runtime.pendingBytes = 0;
      } else if (
        request.resourceType?.toLowerCase() !== 'eventsource' &&
        !runtime.terminal
      ) {
        runtime.terminal = {
          status: 'failed',
          reason: runtime.activationFailureReason ?? 'activation_error',
          endedWallTimeMs: Date.now(),
          failure: request.failure,
        };
      }
    }
  }

  #failPendingLimit(
    request: StreamRequest,
    runtime: RequestRuntime,
    droppedBytes: number,
  ): void {
    runtime.activationFailureReason = 'pending_limit';
    this.#recordDroppedChunk(
      request,
      runtime,
      droppedBytes,
      'pending_buffer_limit',
      this.#limits.maxPendingBytesPerRequest,
    );
    runtime.activationAbort.abort(
      new Error('Pending stream buffer exceeded configured limit'),
    );
  }

  #processChunk(
    request: StreamRequest,
    runtime: RequestRuntime,
    pending: PendingChunk,
  ): void {
    if (
      runtime.finalized ||
      (request.integrityStatus === 'failed' &&
        request.failure?.code === 'DISK_QUOTA_EXCEEDED')
    ) {
      return;
    }
    const chunkIndex = request.chunkCount;
    const events = runtime.parser.push(pending.payload, {
      chunkIndex,
      rawByteStart: runtime.rawOffset,
      monotonicTimeSeconds: pending.monotonicTimeSeconds,
      wallTimeMs: pending.wallTimeMs,
    });
    if (runtime.parser.degradedReason) {
      request.parseStatus = 'degraded';
      request.parseDegradedReason = bounded(runtime.parser.degradedReason);
      request.integrityStatus =
        request.integrityStatus === 'failed' ? 'failed' : 'partial';
    }
    const chunk: StreamChunkOffset = {
      index: chunkIndex,
      monotonicTimeSeconds: pending.monotonicTimeSeconds,
      wallTimeMs: pending.wallTimeMs,
      dataLength: pending.dataLength,
      encodedDataLength: pending.encodedDataLength,
      payloadBytes: pending.payload.length,
      source: pending.source,
      fileOffsetStart: runtime.rawOffset,
      fileOffsetEnd: runtime.rawOffset + pending.payload.length,
      eventIndexes: events.map(event => event.index),
    };
    const rawText = runtime.textDecoder.decode(pending.payload, {stream: true});
    const chunkLine = toJsonLine(chunk);
    const required =
      pending.payload.length + Buffer.byteLength(rawText) + chunkLine.length;
    if (
      !this.#reserveDisk(request, runtime, required, 'stream chunk', {
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
      'decoded_text',
      Buffer.from(rawText, 'utf8'),
    );
    this.#queueArtifactAppend(request, runtime, 'chunks', chunkLine);
    for (const event of events) {
      if (event.invalidUtf8) {
        request.invalidUtf8Count++;
        request.parseStatus = 'degraded';
        request.parseDegradedReason ??=
          'Invalid UTF-8 was replaced while parsing SSE.';
      }
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
    runtime.writeChain = runtime.writeChain.then(async () => {
      if (!artifact?.handle) {
        this.#markArtifactFailure(
          request,
          runtime,
          artifact,
          new Error(`Artifact ${kind} was not initialized.`),
        );
        return;
      }
      try {
        await artifact.handle.write(data);
        artifact.hash.update(data);
        artifact.descriptor.bytes += data.length;
        artifact.descriptor.sha256 = artifact.hash.copy().digest('hex');
        artifact.descriptor.writeStatus = 'written';
      } catch (error) {
        this.#markArtifactFailure(request, runtime, artifact, error);
      }
    });
  }

  async #writeArtifactOnce(
    request: StreamRequest,
    runtime: RequestRuntime,
    kind: StreamArtifactFile['kind'],
    data: Buffer,
  ): Promise<void> {
    if (!this.#reserveDisk(request, runtime, data.length, kind)) {
      return;
    }
    const artifact = runtime.artifacts.get(kind);
    if (!artifact?.handle) {
      this.#markArtifactFailure(
        request,
        runtime,
        artifact,
        new Error(`Artifact ${kind} was not initialized.`),
      );
      return;
    }
    try {
      await artifact.handle.write(data);
      artifact.hash.update(data);
      artifact.descriptor.bytes += data.length;
      artifact.descriptor.sha256 = artifact.hash.copy().digest('hex');
      artifact.descriptor.writeStatus = 'written';
    } catch (error) {
      this.#markArtifactFailure(request, runtime, artifact, error);
    }
  }

  #enqueueEventWrite(
    request: StreamRequest,
    runtime: RequestRuntime,
    event: SseEvent,
    destination: 'raw' | 'semantic',
  ): void {
    const currentCount =
      destination === 'raw'
        ? runtime.scheduledRawEvents
        : runtime.scheduledSemanticEvents;
    if (currentCount >= this.#limits.maxEventsPerRequest) {
      request.parseStatus = 'raw-only';
      request.parseDegradedReason = 'Event count exceeded configured limit.';
      request.integrityStatus = 'partial';
      request.truncation ??= {
        truncatedWallTimeMs: Date.now(),
        reason: 'event_limit',
        limit: this.#limits.maxEventsPerRequest,
        droppedChunkCount: 0,
        droppedBytes: 0,
      };
      this.#touchCapture(runtime.capture);
      return;
    }
    if (destination === 'raw') {
      runtime.scheduledRawEvents++;
    } else {
      runtime.scheduledSemanticEvents++;
    }
    const materialized = this.#materializeEvent(event, request, runtime);
    const targetKind: StreamArtifactFile['kind'] =
      destination === 'raw' ? 'events' : 'eventsource_events';
    const lineEstimate = toJsonLine(materialized.record);
    const payloadBytes = materialized.payloads.reduce(
      (sum, payload) => sum + payload.bytes.length,
      0,
    );
    if (
      !this.#reserveDisk(
        request,
        runtime,
        lineEstimate.length + payloadBytes,
        'SSE event',
      )
    ) {
      return;
    }
    runtime.writeChain = runtime.writeChain.then(async () => {
      for (const payload of materialized.payloads) {
        request.artifacts.push(payload.artifact);
        try {
          const captureRuntime = this.#captureRuntime.get(runtime.capture)!;
          const opened = await openSecureArtifactFile(
            captureRuntime.location.rootPath,
            runtime.absoluteDir,
            payload.relativeToRequestDir,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          );
          try {
            await opened.handle.writeFile(payload.bytes);
            await opened.handle.sync();
          } finally {
            await opened.handle.close();
          }
          payload.artifact.bytes = payload.bytes.length;
          payload.artifact.sha256 = createHash('sha256')
            .update(payload.bytes)
            .digest('hex');
          payload.artifact.writeStatus = 'written';
        } catch (error) {
          payload.artifact.writeStatus = 'failed';
          payload.artifact.error = bounded(getErrorText(error));
          request.writeErrors.push(
            bounded(
              `Could not write payload ${payload.artifact.relativePath}: ${getErrorText(error)}`,
            ) ?? 'Could not write payload.',
          );
          request.integrityStatus = 'partial';
        }
      }
      const target = runtime.artifacts.get(targetKind);
      if (!target?.handle) {
        this.#markArtifactFailure(
          request,
          runtime,
          target,
          new Error(`Artifact ${targetKind} was not initialized.`),
        );
        return;
      }
      try {
        const line = toJsonLine(materialized.record);
        await target.handle.write(line);
        target.hash.update(line);
        target.descriptor.bytes += line.length;
        target.descriptor.sha256 = target.hash.copy().digest('hex');
        target.descriptor.writeStatus = 'written';
        if (destination === 'raw') {
          request.rawEventCount++;
          runtime.capture.rawEventCount++;
          request.primaryEventSource = 'raw-stream';
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
        request.defaultDoneMarkerObserved ||= event.defaultDoneMarker;
        this.#touchCapture(runtime.capture);
      } catch (error) {
        this.#markArtifactFailure(request, runtime, target, error);
      }
    });
  }

  #materializeEvent(
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
      defaultDoneMarker: event.defaultDoneMarker,
      source: event.source,
      invalidUtf8: event.invalidUtf8,
      dataLength: event.data.length,
      dataSha256: createHash('sha256').update(event.data, 'utf8').digest('hex'),
      rawByteStart: event.rawByteStart,
      rawByteEnd: event.rawByteEnd,
      decodedCharStart: event.decodedCharStart,
      decodedCharEnd: event.decodedCharEnd,
      firstChunkIndex: event.firstChunkIndex,
      lastChunkIndex: event.lastChunkIndex,
      firstByteMonotonicTimeSeconds: event.firstByteMonotonicTimeSeconds,
      firstByteWallTimeMs: event.firstByteWallTimeMs,
      completedMonotonicTimeSeconds: event.completedMonotonicTimeSeconds,
      completedWallTimeMs: event.completedWallTimeMs,
    };
    if (event.recordType === 'event') {
      try {
        record.dataType = 'json';
        record.dataJson = this.#materializeJsonValue(
          JSON.parse(event.data) as unknown,
          ['data'],
          request,
          runtime,
          payloads,
        );
      } catch {
        record.dataType = 'text';
        const value = this.#materializeJsonValue(
          event.data,
          ['data'],
          request,
          runtime,
          payloads,
        );
        if (typeof value === 'string') {
          record.data = value;
        } else {
          record.dataArtifact = value;
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
        defaultDoneMarker: event.defaultDoneMarker,
        source: event.source,
        dataLength: event.data.length,
        payloadCount: payloads.length,
        rawByteStart: event.rawByteStart,
        rawByteEnd: event.rawByteEnd,
        completedWallTimeMs: event.completedWallTimeMs,
      },
    };
  }

  #materializeJsonValue(
    value: unknown,
    keyPath: string[],
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
            file => file.kind === 'decoded_text',
          )?.artifactId,
        };
      }
      if (runtime.payloadCount >= this.#limits.maxPayloadsPerRequest) {
        request.integrityStatus = 'partial';
        request.truncation ??= {
          truncatedWallTimeMs: Date.now(),
          reason: 'payload_limit',
          limit: this.#limits.maxPayloadsPerRequest,
          droppedChunkCount: 0,
          droppedBytes: candidate.bytes.length,
        };
        return {
          $payloadOmitted: true,
          encodedChars: value.length,
          encodedSha256: createHash('sha256')
            .update(value, 'utf8')
            .digest('hex'),
          decodedBytes: candidate.bytes.length,
          sha256: createHash('sha256').update(candidate.bytes).digest('hex'),
          reason: 'payload_limit',
        };
      }
      if (
        this.#artifactCount(runtime.capture) >=
        this.#limits.maxArtifactsPerCapture
      ) {
        request.integrityStatus = 'partial';
        request.truncation ??= {
          truncatedWallTimeMs: Date.now(),
          reason: 'artifact_limit',
          limit: this.#limits.maxArtifactsPerCapture,
          droppedChunkCount: 0,
          droppedBytes: candidate.bytes.length,
        };
        return {
          $payloadOmitted: true,
          encodedChars: value.length,
          encodedSha256: createHash('sha256')
            .update(value, 'utf8')
            .digest('hex'),
          decodedBytes: candidate.bytes.length,
          sha256: createHash('sha256').update(candidate.bytes).digest('hex'),
          reason: 'artifact_limit',
        };
      }
      const payloadIndex = runtime.payloadIndex++;
      runtime.payloadCount++;
      const pointer = `/${keyPath
        .map(item => item.replaceAll('~', '~0').replaceAll('/', '~1'))
        .join('/')}`;
      const pointerHash = createHash('sha256')
        .update(pointer)
        .digest('hex')
        .slice(0, 12);
      const filename = `payload-${String(payloadIndex).padStart(6, '0')}-${pointerHash}.${candidate.extension}`;
      const artifact: StreamArtifactFile = {
        artifactId: `art_stream_${runtime.capture.uuid}_request_${request.requestIndex + 1}_payload_${payloadIndex}`,
        kind: 'payload',
        rootIndex: runtime.capture.artifactRootIndex,
        relativePath: toPortablePath(
          path.join(request.relativeDir, 'payloads', filename),
        ),
        bytes: candidate.bytes.length,
        sha256: createHash('sha256').update(candidate.bytes).digest('hex'),
        mimeType: candidate.mimeType,
        sensitivity: 'private',
        containsCredentials: false,
        encoding: 'binary',
        captureSource: 'decoded-base64-event-field',
        writeStatus: 'pending',
      };
      payloads.push({
        artifact,
        relativeToRequestDir: path.join('payloads', filename),
        bytes: candidate.bytes,
      });
      return {
        $artifact: artifact,
        encoding: 'base64',
        encodedChars: value.length,
        encodedSha256: createHash('sha256').update(value, 'utf8').digest('hex'),
        decodedBytes: candidate.bytes.length,
        detectionConfidence: candidate.confidence,
        jsonPointerSha256: pointerHash,
      };
    }
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.#materializeJsonValue(
          item,
          [...keyPath, String(index)],
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
          this.#materializeJsonValue(
            item,
            [...keyPath, key],
            request,
            runtime,
            payloads,
          ),
        ]),
      );
    }
    return value;
  }

  #setTerminal(
    request: StreamRequest,
    runtime: RequestRuntime,
    terminal: RequestTerminal,
  ): void {
    if (runtime.finalized) {
      return;
    }
    runtime.terminal ??= terminal;
    this.#touchCapture(runtime.capture);
    void this.#finalizeRequest(request);
  }

  #notifyExtraInfo(runtime: RequestRuntime): void {
    for (const resolve of runtime.extraInfoWaiters) {
      resolve();
    }
    runtime.extraInfoWaiters.clear();
  }

  #hasExpectedExtraInfo(metadata: RequestMetadata): boolean {
    return (
      metadata.requestExtraInfo.length >=
        metadata.expectedRequestExtraInfoCount &&
      metadata.responseExtraInfo.length >=
        metadata.expectedResponseExtraInfoCount
    );
  }

  async #waitForExtraInfo(runtime: RequestRuntime): Promise<boolean> {
    if (this.#hasExpectedExtraInfo(runtime.metadata)) {
      return true;
    }
    const deadline = Date.now() + this.#limits.extraInfoWaitMs;
    while (
      !runtime.forceTerminated &&
      !this.#hasExpectedExtraInfo(runtime.metadata) &&
      Date.now() < deadline
    ) {
      await Promise.race([
        new Promise<void>(resolve => runtime.extraInfoWaiters.add(resolve)),
        new Promise<void>(resolve =>
          setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))),
        ),
      ]);
    }
    return this.#hasExpectedExtraInfo(runtime.metadata);
  }

  #scheduleRequestMetadataCleanup(
    requestId: string,
    metadataMap: Map<string, RequestMetadata>,
    requestExtraInfoMap: Map<
      string,
      Protocol.Network.RequestWillBeSentExtraInfoEvent[]
    >,
    responseExtraInfoMap: Map<
      string,
      Protocol.Network.ResponseReceivedExtraInfoEvent[]
    >,
  ): void {
    setTimeout(
      () => {
        metadataMap.delete(requestId);
        requestExtraInfoMap.delete(requestId);
        responseExtraInfoMap.delete(requestId);
      },
      Math.max(2_000, this.#limits.extraInfoWaitMs * 2),
    );
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
        if (runtime.forceTerminated) {
          return;
        }
        const skipExtraInfoWait =
          !request.responseObserved ||
          [
            'collector_stop',
            'shutdown_timeout',
            'page_close',
            'finalize_timeout',
          ].includes(runtime.terminal?.reason ?? '');
        const extraInfoComplete = skipExtraInfoWait
          ? this.#hasExpectedExtraInfo(runtime.metadata)
          : await this.#waitForExtraInfo(runtime);
        if (!extraInfoComplete) {
          request.headersCompleteness = 'partial';
          request.requestSnapshotIntegrity = 'partial';
          request.replayReadiness = 'partial';
          request.writeErrors.push(
            'Timed out waiting for all expected Network ExtraInfo events.',
          );
        }
        if (!runtime.snapshotStarted) {
          runtime.snapshotStarted = true;
          const snapshotPromise = this.#writeNetworkSnapshot(
            request,
            runtime,
            runtime.responseEvent,
          );
          void snapshotPromise.catch(() => undefined);
          runtime.snapshotPromise = snapshotPromise;
        }
        await runtime.snapshotPromise.catch(error => {
          request.writeErrors.push(
            bounded(`Network snapshot failed: ${getErrorText(error)}`) ??
              'Network snapshot failed.',
          );
          request.requestSnapshotIntegrity = 'partial';
          request.failurePhase ??= 'finalize';
        });
        if (runtime.forceTerminated) {
          return;
        }
        await runtime.writeChain;
        if (runtime.forceTerminated) {
          return;
        }
      } catch (error) {
        request.writeErrors.push(
          bounded(`Finalize error: ${getErrorText(error)}`) ??
            'Finalize error.',
        );
      }
      const finalText = runtime.textDecoder.decode();
      if (finalText.length > 0) {
        const finalTextBytes = Buffer.from(finalText, 'utf8');
        if (
          this.#reserveDisk(
            request,
            runtime,
            finalTextBytes.length,
            'final UTF-8 decoder output',
          )
        ) {
          this.#queueArtifactAppend(
            request,
            runtime,
            'decoded_text',
            finalTextBytes,
          );
          await runtime.writeChain;
        }
      }
      request.incompleteTailBytes = runtime.parser.incompleteTailBytes;
      if (runtime.parser.degradedReason) {
        request.parseStatus = 'degraded';
        request.parseDegradedReason = bounded(runtime.parser.degradedReason);
        request.semanticParseIntegrity = 'partial';
      }
      const terminal = runtime.terminal ?? {
        status: 'failed' as const,
        reason: runtime.activationFailureReason ?? 'activation_error',
        endedWallTimeMs: Date.now(),
        failure: request.failure,
      };
      request.status = terminal.status;
      request.terminalReason = terminal.reason;
      request.endedMonotonicTimeSeconds = terminal.endedMonotonicTimeSeconds;
      request.endedWallTimeMs = terminal.endedWallTimeMs;
      if (terminal.failure) {
        request.failure = terminal.failure;
      }
      request.networkRequestId = this.#resolveNetworkRequestId?.(
        runtime.page,
        request.cdpRequestId,
      );
      await this.#closeRequestHandles(runtime);
      runtime.finalized = true;
      this.#recomputeRequestIntegrity(request, runtime);
      await this.#writeRequestMetadata(request, runtime);
      this.#recomputeCaptureIntegrity(runtime.capture);
      this.#touchCapture(runtime.capture);
      await this.#queueCaptureMetadata(runtime.capture);
    })();
    await runtime.finalizePromise;
  }

  async #closeRequestHandles(runtime: RequestRuntime): Promise<void> {
    for (const artifact of runtime.artifacts.values()) {
      if (!artifact.handle) {
        continue;
      }
      try {
        await artifact.handle.sync();
      } catch {
        // Write status is already tracked by the append path.
      }
      await artifact.handle.close().catch(() => undefined);
      artifact.handle = undefined;
    }
  }

  #recomputeRequestIntegrity(
    request: StreamRequest,
    runtime: RequestRuntime,
  ): void {
    const criticalFailed = request.artifacts.some(
      artifact =>
        artifact.writeStatus === 'failed' &&
        ['raw_bytes', 'chunks', 'request_metadata'].includes(artifact.kind),
    );
    const supportingFailed = request.artifacts.some(
      artifact => artifact.writeStatus === 'failed',
    );
    request.artifactIntegrity = criticalFailed
      ? 'failed'
      : supportingFailed
        ? 'partial'
        : 'complete';

    if (!request.streamActivationAttempted) {
      request.rawCaptureIntegrity = 'not-attempted';
    } else if (!runtime.activationSucceeded) {
      request.rawCaptureIntegrity = 'failed';
    } else if (
      request.failure?.code === 'DISK_QUOTA_EXCEEDED' ||
      request.artifacts.find(artifact => artifact.kind === 'raw_bytes')
        ?.writeStatus === 'failed'
    ) {
      request.rawCaptureIntegrity = 'failed';
    } else if (request.truncation?.reason === 'disk_quota_exceeded') {
      request.rawCaptureIntegrity = 'partial';
    } else {
      request.rawCaptureIntegrity = 'complete';
    }

    if (request.rawEventCount === 0 && request.semanticEventCount === 0) {
      request.semanticParseIntegrity =
        request.parseStatus === 'complete' ? 'not-attempted' : 'partial';
    } else {
      request.semanticParseIntegrity =
        request.parseStatus === 'complete' ? 'complete' : 'partial';
    }

    if (request.failure?.code === 'DISK_QUOTA_EXCEEDED') {
      request.integrityStatus = 'failed';
      request.status = 'failed';
      request.terminalReason = 'quota';
      return;
    }
    if (criticalFailed || request.failure?.code === 'ARTIFACT_ERROR') {
      request.integrityStatus = 'failed';
      request.status = 'failed';
      request.terminalReason = 'artifact_error';
      return;
    }
    if (
      !runtime.activationSucceeded &&
      request.resourceType?.toLowerCase() === 'eventsource' &&
      request.semanticEventCount > 0
    ) {
      request.integrityStatus = 'semantic-only';
      request.primaryEventSource = 'eventsource';
      request.parseStatus = 'raw-only';
      request.semanticParseIntegrity = 'complete';
      return;
    }
    if (request.responseObserved && request.rawCaptureIntegrity === 'failed') {
      request.integrityStatus = 'failed';
      request.status = 'failed';
      request.terminalReason =
        runtime.activationFailureReason ??
        request.terminalReason ??
        'activation_error';
      return;
    }
    if (
      request.rawCaptureIntegrity === 'partial' ||
      request.semanticParseIntegrity === 'partial' ||
      request.requestSnapshotIntegrity === 'partial' ||
      request.artifactIntegrity === 'partial' ||
      request.truncation ||
      request.writeErrors.length > 0 ||
      !request.responseObserved
    ) {
      request.integrityStatus = 'partial';
      return;
    }
    request.integrityStatus = 'complete';
  }

  #recomputeCaptureIntegrity(capture: StreamCapture): void {
    if (
      capture.truncation &&
      ['disk_quota_exceeded', 'request_limit', 'artifact_limit'].includes(
        capture.truncation.reason,
      )
    ) {
      capture.integrityStatus = 'failed';
      capture.collectorIntegrity = 'failed';
      capture.status = 'failed';
      return;
    }
    if (capture.requests.length === 0) {
      capture.integrityStatus =
        capture.status === 'failed' ? 'failed' : 'partial';
      capture.collectorIntegrity = capture.integrityStatus;
      return;
    }
    capture.collectorIntegrity = capture.requests.reduce<StreamIntegrityStatus>(
      (current, request) =>
        severity(request.integrityStatus) > severity(current)
          ? request.integrityStatus
          : current,
      'complete',
    );
    capture.integrityStatus = capture.collectorIntegrity;
  }

  async #writeRequestMetadata(
    request: StreamRequest,
    runtime: RequestRuntime,
  ): Promise<void> {
    const artifact = runtime.artifacts.get('request_metadata');
    if (!artifact) {
      return;
    }
    let content = Buffer.from(
      `${JSON.stringify(this.#requestManifest(request), null, 2)}\n`,
      'utf8',
    );
    if (content.length > this.#limits.maxMetadataBytes) {
      request.integrityStatus = 'partial';
      request.truncation ??= {
        truncatedWallTimeMs: Date.now(),
        reason: 'metadata_limit',
        limit: this.#limits.maxMetadataBytes,
        droppedChunkCount: 0,
        droppedBytes: content.length - this.#limits.maxMetadataBytes,
      };
      content = Buffer.from(
        `${JSON.stringify(
          {
            request: this.#requestSummaryForManifest(request),
            metadataTruncated: true,
            metadataLimit: this.#limits.maxMetadataBytes,
            errors: request.writeErrors,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
    const delta = Math.max(0, content.length - artifact.descriptor.bytes);
    if (!this.#reserveDisk(request, runtime, delta, 'request metadata')) {
      return;
    }
    const captureRuntime = this.#captureRuntime.get(runtime.capture)!;
    try {
      await writeSecureAtomicArtifactFile(
        captureRuntime.location.rootPath,
        runtime.absoluteDir,
        artifact.relativeToRequestDir,
        content,
      );
      artifact.descriptor.bytes = content.length;
      artifact.descriptor.sha256 = createHash('sha256')
        .update(content)
        .digest('hex');
      artifact.descriptor.writeStatus = 'written';
    } catch (error) {
      this.#markArtifactFailure(request, runtime, artifact, error);
    }
  }

  #requestManifest(request: StreamRequest): Record<string, unknown> {
    return {
      ...this.#requestSummaryForManifest(request),
      artifacts: request.artifacts,
      recentChunks: request.recentChunks,
      writeErrors: request.writeErrors,
    };
  }

  #requestSummaryForManifest(request: StreamRequest): Record<string, unknown> {
    return {
      cdpRequestId: request.cdpRequestId,
      persistentRequestId: request.persistentRequestId,
      networkRequestId: request.networkRequestId,
      networkRequestIdLifetime: request.networkRequestIdLifetime,
      collectorGeneration: request.collectorGeneration,
      requestStartedBeforeCapture: request.requestStartedBeforeCapture,
      responseObserved: request.responseObserved,
      streamActivationAttempted: request.streamActivationAttempted,
      failurePhase: request.failurePhase,
      captureScope: request.captureScope,
      workerCoverage: request.workerCoverage,
      targetType: request.targetType,
      frameId: request.frameId,
      loaderId: request.loaderId,
      fromServiceWorker: request.fromServiceWorker,
      requestIndex: request.requestIndex,
      url: request.url,
      method: request.method,
      resourceType: request.resourceType,
      mimeType: request.mimeType,
      responseStatus: request.responseStatus,
      responseStatusText: request.responseStatusText,
      status: request.status,
      terminalReason: request.terminalReason,
      integrityStatus: request.integrityStatus,
      rawCaptureIntegrity: request.rawCaptureIntegrity,
      semanticParseIntegrity: request.semanticParseIntegrity,
      requestSnapshotIntegrity: request.requestSnapshotIntegrity,
      artifactIntegrity: request.artifactIntegrity,
      headersCompleteness: request.headersCompleteness,
      bodyCompleteness: request.bodyCompleteness,
      bodyCaptureSource: request.bodyCaptureSource,
      replayReadiness: request.replayReadiness,
      parseStatus: request.parseStatus,
      parseDegradedReason: request.parseDegradedReason,
      startedMonotonicTimeSeconds: request.startedMonotonicTimeSeconds,
      startedWallTimeMs: request.startedWallTimeMs,
      endedMonotonicTimeSeconds: request.endedMonotonicTimeSeconds,
      endedWallTimeMs: request.endedWallTimeMs,
      failure: request.failure,
      streamResourceContentEnabled: request.streamResourceContentEnabled,
      streamResourceContentError: request.streamResourceContentError,
      relativeDir: request.relativeDir,
      chunkCount: request.chunkCount,
      rawEventCount: request.rawEventCount,
      semanticEventCount: request.semanticEventCount,
      primaryEventSource: request.primaryEventSource,
      defaultDoneMarkerObserved: request.defaultDoneMarkerObserved,
      invalidUtf8Count: request.invalidUtf8Count,
      incompleteTailBytes: request.incompleteTailBytes,
      rawBytes: request.rawBytes,
      diskBytesReserved: request.diskBytesReserved,
      pendingBytesPeak: request.pendingBytesPeak,
      truncation: request.truncation,
    };
  }

  #captureManifest(capture: StreamCapture): Record<string, unknown> {
    return {
      captureId: capture.id,
      captureUuid: capture.uuid,
      status: capture.status,
      integrityStatus: capture.integrityStatus,
      collectorIntegrity: capture.collectorIntegrity,
      collectorGeneration: capture.collectorGeneration,
      captureArmedWallTimeMs: capture.captureArmedWallTimeMs,
      captureArmedMonotonicTimeSeconds:
        capture.captureArmedMonotonicTimeSeconds,
      includeInFlight: capture.includeInFlight,
      captureScope: capture.captureScope,
      workerCoverage: capture.workerCoverage,
      filter: capture.filter,
      artifactRootIndex: capture.artifactRootIndex,
      relativeDir: capture.relativeDir,
      metadataArtifact: capture.metadataArtifact,
      pageUrl: capture.pageUrl,
      pageTitle: capture.pageTitle,
      createdWallTimeMs: capture.createdWallTimeMs,
      stoppedWallTimeMs: capture.stoppedWallTimeMs,
      requestCount: capture.requests.length,
      totalRawBytes: capture.totalRawBytes,
      diskBytesReserved: capture.diskBytesReserved,
      chunkCount: capture.chunkCount,
      rawEventCount: capture.rawEventCount,
      semanticEventCount: capture.semanticEventCount,
      quotaBytes: capture.quotaBytes,
      truncation: capture.truncation,
      errors: capture.errors,
      requests: capture.requests.map(request => ({
        ...this.#requestSummaryForManifest(request),
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
      let content = Buffer.from(
        `${JSON.stringify(this.#captureManifest(capture), null, 2)}\n`,
        'utf8',
      );
      if (content.length > this.#limits.maxMetadataBytes) {
        capture.integrityStatus = 'partial';
        capture.truncation ??= {
          truncatedWallTimeMs: Date.now(),
          reason: 'metadata_limit',
          limit: this.#limits.maxMetadataBytes,
          droppedChunkCount: 0,
          droppedBytes: content.length - this.#limits.maxMetadataBytes,
        };
        content = Buffer.from(
          `${JSON.stringify(
            {
              captureId: capture.id,
              status: capture.status,
              integrityStatus: capture.integrityStatus,
              relativeDir: capture.relativeDir,
              metadataTruncated: true,
              metadataLimit: this.#limits.maxMetadataBytes,
              requestMetadataArtifacts: capture.requests.map(request =>
                request.artifacts.find(
                  artifact => artifact.kind === 'request_metadata',
                ),
              ),
              errors: capture.errors,
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
      }
      const delta = Math.max(
        0,
        content.length - capture.metadataArtifact.bytes,
      );
      if (capture.diskBytesReserved + delta > capture.quotaBytes) {
        capture.status = 'failed';
        capture.integrityStatus = 'failed';
        capture.errors.push('Capture metadata exceeded disk quota.');
        return;
      }
      capture.diskBytesReserved += delta;
      try {
        await writeSecureAtomicArtifactFile(
          runtime.location.rootPath,
          runtime.location.absoluteDir,
          'capture.json',
          content,
        );
        capture.metadataArtifact.bytes = content.length;
        capture.metadataArtifact.sha256 = createHash('sha256')
          .update(content)
          .digest('hex');
        capture.metadataArtifact.writeStatus = 'written';
      } catch (error) {
        capture.metadataArtifact.writeStatus = 'failed';
        capture.metadataArtifact.error = bounded(getErrorText(error));
        capture.status = 'failed';
        capture.integrityStatus = 'failed';
        capture.errors.push(
          bounded(
            `Could not atomically update capture metadata: ${getErrorText(error)}`,
          ) ?? 'Could not atomically update capture metadata.',
        );
      }
    });
    return runtime.metadataChain;
  }

  #reserveDisk(
    request: StreamRequest,
    runtime: RequestRuntime,
    bytes: number,
    reason: string,
    options: {droppedChunk?: boolean; droppedBytes?: number} = {},
  ): boolean {
    if (bytes <= 0) {
      return true;
    }
    const capture = runtime.capture;
    if (capture.diskBytesReserved + bytes <= capture.quotaBytes) {
      capture.diskBytesReserved += bytes;
      request.diskBytesReserved += bytes;
      return true;
    }
    capture.status = 'failed';
    capture.integrityStatus = 'failed';
    request.integrityStatus = 'failed';
    request.status = 'failed';
    request.terminalReason = 'quota';
    request.failure = {
      errorText: `Stream capture disk quota exceeded while writing ${reason}.`,
      canceled: false,
      code: 'DISK_QUOTA_EXCEEDED',
    };
    const truncation = {
      truncatedWallTimeMs: Date.now(),
      reason: 'disk_quota_exceeded' as const,
      limit: capture.quotaBytes,
      droppedChunkCount: options.droppedChunk ? 1 : 0,
      droppedBytes: options.droppedBytes ?? bytes,
    };
    capture.truncation ??= {...truncation};
    request.truncation ??= {...truncation};
    return false;
  }

  #recordDroppedChunk(
    request: StreamRequest,
    runtime: RequestRuntime,
    payloadBytes: number,
    reason: StreamTruncation['reason'],
    limit: number,
  ): void {
    const now = Date.now();
    runtime.capture.truncation ??= {
      truncatedWallTimeMs: now,
      reason,
      limit,
      droppedChunkCount: 0,
      droppedBytes: 0,
    };
    request.truncation ??= {
      truncatedWallTimeMs: now,
      reason,
      limit,
      droppedChunkCount: 0,
      droppedBytes: 0,
    };
    runtime.capture.truncation.droppedChunkCount++;
    runtime.capture.truncation.droppedBytes += payloadBytes;
    request.truncation.droppedChunkCount++;
    request.truncation.droppedBytes += payloadBytes;
  }

  #markCoreArtifactFailure(
    request: StreamRequest,
    runtime: RequestRuntime,
    error: unknown,
  ): void {
    const message = getErrorText(error);
    request.writeErrors.push(
      bounded(`Artifact initialization failed: ${message}`) ??
        'Artifact initialization failed.',
    );
    request.integrityStatus = 'failed';
    request.status = 'failed';
    request.terminalReason = 'artifact_error';
    request.failure = {
      errorText: bounded(message) ?? 'Artifact initialization failed',
      canceled: false,
      code: 'ARTIFACT_ERROR',
    };
    for (const artifact of runtime.artifacts.values()) {
      if (artifact.descriptor.writeStatus === 'pending') {
        artifact.descriptor.writeStatus = 'failed';
        artifact.descriptor.error = bounded(message);
      }
    }
    runtime.activationAbort.abort(error);
    runtime.terminal ??= {
      status: 'failed',
      reason: 'artifact_error',
      endedWallTimeMs: Date.now(),
      failure: request.failure,
    };
  }

  #markArtifactFailure(
    request: StreamRequest,
    runtime: RequestRuntime,
    artifact: ArtifactRuntime | undefined,
    error: unknown,
  ): void {
    const message = getErrorText(error);
    if (artifact) {
      artifact.descriptor.writeStatus = 'failed';
      artifact.descriptor.error = bounded(message);
    }
    request.writeErrors.push(bounded(message) ?? 'Artifact operation failed.');
    if (artifact?.criticality === 'critical') {
      request.integrityStatus = 'failed';
      request.failure = {
        errorText: bounded(message) ?? 'Critical artifact write failed',
        canceled: false,
        code: 'ARTIFACT_ERROR',
      };
      request.terminalReason = 'artifact_error';
      runtime.activationAbort.abort(error);
      runtime.terminal ??= {
        status: 'failed',
        reason: 'artifact_error',
        endedWallTimeMs: Date.now(),
        failure: request.failure,
      };
    } else {
      request.integrityStatus = 'partial';
    }
    this.#touchCapture(runtime.capture);
  }

  #failCaptureLimit(
    capture: StreamCapture,
    reason: StreamTruncation['reason'],
    limit: number,
    message: string,
  ): void {
    capture.status = 'failed';
    capture.integrityStatus = 'failed';
    capture.truncation ??= {
      truncatedWallTimeMs: Date.now(),
      reason,
      limit,
      droppedChunkCount: 0,
      droppedBytes: 0,
    };
    capture.errors.push(bounded(message) ?? 'Capture limit exceeded.');
    this.#touchCapture(capture);
    const runtime = this.#captureRuntime.get(capture);
    if (runtime && this.#activeCaptureByPage.get(runtime.page) === capture) {
      this.#activeCaptureByPage.delete(runtime.page);
    }
    void this.#queueCaptureMetadata(capture);
  }

  #artifactCount(capture: StreamCapture): number {
    return (
      1 +
      capture.requests.reduce(
        (sum, request) => sum + request.artifacts.length,
        0,
      )
    );
  }

  #trimRecent(events: StreamEventSummary[]): void {
    if (events.length > this.#limits.maxRecentEventsPerRequest) {
      events.splice(0, events.length - this.#limits.maxRecentEventsPerRequest);
    }
  }

  async startCapture(
    page: Page,
    filter: StreamCaptureFilter,
    location: StreamCaptureLocation,
    options: StreamCaptureOptions = {},
  ): Promise<StreamCapture> {
    const active = this.#activeCaptureByPage.get(page);
    if (active && ['armed', 'capturing'].includes(active.status)) {
      throw new Error(
        `Stream capture ${active.id} is already active for the selected page`,
      );
    }
    const id = this.#nextCaptureId++;
    const uuid = randomUUID();
    const collectorGeneration = (this.#pageGeneration.get(page) ?? 0) + 1;
    this.#pageGeneration.set(page, collectorGeneration);
    const relativeDir = toPortablePath(location.relativeDir);
    const metadataArtifact: StreamArtifactFile = {
      artifactId: `art_stream_${uuid}_capture_metadata`,
      kind: 'capture_metadata',
      rootIndex: location.rootIndex,
      relativePath: toPortablePath(path.join(relativeDir, 'capture.json')),
      bytes: 0,
      writeStatus: 'pending',
      sensitivity: 'private',
      containsCredentials: false,
    };
    const capture: StreamCapture = {
      id,
      uuid,
      status: 'armed',
      integrityStatus: 'partial',
      collectorIntegrity: 'partial',
      collectorGeneration,
      captureArmedWallTimeMs: Date.now(),
      captureArmedMonotonicTimeSeconds: this.#latestMonotonicTime.get(page),
      includeInFlight: options.includeInFlight ?? false,
      captureScope: 'page-target-only',
      workerCoverage: false,
      filter: normalizeFilter(filter),
      artifactRootIndex: location.rootIndex,
      relativeDir,
      metadataArtifact,
      pageUrl: bounded(page.url(), 8192) ?? '',
      pageTitle: bounded(await page.title().catch(() => undefined), 2048),
      createdWallTimeMs: Date.now(),
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
      location: {...location, relativeDir},
      metadataChain: Promise.resolve(),
    });
    this.#activeCaptureByPage.set(page, capture);
    this.#requestOwners.get(page)?.clear();
    await this.#queueCaptureMetadata(capture);
    this.#evictOldCaptures();
    return capture;
  }

  getById(captureId: number): StreamCapture {
    const capture = this.#captures.get(captureId);
    if (!capture) {
      throw new Error(`Stream capture ${captureId} was not found`);
    }
    return capture;
  }

  async findEventMatch(
    captureId: number,
    query: StreamEventMatchQuery,
  ): Promise<StreamEventMatch> {
    const capture = this.getById(captureId);
    const afterEventIndex = query.afterEventIndex ?? -1;
    const requests = query.requestId
      ? capture.requests.filter(
          request =>
            request.cdpRequestId === query.requestId ||
            request.persistentRequestId === query.requestId,
        )
      : capture.requests;
    for (const request of requests) {
      const runtime = this.#requestRuntime.get(request);
      if (!runtime) {
        continue;
      }
      await runtime.writeChain.catch(() => undefined);
      for (const [kind, source] of [
        ['events', 'raw-stream'],
        ['eventsource_events', 'eventsource'],
      ] as const) {
        const artifact = runtime.artifacts.get(kind);
        if (!artifact || artifact.descriptor.writeStatus === 'failed') {
          continue;
        }
        const filePath = path.join(
          runtime.absoluteDir,
          artifact.relativeToRequestDir,
        );
        const stream = createReadStream(filePath, {encoding: 'utf8'});
        const lines = createInterface({input: stream, crlfDelay: Infinity});
        try {
          for await (const line of lines) {
            let record: Record<string, unknown>;
            try {
              const parsed = JSON.parse(line) as unknown;
              if (
                !parsed ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed)
              ) {
                continue;
              }
              record = parsed as Record<string, unknown>;
            } catch {
              continue;
            }
            const index = record.index;
            if (
              typeof index !== 'number' ||
              !Number.isInteger(index) ||
              index <= afterEventIndex
            ) {
              continue;
            }
            if (!this.#matchesEventPredicate(record, query.predicate)) {
              continue;
            }
            return {
              matched: true,
              matchedEventIndex: index,
              matchedRequestId: request.cdpRequestId,
              matchedSource: source,
            };
          }
        } finally {
          lines.close();
          stream.destroy();
        }
      }
    }
    return {matched: false};
  }

  #matchesEventPredicate(
    record: Record<string, unknown>,
    predicate: StreamEventPredicate,
  ): boolean {
    if (predicate.type === 'exact_data') {
      return (
        record.dataLength === predicate.value.length &&
        record.dataSha256 ===
          createHash('sha256').update(predicate.value, 'utf8').digest('hex')
      );
    }
    if (predicate.type === 'event_name') {
      return record.eventName === predicate.value;
    }
    const value = this.#readJsonPath(record.dataJson, predicate.path);
    return this.#materializedValueEquals(value, predicate.value);
  }

  #materializedValueEquals(actual: unknown, expected: unknown): boolean {
    if (
      actual &&
      typeof actual === 'object' &&
      !Array.isArray(actual) &&
      typeof expected === 'string'
    ) {
      const descriptor = actual as Record<string, unknown>;
      if (descriptor.$largeText === true) {
        return (
          descriptor.chars === expected.length &&
          descriptor.sha256 ===
            createHash('sha256').update(expected, 'utf8').digest('hex')
        );
      }
      if (
        descriptor.encoding === 'base64' &&
        typeof descriptor.encodedChars === 'number' &&
        typeof descriptor.encodedSha256 === 'string'
      ) {
        return (
          descriptor.encodedChars === expected.length &&
          descriptor.encodedSha256 ===
            createHash('sha256').update(expected, 'utf8').digest('hex')
        );
      }
    }
    if (Array.isArray(actual) && Array.isArray(expected)) {
      return (
        actual.length === expected.length &&
        actual.every((item, index) =>
          this.#materializedValueEquals(item, expected[index]),
        )
      );
    }
    if (
      actual &&
      expected &&
      typeof actual === 'object' &&
      typeof expected === 'object' &&
      !Array.isArray(actual) &&
      !Array.isArray(expected)
    ) {
      const actualObject = actual as Record<string, unknown>;
      const expectedObject = expected as Record<string, unknown>;
      const expectedKeys = Object.keys(expectedObject);
      return (
        Object.keys(actualObject).length === expectedKeys.length &&
        expectedKeys.every(key =>
          this.#materializedValueEquals(actualObject[key], expectedObject[key]),
        )
      );
    }
    return Object.is(actual, expected);
  }

  #readJsonPath(value: unknown, jsonPath: string): unknown {
    if (!jsonPath.startsWith('$.')) {
      return undefined;
    }
    let current = value;
    for (const segment of jsonPath.slice(2).split('.')) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  async stopCapture(
    captureId: number,
    options: {
      reason?: StreamTerminalReason;
      signal?: AbortSignal;
      deadlineWallTimeMs?: number;
    } = {},
  ): Promise<StreamCapture> {
    const reason = options.reason ?? 'collector_stop';
    const capture = this.getById(captureId);
    const runtime = this.#captureRuntime.get(capture);
    if (!runtime) {
      return capture;
    }
    capture.stoppedWallTimeMs ??= Date.now();
    if (capture.status !== 'failed') {
      capture.status = 'stopped';
    }
    this.#touchCapture(capture);
    if (this.#activeCaptureByPage.get(runtime.page) === capture) {
      this.#activeCaptureByPage.delete(runtime.page);
    }
    for (const request of capture.requests) {
      const requestRuntime = this.#requestRuntime.get(request);
      if (!requestRuntime) {
        continue;
      }
      if (!requestRuntime.activationSettled && !requestRuntime.terminal) {
        requestRuntime.activationFailureReason = reason;
        requestRuntime.activationAbort.abort(
          new Error(`Stream activation interrupted by ${reason}`),
        );
      }
      requestRuntime.terminal ??= {
        status: reason === 'shutdown_timeout' ? 'failed' : 'stopped',
        reason,
        endedWallTimeMs: capture.stoppedWallTimeMs,
        failure:
          reason === 'shutdown_timeout'
            ? {
                errorText:
                  'Shutdown timed out while finalizing stream capture.',
                canceled: false,
                code: 'SHUTDOWN_TIMEOUT',
              }
            : undefined,
      };
    }
    const finalizePromise = Promise.all(
      capture.requests.map(request => this.#finalizeRequest(request)),
    );
    try {
      await this.#awaitFinalizeDeadline(finalizePromise, options);
    } catch (error) {
      await this.#forceFinalizeCapture(capture, getErrorText(error));
    }
    this.#recomputeCaptureIntegrity(capture);
    this.#touchCapture(capture);
    await this.#queueCaptureMetadata(capture);
    return capture;
  }

  async #awaitFinalizeDeadline(
    promise: Promise<unknown>,
    options: {signal?: AbortSignal; deadlineWallTimeMs?: number},
  ): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const remaining = options.deadlineWallTimeMs
      ? options.deadlineWallTimeMs - Date.now()
      : undefined;
    if (remaining !== undefined && remaining <= 0) {
      throw new Error('Stream finalization deadline already expired.');
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const deadlinePromise =
      remaining === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Stream finalization deadline exceeded.')),
              remaining,
            );
          });
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          abortListener = () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Stream finalization aborted.'),
            );
          signal.addEventListener('abort', abortListener, {once: true});
        })
      : undefined;
    try {
      await Promise.race(
        [promise, deadlinePromise, abortPromise].filter(
          (candidate): candidate is Promise<unknown> => Boolean(candidate),
        ),
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  async #forceFinalizeCapture(
    capture: StreamCapture,
    errorText: string,
  ): Promise<void> {
    capture.status = 'failed';
    capture.integrityStatus = 'failed';
    capture.collectorIntegrity = 'failed';
    capture.stoppedWallTimeMs ??= Date.now();
    capture.errors.push(
      bounded(`Stream finalization interrupted: ${errorText}`) ??
        'Stream finalization interrupted.',
    );
    this.#touchCapture(capture);
    for (const request of capture.requests) {
      const runtime = this.#requestRuntime.get(request);
      if (!runtime || runtime.finalized) {
        continue;
      }
      runtime.forceTerminated = true;
      runtime.activationAbort.abort(
        new Error('Stream finalization interrupted'),
      );
      request.status = 'failed';
      request.terminalReason = 'finalize_timeout';
      request.failurePhase = 'finalize';
      request.integrityStatus = 'failed';
      request.artifactIntegrity = 'partial';
      request.failure = {
        errorText:
          bounded(`Stream finalization interrupted: ${errorText}`) ??
          'Stream finalization interrupted.',
        canceled: false,
        code: 'FINALIZE_TIMEOUT',
      };
      await this.#closeRequestHandles(runtime);
      runtime.finalized = true;
      await this.#writeRequestMetadata(request, runtime).catch(() => undefined);
      this.#touchCapture(capture);
    }
  }

  async #handlePageClosed(page: Page): Promise<void> {
    const captures = [...this.#captures.values()].filter(
      capture =>
        this.#captureRuntime.get(capture)?.page === page &&
        ['armed', 'capturing'].includes(capture.status),
    );
    for (const capture of captures) {
      capture.status = 'failed';
      capture.stoppedWallTimeMs ??= Date.now();
      capture.errors.push('Owning page closed before capture was finalized.');
      this.#touchCapture(capture);
      for (const request of capture.requests) {
        const runtime = this.#requestRuntime.get(request);
        if (!runtime) {
          continue;
        }
        runtime.activationFailureReason ??= 'activation_error';
        runtime.activationAbort.abort(new Error('Owning page closed'));
        runtime.terminal ??= {
          status: 'failed',
          reason: 'page_close',
          endedWallTimeMs: capture.stoppedWallTimeMs,
          failure: {
            errorText: 'Owning page closed during stream capture.',
            canceled: false,
            code: 'PAGE_CLOSED',
          },
        };
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

  async dispose(
    options: {timeoutMs?: number; reason?: string} = {},
  ): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const timeoutMs = options.timeoutMs ?? this.#limits.shutdownTimeoutMs;
    const active = [...this.#captures.values()].filter(
      capture => !['stopped', 'failed'].includes(capture.status),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = Promise.all(
      active.map(capture =>
        this.stopCapture(capture.id, {
          reason: 'collector_stop',
          deadlineWallTimeMs: Date.now() + timeoutMs,
        }),
      ),
    ).then(() => false);
    const timedOut = await Promise.race([
      cleanup,
      new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (timedOut) {
      for (const capture of active) {
        capture.status = 'failed';
        capture.integrityStatus = 'failed';
        capture.stoppedWallTimeMs ??= Date.now();
        capture.errors.push(
          bounded(
            `Stream shutdown finalization timed out after ${timeoutMs}ms: ${options.reason ?? 'shutdown'}`,
          ) ?? 'Stream shutdown finalization timed out.',
        );
        this.#touchCapture(capture);
        for (const request of capture.requests) {
          const runtime = this.#requestRuntime.get(request);
          runtime?.activationAbort.abort(new Error('shutdown timeout'));
          request.status = 'failed';
          request.terminalReason = 'shutdown_timeout';
          request.integrityStatus = 'failed';
          request.failure = {
            errorText:
              'Shutdown timed out before stream finalization completed.',
            canceled: false,
            code: 'SHUTDOWN_TIMEOUT',
          };
        }
        await this.#queueCaptureMetadata(capture).catch(() => undefined);
      }
    }
    if (this.#listeningForPages) {
      this.#context.off('page', this.#onPageCreated);
      this.#listeningForPages = false;
    }
    for (const page of this.#context.pages()) {
      this.#removePageListeners(page);
    }
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
        return requestRuntime?.finalized === true;
      });
      if (!active && settled) {
        this.#captures.delete(id);
        if (this.#captures.size <= this.#limits.maxCaptures) {
          break;
        }
      }
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
