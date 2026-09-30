/** DOM + misc helpers shared across views. */
import { icon } from './icons.js';

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function uid(len = 8) {
  return Math.random().toString(36).slice(2, 2 + len) + Date.now().toString(36).slice(-3);
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Create an element from an HTML string. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** hyperscript helper */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else if (typeof v === 'string' && /^\s*<svg/i.test(v) && k !== 'html') {
      // Tripwire: an SVG string must never land in an attribute like title=
      // (native tooltips render it as raw markup). Fail loudly instead.
      console.error(`[h()] SVG string passed as attribute "${k}" — wrap in el() or use html:`);
    }
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    // SVG strings (icon()) must render as elements, never as text nodes —
    // otherwise `h('button', {...}, icon('x'))` prints raw markup on screen
    // (and, if it ends up in a title attr, as a broken tooltip).
    if (typeof c === 'string' && /^\s*<svg/i.test(c)) { node.append(el(c)); continue; }
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

/* ------------------------------ loading ------------------------------ */
/** Page-level loading placeholder (labeled, announced to screen readers). */
export function loadingSection(msg = 'Loading…') {
  return h('div', { class: 'center-msg', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'spin' }),
    h('div', { class: 'muted', text: msg }),
  );
}

/**
 * Resolve a promise or reject with a friendly error after `ms`.
 * A hung data call (e.g. an unreachable backend) must never leave an
 * endless loading spinner on screen.
 */
export function withTimeout(promise, ms = 15000, message = 'This is taking too long — please try again.') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Inline error card with an optional Retry action. */
export function errorSection(message, onRetry) {
  return h('div', { class: 'glass', style: { padding: '30px', textAlign: 'center' } },
    h('h3', { text: 'Something went wrong' }),
    h('p', { class: 'muted', text: message }),
    onRetry ? h('div', { style: { marginTop: '16px' } },
      h('button', { class: 'btn primary', text: 'Retry', onclick: onRetry })) : null,
  );
}

/* ------------------------------ toasts ------------------------------ */
export function toast(message, type = 'info', ms = 3200) {
  const root = document.getElementById('toast-root');
  const node = el(`<div class="toast ${type}"><span class="dot"></span><span></span></div>`);
  node.querySelector('span:last-child').textContent = message;
  root.appendChild(node);
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 260); }, ms);
}

/* ------------------------------ modals ------------------------------ */
/** Open a modal. Returns { close, bodyEl, footEl }. content can be a DOM node or {title, sub, body, foot}. */
export function modal(opts) {
  const overlay = el('<div class="overlay"></div>');
  const panel = el(`<div class="modal ${opts.wide ? 'wide' : ''} ${opts.tall ? 'tall' : ''}"></div>`);
  const head = el('<div class="modal-head"></div>');
  if (opts.title) {
    head.append(h('div', { class: 'grow' },
      h('h3', { text: opts.title }),
      opts.sub ? h('div', { class: 'sub', text: opts.sub }) : null,
    ));
  }
  const closeBtn = h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close dialog', onclick: close }, el(icon('x')));
  head.append(closeBtn);
  const body = h('div', { class: 'modal-body' + (opts.scroll ? ' scroll' : '') });
  const foot = h('div', { class: 'modal-foot' });
  panel.append(head, body, foot);
  overlay.append(panel);
  document.getElementById('modal-root').appendChild(overlay);

  function close() {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 190);
    overlay.removeEventListener('click', onOverlay);
    document.removeEventListener('keydown', onKey);
    if (opts.onClose) opts.onClose();
  }
  function onOverlay(e) { if (e.target === overlay && !opts.locked) close(); }
  function onKey(e) { if (e.key === 'Escape' && !opts.locked) close(); }
  overlay.addEventListener('click', onOverlay);
  document.addEventListener('keydown', onKey);

  if (typeof opts.content === 'string') body.innerHTML = opts.content;
  else if (opts.content) body.append(opts.content);
  else if (opts.body) { if (opts.body.nodeType) body.append(opts.body); else body.innerHTML = opts.body; }
  if (opts.foot && foot) {
    if (Array.isArray(opts.foot)) foot.append(...opts.foot);
    else if (opts.foot.nodeType) foot.append(opts.foot);
    else foot.innerHTML = opts.foot;
  }
  if (opts.hideFoot) foot.remove();
  return { close, body, foot, overlay, panel };
}

/** Promise-based confirm dialog. */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    // Track the decision BEFORE closing: modal.close() fires onClose
    // synchronously, so resolving inside the button handler would lose the
    // confirm to the earlier resolve(false).
    let confirmed = false;
    const m = modal({
      title,
      sub: message,
      hideFoot: true,
      onClose: () => resolve(confirmed),
    });
    m.body.append(
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' } },
        h('button', { class: 'btn', text: 'Cancel', onclick: () => { m.close(); } }),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), text: confirmLabel, onclick: () => { confirmed = true; m.close(); } }),
      ),
    );
  });
}

/** Small popover menu anchored to a button. Items: {label, icon, onClick, danger, sep, header}. */
export function popMenu(anchor, items) {
  closeMenus();
  const menu = el('<div class="menu"></div>');
  for (const it of items) {
    if (it.sep) { menu.append(el('<div class="sep"></div>')); continue; }
    if (it.header) { menu.append(h('div', { class: 'lbl', text: it.header })); continue; }
    const b = h('button', { onclick: () => { menu.remove(); it.onClick && it.onClick(); } },
      it.icon ? el(icon(it.icon)) : null,
      h('span', { text: it.label }),
    );
    if (it.danger) b.classList.add('danger');
    menu.append(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  let x = Math.min(r.left, window.innerWidth - mw - 10);
  if (x < 6) x = 6;
  let y = r.bottom + 6;
  if (y + menu.offsetHeight > window.innerHeight - 8) y = Math.max(6, r.top - menu.offsetHeight - 6);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const onDoc = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', onDoc); }
  };
  setTimeout(() => document.addEventListener('mousedown', onDoc), 10);
  return menu;
}

export function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
}

/* ------------------------------ misc ------------------------------ */
export function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); return b ? gcd(b, a % b) : a; }

/** Parse "3/4", "1 1/2", "7" -> {n,d} simplified, or null. */
export function parseFraction(str) {
  if (str == null) return null;
  if (typeof str === 'object') return str.n && str.d ? { n: +str.n, d: +str.d } : null;
  let s = String(str).trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  let n = 0, d = 1;
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) { n = +m[1] * +m[3] + +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d+)\/(\d+)$/))) { n = +m[1]; d = +m[2]; }
  else if ((m = s.match(/^(\d+)$/))) { n = +m[1]; }
  else return null;
  if (!d) return null;
  const g = gcd(n, d) || 1;
  n /= g; d /= g;
  if (d < 0) { n = -n; d = -d; }
  if (neg) n = -n;
  return { n, d };
}

export function fracText(f) {
  if (!f) return '';
  if (f.d === 1) return String(f.n);
  return `${f.n}/${f.d}`;
}

export function fmtNum(v, digits) {
  const n = Number(v);
  if (!isFinite(n)) return String(v ?? '');
  return n.toLocaleString('en-US', { maximumFractionDigits: digits == null ? 10 : digits });
}

/** today / now ISO helpers matching server storage */
export function pad(n) { return String(n).padStart(2, '0'); }
export function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function nowISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
