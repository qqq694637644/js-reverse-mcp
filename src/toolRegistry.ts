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

export const TOOL_EXPOSURE_MODES = ['mcp', 'gpt-action'] as const;
export type ToolExposureMode = (typeof TOOL_EXPOSURE_MODES)[number];

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

/**
 * Ordinary MCP clients may coordinate the stream collector lifecycle directly.
 * GPT Action deployments must keep that lifecycle behind their own atomic
 * runBrowserExperiment/capture_flow operation, so stream lifecycle tools are
 * intentionally absent from tools/list in gpt-action mode.
 */
export function getToolDefinitions(
  mode: ToolExposureMode = 'mcp',
): ToolDefinition[] {
  const tools =
    mode === 'gpt-action'
      ? allTools.filter(tool => !tool.capabilities?.includes('stream'))
      : [...allTools];
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}
