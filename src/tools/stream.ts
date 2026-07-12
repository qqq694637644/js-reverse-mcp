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

function captureSummary(capture: StreamCapture) {
  return {
    captureId: capture.id,
    status: capture.status,
    filter: capture.filter,
    outputDir: capture.outputDir,
    metadataFile: capture.metadataFile,
    createdAt: capture.createdAt,
    stoppedAt: capture.stoppedAt,
    requestCount: capture.requests.length,
    totalBytes: capture.totalBytes,
    totalChunks: capture.totalChunks,
    totalEvents: capture.totalEvents,
    truncated: capture.truncated,
    writeErrors: capture.writeErrors,
    version: capture.version,
  };
}

function requestSummary(request: StreamRequest) {
  const primaryEventsFile =
    request.eventCount > 0
      ? request.files.find(file => file.kind === 'events')?.path
      : request.files.find(file => file.kind === 'eventsource_events')?.path;
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
    outputDir: request.outputDir,
    chunkCount: request.chunks.length,
    eventCount: request.eventCount,
    eventSourceMessageCount: request.eventSourceMessageCount,
    doneMarkerObserved: request.doneMarkerObserved,
    parseErrors: request.parseErrors,
    incompleteTailChars: request.incompleteTailChars,
    totalBytes: request.totalBytes,
    primaryEventsFile,
    files: request.files,
    recentEvents: request.recentEvents,
    writeErrors: request.writeErrors,
  };
}

function findRequest(capture: StreamCapture, requestId: string): StreamRequest {
  const request = capture.requests.find(item => item.requestId === requestId);
  if (!request) {
    throw new ToolError(
      'NOT_FOUND',
      `Stream request ${requestId} was not found in capture ${capture.id}`,
    );
  }
  return request;
}

function paginate<T>(items: T[], pageIdx = 0, pageSize = 100) {
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

function uniqueArtifacts(files: StreamArtifactFile[]): StreamArtifactFile[] {
  return [...new Map(files.map(file => [file.path, file])).values()];
}

export const startStreamCapture = defineTool({
  name: 'start_stream_capture',
  description:
    'Arm streaming HTTP response capture for the selected page before reproducing an action. CDP Base64 is decoded immediately and written under outputDir as raw bytes, decoded SSE text, chunk JSONL, event JSONL, metadata, and extracted binary payload files. The output directory must not already exist and is subject to --allowedRoots. No large Base64 or event body is returned through MCP.',
  annotations: {
    title: 'Start Stream Capture',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: zod.record(zod.string(), zod.unknown()).optional(),
  }),
  schema: {
    outputDir: zod
      .string()
      .trim()
      .min(1)
      .describe(
        'New directory for capture files. It must not already exist and is subject to --allowedRoots.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe('Only capture response URLs containing this substring.'),
    methods: zod
      .array(zod.enum(HTTP_METHODS))
      .optional()
      .describe('Optional HTTP method filter, such as ["POST"].'),
    resourceTypes: zod
      .array(zod.enum(RESOURCE_TYPES))
      .optional()
      .describe(
        'Optional CDP/Playwright resource-type filter, such as ["fetch","eventsource"].',
      ),
    mimeTypes: zod
      .array(zod.string().trim().min(1))
      .optional()
      .describe(
        'Response MIME prefixes to capture. Defaults to ["text/event-stream"]. Pass explicit values for NDJSON or another streaming format.',
      ),
  },
  handler: async (request, response, context) => {
    const filter: StreamCaptureFilter = {
      urlFilter: request.params.urlFilter,
      methods: request.params.methods,
      resourceTypes: request.params.resourceTypes,
      mimeTypes: request.params.mimeTypes,
    };
    const capture = await context.startStreamCapture(
      filter,
      request.params.outputDir,
    );
    response.appendResponseLine(
      `Armed stream capture ${capture.id}; decoded evidence will be written under ${capture.outputDir}.`,
    );
    response.setStructuredContent({capture: captureSummary(capture)});
  },
});

export const getStreamStatus = defineTool({
  name: 'get_stream_status',
  description:
    'Inspect small status and file-index metadata for a streaming capture. It never returns CDP Base64 or full SSE event bodies. Without requestId it lists matched requests. With requestId it returns request status, artifact paths, recent event summaries, and optionally paginated chunk offsets/timing. Read events.jsonl, raw.sse, or payload files with local workspace tools.',
  annotations: {
    title: 'Get Stream Capture Status',
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: zod.record(zod.string(), zod.unknown()).optional(),
    requests: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    request: zod.record(zod.string(), zod.unknown()).optional(),
    chunks: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    pagination: zod.record(zod.string(), zod.unknown()).optional(),
  }),
  schema: {
    captureId: zod.number().int().positive(),
    requestId: zod
      .string()
      .optional()
      .describe(
        'CDP requestId from the capture request list. Omit to list matched requests.',
      ),
    includeChunks: zod
      .boolean()
      .default(false)
      .describe(
        'Return paginated chunk timing and raw.bin byte offsets. Chunk payload bytes are never returned.',
      ),
    pageIdx: zod.number().int().min(0).default(0),
    pageSize: zod.number().int().positive().max(500).default(100),
  },
  handler: async (request, response, context) => {
    const capture = context.getStreamCapture(request.params.captureId);
    const summary = captureSummary(capture);
    if (!request.params.requestId) {
      const {items, pagination} = paginate(
        capture.requests.map(requestSummary),
        request.params.pageIdx,
        request.params.pageSize,
      );
      response.appendResponseLine(
        `Stream capture ${capture.id} contains ${capture.requests.length} matched request${capture.requests.length === 1 ? '' : 's'}; evidence is stored under ${capture.outputDir}.`,
      );
      response.setStructuredContent({
        capture: summary,
        requests: items,
        pagination,
      });
      return;
    }

    const streamRequest = findRequest(capture, request.params.requestId);
    const structured: Record<string, unknown> = {
      capture: summary,
      request: requestSummary(streamRequest),
    };
    if (request.params.includeChunks) {
      const paged = paginate(
        streamRequest.chunks,
        request.params.pageIdx,
        request.params.pageSize,
      );
      structured.chunks = paged.items;
      structured.pagination = paged.pagination;
    }
    response.appendResponseLine(
      `Stream request ${streamRequest.requestId} is ${streamRequest.status}; ${streamRequest.eventCount} parsed event${streamRequest.eventCount === 1 ? '' : 's'} and ${streamRequest.chunks.length} chunk record${streamRequest.chunks.length === 1 ? '' : 's'} are available in ${streamRequest.outputDir}.`,
    );
    response.setStructuredContent(structured);
  },
});

