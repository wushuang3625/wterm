import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const result = await build({ entryPoints: ['src/log-colors.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { DEFAULT_LOG_COLOR_RULES, matchingLogColorRule, ruleError } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('default rules match log levels and exceptions across a full line', () => {
  const rules = DEFAULT_LOG_COLOR_RULES;
  assert.equal(matchingLogColorRule('2026-09-21 INFO hello', rules), rules[2]);
  assert.equal(matchingLogColorRule('warning from remote', rules), rules[1]);
  assert.equal(matchingLogColorRule('java.lang.NullPointerException', rules), rules[0]);
  assert.equal(matchingLogColorRule('information debugged error_count', rules), undefined);
});

test('first matching rule wins, plain text is literal, and invalid regex is rejected', () => {
  const rules = [
    { pattern: 'failed', regex: false, foreground: '#123456', background: '#654321' },
    { pattern: 'fail.*', regex: true, foreground: '#ffffff', background: '' },
  ];
  assert.equal(matchingLogColorRule('FAILED transfer', rules), rules[0]);
  assert.equal(matchingLogColorRule('failover', rules), rules[1]);
  assert.equal(matchingLogColorRule('axb', [{ ...rules[0], pattern: 'a.b' }]), undefined);
  assert.equal(ruleError({ ...rules[0], pattern: '[' , regex: true }), '正则表达式无效');
});
