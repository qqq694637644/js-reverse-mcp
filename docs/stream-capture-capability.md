# Streaming HTTP Capture Capability

## Role in the overall system

`js-reverse-mcp` is a private browser-analysis dependency. It always registers these three MCP lifecycle primitives:

```text
start_stream_capture
get_stream_status
stop_stream_capture
```

A higher-level service such as `web_rev_action` connects to the ordinary MCP server with a private client and an adapter allowlist. GPT never receives the MCP `tools/list`; it sees only the higher-level Action OpenAPI, especially the atomic operation:

```text
runBrowserExperiment(operation = capture_flow)
```

The Action backend owns:

```text
allocate experiment
→ align the page
→ start stream capture
→ run the Playwright flow
→ wait for an experiment condition
→ stop/finalize capture
→ write the experiment manifest
```

Do not ask GPT to coordinate start, click, wait, and stop as separate Action calls.

## Experiment directory ownership

The deployment configures:

```text
--allowedRoots <workspace-root>
--streamArtifactRoot <allowed-root-index-or-exact-root-path>
```

A private backend may pass a constrained `artifactNamespace`, producing:

```text
experiments/<artifactNamespace>/js-reverse/capture-<uuid>/
```

This is not an arbitrary output path. Every namespace segment is validated and resolved below the configured root. Deployments without an experiment namespace use `js-reverse-streams/capture-<uuid>/`.

One LocalEvidenceStore root per MCP process is the simplest deployment. A shared MCP process must use a distinct namespace per experiment/session and keep the selected artifact root visible to the same Action backend. No GitHub Gateway workspace is implied.

## Capture boundary

The current collector is explicit about its scope:

```text
captureScope = page-target-only
workerCoverage = false
```

It records page requests, frame/loader IDs, `fromServiceWorker`, and initiator evidence when CDP supplies them. It does not claim Target auto-attach coverage for worker or service-worker sessions. A higher-level capture-health report must surface this limitation.

## Pre-arm request isolation

Every page has a collector generation. Arming a capture advances the generation.

By default:

```text
includeInFlight = false
```

Requests started in an older generation are excluded even when their response arrives after capture start. A private backend may explicitly set `includeInFlight=true` when it needs to observe an already-running request. Every captured request records:

```text
collectorGeneration
requestStartedBeforeCapture
captureArmedMonotonicTimeSeconds
```

## Requests without a response

A matching request candidate is retained from `Network.requestWillBeSent`. DNS, TLS, CORS, blocking, navigation cancellation, connection failure, and similar failures can therefore produce evidence even when `Network.responseReceived` never arrives.

Each request records:

```text
responseObserved
streamActivationAttempted
failurePhase = before-response | activation | streaming | finalize
```

Raw stream activation is attempted only after a matching response with an allowed MIME type is observed.

## Raw stream ordering and deadlines

For each response:

1. Call `Network.streamResourceContent`.
2. Queue `Network.dataReceived` chunks while activation is pending.
3. Write returned `bufferedData` first.
4. Release queued chunks in arrival order.
5. Finalize only after activation, network snapshot collection, queued writes, and metadata.

Activation has an internal timeout and bounded pending memory. `stop_stream_capture` accepts a propagated AbortSignal and a wall-clock deadline. When finalization is interrupted, it aborts activation, closes open handles, writes best-effort request/capture manifests, and marks the request `finalize_timeout` instead of waiting for an abandoned filesystem or CDP operation indefinitely.

## Artifact files

A request directory can contain:

```text
metadata.json
raw.bin
decoded.sse
chunks.jsonl
events.jsonl
eventsource.jsonl
request-headers.json
request-headers-extra.json
request-headers.redacted.json
request-body.txt
request-body.meta.json
response-headers.json
response-headers-extra.json
response-headers.redacted.json
initiator.json
redirects.json
payloads/*
```

`raw.bin` is the exact captured byte sequence. `decoded.sse` is a UTF-8 reading aid and may contain replacement characters for invalid UTF-8. Precise offsets always refer to `raw.bin`.

`request-body.txt` is not wire bytes. Its metadata states:

```text
encoding = utf-8
captureSource = cdp-postData-utf8
wireBytes = false
bodyCompleteness = complete | partial | none | unknown
```

## Request and header completeness

The collector saves ordinary CDP fields and queues every ExtraInfo event by redirect hop:

```text
Network.requestWillBeSent request.headers
Network.requestWillBeSentExtraInfo headers and associatedCookies
Network.responseReceived response.headers
Network.responseReceivedExtraInfo headers/status/blockedCookies
```

A request records:

```text
headersCompleteness
bodyCompleteness
requestSnapshotIntegrity
replayReadiness
```

Finalize waits for expected ExtraInfo with a bounded deadline. Late ExtraInfo received immediately before `loadingFinished` is included in the final snapshot. `requestSnapshotIntegrity` uses the weakest headers/body dimension: complete headers plus a partial `cdp-postData` body remains partial, while a body-less request can be complete. `replayReadiness` separately reports `ready`, `partial`, or `not-ready`. Multipart, file, binary, or omitted post data must not be described as exact body bytes.

