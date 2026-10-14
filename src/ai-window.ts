import { configStorage } from './config-storage';
import { aiIcon } from './ai-icons';

type Mode = 'left' | 'right' | 'docked';

/** Docking keeps the assistant and the terminal visible beside each other. */
export class AiWindow {
  private mode: Mode = 'right';
  private dockWidth = 520;
  private dockHeight = 320;
  private observer: ResizeObserver;
  private activePointer: number | null = null;
  private initial: { x: number; y: number; width: number; height: number } | null = null;
  private readonly modeButton: HTMLButtonElement;
  private readonly sideButton: HTMLButtonElement;
  private side: 'left' | 'right' = 'right';
  private readonly divider: HTMLElement;

  constructor(private panel: HTMLElement, private container: HTMLElement) {
    this.modeButton = panel.querySelector<HTMLButtonElement>('.ai-mode')!;
    this.sideButton = panel.querySelector<HTMLButtonElement>('.ai-side')!;
    try {
      const saved = JSON.parse(configStorage.getItem('wterm_ai_window') || 'null');
      // Old floating geometry must not override the right-docked default.
      if (saved?.version === 3) {
        if (['left', 'right', 'docked'].includes(saved.mode)) this.mode = saved.mode;
        if (saved.side === 'left') this.side = 'left';
        if (Number.isFinite(saved.dockWidth)) this.dockWidth = saved.dockWidth;
        if (Number.isFinite(saved.dockHeight)) this.dockHeight = saved.dockHeight;
      }
    } catch { /* Ignore invalid stored geometry. */ }
    this.modeButton.onclick = () => {
      this.mode = this.mode === 'docked' ? this.side : 'docked';
      this.layout(); this.save();
    };
    this.sideButton.onclick = () => {
      this.side = this.side === 'right' ? 'left' : 'right'; this.mode = this.side;
      this.layout(); this.save();
    };
    this.divider = document.createElement('div');
    this.divider.className = 'ai-dock-divider'; this.divider.tabIndex = 0;
    this.divider.setAttribute('role', 'separator');
    this.divider.addEventListener('keydown', event => {
      const vertical = this.mode !== 'docked';
      const keys = vertical ? ['ArrowLeft', 'ArrowRight', 'Home', 'End'] : ['ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const smaller = event.key === (vertical ? (this.side === 'right' ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp');
      if (vertical) this.dockWidth = event.key === 'Home' ? 300 : event.key === 'End' ? this.container.clientWidth : this.dockWidth + (smaller ? -20 : 20);
      else this.dockHeight = event.key === 'Home' ? 220 : event.key === 'End' ? this.container.clientHeight : this.dockHeight + (smaller ? -20 : 20);
      this.layout(); this.save();
    });
    panel.append(this.divider);
    this.divider.addEventListener('pointerdown', this.pointerDown);
    this.divider.addEventListener('pointermove', this.pointerMove);
    this.divider.addEventListener('pointerup', this.pointerEnd);
    this.divider.addEventListener('pointercancel', this.pointerEnd);
    this.divider.addEventListener('lostpointercapture', this.pointerEnd);
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(container); this.layout();
  }

  private save(): void {
    configStorage.setItem('wterm_ai_window', JSON.stringify({ version: 3, mode: this.mode, side: this.side, dockWidth: this.dockWidth, dockHeight: this.dockHeight }));
  }

  layout(): void {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (!width || !height) return;
    const maximumWidth = Math.min(width, Math.max(280, width - 320));
    const minimumWidth = Math.min(this.panel.classList.contains('ai-history-open') ? 420 : 300, maximumWidth);
    this.dockWidth = Math.min(Math.max(minimumWidth, this.dockWidth), maximumWidth);
    this.dockHeight = Math.max(Math.min(220, height * .6), Math.min(this.dockHeight, height - 160));
    const top = this.mode === 'docked', open = this.panel.classList.contains('open');
    this.panel.classList.toggle('ai-left', this.mode === 'left'); this.panel.classList.toggle('ai-right', this.mode === 'right'); this.panel.classList.toggle('ai-docked', top);
    this.container.classList.toggle('ai-dock-open', top && open); this.container.classList.toggle('ai-left-open', this.mode === 'left' && open); this.container.classList.toggle('ai-right-open', this.mode === 'right' && open);
    this.modeButton.innerHTML = aiIcon(top ? 'sidebar' : 'dock');
    this.modeButton.title = top ? (this.side === 'right' ? '停靠右侧' : '停靠左侧') : '停靠上方';
    this.modeButton.setAttribute('aria-label', this.modeButton.title);
    this.modeButton.setAttribute('aria-pressed', String(top));
    this.sideButton.innerHTML = aiIcon(this.side === 'right' ? 'left' : 'right');
    this.sideButton.title = this.side === 'right' ? '移到左侧' : '移到右侧'; this.sideButton.setAttribute('aria-label', this.sideButton.title);
    Object.assign(this.panel.style, { left: '', top: '', width: top ? '' : this.dockWidth + 'px', height: top ? this.dockHeight + 'px' : '' });
    this.divider.setAttribute('aria-label', top ? '调整 AI 与终端的高度' : '调整 AI 与终端的宽度');
    this.divider.setAttribute('aria-orientation', top ? 'horizontal' : 'vertical');
    this.divider.setAttribute('aria-valuenow', String(Math.round(top ? this.dockHeight : this.dockWidth)));
    this.divider.setAttribute('aria-valuemin', String(Math.round(top ? Math.min(220, height * .6) : minimumWidth)));
    this.divider.setAttribute('aria-valuemax', String(Math.round(top ? height - 160 : maximumWidth)));
  }

  private pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.activePointer = event.pointerId;
    this.initial = { x: event.clientX, y: event.clientY, width: this.dockWidth, height: this.dockHeight };
    this.divider.setPointerCapture(event.pointerId); this.panel.classList.add('ai-manipulating');
  };
  private pointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointer || !this.initial) return;
    if (this.mode !== 'docked') this.dockWidth = this.initial.width + (this.side === 'right' ? -1 : 1) * (event.clientX - this.initial.x);
    else this.dockHeight = this.initial.height + event.clientY - this.initial.y;
    this.layout();
  };
  private pointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointer) return;
    this.activePointer = null; this.initial = null; this.panel.classList.remove('ai-manipulating');
    if (this.divider.hasPointerCapture(event.pointerId)) this.divider.releasePointerCapture(event.pointerId);
    this.save();
  };
  dispose(): void {
    this.observer.disconnect(); this.container.classList.remove('ai-dock-open', 'ai-left-open', 'ai-right-open');
    this.divider.removeEventListener('pointerdown', this.pointerDown); this.divider.removeEventListener('pointermove', this.pointerMove);
    this.divider.removeEventListener('pointerup', this.pointerEnd); this.divider.removeEventListener('pointercancel', this.pointerEnd);
    this.divider.removeEventListener('lostpointercapture', this.pointerEnd);
  }
}