export const stopStreamCapture = defineTool({
  name: 'stop_stream_capture',
  description:
    'Stop an armed stream capture, flush incremental UTF-8/SSE parsing, and finalize request/capture metadata files. This does not cancel the browser request. Use after completion, failure, cancellation, or the desired partial-stream state has been observed.',
  annotations: {
    title: 'Stop Stream Capture',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
    idempotentHint: true,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: zod.record(zod.string(), zod.unknown()).optional(),
  }),
  schema: {
    captureId: zod.number().int().positive(),
  },
  handler: async (request, response, context) => {
    const capture = await context.stopStreamCapture(request.params.captureId);
    response.appendResponseLine(
      `Stopped stream capture ${capture.id} and finalized files under ${capture.outputDir}.`,
    );
    response.setStructuredContent({capture: captureSummary(capture)});
  },
});

export const exportStreamCapture = defineTool({
  name: 'export_stream_capture',
  description:
    'Flush current streaming evidence to disk and return only the artifact file index. Raw bytes, SSE text, JSONL events, chunk metadata, and extracted binary payloads are already stored under the capture output directory; this tool never returns their contents or Base64 through MCP.',
  annotations: {
    title: 'Export Stream Capture File Index',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
    idempotentHint: true,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: zod.record(zod.string(), zod.unknown()).optional(),
    artifacts: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
  }),
  schema: {
    captureId: zod.number().int().positive(),
    requestId: zod
      .string()
      .optional()
      .describe(
        'Optional requestId to return only files for one matched stream request.',
      ),
  },
  handler: async (request, response, context) => {
    const capture = await context.flushStreamCapture(request.params.captureId);
    let artifacts: StreamArtifactFile[] = [
      {kind: 'capture_metadata', path: capture.metadataFile},
    ];
    if (request.params.requestId) {
      artifacts.push(...findRequest(capture, request.params.requestId).files);
    } else {
      artifacts.push(...capture.requests.flatMap(item => item.files));
    }
    artifacts = uniqueArtifacts(artifacts);
    response.appendResponseLine(
      `Flushed stream capture ${capture.id}; ${artifacts.length} artifact file${artifacts.length === 1 ? '' : 's'} are available under ${capture.outputDir}.`,
    );
    response.setStructuredContent({
      capture: captureSummary(capture),
      artifacts,
    });
  },
});
