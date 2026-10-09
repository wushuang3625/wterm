import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadModule(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const { WTERM_THEMES } = await loadModule('src/themes.ts');
const { defaultLogColorRules } = await loadModule('src/log-colors.ts');

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).slice(0, 3).map(value => parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('reading themes keep text, ANSI foregrounds, and default log rows readable', () => {
  const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  for (const id of ['eye-green', 'warm-paper', 'everforest', 'zenburn']) {
    const theme = WTERM_THEMES.find(item => item.id === id);
    assert.ok(theme, `${id} exists`);
    const [background, , hover, , text, dim, accent, green, yellow, red] = theme.ui;
    for (const [name, foreground, surface] of [
      ['text', text, background], ['dim on hover', dim, hover], ['accent', accent, background],
      ['green', green, background], ['yellow', yellow, background], ['red on hover', red, hover],
    ]) assert.ok(contrast(foreground, surface) >= 4.5, `${id} ${name}`);
    for (const name of ansiNames) assert.ok(contrast(theme.terminal[name], background) >= 4.5, `${id} ANSI ${name}`);
  }
});

test('default log colors adapt to every built-in theme', () => {
  for (const theme of WTERM_THEMES) {
    for (const rule of defaultLogColorRules(theme.id)) {
      assert.ok(contrast(rule.foreground, theme.ui[0]) >= 4.5, `${theme.id} log ${rule.pattern}`);
    }
  }
});
