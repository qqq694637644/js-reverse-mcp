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

const failureSchema = zod
  .object({
    errorText: zod.string().max(4096),
    canceled: zod.boolean(),
    blockedReason: zod.string().max(256).optional(),
    code: zod
      .enum(['DISK_QUOTA_EXCEEDED', 'PAGE_CLOSED', 'STREAM_ERROR'])
      .optional(),
  })
  .strict();

const truncationSchema = zod
  .object({
    truncatedAt: zod.number(),
    reason: zod.literal('disk_quota_exceeded'),
    quotaBytes: zod.number().int().nonnegative(),
    droppedChunkCount: zod.number().int().nonnegative(),
    droppedBytes: zod.number().int().nonnegative(),
  })
  .strict();

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

const chunkOffsetSchema = zod
  .object({
    index: zod.number().int().nonnegative(),
    timestamp: zod.number(),
    dataLength: zod.number().int().nonnegative(),
    encodedDataLength: zod.number().nonnegative(),
    payloadBytes: zod.number().int().nonnegative(),
    source: zod.enum(['buffered', 'network']),
    fileOffsetStart: zod.number().int().nonnegative(),
    fileOffsetEnd: zod.number().int().nonnegative(),
    eventIndexes: zod.array(zod.number().int().nonnegative()).max(1000),
  })
  .strict();

const eventSummarySchema = zod
  .object({
    index: zod.number().int().nonnegative(),
    recordType: zod.enum(['event', 'heartbeat']),
    eventName: zod.string().max(256).optional(),
    done: zod.boolean(),
    timestamp: zod.number().optional(),
    source: zod.enum(['raw-stream', 'eventsource']),
    dataLength: zod.number().int().nonnegative(),
    payloadCount: zod.number().int().nonnegative(),
  })
  .strict();

const requestSummarySchema = zod
  .object({
    requestId: zod.string().max(512),
    requestIndex: zod.number().int().nonnegative(),
    url: zod.string().max(8192),
    method: zod.string().max(32),
    resourceType: zod.string().max(128).optional(),
    mimeType: zod.string().max(256).optional(),
    status: zod.enum([
      'activating',
      'streaming',
      'finished',
      'stopped',
      'failed',
    ]),
    startedAt: zod.number(),
    endedAt: zod.number().optional(),
    failure: failureSchema.optional(),
    streamResourceContentEnabled: zod.boolean(),
    streamResourceContentError: zod.string().max(4096).optional(),
    relativeDir: zod.string().max(4096),
    chunkCount: zod.number().int().nonnegative(),
    rawEventCount: zod.number().int().nonnegative(),
    semanticEventCount: zod.number().int().nonnegative(),
    primaryEventSource: zod.enum(['raw-stream', 'eventsource', 'none']),
    doneMarkerObserved: zod.boolean(),
    parseErrors: zod.number().int().nonnegative(),
    incompleteTailChars: zod.number().int().nonnegative(),
    rawBytes: zod.number().int().nonnegative(),
    diskBytesReserved: zod.number().int().nonnegative(),
    truncation: truncationSchema.optional(),
    artifactCount: zod.number().int().nonnegative(),
    coreArtifacts: zod.array(artifactSchema).max(16),
    recentRawEvents: zod.array(eventSummarySchema).max(20),
    recentSemanticEvents: zod.array(eventSummarySchema).max(20),
    writeErrors: zod.array(zod.string().max(4096)).max(100),
  })
  .strict();

