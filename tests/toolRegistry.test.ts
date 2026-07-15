/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getToolDefinitions} from '../src/toolRegistry.js';

test('MCP registry includes the stream collector lifecycle', () => {
  const names = getToolDefinitions().map(tool => tool.name);
  assert.equal(names.length, 27);
  for (const name of [
    'start_stream_capture',
    'get_stream_status',
    'stop_stream_capture',
  ]) {
    assert.ok(names.includes(name), `${name} should be available in MCP mode`);
  }
});