## Collector-side event predicates

`get_stream_status` can receive:

```text
eventPredicate = exact_data | event_name | json_path_equals
afterEventIndex
requestId (optional)
```

The collector scans the complete on-disk `events.jsonl` / `eventsource.jsonl` sequence. It does not depend on bounded recent-event summaries, so a target remains matchable after dozens of later events. MCP returns only:

```text
matched
matchedEventIndex
matchedRequestId
matchedSource
```

The matching event body is not returned through MCP.

Every state change visible to `get_stream_status` increments `capture.version`, including semantic-only EventSource events, parsed SSE completion, terminal transitions, parser degradation, request finalize, artifact/integrity changes, and capture stop/failure.

## Credential artifacts

Full request/response header artifacts may contain Cookie, Authorization, CSRF, or Set-Cookie data. Their descriptors include:

```text
sensitivity = credential
containsCredentials = true
redactedArtifactId = <public redacted artifact>
```

Default report, search, diff, and natural-language paths should use the redacted artifact. Full credential artifacts are for explicit local replay operations and should not be copied into GPT summaries or logs.

## Persistent identifiers

The numeric `captureId` is a short-lived MCP handle. Persistent artifact identifiers use a capture UUID:

```text
art_stream_<capture-uuid>_<request-index>_<kind>
```

Each request also records:

```text
persistentRequestId
cdpRequestId
networkRequestId
networkRequestIdLifetime = page-collector-generation
collectorGeneration
```

`networkRequestId` is only a temporary correlation to `list_network_requests`. A higher-level experiment manifest must generate its own stable `evidence_id`.

## Network terminal semantics

The collector reports neutral transport/lifecycle facts. A canceled CDP request becomes:

```text
status = canceled
terminalReason = network_canceled
```

The collector does not infer that the user clicked Stop. `web_rev_action` may classify a cancellation as `expected_user_cancel` only after correlating the Playwright Stop step, time window, page, and target request.

## Completion predicates

The parser records a convenience field:

```text
defaultDoneMarker = (trimmed event data equals "[DONE]")
```

This is not the universal definition of stream completion. A higher-level `capture_flow` supplies its own controlled predicate, for example:

```text
exact_data
event_name
json_path_equals
network_terminal
selector_state
```

Network terminal state and raw events remain authoritative evidence.

## Integrity dimensions

Each request exposes separate dimensions:

```text
rawCaptureIntegrity
semanticParseIntegrity
requestSnapshotIntegrity
artifactIntegrity
```

Possible values are:

```text
complete | partial | failed | not-attempted
```

The legacy summary `integrityStatus` remains for compact MCP status. The capture also reports `collectorIntegrity`, which is a collector-wide worst-case diagnostic. It is not experiment success.

A higher-level Action must select target requests and calculate:

```text
primaryRequestIntegrity
objectiveIntegrity
```

using its `primaryRequestMatcher`, expected match count, and `allowSupportingFailures` policy. An unrelated telemetry stream failure must not automatically fail the primary conversation experiment.

## Event positions and time

CDP monotonic and wall times are saved separately. Parsed events can include:

```text
rawByteStart
rawByteEnd
decodedCharStart
decodedCharEnd
firstChunkIndex
lastChunkIndex
firstByteMonotonicTimeSeconds
firstByteWallTimeMs
completedMonotonicTimeSeconds
completedWallTimeMs
```

This supports targeted local-evidence reads from `raw.bin` without loading an entire stream into GPT context.

`captureArmedWallTimeMs` is recorded directly at `start_stream_capture`. `captureArmedMonotonicTimeSeconds` is optional and is only a page-network clock reference, not a substitute for the actual arm wall time.

## Stable page selection

Page listings return a stable process-lifetime `pageId` in addition to the current `pageIdx`. Higher-level orchestrators should save `pageId`, select by ID on later experiments, and verify that its URL still matches. `pageIdx` remains display and initial-discovery metadata only.

## Parser degradation

The semantic parser is a bounded byte-oriented line state machine supporting BOM, LF, CRLF, CR, and mixed line endings. Oversized events, incomplete tails, or invalid UTF-8 can degrade semantic parsing while exact `raw.bin` evidence remains usable for offline parsing.

## Lifecycle immutability

Only active `armed` or `capturing` captures are changed when a page closes. A stopped/finalized capture is immutable; closing its former page does not rewrite its status or manifest.

## Downstream wait contract

Polling `get_stream_status` is available to ordinary MCP clients. A higher-level private adapter should expose an internal wait method rather than a GPT-visible Action. For body predicates it passes `eventPredicate` and the last `afterEventIndex`; the collector returns only match metadata:

```text
waitForStreamCondition(
  captureId,
  requestMatcher,
  condition,
  sinceVersion,
  deadline
)
```

Conditions should include:

```text
first_event
event_predicate
default_done_marker
network_finished
network_canceled
failed
```

The adapter owns polling cadence, deadline propagation, primary-request selection, and Action-level objective evaluation.
