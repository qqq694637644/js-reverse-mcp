/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {YargsOptions} from './third_party/index.js';
import {yargs, hideBin} from './third_party/index.js';
import {TOOL_EXPOSURE_MODES} from './toolRegistry.js';

export const cliOptions = {
  browserUrl: {
    type: 'string',
    description:
      'Connect to a running Chrome instance via CDP HTTP endpoint (e.g., http://127.0.0.1:9222). The MCP will probe the endpoint to find the WebSocket debugger URL.',
    alias: 'u',
    coerce: (url: string | undefined) => {
      if (!url) {
        return;
      }
      try {
        new URL(url);
      } catch {
        throw new Error(`Provided browserUrl ${url} is not valid URL.`);
      }
      return url;
    },
  },
  isolated: {
    type: 'boolean',
    description:
      'Create a temporary user-data-dir that is auto-cleaned when the browser closes. Use this for runs where you do NOT want cookies/localStorage to persist into your default profile.',
    default: false,
  },
  logFile: {
    type: 'string',
    describe:
      'Path to a 0600 regular file for js-reverse-mcp debug logs. Use DEBUG=mcp:* for verbose MCP logs; never use DEBUG=* because browser protocol logs can contain page data, cookies, scripts, and credentials.',
  },
  allowedRoots: {
    type: 'string',
    array: true,
    description:
      'Optional directories that local-file tools may read from or write to. Repeat the flag for multiple roots. Roots are resolved at startup and symlink escapes are rejected. While configured, file:, view-source:file:, and filesystem:file: browser pages are disabled. When omitted, local-file access is unrestricted and a security warning is printed.',
  },
  streamMaxBytes: {
    type: 'number',
    description:
      'Maximum on-disk bytes reserved for one streaming-response capture. Defaults to 536870912 (512 MiB). Exceeding the quota marks the capture failed and records explicit truncation statistics.',
    default: 512 * 1024 * 1024,
    coerce: (value: number) => {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('streamMaxBytes must be a positive safe integer.');
      }
      return value;
    },
  },
  streamArtifactRoot: {
    type: 'string',
    description:
      'Deployment-controlled allowed-root selector used for stream artifacts. Accepts an allowed-root index such as "0" or an exact configured allowed-root path. Required before stream capture can start.',
  },
  streamActivationTimeoutMs: {
    type: 'number',
    description:
      'Internal timeout for Network.streamResourceContent activation. Defaults to 10000ms. Timeout produces a finalized failed or semantic-only manifest instead of leaving a request permanently activating.',
    default: 10_000,
    coerce: (value: number) => {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(
          'streamActivationTimeoutMs must be a positive safe integer.',
        );
      }
      return value;
    },
  },
  streamPendingMaxBytes: {
    type: 'number',
    description:
      'Maximum in-memory bytes queued while streamResourceContent activation is pending. Defaults to 8388608 (8 MiB). Exceeding it fails activation explicitly.',
    default: 8 * 1024 * 1024,
    coerce: (value: number) => {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(
          'streamPendingMaxBytes must be a positive safe integer.',
        );
      }
      return value;
    },
  },
  streamMaxSseEventBytes: {
    type: 'number',
    description:
      'Maximum bytes retained by the semantic SSE parser for one event or incomplete tail. Raw capture continues after semantic parsing degrades. Defaults to 8388608 (8 MiB).',
    default: 8 * 1024 * 1024,
    coerce: (value: number) => {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(
          'streamMaxSseEventBytes must be a positive safe integer.',
        );
      }
      return value;
    },
  },
  toolExposureMode: {
    type: 'string',
    choices: TOOL_EXPOSURE_MODES,
    default: 'mcp',
    description:
      'Tool exposure profile. "mcp" exposes stream lifecycle primitives. "gpt-action" hides them from tools/list so a downstream Action can expose only one atomic capture_flow operation.',
  },
  cloak: {
    type: 'boolean',
    description:
      'Use CloakBrowser stealth-patched Chromium instead of system Chrome. ' +
      'Adds source-level fingerprint patches (canvas/WebGL/audio/GPU). ' +
      'Binary auto-downloads (~200MB) on first use. Identity is persisted ' +
      'per profile in <profile>/.cloak-seed.',
    // No `default: false` here on purpose: yargs treats a defaulted boolean as
    // "set", which makes `conflicts` fire even when the user only passed
    // `--browserUrl`. Leaving it undefined keeps the conflict check honest.
    conflicts: ['browserUrl'],
  },
} satisfies Record<string, YargsOptions>;

export function parseArguments(version: string, argv = process.argv) {
  const yargsInstance = yargs(hideBin(argv))
    .scriptName('npx js-reverse-mcp@latest')
    .options(cliOptions)
    .example([
      [
        '$0',
        'Launch system Chrome (stable) with the default persistent profile',
      ],
      [
        '$0 --cloak',
        'Use CloakBrowser stealth-patched Chromium (source-level fingerprint patches)',
      ],
      [
        '$0 --isolated',
        'Run with a throwaway profile (no cookies/localStorage saved)',
      ],
      [
        '$0 --browserUrl http://127.0.0.1:9222',
        'Connect to a running Chrome instance instead of launching a new one',
      ],
      ['$0 --logFile /tmp/log.txt', 'Save debug logs to a file'],
      [
        '$0 --allowedRoots /workspace --allowedRoots /tmp/captures',
        'Restrict local-file reads and writes to explicit directories',
      ],
      [
        '$0 --allowedRoots /workspace --streamArtifactRoot 0',
        'Store stream artifacts under allowed root index 0',
      ],
      [
        '$0 --toolExposureMode gpt-action',
        'Hide stream lifecycle primitives from tools/list for GPT Action deployment',
      ],
      ['$0 --help', 'Print CLI options'],
    ]);

  return yargsInstance
    .wrap(Math.min(120, yargsInstance.terminalWidth()))
    .help()
    .version(version)
    .parseSync();
}
