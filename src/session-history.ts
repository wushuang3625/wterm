import type { TermSession } from './terminal';

// Bound workspace storage, including many tabs, below WebView storage quotas.
export const MAX_HISTORY_CHARS = 128_000;
export const WORKSPACE_HISTORY_CHARS = 1_000_000;
const MAX_HISTORY_ROWS = 10_000;

export interface SessionHistory {
  screen: string;
  cols: number;
  rows: number;
  savedAt: number;
}

export function captureHistory(session: TermSession, maxChars = MAX_HISTORY_CHARS): SessionHistory | undefined {
  const { term, serialize } = session;
  let scrollback = Math.min(MAX_HISTORY_ROWS, term.buffer.normal.baseY);
  while (true) {
    const screen = serialize.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true });
    if (screen.length <= maxChars) return { screen, cols: term.cols, rows: term.rows, savedAt: Date.now() };
    // Serialize fewer complete rows, never slicing through ANSI or CJK data.
    if (scrollback === 0) return undefined;
    scrollback = Math.floor(scrollback / 2);
  }
}

export async function restoreHistory(session: TermSession, history?: SessionHistory): Promise<void> {
  if (!history || typeof history.screen !== 'string' || !history.screen || history.screen.length > MAX_HISTORY_CHARS ||
      !Number.isInteger(history.cols) || !Number.isInteger(history.rows) ||
      history.cols < 1 || history.cols > 1000 || history.rows < 1 || history.rows > 1000) return;
  const { term, fit } = session;
  // Restore wrapped/CJK rows at their original width, then let xterm reflow.
  term.resize(history.cols, history.rows);
  await new Promise<void>(resolve => term.write(history.screen, resolve));
  await new Promise<void>(resolve => term.write('\x1b[0m\r\n\x1b[90m── 上次会话历史 · 以下为新会话 ──\x1b[0m\r\n', resolve));
  fit.fit();
}
