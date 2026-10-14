import { AiPanel, type AiPanelDeps } from './ai-panel';
import type { Terminal } from '@xterm/xterm';
import type { FailedCommand } from './ai-helpers';
import { attachSelectionActions, type AiSelectionAction } from './ai-selection';
export { AI_SELECTION_ACTIONS } from './ai-selection';
export { AiPanel } from './ai-panel';
export type { AiPanelDeps } from './ai-panel';
export * from './ai-helpers';
export { connectionForProfile } from './ai-history';

// ---------- 选中浮动按钮 ----------

/**
 * AI 可用且有选中文字时显示入口，选择动作后带入聊天框。
 * 与「命令块」浮动按钮同一设计语言。
 */
export function attachSelectionButton(pane: HTMLElement, term: Terminal, onAction: (text: string, action: AiSelectionAction) => void): () => void {
  return attachSelectionActions(pane, term, onAction);
}

let panel: AiPanel | null = null;

export function initPanel(container: HTMLElement, deps: AiPanelDeps): void {
  panel?.dispose();
  panel = new AiPanel(container, deps);
}

export function togglePanel(): void {
  panel?.toggle();
}

export function openPanel(): void {
  panel?.open();
}

export function explainSelection(): void {
  panel?.explainSelection();
}

export function sessionChanged(id: string | null): void { panel?.sessionChanged(id); }
export function flushHistory(): Promise<void> { return panel?.flush() ?? Promise.resolve(); }
export function diagnoseFailure(sid: string, failure: FailedCommand): void { panel?.diagnoseFailure(sid, failure); }

/** 供 main.ts 在每个会话创建后调用：挂载选中浮动按钮。 */
export function prepareSelection(text: string, action: AiSelectionAction, sid?: string): void { panel?.prepareSelection(text, action, sid); }
export function watchSelection(pane: HTMLElement, term: Terminal, sid: string): () => void {
  return attachSelectionButton(pane, term, (text, action) => panel?.prepareSelection(text, action, sid));
}
