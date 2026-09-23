import type { Terminal, ITerminalAddon, IDisposable } from '@xterm/xterm';

export interface LogToken { start: number; end: number; kind: 'error' | 'warn' | 'info' | 'debug' | 'time' }

/** Match text only; never rewrite the PTY stream or its escape sequences. */
export function logTokens(text: string): LogToken[] {
  const pattern = /\b(?:TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b|\b[\w.$]*(?:Exception|Error)\b|\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:\d{2})?/gi;
  return Array.from(text.matchAll(pattern), match => {
    const value = match[0].toUpperCase();
    const kind = /^\d/.test(value) ? 'time' : /ERROR|EXCEPTION|FATAL|CRITICAL/.test(value) ? 'error' : /^WARN/.test(value) ? 'warn' : /INFO|NOTICE/.test(value) ? 'info' : 'debug';
    return { start: match.index!, end: match.index! + match[0].length, kind };
  });
}

/** Only decorate visible normal-buffer cells. Scrollback and copied text stay original. */
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
    this.schedule();
  }
  private clear(): void { this.decorations.splice(0).forEach(item => item.dispose()); }
  private paint(): void {
    this.clear();
    const term = this.term;
    if (!term || localStorage.getItem('wterm_log_colors') === 'false' || term.buffer.active !== term.buffer.normal) return;
    const buffer = term.buffer.active;
    const style = getComputedStyle(document.documentElement);
    const colors = { error: style.getPropertyValue('--red').trim() || '#e06c75', warn: style.getPropertyValue('--yellow').trim() || '#e5c07b', info: style.getPropertyValue('--green').trim() || '#98c379', debug: style.getPropertyValue('--accent').trim() || '#56b6c2', time: style.getPropertyValue('--text-dim').trim() || '#8b949e' };
    let count = 0;
    // A logical log line can wrap across multiple terminal rows, including mid-token.
    let row = buffer.viewportY;
    while (row > 0 && buffer.getLine(row)?.isWrapped && buffer.viewportY - row < 32) row--;
    const bottom = Math.min(buffer.length, buffer.viewportY + term.rows);
    while (row < bottom && count < 1000) {
      let text = '';
      const cells: Array<{ row: number; col: number; start: number; end: number; width: number; plain: boolean }> = [];
      do {
        const line = buffer.getLine(row);
        if (!line) break;
        for (let col = 0; col < line.length; col++) {
          const cell = line.getCell(col);
          if (!cell || !cell.getWidth()) continue;
          const start = text.length;
          text += cell.getChars() || ' ';
          cells.push({ row, col, start, end: text.length, width: cell.getWidth(), plain: cell.isFgDefault() && cell.isBgDefault() });
        }
        row++;
      } while (row < bottom && buffer.getLine(row)?.isWrapped && text.length < 16384);
      for (const token of logTokens(text)) {
        const matching = cells.filter(cell => cell.row >= buffer.viewportY && cell.plain && cell.start < token.end && cell.end > token.start);
        for (let i = 0; i < matching.length && count < 1000;) {
          const first = matching[i++]; let width = first.width;
          while (i < matching.length && matching[i].row === first.row && matching[i].col === first.col + width) width += matching[i++].width;
          const marker = term.registerMarker(first.row - buffer.baseY - buffer.cursorY);
          if (!marker) continue;
          const decoration = term.registerDecoration({ marker, x: first.col, width, foregroundColor: colors[token.kind], layer: 'bottom' });
          this.decorations.push(marker);
          if (decoration) this.decorations.push(decoration);
          count++;
        }
      }
    }
  }
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.subscriptions.splice(0).forEach(item => item.dispose());
    window.removeEventListener('wterm-appearance-changed', this.schedule);
    window.removeEventListener('wterm-theme-changed', this.schedule);
    this.clear(); this.term = undefined;
  }
}
