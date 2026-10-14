const paths = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  dock: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 10h18"/>',
  left: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m8-7-3-3 3-3M14 10h5"/>',
  right: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16m-8-7 3-3-3-3M5 10h5"/>',
  floating: '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="11" y="11" width="7" height="7" rx="1"/>',
  new: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12"/>',
  rename: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>',
  pin: '<path d="m16 3 5 5-3 1-4 4v4l-7-7h4l4-4zM9 15l-6 6"/>',
  unpin: '<path d="m16 3 5 5-3 1-4 4v4l-7-7h4l4-4zM9 15l-6 6M3 3l18 18"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
};

export function aiIcon(name: keyof typeof paths): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}
