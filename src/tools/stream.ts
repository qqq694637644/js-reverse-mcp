/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';

import type {
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
    createdAt: capture.createdAt,
    stoppedAt: capture.stoppedAt,
    requestCount: capture.requests.length,
    totalBytes: capture.totalBytes,
    totalChunks: capture.totalChunks,
    truncated: capture.truncated,
    version: capture.version,
  };
}

function requestSummary(request: StreamRequest) {
  return {
    requestId: request.requestId,
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
    eventSourceMessageCount: request.eventSourceMessages.length,
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

export const startStreamCapture = defineTool({
  name: 'start_stream_capture',
  description:
    'Arm streaming HTTP response capture for the selected page before reproducing an action. It uses Network.streamResourceContent so fetch/XHR text-event-stream bytes are retained during delivery, and also records native EventSource messages. Only one capture may be active per selected page. The default MIME filter is text/event-stream; narrow with URL, method, resource type, or MIME filters. Follow with get_stream_chunks, then stop_stream_capture.',
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
    const capture = context.startStreamCapture(filter);
    response.appendResponseLine(
      `Armed stream capture ${capture.id} for the selected page.`,
    );
    response.setStructuredContent({capture: captureSummary(capture)});
  },
});

export const getStreamChunks = defineTool({
  name: 'get_stream_chunks',
  description:
    'Inspect a previously armed streaming-response capture. Without requestId it lists matched streaming requests. With requestId it returns parsed SSE events, raw chunk metadata, or both. Parsed events preserve order and identify [DONE]; native EventSource messages are used as a fallback when raw bytes are unavailable. Exact bytes should be exported with export_stream_capture.',
  annotations: {
    title: 'Inspect Stream Capture',
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    capture: zod.record(zod.string(), zod.unknown()).optional(),
    requests: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    request: zod.record(zod.string(), zod.unknown()).optional(),
    events: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    chunks: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    incompleteTail: zod.string().optional(),
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
    view: zod
      .enum(['events', 'chunks', 'all'])
      .default('events')
      .describe(
        'With requestId, return parsed SSE events, raw chunk metadata, or both.',
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
        `Stream capture ${capture.id} contains ${capture.requests.length} matched request${capture.requests.length === 1 ? '' : 's'}.`,
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

    if (request.params.view === 'events' || request.params.view === 'all') {
      const parsed = context.getStreamSseEvents(streamRequest);
      const {items, pagination} = paginate(
        parsed.events,
        request.params.pageIdx,
        request.params.pageSize,
      );
      structured.events = items;
      structured.incompleteTail = parsed.incompleteTail;
      structured.pagination = pagination;
    }

    if (request.params.view === 'chunks' || request.params.view === 'all') {
      const chunks = streamRequest.chunks.map(chunk => ({
        index: chunk.index,
        requestId: chunk.requestId,
        timestamp: chunk.timestamp,
        dataLength: chunk.dataLength,
        encodedDataLength: chunk.encodedDataLength,
        payloadBytes: chunk.payloadBytes,
        source: chunk.source,
        hasData: Boolean(chunk.dataBase64),
      }));
      const paged = paginate(
        chunks,
        request.params.pageIdx,
        request.params.pageSize,
      );
      structured.chunks = paged.items;
      structured.pagination = paged.pagination;
    }

    response.appendResponseLine(
      `Stream request ${streamRequest.requestId} is ${streamRequest.status} with ${streamRequest.chunks.length} retained chunk${streamRequest.chunks.length === 1 ? '' : 's'}.`,
    );
    response.setStructuredContent(structured);
  },
});

export const stopStreamCapture = defineTool({
  name: 'stop_stream_capture',
  description:
    'Stop an armed stream capture for the selected page. This freezes the retained bytes and semantic events but does not cancel the browser request. Call after the reproduced action has completed or after the desired cancellation/error state was observed.',
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
    const capture = context.stopStreamCapture(request.params.captureId);
    response.appendResponseLine(`Stopped stream capture ${capture.id}.`);
    response.setStructuredContent({capture: captureSummary(capture)});
  },
});

export const exportStreamCapture = defineTool({
  name: 'export_stream_capture',
  description:
    'Export exact retained streaming-response evidence to a local file. Use format="raw" for the concatenated response bytes of one request, or format="json" for capture metadata, chunk base64, EventSource messages, and parsed SSE events. Subject to --allowedRoots.',
  annotations: {
    title: 'Export Stream Capture',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  capabilities: ['stream'],
  outputSchema: createToolOutputSchema({
    export: zod.record(zod.string(), zod.unknown()).optional(),
  }),
  schema: {
    captureId: zod.number().int().positive(),
    requestId: zod
      .string()
      .optional()
      .describe(
        'Required for raw export when a capture contains multiple requests. Optional for JSON export.',
      ),
    format: zod.enum(['raw', 'json']).default('json'),
    outputFile: zod.string().min(1),
    confirmOverwrite: zod.boolean().default(false),
  },
  handler: async (request, response, context) => {
    const capture = context.getStreamCapture(request.params.captureId);
    let data: Buffer;
    let requestId = request.params.requestId;

    if (request.params.format === 'raw') {
      if (!requestId && capture.requests.length === 1) {
        requestId = capture.requests[0].requestId;
      }
      if (!requestId) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          'Raw export requires requestId when the capture does not contain exactly one request.',
        );
      }
      const streamRequest = findRequest(capture, requestId);
      data = Buffer.from(context.getStreamRawBody(streamRequest));
    } else {
      const bundle = {
        capture: captureSummary(capture),
        requests: capture.requests.map(streamRequest => ({
          ...requestSummary(streamRequest),
          chunks: streamRequest.chunks,
          eventSourceMessages: streamRequest.eventSourceMessages,
          parsedSse: context.getStreamSseEvents(streamRequest),
        })),
      };
      data = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
    }

    const file = await context.saveFile(data, request.params.outputFile, {
      confirmOverwrite: request.params.confirmOverwrite,
    });
    response.appendResponseLine(
      `Exported stream capture ${capture.id} (${data.length} bytes) to ${file.filename}.`,
    );
    response.setStructuredContent({
      export: {
        captureId: capture.id,
        requestId,
        format: request.params.format,
        filename: file.filename,
        byteLength: data.length,
      },
    });
  },
});
