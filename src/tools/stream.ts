/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  StreamArtifactFile,
  StreamCapture,
  StreamCaptureFilter,
  StreamRequest,
} from '../StreamCollector.js';
import {zod} from '../third_party/index.js';
import {ToolError} from '../ToolError.js';

import {ToolCategory} from './categories.js';
import {createToolOutputSchema, defineTool} from './ToolDefinition.js';

const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
] as const;
const RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'manifest',
  'ping',
  'preflight',
  'other',
] as const;
const integritySchema = zod.enum([
  'complete',
  'semantic-only',
  'partial',
  'failed',
]);
const artifactSchema = zod
  .object({
    artifactId: zod.string().max(256),
    kind: zod.enum([
      'capture_metadata',
      'request_metadata',
      'raw_bytes',
      'raw_text',
      'chunks',
      'events',
      'eventsource_events',
      'request_headers',
      'request_body',
      'response_headers',
      'initiator',
      'redirects',
      'payload',
    ]),
    rootIndex: zod.number().int().nonnegative(),
    relativePath: zod.string().max(4096),
    bytes: zod.number().int().nonnegative(),
    sha256: zod
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mimeType: zod.string().max(256).optional(),
    writeStatus: zod.enum(['pending', 'written', 'failed']),
    error: zod.string().max(4096).optional(),
  })
  .strict();
const truncationSchema = zod
  .object({
    truncatedWallTimeMs: zod.number(),
    reason: zod.enum([
      'disk_quota_exceeded',
      'pending_buffer_limit',
      'request_limit',
      'artifact_limit',
      'payload_limit',
      'event_limit',
      'metadata_limit',
      'activation_failure',
    ]),
    limit: zod.number().int().nonnegative(),
    droppedChunkCount: zod.number().int().nonnegative(),
    droppedBytes: zod.number().int().nonnegative(),
  })
  .strict();
const failureSchema = zod
  .object({
    errorText: zod.string().max(4096),
    canceled: zod.boolean(),
    blockedReason: zod.string().max(256).optional(),
    code: zod.enum([
      'DISK_QUOTA_EXCEEDED',
      'PAGE_CLOSED',
      'NETWORK_ERROR',
      'ACTIVATION_TIMEOUT',
      'PENDING_BUFFER_LIMIT',
      'ACTIVATION_ERROR',
      'ARTIFACT_ERROR',
      'SHUTDOWN_TIMEOUT',
    ]),
  })
  .strict();
const eventSummarySchema = zod
  .object({
    index: zod.number().int().nonnegative(),
    recordType: zod.enum(['event', 'heartbeat']),
    eventName: zod.string().max(256).optional(),
    done: zod.boolean(),
    source: zod.enum(['raw-stream', 'eventsource']),
    dataLength: zod.number().int().nonnegative(),
    payloadCount: zod.number().int().nonnegative(),
    rawByteStart: zod.number().int().nonnegative().optional(),
    rawByteEnd: zod.number().int().nonnegative().optional(),
    completedWallTimeMs: zod.number().optional(),
  })
  .strict();
const chunkSchema = zod
  .object({
    index: zod.number().int().nonnegative(),
    monotonicTimeSeconds: zod.number(),
    wallTimeMs: zod.number().optional(),
    dataLength: zod.number().int().nonnegative(),
    encodedDataLength: zod.number().nonnegative(),
    payloadBytes: zod.number().int().nonnegative(),
    source: zod.enum(['buffered', 'network']),
    fileOffsetStart: zod.number().int().nonnegative(),
    fileOffsetEnd: zod.number().int().nonnegative(),
    eventIndexes: zod.array(zod.number().int().nonnegative()).max(1000),
  })
  .strict();
