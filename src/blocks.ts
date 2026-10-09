import { configStorage } from './config-storage';
import type { Terminal } from '@xterm/xterm';

export type BlocksMode = 'off' | 'shell' | 'compatible';

export function blocksMode(): BlocksMode {
  const value = configStorage.getItem('wterm_blocks_mode');
  return value === 'shell' || value === 'compatible' ? value : 'off';
}

interface Block {
  command: string;
  startLine: number;
  output: string;
  body: HTMLElement;
  state: HTMLElement;
}

/** An on-demand command history that replaces the terminal view while open. */
export class CommandBlocks {
  private mode: BlocksMode;
  private promptReady = false;
  private inputLine = '';
  private current?: Block;
  private refreshPending = false;
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly disposeWrite: { dispose(): void };
  private readonly disposeBuffer: { dispose(): void };
  private readonly onModeChange = () => this.setMode(blocksMode());

  constructor(private readonly term: Terminal, private readonly pane: HTMLElement,
    private readonly rerun: (command: string) => void) {
    this.mode = blocksMode();
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'blocks-toggle';
    this.toggle.textContent = '▤ 命令块';
    this.toggle.setAttribute('aria-label', '查看命令块');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.onclick = () => this.show(!this.panel.classList.contains('open'));

    this.panel = document.createElement('aside');
    this.panel.className = 'blocks-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', '命令块');
    this.panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.show(false); this.term.focus(); }
    });
    const header = document.createElement('header');
    header.className = 'blocks-header';
    const title = document.createElement('strong'); title.textContent = '命令块';
    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button'; this.closeButton.textContent = '返回终端';
    this.closeButton.setAttribute('aria-label', '关闭命令块并返回终端');
    this.closeButton.onclick = () => { this.show(false); this.term.focus(); };
    header.append(title, this.closeButton);
    this.list = document.createElement('div'); this.list.className = 'blocks-list';
    this.empty = document.createElement('p'); this.empty.className = 'blocks-empty';
    this.empty.textContent = '运行命令后，会在这里显示命令和输出。';
    this.list.append(this.empty);
    this.panel.append(header, this.list);
    pane.append(this.panel);
    pane.append(this.toggle);
    this.disposeWrite = term.onWriteParsed(() => {
      if (this.refreshPending || !this.current) return;
      this.refreshPending = true;
      requestAnimationFrame(() => { this.refreshPending = false; this.refresh(); });
    });
    this.disposeBuffer = term.buffer.onBufferChange(() => {
      if (term.buffer.active !== term.buffer.normal && this.panel.classList.contains('open')) {
        this.show(false);
        term.focus();
      }
    });
    window.addEventListener('wterm-blocks-mode-change', this.onModeChange);
    this.setMode(this.mode);
  }

  setMode(mode: BlocksMode): void {
    this.mode = mode;
    this.toggle.hidden = mode === 'off';
    if (mode === 'off') this.show(false);
    this.empty.textContent = mode === 'shell'
      ? '等待支持 OSC 133 的 Shell 提示符。运行命令后将显示在这里。'
      : '运行命令后，会在这里显示命令和输出。';
    if (mode === 'off') this.finish();
  }

  promptStart(): void {
    this.finish();
    this.promptReady = false;
  }

  private show(open: boolean): void {
    if (open && (this.mode === 'off' || this.term.buffer.active !== this.term.buffer.normal)) return;
    this.panel.classList.toggle('open', open);
    this.panel.hidden = !open;
    if (this.term.element) this.term.element.inert = open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) this.closeButton.focus();
  }

  private updateCount(): void {
    const count = this.list.querySelectorAll('.command-block').length;
    this.toggle.textContent = `▤ 命令块${count ? ` · ${count}` : ''}`;
    this.toggle.setAttribute('aria-label', `查看命令块${count ? `，${count} 条记录` : ''}`);
  }

  promptEnd(): void { this.promptReady = true; }

  commandFinished(exitCode?: string): void { this.finish(exitCode); }

  input(data: string): void {
    if (this.mode === 'off' || (this.mode === 'shell' && !this.promptReady)) return;
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const command = this.inputLine.trim();
        this.inputLine = '';
        if (command) this.submit(command);
        this.promptReady = false;
      } else if (char === '\x7f' || char === '\b') {
        this.inputLine = this.inputLine.slice(0, -1);
      } else if (char === '\x15') {
        this.inputLine = '';
      } else if (char === '\x03') {
        this.inputLine = '';
        this.finish();
      } else if (char >= ' ' && char !== '\x7f' && this.inputLine.length < 4096) {
        this.inputLine += char;
      }
    }
  }

  submit(command: string): void {
    if (this.mode === 'off') return;
    this.finish();
    this.show(false);
    const buffer = this.term.buffer.active;
    const startLine = buffer.baseY + buffer.cursorY + 1;
    const card = document.createElement('details');
    card.className = 'command-block'; card.open = true;
    const summary = document.createElement('summary');
    const label = document.createElement('code'); label.textContent = command;
    const state = document.createElement('span'); state.className = 'block-state';
    state.textContent = this.mode === 'compatible' ? '记录中' : '运行中';
    summary.append(label, state);
    const actions = document.createElement('div'); actions.className = 'block-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制';
    const run = document.createElement('button'); run.type = 'button'; run.textContent = '重新运行';
    const body = document.createElement('pre'); body.className = 'block-output';
    copy.onclick = () => {
      const output = body.textContent || '';
      void navigator.clipboard.writeText(command + (output ? '\n' + output : '')).catch(() => {});
    };
    run.onclick = () => { this.rerun(command); this.term.focus(); };
    actions.append(copy, run); card.append(summary, actions, body);
    this.empty.hidden = true; this.list.append(card);
    while (this.list.querySelectorAll('.command-block').length > 100) this.list.querySelector('.command-block')?.remove();
    this.updateCount();
    this.current = { command, startLine, output: '', body, state };
    this.list.scrollTop = this.list.scrollHeight;
  }

  private refresh(): void {
    const block = this.current;
    if (!block || this.term.buffer.active !== this.term.buffer.normal) return;
    const buffer = this.term.buffer.normal;
    const end = Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
    const first = Math.max(block.startLine, end - 1999);
    const lines: string[] = [];
    for (let i = first; i <= end; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    const output = lines.join('\n').slice(-200_000).trimEnd();
    if (output !== block.output) {
      block.output = output;
      block.body.textContent = output;
      this.list.scrollTop = this.list.scrollHeight;
    }
  }

  finish(exitCode?: string): void {
    if (!this.current) return;
    this.refresh();
    this.current.state.textContent = exitCode === undefined ? '完成' : `退出 ${exitCode}`;
    this.current.state.classList.toggle('failed', exitCode !== undefined && exitCode !== '0');
    this.current = undefined;
  }

  dispose(): void {
    this.mode = 'off';
    this.finish();
    this.disposeWrite.dispose();
    this.disposeBuffer.dispose();
    window.removeEventListener('wterm-blocks-mode-change', this.onModeChange);
    this.toggle.remove(); this.panel.remove();
  }
}
