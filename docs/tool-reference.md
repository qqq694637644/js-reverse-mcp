<!-- AUTO GENERATED DO NOT EDIT - run 'npm run docs' to update-->

# Chrome DevTools MCP Tool Reference

**Total: 27 tools.**

Every tool declares an MCP output schema. Successful calls and errors raised by
tool handlers or runtime operations return `structuredContent` with a stable
envelope: `ok`, `tool`, `summary`, optional machine-readable `data`, and an
`error` object (`code`, `message`, `retryable`) on failure. Protocol-level
input validation errors use the standard MCP/JSON-RPC error response. Text
content is kept for human-readable compatibility.

- **[Navigation automation](#navigation-automation)** (4 tools)
  - [`click_element`](#click_element)
  - [`navigate_page`](#navigate_page)
  - [`new_page`](#new_page)
  - [`select_page`](#select_page)
- **[Browser state](#browser-state)** (1 tool)
  - [`clear_site_data`](#clear_site_data)
- **[Network](#network)** (6 tools)
  - [`clear_network_requests`](#clear_network_requests)
  - [`get_stream_status`](#get_stream_status)
  - [`get_websocket_messages`](#get_websocket_messages)
  - [`list_network_requests`](#list_network_requests)
  - [`start_stream_capture`](#start_stream_capture)
  - [`stop_stream_capture`](#stop_stream_capture)
- **[Debugging](#debugging)** (4 tools)
  - [`evaluate_script`](#evaluate_script)
  - [`list_console_messages`](#list_console_messages)
  - [`select_frame`](#select_frame)
  - [`take_screenshot`](#take_screenshot)
- **[JS Reverse Engineering](#js-reverse-engineering)** (12 tools)
  - [`break_on_xhr`](#break_on_xhr)
  - [`get_paused_info`](#get_paused_info)
  - [`get_request_initiator`](#get_request_initiator)
  - [`get_script_source`](#get_script_source)
  - [`list_breakpoints`](#list_breakpoints)
  - [`list_scripts`](#list_scripts)
  - [`pause_or_resume`](#pause_or_resume)
  - [`remove_breakpoint`](#remove_breakpoint)
  - [`save_script_source`](#save_script_source)
  - [`search_in_sources`](#search_in_sources)
  - [`set_breakpoint_on_text`](#set_breakpoint_on_text)
  - [`step`](#step)

## Navigation automation

### `click_element`

**Description:** Performs one verified, auditable click in the currently selected frame. Use it when the task requires activating a known button, link, or control after selecting the correct page/frame and identifying a CSS selector; it is the preferred minimal interaction primitive over arbitrary [`evaluate_script`](#evaluate_script) code. It does not discover elements, type text, or silently guess among matches: the selector must resolve to exactly one element unless index is explicit, and the chosen element must be visible. A click can submit data, navigate, or trigger external effects, so confirm=true is required and the result reports the exact resolved element.

**Parameters:**

- **button** (enum: "left", "middle", "right") _(optional)_: Mouse button. Defaults to left.
- **confirm** (boolean) _(optional)_: Must be true to authorize this specific click because it can submit data, navigate, or trigger external side effects.
- **index** (integer) _(optional)_: Explicit zero-based match index. Required when the selector matches more than one element.
- **modifiers** (array) _(optional)_: Optional keyboard modifiers held during the click.
- **selector** (string) **(required)**: CSS selector evaluated only in the currently selected frame. Use [`select_frame`](#select_frame) first when the target is inside an iframe.
- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.

---

### `navigate_page`

**Description:** Navigates, reloads, or moves through history in the currently selected page. Use it to reproduce requests, trigger configured breakpoints, refresh scripts, or continue a workflow in the same tab; use [`new_page`](#new_page) when a separate tab is required. It does not clear cookies, storage, cache, or site data, so call [`clear_site_data`](#clear_site_data) first only when a clean replay is intended. It waits for DOMContentLoaded rather than every background resource; if a breakpoint pauses loading, use [`get_paused_info`](#get_paused_info) and then [`pause_or_resume`](#pause_or_resume)(action="resume"). Navigation invalidates old script IDs, while tracked URL and XHR/Fetch breakpoints are restored when possible.

**Parameters:**

- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.
- **type** (enum: "url", "back", "forward", "reload") _(optional)_: Navigation action for the selected page: url, back, forward, or reload. Use type=url together with url; omit type only when url is provided.
- **url** (string) _(optional)_: Target URL for type=url. Do not pass it for back, forward, or reload.

---

### `new_page`

**Description:** Opens a separate browser page for a URL, reusing an existing about:blank startup tab when available. Use this when the task needs another tab or should preserve the currently selected page; use [`navigate_page`](#navigate_page) to change the URL in the existing selected page instead. It waits for DOMContentLoaded, not every background resource, and then makes the opened page the target for later tools. It preserves cookies, storage, cache, and other browser state; use [`clear_site_data`](#clear_site_data) separately when a clean replay is required.

**Parameters:**

- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.
- **url** (string) **(required)**: Absolute URL to load in a separate or reusable blank page. Use [`navigate_page`](#navigate_page) instead when the current selected page should be reused.

---

### `select_page`

**Description:** Lists or selects open browser pages. Use it without pageIdx to identify the active page or choose the correct tab before inspecting network traffic, scripts, frames, or console output; pass pageIdx to make one listed page the shared target for later tools. It does not navigate or create pages: use [`navigate_page`](#navigate_page) to change the selected page's URL and [`new_page`](#new_page) when a separate tab is required. listPageIdx only paginates the page listing and never changes selection.

**Parameters:**

- **listPageIdx** (integer) _(optional)_: Zero-based pagination index for the page listing only. This is not the pageIdx used to select a browser page. Defaults to 0.
- **pageIdx** (number) _(optional)_: Snapshot index from the latest page listing. Pass it to make that page the target for later tools; omit it to list pages without changing selection. Re-list after pages open or close because indices can shift.
- **pageSize** (integer) _(optional)_: Maximum pages to list per response. Defaults to 20.

---

## Browser state

### `clear_site_data`

**Description:** Irreversibly clear browser state after confirm=true to create a clean replay environment for the selected page. Use this before replaying login, session creation, storage initialization, or other state-dependent flows; do not use it to inspect cookies or determine which response set one. For cookie provenance, including HttpOnly, Secure, and SameSite attributes, use [`list_network_requests`](#list_network_requests) with cookieName first. Cleanup covers cookies affecting the selected page's HTTP(S) frames—including HttpOnly and Secure cookies through the browser context—persistent storage for those frame origins, and each HTTP(S) frame's sessionStorage. It does not reload the page. The browser HTTP cache is global and is preserved by default; set clearBrowserCache=true only when that wider cross-page effect is explicitly intended.

**Parameters:**

- **clearBrowserCache** (boolean) _(optional)_: Also clear the browser-wide HTTP cache. Leave false for site-scoped replay cleanup. Setting true has a wider global effect on every page and origin in this browser, not only the selected page or its frame origins.
- **confirm** (boolean) _(optional)_: Must be true to irreversibly delete cookies affecting the selected page's HTTP(S) frames, persistent storage for those frame origins, and HTTP(S) frame sessionStorage. This confirms state reset for replay, not inspection.

---

## Network

### `clear_network_requests`

**Description:** Discard captured HTTP(S) evidence for the currently selected page after confirm=true. Use this immediately before reproducing an action when a clean network capture window is needed; do not use it to reset login, cookies, cache, or other browser state. It irreversibly clears the in-memory request queue, cached response bodies, and initiator maps only. Browser cookies, HTTP cache, origin storage, console messages, and WebSocket connections/messages are unchanged; use [`clear_site_data`](#clear_site_data) for cookie and storage reset. New captures continue above the previous reqid high-water mark because reqids are never reused.

**Parameters:**

- **confirm** (boolean) _(optional)_: Must be true to irreversibly delete the selected page's captured request history, response-body cache, and initiator evidence. This confirms capture cleanup, not browser-state cleanup.

---

### `get_stream_status`

**Description:** Inspect bounded status for a global stream capture ID, independent of the currently selected page. It returns capture/request summaries, workspace-relative artifact paths, bounded recent event summaries, and optionally bounded recent chunk offsets. It never returns event bodies, raw bytes, Base64, or operating-system absolute paths.

**Parameters:**

- **captureId** (integer) **(required)**
- **includeRecentChunks** (boolean) _(optional)_
- **pageIdx** (integer) _(optional)_
- **pageSize** (integer) _(optional)_
- **requestId** (string) _(optional)_

---

### `get_websocket_messages`

**Description:** Inspect captured bidirectional WebSocket connections and frame payloads for the selected page. Use this for WebSocket, socket, live-update, push, streaming, or realtime message flows; use [`list_network_requests`](#list_network_requests) for ordinary HTTP/XHR/fetch traffic and WebSocket upgrade request headers. WebSocket capture starts lazily on this tool's first use and is not retroactive: if the relevant socket already connected or exchanged frames, call this tool once to initialize capture, then reload or reproduce the flow. Without wsid it lists connections so you can choose one. With wsid it lists paginated sent/received frames; add show_content=true for payload previews. With wsid and analyze=true it groups frames by payload pattern and returns group IDs and sample frame indices; then use groupId to inspect one pattern. With wsid and frameIndex it returns one retained frame's detailed payload using the stable index shown in frame tables or analysis samples.

**Parameters:**

- **analyze** (boolean) _(optional)_: With wsid, group retained frames by payload pattern/fingerprint. Use this to discover message types in noisy realtime traffic; it returns traffic statistics, group IDs, and sample stable frame indices. Follow with groupId or frameIndex for focused inspection.
- **direction** (enum: "sent", "received") _(optional)_: With wsid, restrict frame-list, analysis, or group results to frames "sent" by the page or "received" from the server. It does not filter connection-list mode.
- **frameIndex** (integer) _(optional)_: With wsid, return one retained frame and its payload by stable frame index. This is the Idx shown in frame tables or analyze=true samples, not a page-relative array offset. Indices are monotonic and may begin above 0 after older frames are evicted.
- **groupId** (string) _(optional)_: With wsid, list only frames from a pattern group such as A, B, or C. Run analyze=true first to discover group IDs. If analysis used direction, repeat the same direction because grouping is computed over that filtered frame set.
- **includePreservedConnections** (boolean) _(optional)_: In connection-list mode only (without wsid), include connections preserved from the last three navigations. Use this when the relevant socket belonged to a previous page state.
- **pageIdx** (integer) _(optional)_: Zero-based page for the active connection-list, frame-list, group-list, or analysis-group mode. Omit it for the first page.
- **pageSize** (integer) _(optional)_: Items per page: connections when wsid is omitted, frames in normal/group mode, or pattern groups when analyze=true. Defaults to 10.
- **show_content** (boolean) _(optional)_: With wsid in normal or group frame-list mode, include payload previews up to 10,000 characters for frames on the current page. Leave false for compact metadata, or use frameIndex when one exact frame needs detailed inspection.
- **urlFilter** (string) _(optional)_: In connection-list mode only (without wsid), return WebSocket URLs containing this substring. Use it to narrow by host, path, or query text.
- **wsid** (number) _(optional)_: Select a WebSocket connection by the wsid returned from connection-list mode. Omit it to list captured connections before inspecting their frames.

---

### `list_network_requests`

**Description:** Inspect captured HTTP(S) traffic for the currently selected page. Use this for API calls, request or response headers and bodies, redirects, authentication/session flows, replay or signing inputs, and determining which response created, refreshed, rotated, overwritten, or deleted a cookie. Without reqid it lists and filters requests; with cookieName it traces exact response Set-Cookie updates oldest-first, including cookies with HttpOnly, Secure, or SameSite attributes that page JavaScript cannot fully inspect; with reqid it returns bounded request details; with reqid plus outputFile it exports exact data. To inspect complete Set-Cookie values and attributes, export outputPart="responseHeaders" for a reqid returned by cookieName mode. cookieName never searches outbound Cookie request headers. Use [`get_websocket_messages`](#get_websocket_messages) for WebSocket frame payloads; this tool only represents the HTTP upgrade request. Capture begins when this MCP attaches and is not retroactive, so reload or reproduce traffic that occurred earlier. Captures then survive navigation in a 5000-request FIFO queue. List and cookie-flow modes default to 20 items per page; filters combine with AND and multiple values inside one filter combine with OR.

**Parameters:**

- **confirmOverwrite** (boolean) _(optional)_: Must be true when outputFile already exists. New files do not require confirmation.
- **cookieName** (string) _(optional)_: Trace an exact cookie name in response Set-Cookie headers. Use this when asked where, when, or by which response a cookie was created, refreshed, rotated, overwritten, or deleted, including HttpOnly cookies and cookies carrying Secure or SameSite attributes. Matching setter responses are returned oldest-first with reqids and use pageSize/pageIdx. Export outputPart="responseHeaders" for a returned reqid to inspect the complete value and Path, Domain, HttpOnly, Secure, SameSite, Expires, or Max-Age attributes. This mode does not search outbound Cookie request headers.
- **methods** (array) _(optional)_: Filter requests by HTTP method (the request verb). Matched case-insensitively. Pass one or more of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS; multiple values are OR-ed (e.g. ["POST"] shows only POSTs, ["GET","POST"] shows both). Use this to hunt for submissions (POST/PUT/PATCH) versus reads (GET). This is the HTTP verb, distinct from resourceTypes which filters by resource category (xhr, document, ...). When omitted or empty, methods are not filtered.
- **outputFile** (string) _(optional)_: With reqid, save selected network data to a local file. Use export instead of bounded inline details for complete Set-Cookie headers, exact bytes, large or binary bodies, long query payloads, replay/signature inputs, or external decoding. Absolute paths and paths relative to the current working directory are supported. The response reports the resolved absolute path; use it with [`evaluate_script`](#evaluate_script) localFilePath for browser-side processing. Subject to --allowedRoots when configured.
- **outputPart** (enum: "all", "responseHeaders", "responseBody", "requestBody", "queryParams") _(optional)_: Select what outputFile receives for the chosen reqid. Use "responseHeaders" for complete cookie attributes and repeated Set-Cookie headers, "responseBody" for raw response bytes, "requestBody" for captured request bytes, "queryParams" for parsed URL parameters, or "all" for a JSON bundle of metadata, headers, query parameters, and body content/metadata. Defaults to "all".
- **pageIdx** (integer) _(optional)_: Zero-based page to return in request-list or cookie-flow mode. Omit it for the first page.
- **pageSize** (integer) _(optional)_: Maximum requests or Set-Cookie updates per page in list or cookie-flow mode. Defaults to 20.
- **reqid** (number) _(optional)_: Inspect one captured request by the reqid returned by request-list or cookie-flow mode. Omit it to list/filter requests or trace cookie setters. Add outputFile when exact, complete, or large data is needed.
- **resourceTypes** (array) _(optional)_: Filter requests to only return requests of the specified resource types (xhr, fetch, document, script, ...). This is the resource category, NOT the HTTP verb — use methods for GET/POST filtering. When omitted or empty, returns all requests.
- **urlFilter** (string) _(optional)_: Filter request-list results to URLs containing this substring. Use an endpoint path, host, query fragment, or other known URL text; combine with methods/resourceTypes to narrow an API flow.

---

### `start_stream_capture`

**Description:** Arm streaming HTTP capture for the selected page. The server requires --allowedRoots, allocates a globally unique directory under the first allowed root, decodes CDP Base64 internally, and returns only an opaque capture ID plus workspace-relative artifact metadata. Application code should orchestrate start, browser action, wait, and stop atomically; do not expose this sequence as separate user-managed GPT Actions.

**Parameters:**

- **methods** (array) _(optional)_: Optional HTTP method filter, such as ["POST"].
- **mimeTypes** (array) _(optional)_: Response MIME prefixes to capture. Defaults to ["text/event-stream"].
- **resourceTypes** (array) _(optional)_: Optional CDP/Playwright resource-type filter, such as ["fetch","eventsource"].
- **urlFilter** (string) _(optional)_: Only capture response URLs containing this substring.

---

### `stop_stream_capture`

**Description:** Stop a global stream capture ID regardless of the currently selected page. The call waits for streamResourceContent activation, queued chunks, incremental parsing, artifact writes, and atomic metadata finalization. It returns the final capture summary plus a bounded artifact index; the complete index is in capture.json.

**Parameters:**

- **captureId** (integer) **(required)**

---

## Debugging

### `evaluate_script`

**Description:** Evaluates one focused JavaScript function for DOM/page state, web storage, page-defined globals, a paused-frame expression, or browser-side processing of one local file. Use it when those runtime values are the goal and no narrower evidence tool applies. Do not use document.cookie or page evaluation to investigate HttpOnly/Secure cookies, Set-Cookie provenance, or captured HTTP evidence; use [`list_network_requests`](#list_network_requests) with cookieName/reqid, and use [`search_in_sources`](#search_in_sources)/[`get_script_source`](#get_script_source) for source discovery. While running, evaluation uses the selected frame's isolated world by default or its page main world with mainWorld=true; while paused, it always uses the chosen call frame and ignores mainWorld. Call [`get_paused_info`](#get_paused_info) before paused evaluation, then [`step`](#step) or resume when finished. Arbitrary code can change page/external state and requires confirm=true; inline results are bounded, so use outputFile for exact large or binary results.

**Parameters:**

- **confirm** (boolean) _(optional)_: Must be true to authorize this exact arbitrary-code evaluation, which may mutate page state, send requests, or cause external side effects. Prefer a read-only expression when inspection is sufficient.
- **confirmOverwrite** (boolean) _(optional)_: Set true only to authorize replacing an existing outputFile. A new file does not require overwrite confirmation.
- **frameIndex** (integer) _(optional)_: Paused mode only: zero-based call frame from [`get_paused_info`](#get_paused_info) (default: top frame). The index and its callFrameId expire after any [`step`](#step) or resume.
- **function** (string) **(required)**: JavaScript function declaration invoked by the tool, for example `() => document.title` or `async () => await Promise.resolve(location.href)`. Return JSON-serializable data; ArrayBuffer/typed arrays require outputFile for exact bytes. With localFilePath, accept `async ({localFile}) => ...` and read localFile.text for UTF-8 or localFile.base64 for exact bytes. Keep the function focused; use mainWorld=true only when page-defined globals are required.
- **localFilePath** (string) _(optional)_: Absolute path to one host file passed as localFile; the browser never reads the path directly. Relative paths, file:// URLs, globs, ~, and directories are rejected, access is subject to --allowedRoots, and file contents may expose sensitive host data.
- **mainWorld** (boolean) _(optional)_: Running-page mode only: false uses the selected frame's isolated context; true uses that frame's page main world to access application-defined globals. When execution is paused, evaluation always targets frameIndex and this option is ignored.
- **outputFile** (string) _(optional)_: Save the exact result locally instead of returning bounded inline content. JSON-serializable values are written as JSON text and ArrayBuffer/typed arrays as raw bytes; the returned filename is resolved and subject to --allowedRoots.

---

### `list_console_messages`

**Description:** Inspects console messages and uncaught page errors captured for the selected page. Use it to diagnose runtime failures, warnings, application logs, or values already emitted by page code; use [`search_in_sources`](#search_in_sources) for source text and [`list_network_requests`](#list_network_requests) for HTTP evidence instead. Without msgid it lists messages 20 per page by default, optionally filtered by type or retained navigation history. With msgid it returns one message by its stable ID for focused inspection. Capture begins when this MCP attaches and is not retroactive, so reload or reproduce code that logged before attachment.

**Parameters:**

- **includePreservedMessages** (boolean) _(optional)_: Include retained console messages from the last 3 navigations. Leave false when only the current page load is relevant.
- **msgid** (number) _(optional)_: Stable message ID returned by list mode. Pass it to inspect one captured console message; omit it to list messages.
- **pageIdx** (integer) _(optional)_: Page number to return (0-based). When omitted, returns the first page.
- **pageSize** (integer) _(optional)_: Maximum number of messages to return. Defaults to 20.
- **types** (array) _(optional)_: Console levels/types to include in list mode, such as error, warn, log, or trace. Values are OR-ed; omit or pass an empty array for all types.

---

### `select_frame`

**Description:** Lists or selects frames, including iframes, within the current page. Use it when the target element, page-defined global, script, or execution context may live in an iframe: first list frames, then pass frameIdx before [`click_element`](#click_element) or [`evaluate_script`](#evaluate_script). Omitting frameIdx lists 20 frames per page without changing context; passing frameIdx changes the shared frame target, with 0 restoring the main frame. It does not switch browser tabs or navigate—use [`select_page`](#select_page) or [`navigate_page`](#navigate_page) for those actions—and listPageIdx only paginates this listing.

**Parameters:**

- **frameIdx** (integer) _(optional)_: Frame index from the latest frame listing. Pass it to target later frame-aware tools; 0 restores the main frame. Omit it to list frames without changing context, and re-list after navigation or frame attachment/detachment because indices can shift.
- **listPageIdx** (integer) _(optional)_: Zero-based pagination index for the frame listing only. This is not the frameIdx used to select a frame. Defaults to 0.
- **pageSize** (integer) _(optional)_: Maximum frames to list per response. Defaults to 20.

---

### `take_screenshot`

**Description:** Captures the visual state of the currently selected page. Use it to verify page layout, visible UI state, selector targets, in-page dialogs/modals, or the effect of a navigation/click; it is not a substitute for DOM values, network evidence, or script inspection. By default it returns the visible viewport, while fullPage=true captures the whole document; oversized captures may be saved as a temporary artifact instead of attached. Pass filePath for a reusable local artifact; existing files require confirmOverwrite=true and remain subject to --allowedRoots.

**Parameters:**

- **confirmOverwrite** (boolean) _(optional)_: Must be true when filePath already exists. New files do not require confirmation.
- **filePath** (string) _(optional)_: Optional absolute or working-directory-relative path for a reusable screenshot artifact. Omit it to attach the image directly. Subject to --allowedRoots when configured.
- **format** (enum: "png", "jpeg") _(optional)_: Image format for the attachment or saved file. Defaults to png; use jpeg when smaller lossy output is preferred.
- **fullPage** (boolean) _(optional)_: Capture the entire scrollable document when true; leave false or omit it for the currently visible viewport.
- **quality** (number) _(optional)_: Compression quality for JPEG format (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.

---

## JS Reverse Engineering

### `break_on_xhr`

**Description:** Sets a URL-substring breakpoint for a future XHR/Fetch when runtime request arguments, local variables, or payload construction must be inspected. For an already captured request, call [`get_request_initiator`](#get_request_initiator) first because it is non-pausing; use this only when that evidence is insufficient. Set it before reproducing the user action—it does not inspect past traffic—then call [`get_paused_info`](#get_paused_info)/[`evaluate_script`](#evaluate_script) and finally [`step`](#step) or resume. The URL pattern identifies this breakpoint for [`list_breakpoints`](#list_breakpoints) and [`remove_breakpoint`](#remove_breakpoint)(action="remove_xhr").

**Parameters:**

- **url** (string) **(required)**: Case-sensitive URL substring matched against future XHR/Fetch requests. Prefer a narrow endpoint path from [`list_network_requests`](#list_network_requests); retain the exact string to remove the breakpoint later.

---

### `get_paused_info`

**Description:** Inspects the current call stack, source locations, and selected call-frame scopes after a code/XHR breakpoint or explicit pause has stopped execution. It neither creates a pause nor resumes one. Returned frameIndex values and callFrameIds belong only to the current pause and expire after any [`step`](#step) or resume; use [`evaluate_script`](#evaluate_script) with frameIndex for a focused expression, then [`step`](#step) or [`pause_or_resume`](#pause_or_resume)(action="resume").

**Parameters:**

- **frameIndex** (integer) _(optional)_: Zero-based frame from this pause whose scopes should be read (default: top frame). Frame indices change after a [`step`](#step) and expire on resume.
- **includeScopes** (boolean) _(optional)_: Include bounded variables from the selected call frame (default: true). Set false when only the stack and source locations are needed.
- **maxScopeDepth** (integer) _(optional)_: Scope categories to include for frameIndex (default: 2): 1 reads arguments/locals, 2 also reads closures, and 3+ includes other non-global scopes. Increase only when the needed value is absent.

---

### `get_request_initiator`

**Description:** Non-pausing first action for tracing which JavaScript initiated a retained HTTP request when CDP initiator evidence was active. Pass the reqid from [`list_network_requests`](#list_network_requests); because initiator capture starts lazily and is not retroactive, an older request may have no stack—in that case reproduce the action and inspect the new reqid, or set [`break_on_xhr`](#break_on_xhr) before reproduction when runtime values are required. If the captured stack identifies the code, inspect its URL/location with [`get_script_source`](#get_script_source). If arguments, locals, or a dynamically built payload are still needed, use [`break_on_xhr`](#break_on_xhr), reproduce, then call [`get_paused_info`](#get_paused_info) or [`evaluate_script`](#evaluate_script) before stepping or resuming. This tool only reads retained evidence and does not pause or reproduce the request.

**Parameters:**

- **requestId** (integer) **(required)**: Numeric reqid returned by [`list_network_requests`](#list_network_requests), not a raw CDP request ID. It survives navigation while retained, but becomes stale after FIFO eviction or [`clear_network_requests`](#clear_network_requests); list requests again if needed.

---

### `get_script_source`

**Description:** Reads a small source region around a search match, paused location, or known statement without executing or pausing the page. Select by URL when available because URL-backed scripts can be resolved again after navigation; use the debugger-context-scoped scriptId only for current inline/eval scripts. Use line ranges for normal source and offset/length for minified single-line bundles. For a whole, minified, or WASM source, use [`save_script_source`](#save_script_source); to observe runtime values next, call [`set_breakpoint_on_text`](#set_breakpoint_on_text) against the original loaded source.

**Parameters:**

- **endLine** (integer) _(optional)_: Inclusive 1-based end line for a bounded multi-line snippet. Omit both line bounds and use offset/length for a minified single-line bundle.
- **length** (integer) _(optional)_: Maximum characters to return from offset (default: 1000). This is ignored unless offset is provided.
- **offset** (integer) _(optional)_: Zero-based character offset into the original source. Use for a bounded read of minified single-line code when line ranges would be too large.
- **scriptId** (string) _(optional)_: Debugger-context-scoped script ID from [`list_scripts`](#list_scripts), [`search_in_sources`](#search_in_sources), or paused information. Required for unnamed inline/eval scripts, but invalid after reload, navigation, or debugger target/frame change; prefer url for external scripts.
- **startLine** (integer) _(optional)_: Inclusive 1-based start line, typically copied from [`search_in_sources`](#search_in_sources) or paused information. Use with endLine for normal multi-line source.
- **url** (string) _(optional)_: URL from [`list_scripts`](#list_scripts), [`search_in_sources`](#search_in_sources), or a call stack. Preferred stable selector for URL-backed scripts; resolution tries an exact match before a substring match, so provide enough of the URL to avoid ambiguity.

---

### `list_breakpoints`

**Description:** Inspects code and XHR/Fetch breakpoints managed by this MCP session before reproducing an action or cleaning up debugger state. Returns current code breakpointIds and the exact XHR URL patterns needed by [`remove_breakpoint`](#remove_breakpoint); URL-backed definitions are restored after navigation when possible, but a rebuilt debugger session may assign new IDs. This does not show why or where execution is currently paused—use [`get_paused_info`](#get_paused_info) for the active call stack.

**Parameters:**

- **pageIdx** (integer) _(optional)_: Page number (0-based). Defaults to 0.
- **pageSize** (integer) _(optional)_: Maximum items per page. Defaults to 20.

---

### `list_scripts`

**Description:** Discovers JavaScript currently loaded in the selected debugger context—the main frame by default, or the frame chosen with [`select_frame`](#select_frame). Use [`select_frame`](#select_frame) first for iframe-specific source/debugger work. Includes external, inline, and eval scripts in that context; if you already know a function name, endpoint, or code literal, use [`search_in_sources`](#search_in_sources) instead. Each result includes a context-scoped scriptId that expires on reload, navigation, or debugger target change and, for external scripts, a URL that is the preferred selector for [`get_script_source`](#get_script_source) or [`save_script_source`](#save_script_source).

**Parameters:**

- **filter** (string) _(optional)_: Case-insensitive URL substring used to narrow external scripts. It does not search source text or match unnamed inline/eval scripts; use [`search_in_sources`](#search_in_sources) for code-content queries.
- **pageIdx** (integer) _(optional)_: Page number (0-based). Defaults to 0.
- **pageSize** (integer) _(optional)_: Maximum items per page. Defaults to 20.

---

### `pause_or_resume`

**Description:** Explicitly requests an immediate pause or resumes an existing paused execution; it never toggles implicitly. Use a code breakpoint or [`break_on_xhr`](#break_on_xhr) instead when a specific statement/request should stop, and use [`get_paused_info`](#get_paused_info) before resuming if evidence must be collected. Resuming invalidates current callFrameIds and frame indices.

**Parameters:**

- **action** (enum: "pause", "resume") **(required)**: Use "pause" only while running, or "resume" only after a breakpoint/manual pause. Resume after [`get_paused_info`](#get_paused_info)/[`evaluate_script`](#evaluate_script)/[`step`](#step) inspection is complete.

---

### `remove_breakpoint`

**Description:** Removes a known code breakpoint, XHR/Fetch breakpoint, or every MCP-managed breakpoint after explicit confirmation. Use breakpointId from [`set_breakpoint_on_text`](#set_breakpoint_on_text)/[`list_breakpoints`](#list_breakpoints) for remove_code, or reuse the exact URL pattern from [`break_on_xhr`](#break_on_xhr)/[`list_breakpoints`](#list_breakpoints) for remove_xhr. Removal does not resume an already paused page; call [`pause_or_resume`](#pause_or_resume)(action="resume") separately after inspection.

**Parameters:**

- **action** (enum: "remove_code", "remove_xhr", "remove_all") **(required)**: Required removal mode: remove_code needs breakpointId, remove_xhr needs url, and remove_all removes both kinds.
- **breakpointId** (string) _(optional)_: Current breakpoint ID returned by [`set_breakpoint_on_text`](#set_breakpoint_on_text) or [`list_breakpoints`](#list_breakpoints). Used only with action="remove_code"; list again after a debugger/page-session rebuild because restoration may assign a new ID.
- **confirm** (boolean) _(optional)_: Must be true to authorize the selected removal action. This does not authorize or trigger resuming execution.
- **url** (string) _(optional)_: Exact URL substring pattern previously passed to [`break_on_xhr`](#break_on_xhr) or returned by [`list_breakpoints`](#list_breakpoints). Used only with action="remove_xhr".

---

### `save_script_source`

**Description:** Saves one complete JavaScript or WASM source for local inspection when an inline snippet is insufficient, especially for large or minified bundles. Prefer [`get_script_source`](#get_script_source) for a small known region and [`search_in_sources`](#search_in_sources) to locate text across loaded scripts first. With format=true, destinations using a supported JavaScript/TypeScript extension are formatted by default; other extensions preserve raw source, and formatted line numbers may differ from the live page. Use distinctive text plus the original URL with [`set_breakpoint_on_text`](#set_breakpoint_on_text) for runtime debugging. The returned filename is the resolved local path, while scriptId remains scoped to the current debugger context.

**Parameters:**

- **confirmOverwrite** (boolean) _(optional)_: Set true only to authorize replacing an existing filePath. A new file does not require overwrite confirmation.
- **filePath** (string) **(required)**: Destination path for the complete source, absolute or relative to the server working directory and subject to --allowedRoots. A JavaScript/TypeScript extension enables formatting; use .wasm for bytecode or another extension to preserve raw text.
- **format** (boolean) _(optional)_: Format supported JavaScript/TypeScript extensions for readability (default: true). Set false when exact source bytes or original line layout matter; formatted line numbers cannot be used as live breakpoint locations.
- **scriptId** (string) _(optional)_: Debugger-context-scoped script ID from [`list_scripts`](#list_scripts) or [`search_in_sources`](#search_in_sources). Use for unnamed inline/eval scripts; it becomes invalid after reload, navigation, or debugger target/frame change.
- **url** (string) _(optional)_: URL from [`list_scripts`](#list_scripts), [`search_in_sources`](#search_in_sources), or a call stack. Preferred over scriptId because it can be resolved again after navigation; exact match is tried before substring match.

---

### `search_in_sources`

**Description:** Finds a known function name, endpoint, string literal, token, or code pattern in JavaScript loaded by the selected debugger context—the main frame by default, or the frame chosen with [`select_frame`](#select_frame). It searches external, inline/eval, and minified sources in that context without executing or pausing the page, returning 1-based lines plus context-scoped scriptIds; URLs are the preferred selectors for URL-backed matches. Use [`select_frame`](#select_frame) first for iframe-specific source work, [`get_script_source`](#get_script_source) for nearby context, [`save_script_source`](#save_script_source) for a whole bundle, or [`set_breakpoint_on_text`](#set_breakpoint_on_text) when runtime values are needed. For a known captured request, prefer [`get_request_initiator`](#get_request_initiator) before a broad source search.

**Parameters:**

- **caseSensitive** (boolean) _(optional)_: Match case exactly when true. Leave false for discovery; set true when choosing exact code text for a breakpoint.
- **excludeMinified** (boolean) _(optional)_: Skip sources with very long lines when true. Keep the default false for reverse engineering because relevant code often exists only in compressed bundles.
- **isRegex** (boolean) _(optional)_: Interpret query as a regular expression when true. Leave false for literal endpoint, token, and code-text searches.
- **maxLineLength** (integer) _(optional)_: Maximum characters in each matched-line preview (default: 150). Use [`get_script_source`](#get_script_source) rather than a very large preview when surrounding context is needed.
- **maxResults** (integer) _(optional)_: Maximum matches to return (default: 30). Narrow with urlFilter before increasing this for common text.
- **query** (string) **(required)**: Source text to locate, or a regular-expression pattern when isRegex=true. Prefer a distinctive function name, endpoint, property, or literal that can also anchor [`set_breakpoint_on_text`](#set_breakpoint_on_text).
- **urlFilter** (string) _(optional)_: Case-insensitive script-URL substring used to narrow matches to a known bundle or domain. It excludes unnamed inline/eval scripts.

---

### `set_breakpoint_on_text`

**Description:** Sets a restorable URL-backed breakpoint when distinctive code text is known and its runtime values must be observed. Call it directly when the user already supplies precise text plus any URL/occurrence disambiguation; use [`search_in_sources`](#search_in_sources)/[`get_script_source`](#get_script_source) first only when the location is unknown or ambiguous. For an API with no known code location, start with [`list_network_requests`](#list_network_requests) and [`get_request_initiator`](#get_request_initiator) or use [`break_on_xhr`](#break_on_xhr). On a hit, call [`get_paused_info`](#get_paused_info), optionally [`evaluate_script`](#evaluate_script), then [`step`](#step) or resume. Returns the current breakpointId for [`remove_breakpoint`](#remove_breakpoint); list breakpoints again after a rebuilt debugger session, and note that unnamed inline/eval scripts cannot use this URL breakpoint.

**Parameters:**

- **condition** (string) _(optional)_: Optional simple synchronous expression evaluated in the future call frame; the breakpoint pauses only when it is true. Use it to reduce repeated hits after the location is precise, never for async work, complex discovery, or side effects.
- **occurrence** (integer) _(optional)_: One-based occurrence among matching loaded-source results (default: 1). Use only after reviewing multiple search matches; urlFilter is usually the more stable disambiguator.
- **text** (string) **(required)**: Exact case-sensitive source text used to locate the breakpoint, such as a distinctive function declaration, call, or statement. Prefer a snippet confirmed by [`search_in_sources`](#search_in_sources) and avoid common tokens.
- **urlFilter** (string) _(optional)_: Case-insensitive URL substring that limits candidate scripts. Use the URL from [`search_in_sources`](#search_in_sources)/[`get_script_source`](#get_script_source) to avoid the same text in unrelated bundles.

---

### `step`

**Description:** Advances JavaScript execution by one debugger operation from an existing pause and returns the next stopped call frame with concise source context. Use after [`get_paused_info`](#get_paused_info) or [`evaluate_script`](#evaluate_script) when control flow still needs tracing; it cannot start from running execution. Each advance invalidates prior callFrameIds, so inspect the new pause again as needed, then use [`pause_or_resume`](#pause_or_resume)(action="resume") to finish.

**Parameters:**

- **direction** (enum: "over", "into", "out") **(required)**: Choose "over" for the next statement without entering calls, "into" to follow a call, or "out" to continue until the current function returns.

---

## CLI Configuration

- **`--browserUrl`, `-u`**
  Connect to a running Chrome instance via CDP HTTP endpoint (e.g., http://127.0.0.1:9222). The MCP will probe the endpoint to find the WebSocket debugger URL.
  - **Type:** string

- **`--isolated`**
  Create a temporary user-data-dir that is auto-cleaned when the browser closes. Use this for runs where you do NOT want cookies/localStorage to persist into your default profile.
  - **Type:** boolean
  - **Default:** `false`

- **`--logFile`**
  Path to a 0600 regular file for js-reverse-mcp debug logs. Use DEBUG=mcp:_ for verbose MCP logs; never use DEBUG=_ because browser protocol logs can contain page data, cookies, scripts, and credentials.
  - **Type:** string

- **`--allowedRoots`**
  Optional directories that local-file tools may read from or write to. Repeat the flag for multiple roots. Roots are resolved at startup and symlink escapes are rejected. While configured, file:, view-source:file:, and filesystem:file: browser pages are disabled. When omitted, local-file access is unrestricted and a security warning is printed.
  - **Type:** string[]

- **`--streamMaxBytes`**
  Maximum on-disk bytes reserved for one streaming-response capture. Defaults to 536870912 (512 MiB). Exceeding the quota marks the capture failed and records explicit truncation statistics.
  - **Type:** number
  - **Default:** `536870912`

- **`--cloak`**
  Use CloakBrowser stealth-patched Chromium instead of system Chrome. Adds source-level fingerprint patches (canvas/WebGL/audio/GPU). Binary auto-downloads (~200MB) on first use. Identity is persisted per profile in <profile>/.cloak-seed.
  - **Type:** boolean
