/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as consoleTools from './tools/console.js';
import * as debuggerTools from './tools/debugger.js';
import * as frameTools from './tools/frames.js';
import * as interactionTools from './tools/interaction.js';
import * as networkTools from './tools/network.js';
import * as pagesTools from './tools/pages.js';
import * as screenshotTools from './tools/screenshot.js';
import * as scriptTools from './tools/script.js';
import * as siteDataTools from './tools/siteData.js';
import * as streamTools from './tools/stream.js';
import type {ToolDefinition} from './tools/ToolDefinition.js';
import * as websocketTools from './tools/websocket.js';

const allTools = [
  ...Object.values(consoleTools),
  ...Object.values(debuggerTools),
  ...Object.values(frameTools),
  ...Object.values(interactionTools),
  ...Object.values(networkTools),
  ...Object.values(pagesTools),
  ...Object.values(screenshotTools),
  ...Object.values(scriptTools),
  ...Object.values(siteDataTools),
  ...Object.values(streamTools),
  ...Object.values(websocketTools),
].filter(tool => {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    'name' in tool &&
    'handler' in tool &&
    'schema' in tool &&
    'annotations' in tool
  );
}) as unknown as ToolDefinition[];

export function getToolDefinitions(): ToolDefinition[] {
  return [...allTools].sort((a, b) => a.name.localeCompare(b.name));
}
