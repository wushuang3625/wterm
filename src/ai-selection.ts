import type { Terminal } from '@xterm/xterm';
import { aiReady } from './ai-config';

export type AiSelectionAction = 'explain' | 'diagnose' | 'attach';
export const AI_SELECTION_ACTIONS: { action: AiSelectionAction; label: string }[] = [
  { action: 'explain', label: '解释命令' },
  { action: 'diagnose', label: '排查问题' },
  { action: 'attach', label: '插入会话' },
];

export function selectionDraft(text: string, action: AiSelectionAction): string {
  const content = text.trim().slice(0, 6000);
  return action === 'explain' ? '请解释下面命令的含义和参数：\n\n' + content
    : action === 'diagnose' ? '请根据下面的终端内容排查问题，说明可能原因和排查步骤：\n\n' + content : content;
}

export function attachSelectionActions(pane: HTMLElement, term: Terminal, choose: (text: string, action: AiSelectionAction) => void): () => void {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'ai-select-btn';
  button.textContent = 'AI ▾'; button.title = '使用选中内容'; button.setAttribute('aria-label', '选中内容的 AI 操作'); button.setAttribute('aria-haspopup', 'menu');
  let menu: HTMLElement | undefined;
  let snapshot = '';
  let selecting = false;
  let anchor: { x: number; y: number } | undefined;
  let frame: number | undefined;
  const close = () => { menu?.remove(); menu = undefined; button.setAttribute('aria-expanded', 'false'); };
  const update = () => {
    button.hidden = selecting || !aiReady() || !term.hasSelection() || !pane.getClientRects().length;
    if (button.hidden) { close(); return; }
    const bounds = pane.getBoundingClientRect();
    if (!anchor) {
      const screen = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
      const end = term.getSelectionPosition()?.end;
      anchor = screen && end ? { x: screen.left - bounds.left + end.x * screen.width / term.cols,
        y: screen.top - bounds.top + (end.y - term.buffer.active.viewportY + 1) * screen.height / term.rows } : { x: 8, y: 8 };
    }
    const width = button.offsetWidth, height = button.offsetHeight;
    const x = anchor.x + 12 + width <= bounds.width - 8 ? anchor.x + 12 : anchor.x - width - 12;
    const y = anchor.y + 12 + height <= bounds.height - 8 ? anchor.y + 12 : anchor.y - height - 12;
    button.style.left = Math.max(8, Math.min(x, bounds.width - width - 8)) + 'px';
    button.style.top = Math.max(8, Math.min(y, bounds.height - height - 8)) + 'px';
  };
  const beginSelection = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.xterm')) return;
    selecting = true; anchor = undefined; snapshot = ''; button.hidden = true; close();
  };
  const endSelection = (event: MouseEvent) => {
    if (!selecting || event.button !== 0) return;
    selecting = false;
    const bounds = pane.getBoundingClientRect(); anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    // xterm finishes its selection on mouseup; reveal the action after that event.
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = undefined; update(); });
  };
  button.onpointerdown = event => { snapshot = term.getSelection(); event.preventDefault(); event.stopPropagation(); };
  button.onclick = () => {
    if (menu) { close(); return; }
    const text = snapshot || term.getSelection(); snapshot = ''; if (!text.trim()) return;
    menu = document.createElement('div'); const current = menu;
    current.className = 'menu-dropdown ai-selection-menu'; current.popover = 'auto'; current.setAttribute('role', 'menu'); current.setAttribute('aria-label', '选中内容的 AI 操作');
    for (const item of AI_SELECTION_ACTIONS) {
      const action = document.createElement('button'); action.type = 'button'; action.className = 'menu-item'; action.setAttribute('role', 'menuitem'); action.textContent = item.label;
      action.onclick = () => { close(); choose(text, item.action); }; current.append(action);
    }
    current.onkeydown = event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); button.focus(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const actions = [...current.querySelectorAll<HTMLButtonElement>('button')];
      const index = actions.indexOf(document.activeElement as HTMLButtonElement);
      actions[event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length].focus();
    };
    current.addEventListener('toggle', () => { if (!current.matches(':popover-open') && menu === current) close(); });
    document.body.append(current); current.showPopover();
    const owner = button.getBoundingClientRect(), bounds = current.getBoundingClientRect();
    current.style.left = Math.max(8, Math.min(owner.left, window.innerWidth - bounds.width - 8)) + 'px';
    const top = owner.bottom + bounds.height + 4 <= window.innerHeight - 8 ? owner.bottom + 4 : owner.top - bounds.height - 4;
    current.style.top = Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) + 'px';
    button.setAttribute('aria-expanded', 'true'); current.querySelector<HTMLButtonElement>('button')!.focus();
  };
  pane.append(button); const selection = term.onSelectionChange(update); update();
  pane.addEventListener('mousedown', beginSelection, true); document.addEventListener('mouseup', endSelection);
  const resized = () => { close(); update(); };
  const observer = new ResizeObserver(resized); observer.observe(pane);
  window.addEventListener('wterm-ai-config-change', update); window.addEventListener('resize', resized);
  return () => {
    close(); selection.dispose(); observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); button.remove();
    pane.removeEventListener('mousedown', beginSelection, true); document.removeEventListener('mouseup', endSelection);
    window.removeEventListener('wterm-ai-config-change', update); window.removeEventListener('resize', resized);
  };
}
