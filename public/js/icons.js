/** Small inline-SVG icon set (stroke = currentColor). */
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  unarchive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M12 17v-6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  drag: '<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  chart: '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx=".5"/><rect x="12" y="8" width="3" height="10" rx=".5"/><rect x="17" y="5" width="3" height="13" rx=".5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  chevronD: '<path d="m6 9 6 6 6-6"/>',
  arrowL: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  fx: '<text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="800" stroke="none" fill="currentColor">fx</text>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-.9.7-1.7 1.2-1.7 2.2M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  palette: '<path d="M12 22a10 10 0 1 1 10-10c0 3-2.5 4.3-5.2 4.3h-2.3a2.1 2.1 0 0 0-1.5 3.6c.6.6.2 2.1-1 2.1Z"/><circle cx="7.5" cy="11.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="11" cy="7.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"/><path d="M2 10h20"/>',
  folderOpen: '<path d="M6 14 2.6 8.2A1.7 1.7 0 0 1 4.2 5.7H9l2 3h6.6a1.7 1.7 0 0 1 1.5 2.4L17 14"/><path d="M2 11h4.2a2 2 0 0 1 1.8 1.1l.8 1.4a2 2 0 0 0 1.8 1.1h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-9l-2-3H4a2 2 0 0 0-2 2Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
};

export function icon(name, size) {
  const p = paths[name] || paths.x;
  const s = size ? `width="${size}" height="${size}"` : '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${s}>${p}</svg>`;
}

/** Icon per column data type — used in type pickers and column headers. */
export const typeIcon = {
  text: 'list',
  number: 'hashtag',
  fraction: 'divide',
  boolean: 'toggle',
  currency: 'dollar',
  dropdown: 'chevronD',
  date: 'calendar',
  time: 'clock',
  datetime: 'calendar',
  image: 'image',
  file: 'file',
  formula: 'fx',
};
// extra glyphs not defined above are rendered from small dedicated paths
/**
 * Theme-aware DataForge logo mark (forge spark rising off data bars).
 * Inline SVG so it resolves the app's CSS variables — the same mark repaints
 * with every theme's gradient. Use el(logoMark(size)) instead of an <img>.
 */
let logoUid = 0;
export function logoMark(size) {
  const id = `dfg${++logoUid}`;
  const s = size ? `width="${size}" height="${size}"` : '';
  return `<svg viewBox="0 0 48 48" ${s} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" style="stop-color:var(--indigo)"/>` +
    `<stop offset=".55" style="stop-color:var(--violet)"/>` +
    `<stop offset="1" style="stop-color:var(--teal)"/>` +
    `</linearGradient></defs>` +
    `<rect x="4" y="4" width="40" height="40" rx="12" fill="url(#${id})" opacity=".14"/>` +
    `<rect x="4" y="4" width="40" height="40" rx="12" fill="none" stroke="url(#${id})" stroke-width="2.2"/>` +
    `<path d="M13 33h22v5H13z" fill="url(#${id})"/>` +
    `<path d="M20 26h15v5H20z" fill="url(#${id})" opacity=".78"/>` +
    `<path d="M27 19h8v5H27z" fill="url(#${id})" opacity=".58"/>` +
    `<path d="M33 9.5l1.7 3.6 3.8.9-3.8.9-1.7 3.6-1.7-3.6-3.8-.9 3.8-.9z" fill="url(#${id})"/>` +
    `</svg>`;
}

paths.hashtag = '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>';
paths.dollar = '<path d="M12 2v20M17 5.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>';
paths.divide = '<circle cx="12" cy="6" r="1.6" fill="currentColor" stroke="none"/><path d="M4 12h16"/><circle cx="12" cy="18" r="1.6" fill="currentColor" stroke="none"/>';
paths.toggle = '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="16" cy="12" r="3.2"/>';

/* ---- About / “From the Creator” glyphs ---- */
paths.user = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
paths.heart = '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l8.8 8.8 8.8-8.8a5 5 0 0 0 0-7.1Z"/>';
paths.mug = '<path d="M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M7 2v3M11 2v3"/>';
paths.mail = '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>';
paths.camera = '<path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>';
paths.quote = '<path fill="currentColor" stroke="none" d="M9.5 6C6.5 7 5 9.2 5 12.4V18h5v-5H7.6c0-2 .8-3.4 2.6-4.3L9.5 6Zm9 0c-3 1-4.5 3.2-4.5 6.4V18h5v-5h-2.4c0-2 .8-3.4 2.6-4.3L18.5 6Z"/>';
paths.github = '<path fill="currentColor" stroke="none" d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/>';