const captureSchema = zod
  .object({
    captureId: zod.number().int().positive(),
    status: zod.enum(['armed', 'capturing', 'stopped', 'failed']),
    integrityStatus: integritySchema,
    artifactRootIndex: zod.number().int().nonnegative(),
    relativeDir: zod.string().max(4096),
    metadataArtifact: artifactSchema,
    pageUrl: zod.string().max(8192),
    pageTitle: zod.string().max(2048).optional(),
    createdWallTimeMs: zod.number(),
    stoppedWallTimeMs: zod.number().optional(),
    requestCount: zod.number().int().nonnegative(),
    totalRawBytes: zod.number().int().nonnegative(),
    diskBytesReserved: zod.number().int().nonnegative(),
    chunkCount: zod.number().int().nonnegative(),
    rawEventCount: zod.number().int().nonnegative(),
    semanticEventCount: zod.number().int().nonnegative(),
    quotaBytes: zod.number().int().positive(),
    truncation: truncationSchema.optional(),
    errors: zod.array(zod.string().max(4096)).max(100),
    version: zod.number().int().nonnegative(),
  })
  .strict();
const requestSchema = zod
  .object({
    cdpRequestId: zod.string().max(512),
    networkRequestId: zod.number().int().positive().optional(),
    requestIndex: zod.number().int().nonnegative(),
    url: zod.string().max(8192),
    method: zod.string().max(32),
    resourceType: zod.string().max(128).optional(),
    mimeType: zod.string().max(256).optional(),
    responseStatus: zod.number().optional(),
    status: zod.enum([
      'activating',
      'streaming',
      'finished',
      'canceled',
      'stopped',
      'failed',
    ]),
    terminalReason: zod
      .enum([
        'completed',
        'user_cancel',
        'page_close',
        'network_error',
        'quota',
        'collector_stop',
        'activation_timeout',
        'pending_limit',
        'activation_error',
        'artifact_error',
        'shutdown_timeout',
      ])
      .optional(),
    integrityStatus: integritySchema,
    parseStatus: zod.enum(['complete', 'degraded', 'raw-only']),
    parseDegradedReason: zod.string().max(4096).optional(),
    startedMonotonicTimeSeconds: zod.number(),
    startedWallTimeMs: zod.number().optional(),
    endedMonotonicTimeSeconds: zod.number().optional(),
    endedWallTimeMs: zod.number().optional(),
    failure: failureSchema.optional(),
    streamResourceContentEnabled: zod.boolean(),
    streamResourceContentError: zod.string().max(4096).optional(),
    relativeDir: zod.string().max(4096),
    chunkCount: zod.number().int().nonnegative(),
    rawEventCount: zod.number().int().nonnegative(),
    semanticEventCount: zod.number().int().nonnegative(),
    primaryEventSource: zod.enum(['raw-stream', 'eventsource', 'none']),
    doneMarkerObserved: zod.boolean(),
    invalidUtf8Count: zod.number().int().nonnegative(),
    incompleteTailBytes: zod.number().int().nonnegative(),
    rawBytes: zod.number().int().nonnegative(),
    diskBytesReserved: zod.number().int().nonnegative(),
    pendingBytesPeak: zod.number().int().nonnegative(),
    truncation: truncationSchema.optional(),
    coreArtifacts: zod.array(artifactSchema).max(16),
    recentRawEvents: zod.array(eventSummarySchema).max(20),
    recentSemanticEvents: zod.array(eventSummarySchema).max(20),
    writeErrors: zod.array(zod.string().max(4096)).max(100),
  })
  .strict();
const paginationSchema = zod
  .object({
    pageIdx: zod.number().int().nonnegative(),
    pageSize: zod.number().int().positive(),
    totalItems: zod.number().int().nonnegative(),
    totalPages: zod.number().int().positive(),
    hasNextPage: zod.boolean(),
    hasPreviousPage: zod.boolean(),
  })
  .strict();

const startDataSchema = zod.object({capture: captureSchema}).strict();
const statusDataSchema = zod
  .object({
    capture: captureSchema,
    requests: zod.array(requestSchema).optional(),
    request: requestSchema.optional(),
    recentChunks: zod.array(chunkSchema).max(100).optional(),
    pagination: paginationSchema.optional(),
  })
  .strict();
const stopDataSchema = zod
  .object({
    capture: captureSchema,
    captureMetadataArtifact: artifactSchema,
    requestMetadataArtifacts: zod.array(artifactSchema).max(200),
  })
  .strict();

const BANNED_OUTPUT_KEYS = new Set([
  'data',
  'body',
  'dataBase64',
  'base64',
  'rawBody',
]);

