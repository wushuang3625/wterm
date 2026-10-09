// Use pointer events: Tauri's native file drop handler intercepts HTML drag/drop
// on Windows, and must stay enabled for SFTP file uploads.
export function bindTabDrag(container: HTMLElement, move: (id: string, targetId: string) => void): () => void {
  let drag: { pointerId: number; id: string; x: number; y: number; currentX: number; currentY: number; grabOffset: number; dragging: boolean; targetId?: string } | undefined;
  let suppressClick = false;
  const tabs = () => [...container.querySelectorAll<HTMLElement>('.tab')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const slot = document.createElement('div');
  slot.className = 'tab-drop-slot';
  slot.setAttribute('aria-hidden', 'true');

  // Layout coordinates stay stable while tabs are visually translated to make
  // room. Hit-testing the moving elements would make the insertion point jitter.
  function layoutLeft(el: HTMLElement): number {
    return container.getBoundingClientRect().left + el.offsetLeft - container.scrollLeft;
  }

  function refresh(): void {
    const items = tabs();
    const from = items.findIndex(el => el.dataset.sid === drag?.id);
    const to = items.findIndex(el => el.dataset.sid === drag?.targetId);
    container.classList.toggle('tab-sorting', !!drag?.dragging);
    const source = items[from];
    const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
    const shift = source ? source.offsetWidth + gap : 0;
    items.forEach((el, index) => {
      el.classList.toggle('dragging', !!drag?.dragging && index === from);
      el.classList.toggle('drop-before', !!drag?.dragging && index === to && to < from);
      el.classList.toggle('drop-after', !!drag?.dragging && index === to && to > from);
      let offset = 0;
      if (drag?.dragging && source) {
        if (index === from) {
          const bounds = container.getBoundingClientRect();
          const left = Math.max(bounds.left, Math.min(drag.currentX - drag.grabOffset, bounds.right - source.offsetWidth));
          offset = left - layoutLeft(source);
        } else if (to > from && index > from && index <= to) offset = -shift;
        else if (to >= 0 && to < from && index >= to && index < from) offset = shift;
      }
      if (drag?.dragging) el.style.transform = `translateX(${offset}px)`;
      else el.style.removeProperty('transform');
    });
    if (drag?.dragging && source && to >= 0) {
      const destination = items[to];
      const left = destination.offsetLeft + (to > from ? destination.offsetWidth - source.offsetWidth : 0);
      slot.style.width = `${source.offsetWidth}px`;
      slot.style.height = `${source.offsetHeight}px`;
      slot.style.top = `${source.offsetTop}px`;
      slot.style.transform = `translateX(${left}px)`;
      if (slot.parentElement !== container) container.appendChild(slot);
    } else slot.remove();
  }

  function targetAt(x: number, y: number): string | undefined {
    const bounds = container.getBoundingClientRect();
    if (y < bounds.top || y > bounds.bottom || x < bounds.left || x > bounds.right) return;
    const items = tabs();
    const el = items.find(item => x < layoutLeft(item) + item.offsetWidth) ?? items.at(-1);
    return el?.dataset.sid;
  }

  function finish(commit: boolean): void {
    const previous = drag;
    const positions = new Map(tabs().map(el => [el.dataset.sid, el.getBoundingClientRect().left]));
    drag = undefined;
    if (!previous) return;
    suppressClick = previous.dragging;
    if (container.hasPointerCapture(previous.pointerId)) container.releasePointerCapture(previous.pointerId);
    refresh();
    if (commit && previous.dragging && previous.targetId && previous.targetId !== previous.id) {
      move(previous.id, previous.targetId);
    }
    if (previous.dragging && !reducedMotion.matches) {
      tabs().forEach(el => {
        const before = positions.get(el.dataset.sid);
        if (before === undefined) return;
        const delta = before - el.getBoundingClientRect().left;
        if (Math.abs(delta) < 1) return;
        el.animate([{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], {
          duration: 180, easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
        });
      });
    }
  }

  container.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    suppressClick = false;
    if (event.target.closest('.close')) return;
    const tab = event.target.closest<HTMLElement>('.tab');
    if (!tab?.dataset.sid) return;
    // A new drag can interrupt a settling animation without leaving transforms.
    tabs().forEach(el => el.getAnimations().forEach(animation => animation.cancel()));
    drag = {
      pointerId: event.pointerId, id: tab.dataset.sid, x: event.clientX, y: event.clientY,
      currentX: event.clientX, currentY: event.clientY,
      grabOffset: event.clientX - tab.getBoundingClientRect().left, dragging: false,
    };
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!(event.buttons & 1)) { finish(false); return; }
    if (!drag.dragging && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    if (!drag.dragging) {
      drag.dragging = true;
      // Capture after the threshold so ordinary tab clicks retain their target.
      // The stable container survives title/status updates recreating tab nodes.
      container.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    drag.currentX = event.clientX;
    drag.currentY = event.clientY;
    const bounds = container.getBoundingClientRect();
    if (event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
      if (event.clientX < bounds.left + 24) container.scrollLeft -= 16;
      else if (event.clientX > bounds.right - 24) container.scrollLeft += 16;
    }
    drag.targetId = targetAt(event.clientX, event.clientY);
    refresh();
  });
  window.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.targetId = targetAt(event.clientX, event.clientY);
    finish(true);
  });
  container.addEventListener('pointercancel', () => finish(false));
  container.addEventListener('lostpointercapture', () => finish(false));
  container.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(false); }
  });
  return refresh;
}
