/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getToolDefinitions} from '../src/toolRegistry.js';

const STREAM_TOOLS = [
  'start_stream_capture',
  'get_stream_status',
  'stop_stream_capture',
];

test('ordinary MCP exposure includes the stream collector lifecycle', () => {
  const names = getToolDefinitions('mcp').map(tool => tool.name);
  assert.equal(names.length, 27);
  for (const name of STREAM_TOOLS) {
    assert.ok(names.includes(name), `${name} should be available in MCP mode`);
  }
});

test('GPT Action exposure hides every stream lifecycle primitive', () => {
  const tools = getToolDefinitions('gpt-action');
  const names = tools.map(tool => tool.name);
  assert.equal(names.length, 24);
  for (const name of STREAM_TOOLS) {
    assert.equal(
      names.includes(name),
      false,
      `${name} must not appear in GPT Action tools/list`,
    );
  }
  assert.equal(
    tools.some(tool => tool.capabilities?.includes('stream')),
    false,
  );
});