export function assertSafeStreamToolOutput(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (value.length > 8192) {
      throw new ToolError(
        'INTERNAL',
        `Stream tool output contains an overlong string at ${path}.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeStreamToolOutput(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (BANNED_OUTPUT_KEYS.has(key)) {
      throw new ToolError(
        'INTERNAL',
        `Stream tool output contains forbidden field ${path}.${key}.`,
      );
    }
    assertSafeStreamToolOutput(item, `${path}.${key}`);
  }
}

function setValidatedData(
  response: {setStructuredContent(value: Record<string, unknown>): void},
  schema: zod.ZodType<Record<string, unknown>>,
  value: Record<string, unknown>,
): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ToolError(
      'INTERNAL',
      `Stream tool produced invalid structured output: ${parsed.error.issues
        .slice(0, 5)
        .map(issue => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  assertSafeStreamToolOutput(parsed.data);
  response.setStructuredContent(parsed.data);
}

function captureSummary(capture: StreamCapture) {
  return {
    captureId: capture.id,
    status: capture.status,
    integrityStatus: capture.integrityStatus,
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
    errors: capture.errors.slice(-100),
    version: capture.version,
  };
}

function coreArtifacts(request: StreamRequest): StreamArtifactFile[] {
  return request.artifacts.filter(artifact =>
    [
      'request_metadata',
      'raw_bytes',
      'raw_text',
      'chunks',
      'events',
      'eventsource_events',
      'request_headers',
      'request_body',
      'response_headers',
      'initiator',
      'redirects',
    ].includes(artifact.kind),
  );
}

function requestSummary(request: StreamRequest) {
  return {
    cdpRequestId: request.cdpRequestId,
    networkRequestId: request.networkRequestId,
    requestIndex: request.requestIndex,
    url: request.url,
    method: request.method,
    resourceType: request.resourceType,
    mimeType: request.mimeType,
    responseStatus: request.responseStatus,
    status: request.status,
    terminalReason: request.terminalReason,
    integrityStatus: request.integrityStatus,
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
    doneMarkerObserved: request.doneMarkerObserved,
    invalidUtf8Count: request.invalidUtf8Count,
    incompleteTailBytes: request.incompleteTailBytes,
    rawBytes: request.rawBytes,
    diskBytesReserved: request.diskBytesReserved,
    pendingBytesPeak: request.pendingBytesPeak,
    truncation: request.truncation,
    coreArtifacts: coreArtifacts(request),
    recentRawEvents: request.recentRawEvents,
    recentSemanticEvents: request.recentSemanticEvents,
    writeErrors: request.writeErrors.slice(-100),
  };
}

function paginate<T>(items: T[], pageIdx: number, pageSize: number) {
  const start = pageIdx * pageSize;
  const page = items.slice(start, start + pageSize);
  return {
    items: page,
    pagination: {
      pageIdx,
      pageSize,
      totalItems: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: pageIdx > 0,
    },
  };
}

export const startStreamCapture = defineTool({
  name: 'start_stream_capture',
  description:
    'Ordinary MCP primitive that arms stream capture for the selected page. The deployment must configure --allowedRoots and --streamArtifactRoot; the server allocates the directory. In --toolExposureMode gpt-action this tool is hidden from tools/list because a downstream runBrowserExperiment(capture_flow) backend must own the entire start/action/wait/stop lifecycle.',
  annotations: {
    title: 'Start Stream Capture',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({capture: captureSchema.optional()}),
  schema: {
    urlFilter: zod.string().max(8192).optional(),
    methods: zod.array(zod.enum(HTTP_METHODS)).min(1).max(16).optional(),
    resourceTypes: zod
      .array(zod.enum(RESOURCE_TYPES))
      .min(1)
      .max(32)
      .optional(),
    mimeTypes: zod
      .array(zod.string().trim().min(1).max(256))
      .min(1)
      .max(32)
      .optional(),
  },
  handler: async (request, response, context) => {
    const filter: StreamCaptureFilter = {
      urlFilter: request.params.urlFilter,
      methods: request.params.methods,
      resourceTypes: request.params.resourceTypes,
      mimeTypes: request.params.mimeTypes,
    };
    const capture = await context.startStreamCapture(filter);
    const data = {capture: captureSummary(capture)};
    response.appendResponseLine(
      `Armed stream capture ${capture.id} under artifact root ${capture.artifactRootIndex} at ${capture.relativeDir}.`,
    );
    setValidatedData(response, startDataSchema, data);
  },
});

export const getStreamStatus = defineTool({
  name: 'get_stream_status',
  description:
    'Ordinary MCP primitive that returns bounded status for a global capture ID. It never returns event bodies, credentials, raw bytes, Base64, payload artifacts, or host absolute paths. Full evidence and the complete payload index remain in capture.json and request metadata files.',
  annotations: {
    title: 'Get Stream Capture Status',
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: captureSchema.optional(),
    requests: zod.array(requestSchema).optional(),
    request: requestSchema.optional(),
    recentChunks: zod.array(chunkSchema).max(100).optional(),
    pagination: paginationSchema.optional(),
  }),
  schema: {
    captureId: zod.number().int().positive(),
    requestId: zod.string().max(512).optional(),
    includeRecentChunks: zod.boolean().default(false),
    pageIdx: zod.number().int().min(0).default(0),
    pageSize: zod.number().int().positive().max(100).default(20),
  },
  handler: async (request, response, context) => {
    const capture = context.getStreamCapture(request.params.captureId);
    if (!request.params.requestId) {
      const paged = paginate(
        capture.requests.map(requestSummary),
        request.params.pageIdx,
        request.params.pageSize,
      );
      const data = {
        capture: captureSummary(capture),
        requests: paged.items,
        pagination: paged.pagination,
      };
      response.appendResponseLine(
        `Stream capture ${capture.id} is ${capture.status}/${capture.integrityStatus} with ${capture.requests.length} request(s).`,
      );
      setValidatedData(response, statusDataSchema, data);
      return;
    }
    const streamRequest = capture.requests.find(
      item => item.cdpRequestId === request.params.requestId,
    );
    if (!streamRequest) {
      throw new ToolError(
        'NOT_FOUND',
        `Stream request ${request.params.requestId} was not found in capture ${capture.id}.`,
      );
    }
    const data: Record<string, unknown> = {
      capture: captureSummary(capture),
      request: requestSummary(streamRequest),
    };
    if (request.params.includeRecentChunks) {
      data.recentChunks = streamRequest.recentChunks;
    }
    response.appendResponseLine(
      `Stream request ${streamRequest.cdpRequestId} is ${streamRequest.status}/${streamRequest.integrityStatus}; inspect ${capture.metadataArtifact.artifactId} for the complete artifact index.`,
    );
    setValidatedData(response, statusDataSchema, data);
  },
});

export const stopStreamCapture = defineTool({
  name: 'stop_stream_capture',
  description:
    'Ordinary MCP primitive that stops a global capture ID and waits for activation settlement, queued chunks, network snapshot artifacts, open-file writes, and atomic manifests. It returns only capture.json plus one request metadata artifact per request. In GPT Action deployments this tool is hidden and the backend invokes the collector internally.',
  annotations: {
    title: 'Stop Stream Capture',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
    idempotentHint: true,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: captureSchema.optional(),
    captureMetadataArtifact: artifactSchema.optional(),
    requestMetadataArtifacts: zod.array(artifactSchema).max(200).optional(),
  }),
  schema: {captureId: zod.number().int().positive()},
  handler: async (request, response, context) => {
    const capture = await context.stopStreamCapture(request.params.captureId);
    const requestMetadataArtifacts = capture.requests.flatMap(streamRequest => {
      const artifact = streamRequest.artifacts.find(
        item => item.kind === 'request_metadata',
      );
      return artifact ? [artifact] : [];
    });
    const data = {
      capture: captureSummary(capture),
      captureMetadataArtifact: capture.metadataArtifact,
      requestMetadataArtifacts,
    };
    response.appendResponseLine(
      `Finalized stream capture ${capture.id} as ${capture.status}/${capture.integrityStatus}; the complete artifact index is in ${capture.metadataArtifact.artifactId}.`,
    );
    setValidatedData(response, stopDataSchema, data);
  },
});
