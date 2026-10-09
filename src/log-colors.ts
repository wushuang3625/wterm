import { configStorage } from './config-storage';
import type { Terminal, ITerminalAddon, IDisposable } from '@xterm/xterm';
import { currentThemeId, getTheme } from './themes';

export interface LogColorRule {
  pattern: string;
  regex: boolean;
  foreground: string;
  background: string;
}

export const DEFAULT_LOG_COLOR_RULES: LogColorRule[] = [
  { pattern: '\\b(?:ERROR|FATAL|CRITICAL|[\\w.$]*(?:Exception|Error))\\b', regex: true, foreground: '#ff8585', background: '' },
  { pattern: '\\bWARN(?:ING)?\\b', regex: true, foreground: '#ffd479', background: '' },
  { pattern: '\\b(?:INFO|NOTICE)\\b', regex: true, foreground: '#8ddb9d', background: '' },
  { pattern: '\\b(?:DEBUG|TRACE)\\b', regex: true, foreground: '#91c8ff', background: '' },
];

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function readableForeground(foreground: string, background: string): string {
  const surface = luminance(background);
  const contrast = (color: string) => {
    const text = luminance(color);
    return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
  };
  if (contrast(foreground) >= 4.5) return foreground;
  const source = [1, 3, 5].map(index => parseInt(foreground.slice(index, index + 2), 16));
  const target = surface > 0.179 ? 0 : 255;
  const blend = (amount: number) => `#${source.map(value => Math.round(value + (target - value) * amount).toString(16).padStart(2, '0')).join('')}`;
  let low = 0, high = 1;
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    if (contrast(blend(middle)) >= 4.5) high = middle;
    else low = middle;
  }
  return blend(high);
}

export function defaultLogColorRules(themeId?: string): LogColorRule[] {
  const activeId = themeId || (typeof document !== 'undefined' && document.documentElement.dataset.theme) || currentThemeId();
  const [background, , , , , , accent, green, yellow, red] = getTheme(activeId).ui;
  return DEFAULT_LOG_COLOR_RULES.map((rule, index) => ({
    ...rule,
    foreground: readableForeground([red, yellow, green, accent][index], background),
  }));
}

const STORAGE_KEY = 'wterm_log_color_rules';
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function ruleError(rule: LogColorRule): string | undefined {
  if (!rule.pattern.trim()) return '匹配文本不能为空';
  if (rule.pattern.length > 256) return '匹配文本不能超过 256 个字符';
  if (!COLOR.test(rule.foreground) || (rule.background && !COLOR.test(rule.background))) return '颜色必须是 #RRGGBB 格式';
  if (rule.regex) {
    try { new RegExp(rule.pattern, 'i'); } catch { return '正则表达式无效'; }
  }
}

export function loadLogColorRules(): LogColorRule[] {
  try {
    const stored: unknown = JSON.parse(configStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(stored) && stored.length <= 50 && stored.every(rule => rule && typeof rule.pattern === 'string' && typeof rule.regex === 'boolean' && typeof rule.foreground === 'string' && typeof rule.background === 'string' && !ruleError(rule))) {
      // Earlier builds saved fixed dark-theme defaults whenever settings were saved.
      if (JSON.stringify(stored) !== JSON.stringify(DEFAULT_LOG_COLOR_RULES)) return stored;
    }
  } catch { /* Use defaults if storage is malformed. */ }
  return defaultLogColorRules();
}

export function saveLogColorRules(rules?: LogColorRule[]): void {
  if (rules) configStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  else configStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('wterm-log-colors-changed'));
}

export function matchingLogColorRule(text: string, rules: LogColorRule[]): LogColorRule | undefined {
  for (const rule of rules) {
    if (rule.regex ? new RegExp(rule.pattern, 'i').test(text) : text.toLocaleLowerCase().includes(rule.pattern.toLocaleLowerCase())) return rule;
  }
}

/** Paint visible normal-buffer rows without rewriting PTY output or copied text. */
export class LogColorsAddon implements ITerminalAddon {
  private subscriptions: IDisposable[] = [];
  private decorations: IDisposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private term?: Terminal;
  private schedule = () => {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.paint(); }, 80);
  };
  activate(term: Terminal): void {
    this.term = term;
    this.subscriptions.push(term.onWriteParsed(this.schedule), term.onScroll(this.schedule), term.onResize(this.schedule), term.buffer.onBufferChange(this.schedule));
    window.addEventListener('wterm-appearance-changed', this.schedule);
    window.addEventListener('wterm-theme-changed', this.schedule);
    window.addEventListener('wterm-log-colors-changed', this.schedule);
    this.schedule();
  }
  private clear(): void { this.decorations.splice(0).forEach(item => item.dispose()); }
  private paint(): void {
    this.clear();
    const term = this.term;
    if (!term || configStorage.getItem('wterm_log_colors') === 'false' || term.buffer.active !== term.buffer.normal) return;
    const rules = loadLogColorRules();
    if (!rules.length) return;
    const buffer = term.buffer.active;
    let row = buffer.viewportY;
    while (row > 0 && buffer.getLine(row)?.isWrapped && buffer.viewportY - row < 32) row--;
    const bottom = Math.min(buffer.length, buffer.viewportY + term.rows);
    let count = 0;
    while (row < bottom && count < 1000) {
      const rows: number[] = [];
      let text = '';
      do {
        const line = buffer.getLine(row);
        if (!line) break;
        rows.push(row);
        text += line.translateToString(true);
        row++;
      } while (row < bottom && buffer.getLine(row)?.isWrapped && text.length < 16384);
      const rule = matchingLogColorRule(text, rules);
      if (!rule) continue;
      for (const physicalRow of rows) {
        if (physicalRow < buffer.viewportY || count >= 1000) continue;
        const marker = term.registerMarker(physicalRow - buffer.baseY - buffer.cursorY);
        if (!marker) continue;
        const decoration = term.registerDecoration({ marker, x: 0, width: term.cols, foregroundColor: rule.foreground, ...(rule.background ? { backgroundColor: rule.background } : {}), layer: 'bottom' });
        this.decorations.push(marker);
        if (decoration) this.decorations.push(decoration);
        count++;
      }
    }
  }
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.subscriptions.splice(0).forEach(item => item.dispose());
    window.removeEventListener('wterm-appearance-changed', this.schedule);
    window.removeEventListener('wterm-theme-changed', this.schedule);
    window.removeEventListener('wterm-log-colors-changed', this.schedule);
    this.clear(); this.term = undefined;
  }
}
