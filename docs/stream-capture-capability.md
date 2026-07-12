# Streaming HTTP Capture Capability

## Purpose

Ordinary network inspection is sufficient only after Chromium still retains a completed response body. Long-lived `fetch`, XHR, and EventSource streams need a collector that is active while bytes arrive. `Network.streamResourceContent` supplies bytes received before activation as `bufferedData` and supplies later bytes through `Network.dataReceived.data`; the collector must preserve that ordering and must not depend on a later `getResponseBody` call.

This capability is one collector lifecycle primitive represented by three ordinary MCP operations:

```text
start_stream_capture
get_stream_status
stop_stream_capture
```

They are lifecycle operations for one collector, not three protocol-analysis variants.

## Exposure modes

### Ordinary MCP

`--toolExposureMode mcp` exposes the three lifecycle operations. A capable MCP client may coordinate them directly.

### GPT Action

`--toolExposureMode gpt-action` removes all three lifecycle operations from `tools/list`.

The GPT Action backend must expose one higher-level operation such as:

```text
runBrowserExperiment(operation = capture_flow)
```

The backend owns this complete sequence:

```text
allocate experiment directory
→ select and align the browser page
→ start internal stream capture
→ execute the Playwright flow
→ wait for completion, cancellation, or failure
→ stop and finalize capture
→ write the experiment manifest
→ return only evidence IDs and workspace-relative paths
```

GPT must not coordinate start, page action, wait, and stop as separate Action calls. This repository supplies the internal collector and deployment exposure switch; the downstream Action repository owns the atomic `capture_flow` OpenAPI contract and its contract test.

## Workspace ownership

The deployment must configure both:

```text
--allowedRoots <workspace-root>
--streamArtifactRoot <allowed-root-index-or-exact-root-path>
```

`streamArtifactRoot` is deployment configuration and is never a model argument. `js-reverse-mcp` and the downstream workspace file tools must see the same directory contents, either through the same filesystem or an explicit container volume mapping.

MCP responses contain only:

```text
allowed-root index
workspace-relative path
opaque artifact ID
bounded status and counters
```

They never contain host absolute paths, stream bodies, request bodies, credentials, or CDP Base64.

The experiment owner is responsible for retention and cleanup. `js-reverse-mcp` creates capture artifacts but does not delete completed evidence automatically.

## Capture artifacts

Each capture contains `capture.json`. Each matched request contains:

```text
metadata.json
raw.bin
raw.sse
chunks.jsonl
events.jsonl
eventsource.jsonl
request-headers.json
request-body.bin
response-headers.json
initiator.json
redirects.json
payloads/*
```

The minimum request-replay evidence set is:

```text
cdpRequestId
networkRequestId / reqid when correlation is available
request headers artifact
request body artifact
response status and headers artifact
redirect chain artifact
initiator artifact
raw stream artifact
parsed event artifact
```

Sensitive material remains in workspace files and is not returned through MCP structured content.

## Time model

CDP event timestamps use a monotonic clock. Request start also includes a wall-clock value. The collector records both explicitly:

```text
monotonicTimeSeconds
wallTimeMs
```

The `requestWillBeSent.wallTime` and `requestWillBeSent.timestamp` pair establishes the conversion offset used for later chunk and terminal events. The manifest does not use ambiguous generic `timestamp`, `startedAt`, or `endedAt` fields.

## Activation and ordering

For every request:

1. Call `Network.streamResourceContent`.
2. Queue `dataReceived` chunks until activation settles.
3. Process `bufferedData` first.
4. Release queued chunks in arrival order.
5. Finalize only after activation, queued chunks, writes, and metadata complete.

Activation has an internal timeout. Pending bytes have a separate in-memory limit. Stop, page close, and shutdown can abort activation, after which a final manifest is still written.

## Completion and integrity matrix

`request.status` describes the network/lifecycle terminal state. `integrityStatus` describes evidence completeness. They are intentionally separate.

| Situation                                                                                      | Request status           | Terminal reason                            | Integrity       |
| ---------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------ | --------------- |
| Raw fetch/XHR stream captured and all core artifacts written                                   | `finished`               | `completed`                                | `complete`      |
| Expected user stop causes CDP cancellation but captured evidence is complete                   | `canceled`               | `user_cancel`                              | `complete`      |
| Native EventSource raw activation fails, but semantic mirror events are saved                  | `finished` or `canceled` | network terminal reason                    | `semantic-only` |
| Raw bytes exist but parser degrades, supporting artifact fails, or a noncritical payload fails | network terminal state   | network terminal reason                    | `partial`       |
| Fetch/XHR activation fails or times out                                                        | `failed`                 | `activation_error` or `activation_timeout` | `failed`        |
| Pending activation memory limit is exceeded                                                    | `failed`                 | `pending_limit`                            | `failed`        |
| Core artifact initialization/write fails                                                       | `failed`                 | `artifact_error`                           | `failed`        |
| Disk quota is exceeded                                                                         | `failed`                 | `quota`                                    | `failed`        |
| Page closes before finalization                                                                | `failed`                 | `page_close`                               | `failed`        |
| Shutdown cannot finalize within its deadline                                                   | `failed`                 | `shutdown_timeout`                         | `failed`        |

A downstream Action may treat `canceled/user_cancel` as the expected result of a stop-generation experiment. It must not treat `semantic-only`, `partial`, or `failed` as equivalent to `complete` when validating raw SSE capture.

## Parser degradation

The semantic parser is a bounded byte-oriented line state machine. It supports BOM, `LF`, `CRLF`, `CR`, and mixed line endings. Every event records raw byte offsets, decoded character offsets, first/last chunk indexes, and first/completed times.

If one event or an incomplete tail exceeds the configured parser limit, semantic parsing becomes `degraded` while `raw.bin`, chunk offsets, and subsequent collector metadata continue to be preserved. Invalid UTF-8 is recorded and replacement decoding is limited to the readable `raw.sse`/event representation; exact bytes remain in `raw.bin`.

## Resource limits

The collector applies explicit limits for:

```text
disk bytes per capture
activation duration
pending activation bytes
SSE event / incomplete-tail bytes
requests per capture
artifacts per capture
payloads per request
events per request
metadata bytes
shutdown finalization time
```

Limits never silently convert an incomplete capture into a normal successful result. The manifest records the limit, reason, time, and dropped counts where applicable.
