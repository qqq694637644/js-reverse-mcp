/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getScriptSource} from '../../src/tools/debugger.js';

function createResponse(
  lines: string[],
  structured: Array<Record<string, unknown>>,
) {
  return {
    appendResponseLine(value: string) {
      lines.push(value);
    },
    setStructuredContent(value: Record<string, unknown>) {
      structured.push(value);
    },
  };
}

test('get_script_source returns structured preview for an oversized line range', async () => {
  const source = `const bundled = "${'x'.repeat(1500)}";`;
  const lines: string[] = [];
  const structured: Array<Record<string, unknown>> = [];

  await getScriptSource.handler(
    {
      params: {
        scriptId: 'script-minified',
        startLine: 1,
        endLine: 1,
        length: 1000,
      },
    },
    createResponse(lines, structured) as never,
    {
      debuggerContext: {
        isEnabled: () => true,
        getScriptSource: async () => ({scriptSource: source}),
      },
    } as never,
  );

  assert.equal(structured.length, 1);
  assert.equal(structured[0]?.scriptId, 'script-minified');
  assert.equal(structured[0]?.sourceType, 'javascript');
  assert.equal(structured[0]?.truncated, true);
  assert.equal(structured[0]?.startLine, 1);
  assert.equal(structured[0]?.endLine, 1);
  assert.equal(structured[0]?.totalLines, 1);
  assert.equal(structured[0]?.totalChars, source.length);
  assert.equal((structured[0]?.source as string).length, 1000);
  assert.match(String(structured[0]?.nextRecommendedAction), /offset\/length/);
  assert.match(lines.join('\n'), /too large/);
});
