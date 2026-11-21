const paths = {
  brand: '<path d="m3.5 9 8.5-5 8.5 5-8.5 5-8.5-5Z"/><path d="M3.5 13.25 12 18.3l8.5-5.05M3.5 17.5l8.5 5 8.5-5"/>',
  pencil: '<path d="m14.5 5.5 4 4M4 20l4.5-1 11-11a2.83 2.83 0 0 0-4-4l-11 11L4 20Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1M3 7v12a2 2 0 0 0 2 2h13a2 2 0 0 0 2-1.5l2-7a1 1 0 0 0-1-1.5H7a2 2 0 0 0-2 1.5L3 19"/>',
  file: '<path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4H8Z"/><path d="M8 3v6h8V3M7 21v-7h10v7"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  drive: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 13h18m-14 3h.01m4 0h.01"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>',
  sliders: '<path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10M10 4v4m4 2v4M6 16v4"/>',
  box: '<path d="m3 8 9 5 9-5m-9 5v8M3 8l9-5 9 5v8l-9 5-9-5V8Z"/>',
  layers: '<path d="m3 8 9-5 9 5-9 5-9-5Zm0 4 9 5 9-5m-18 4 9 5 9-5"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8 8l13 13M8 16 21 3"/>',
  bolt: '<path d="m8 3-4 4v7l4 4h8l4-4V7l-4-4H8Zm-4 8h16M9 18v3m6-3v3"/>',
  plus: '<path d="M12 5v14m-7-7h14"/>',
  swap: '<path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14m-8 4v6m4-6v6"/>',
  restart: '<path d="M4 5v6h6M4.6 10a8 8 0 1 1 1.8 8.7"/>',
  cube: '<path d="m12 3 9 5v8l-9 5-9-5V8l9-5Zm0 0v9m9 4-9-4-9 4"/>',
  fit: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/><circle cx="12" cy="12" r="2.5"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
  ruler: '<path d="m3 16 13-13 5 5L8 21l-5-5Zm8-8 2 2m1-5 2 2m-8 4 2 2m-5 1 2 2"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  formula: '<path d="M18 4H6l6 8-6 8h12m0-16v3m0 10v3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
}

export function addIcons(root) {
  for (const holder of root.querySelectorAll('[data-icon]')) {
    holder.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[holder.dataset.icon] + '</svg>'
  }
}
