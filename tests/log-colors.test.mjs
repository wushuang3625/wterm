import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const result = await build({ entryPoints: ['src/log-colors.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { logTokens } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
test('Java logs and JSON levels retain exact token offsets', () => {
 const line = '[trace] 2026-09-21 14:22:25.358 INFO 中文 java.lang.NullPointerException';
 const tokens = logTokens(line);
 assert.deepEqual(tokens.map(t => t.kind), ['debug', 'time', 'info', 'error']);
 assert.equal(line.slice(tokens[3].start, tokens[3].end), 'java.lang.NullPointerException');
 assert.equal(logTokens('{"level":"warning","msg":"failed"}')[0].kind, 'warn');
 assert.deepEqual(logTokens('information debugged error_count'), []);
});
