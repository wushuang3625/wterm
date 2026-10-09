import type { ITerminalAddon, Terminal } from '@xterm/xterm';

const MAX_IMAGE_BYTES = 20_000_000;

function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  return null;
}

/** Displays iTerm2 inline images outside xterm's reflowing character grid. */
export class InlineImagePreviewAddon implements ITerminalAddon {
  private readonly trigger = document.createElement('button');
  private readonly viewer = document.createElement('section');
  private readonly image = document.createElement('img');
  private readonly meta = document.createElement('span');
  private readonly sizeButton = document.createElement('button');
  private handler?: { dispose(): void };
  private objectUrl?: string;
  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !this.viewer.hidden) this.viewer.hidden = true;
  };

  constructor(private readonly container: HTMLElement) {
    this.trigger.type = 'button';
    this.trigger.className = 'inline-image-trigger';
    this.trigger.textContent = '▣ 图片预览';
    this.trigger.hidden = true;
    this.trigger.onclick = () => { this.viewer.hidden = false; };

    this.viewer.className = 'inline-image-viewer';
    this.viewer.hidden = true;
    this.viewer.setAttribute('aria-label', '终端图片预览');
    const header = document.createElement('header');
    const title = document.createElement('strong'); title.textContent = '图片预览';
    this.meta.className = 'inline-image-meta';
    this.sizeButton.type = 'button';
    this.sizeButton.textContent = '原始大小';
    this.sizeButton.onclick = () => {
      const original = this.viewer.classList.toggle('original-size');
      this.sizeButton.textContent = original ? '适应窗口' : '原始大小';
    };
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭图片预览');
    close.onclick = () => { this.viewer.hidden = true; };
    header.append(title, this.meta, this.sizeButton, close);
    const body = document.createElement('div'); body.className = 'inline-image-body';
    this.image.alt = '终端输出的图片';
    this.image.onload = () => { this.meta.textContent = `${this.image.naturalWidth} × ${this.image.naturalHeight}`; };
    body.append(this.image);
    this.viewer.append(header, body);
  }

  activate(term: Terminal): void {
    this.container.append(this.trigger, this.viewer);
    this.handler = term.parser.registerOscHandler(1337, value => this.receive(value));
    window.addEventListener('keydown', this.onKey);
  }

  private receive(value: string): boolean {
    if (!value.startsWith('File=')) return false;
    const colon = value.indexOf(':');
    if (colon < 0) return true;
    const header = value.slice(5, colon);
    if (!/(?:^|;)inline=1(?:;|$)/.test(header)) return true;
    const size = Number(/(?:^|;)size=(\d+)(?:;|$)/.exec(header)?.[1]);
    const encoded = value.slice(colon + 1);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES || encoded.length > Math.ceil(size / 3) * 4 + 4) return true;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return true;
    try {
      const raw = atob(encoded);
      if (raw.length !== size) return true;
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      const mime = imageMime(bytes);
      if (!mime) return true;
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = url;
      this.image.src = url;
      this.viewer.classList.remove('original-size');
      this.sizeButton.textContent = '原始大小';
      this.meta.textContent = '';
      this.trigger.hidden = false;
      this.viewer.hidden = false;
    } catch {
      // Malformed or unsupported image data is ignored like other terminal graphics.
    }
    return true;
  }

  dispose(): void {
    this.handler?.dispose();
    window.removeEventListener('keydown', this.onKey);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.trigger.remove();
    this.viewer.remove();
  }
}