const captureSummarySchema = zod
  .object({
    captureId: zod.number().int().positive(),
    status: zod.enum(['armed', 'capturing', 'stopped', 'failed']),
    filter: zod
      .object({
        urlFilter: zod.string().max(8192).optional(),
        methods: zod.array(zod.string().max(32)).max(16).optional(),
        resourceTypes: zod.array(zod.string().max(128)).max(32).optional(),
        mimeTypes: zod.array(zod.string().max(256)).max(32).optional(),
      })
      .strict(),
    artifactRootIndex: zod.number().int().nonnegative(),
    relativeDir: zod.string().max(4096),
    metadataArtifact: artifactSchema,
    pageUrl: zod.string().max(8192),
    pageTitle: zod.string().max(2048).optional(),
    createdAt: zod.number(),
    stoppedAt: zod.number().optional(),
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

function captureSummary(capture: StreamCapture) {
  return {
    captureId: capture.id,
    status: capture.status,
    filter: capture.filter,
    artifactRootIndex: capture.artifactRootIndex,
    relativeDir: capture.relativeDir,
    metadataArtifact: capture.metadataArtifact,
    pageUrl: capture.pageUrl,
    pageTitle: capture.pageTitle,
    createdAt: capture.createdAt,
    stoppedAt: capture.stoppedAt,
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

function requestSummary(request: StreamRequest) {
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
    artifactCount: request.artifacts.length,
    coreArtifacts: request.artifacts.filter(
      artifact => artifact.kind !== 'payload',
    ),
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

const BANNED_STREAM_OUTPUT_KEYS = new Set([
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
    for (const [index, item] of value.entries()) {
      assertSafeStreamToolOutput(item, `${path}[${index}]`);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (BANNED_STREAM_OUTPUT_KEYS.has(key)) {
      throw new ToolError(
        'INTERNAL',
        `Stream tool output contains forbidden field ${path}.${key}.`,
      );
    }
    assertSafeStreamToolOutput(item, `${path}.${key}`);
  }
}

function setSafeStructuredContent(
  response: {setStructuredContent(value: Record<string, unknown>): void},
  value: Record<string, unknown>,
): void {
  assertSafeStreamToolOutput(value);
  response.setStructuredContent(value);
}

export const startStreamCapture = defineTool({
  name: 'start_stream_capture',
  description:
    'Arm streaming HTTP capture for the selected page. The server requires --allowedRoots, allocates a globally unique directory under the first allowed root, decodes CDP Base64 internally, and returns only an opaque capture ID plus workspace-relative artifact metadata. Application code should orchestrate start, browser action, wait, and stop atomically; do not expose this sequence as separate user-managed GPT Actions.',
  annotations: {
    title: 'Start Stream Capture',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: captureSummarySchema.optional(),
  }),
  schema: {
    urlFilter: zod
      .string()
      .max(8192)
      .optional()
      .describe('Only capture response URLs containing this substring.'),
    methods: zod
      .array(zod.enum(HTTP_METHODS))
      .max(16)
      .optional()
      .describe('Optional HTTP method filter, such as ["POST"].'),
    resourceTypes: zod
      .array(zod.enum(RESOURCE_TYPES))
      .max(32)
      .optional()
      .describe(
        'Optional CDP/Playwright resource-type filter, such as ["fetch","eventsource"].',
      ),
    mimeTypes: zod
      .array(zod.string().trim().min(1).max(256))
      .max(32)
      .optional()
      .describe(
        'Response MIME prefixes to capture. Defaults to ["text/event-stream"].',
      ),
  },
  handler: async (request, response, context) => {
    const filter: StreamCaptureFilter = {
      urlFilter: request.params.urlFilter,
      methods: request.params.methods,
      resourceTypes: request.params.resourceTypes,
      mimeTypes: request.params.mimeTypes,
    };
    const capture = await context.startStreamCapture(filter);
    const structured = {capture: captureSummary(capture)};
    response.appendResponseLine(
      `Armed stream capture ${capture.id}; artifacts will be written under allowed root ${capture.artifactRootIndex} at ${capture.relativeDir}.`,
    );
    setSafeStructuredContent(response, structured);
  },
});

export const getStreamStatus = defineTool({
  name: 'get_stream_status',
  description:
    'Inspect bounded status for a global stream capture ID, independent of the currently selected page. It returns capture/request summaries, workspace-relative artifact paths, bounded recent event summaries, and optionally bounded recent chunk offsets. It never returns event bodies, raw bytes, Base64, or operating-system absolute paths.',
  annotations: {
    title: 'Get Stream Capture Status',
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: captureSummarySchema.optional(),
    requests: zod.array(requestSummarySchema).optional(),
    request: requestSummarySchema.optional(),
    recentChunks: zod.array(chunkOffsetSchema).max(100).optional(),
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
    const captureData = captureSummary(capture);
    if (!request.params.requestId) {
      const {items, pagination} = paginate(
        capture.requests.map(requestSummary),
        request.params.pageIdx,
        request.params.pageSize,
      );
      const structured = {
        capture: captureData,
        requests: items,
        pagination,
      };
      response.appendResponseLine(
        `Stream capture ${capture.id} is ${capture.status} with ${capture.requests.length} matched request${capture.requests.length === 1 ? '' : 's'}.`,
      );
      setSafeStructuredContent(response, structured);
      return;
    }

    const streamRequest = capture.requests.find(
      item => item.requestId === request.params.requestId,
    );
    if (!streamRequest) {
      throw new ToolError(
        'NOT_FOUND',
        `Stream request ${request.params.requestId} was not found in capture ${capture.id}.`,
      );
    }
    const structured: Record<string, unknown> = {
      capture: captureData,
      request: requestSummary(streamRequest),
    };
    if (request.params.includeRecentChunks) {
      structured.recentChunks = streamRequest.recentChunks;
    }
    response.appendResponseLine(
      `Stream request ${streamRequest.requestId} is ${streamRequest.status}; inspect artifact ${capture.metadataArtifact.artifactId} or workspace-relative files for full evidence.`,
    );
    setSafeStructuredContent(response, structured);
  },
});

export const stopStreamCapture = defineTool({
  name: 'stop_stream_capture',
  description:
    'Stop a global stream capture ID regardless of the currently selected page. The call waits for streamResourceContent activation, queued chunks, incremental parsing, artifact writes, and atomic metadata finalization. It returns the final capture summary plus a bounded artifact index; the complete index is in capture.json.',
  annotations: {
    title: 'Stop Stream Capture',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
    idempotentHint: true,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: captureSummarySchema.optional(),
    artifacts: zod.array(artifactSchema).max(200).optional(),
    artifactCount: zod.number().int().nonnegative().optional(),
    artifactsTruncated: zod.boolean().optional(),
  }),
  schema: {
    captureId: zod.number().int().positive(),
  },
  handler: async (request, response, context) => {
    const capture = await context.stopStreamCapture(request.params.captureId);
    const allArtifacts: StreamArtifactFile[] = [
      capture.metadataArtifact,
      ...capture.requests.flatMap(item => item.artifacts),
    ];
    const artifacts = allArtifacts.slice(0, 200);
    const structured = {
      capture: captureSummary(capture),
      artifacts,
      artifactCount: allArtifacts.length,
      artifactsTruncated: allArtifacts.length > artifacts.length,
    };
    response.appendResponseLine(
      `Finalized stream capture ${capture.id}; ${allArtifacts.length} artifact${allArtifacts.length === 1 ? '' : 's'} are indexed by ${capture.metadataArtifact.artifactId}.`,
    );
    setSafeStructuredContent(response, structured);
  },
});
