/**
 * Column data-type registry.
 *
 * To add a new column type:
 *   1. register it in TYPES below (label + group),
 *   2. implement cellHTML() and attachEditor() branches,
 *   3. add any subtype/option fields in configFields() (public/js/components/columnEditor.js)
 *   4. mirror the storage coercion in server/store.js `coerceValue` + TYPES.
 */
import { icon, typeIcon } from './icons.js';
import { esc, parseFraction, fracText, fmtNum, pad, todayISO, nowISO } from './util.js';
import { assetUrl } from './api.js';

export const TYPES = [
  { id: 'text', label: 'Text', group: 'Basic', icon: 'text', blurb: 'Single or multi-line text', subtype: 'single', subtypes: [{ id: 'single', label: 'Single line' }, { id: 'multi', label: 'Multi-line' }] },
  { id: 'number', label: 'Number', group: 'Basic', icon: 'number', blurb: 'Integer or decimal value', subtype: 'decimal', subtypes: [{ id: 'integer', label: 'Integer' }, { id: 'decimal', label: 'Decimal' }] },
  { id: 'fraction', label: 'Fraction', group: 'Basic', icon: 'fraction', blurb: 'numerator / denominator, auto-simplified' },
  { id: 'boolean', label: 'Boolean', group: 'Basic', icon: 'boolean', blurb: 'Yes / no checkbox' },
  { id: 'currency', label: 'Currency', group: 'Basic', icon: 'currency', blurb: 'Money amount with symbol' },
  { id: 'date', label: 'Date', group: 'Time', icon: 'date', blurb: 'Calendar date' },
  { id: 'time', label: 'Time', group: 'Time', icon: 'time', blurb: 'Clock time' },
  { id: 'datetime', label: 'Date & time', group: 'Time', icon: 'datetime', blurb: 'Date and time combined' },
  { id: 'dropdown', label: 'Dropdown', group: 'Choice', icon: 'dropdown', blurb: 'Single or multi-select options' },
  { id: 'image', label: 'Image', group: 'Media', icon: 'image', blurb: 'Uploaded image with preview' },
  { id: 'file', label: 'File', group: 'Media', icon: 'file', blurb: 'Attach any file' },
  { id: 'formula', label: 'Formula', group: 'Computed', icon: 'formula', blurb: 'Excel-style computed column' },
];

export const TYPE_IDS = TYPES.map((t) => t.id);

export function typeMeta(id) {
  return TYPES.find((t) => t.id === id) || TYPES[0];
}
export function typeLabel(id) {
  return typeMeta(id).label;
}
export function typeIconSvg(id, size) {
  return icon(typeIcon[id] || 'text', size);
}

/** Pretty display string for a raw stored value (no HTML). */
export function displayText(col, v) {
  if (v === null || v === undefined || v === '') return '';
  switch (col.type) {
    case 'text': return String(v);
    case 'number': return fmtNum(v, col.subtype === 'integer' ? 0 : 6);
    case 'currency': {
      const sym = col.options && col.options.symbol != null ? col.options.symbol : '$';
      const n = Number(v);
      return isFinite(n) ? `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    }
    case 'fraction': return fracText(v);
    case 'date': return String(v);
    case 'time': return String(v);
    case 'datetime': return String(v).replace('T', ' ');
    case 'boolean': return v ? 'Yes' : 'No';
    case 'dropdown': return Array.isArray(v) ? v.join(', ') : String(v);
    case 'image': case 'file': return (v && v.name) || '';
    default: return String(v);
  }
}

/** HTML used inside grid/form cells. */
export function cellHTML(col, v) {
  if (v === null || v === undefined || v === '') {
    return `<div class="cell empty"><span>—</span></div>`;
  }
  let inner = '';
  switch (col.type) {
    case 'text':
      inner = `<span>${esc(String(v))}</span>`;
      break;
    case 'number':
      inner = `<span>${esc(fmtNum(v, col.subtype === 'integer' ? 0 : 6))}</span>`;
      break;
    case 'currency': {
      const sym = col.options && col.options.symbol != null ? col.options.symbol : '$';
      inner = `<span>${esc(sym)}${esc(Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</span>`;
      break;
    }
    case 'fraction':
      inner = `<span class="frac">${esc(fracText(v))}</span>`;
      break;
    case 'date': case 'time': case 'datetime':
      inner = `<span>${esc(displayText(col, v))}</span>`;
      break;
    case 'boolean':
      inner = `<span class="toggle ${v ? 'on' : ''}" data-role="boolview"></span>`;
      break;
    case 'dropdown': {
      const arr = Array.isArray(v) ? v : [v];
      inner = `<span class="optpills">${arr.map((o) => `<span class="pill">${esc(String(o))}</span>`).join('')}</span>`;
      break;
    }
    case 'image':
      inner = v && v.url
        ? `<span class="fchip"><img class="thumb" data-role="img" src="${esc(assetUrl(v.url))}" alt=""><span>${esc(v.name || '')}</span></span>`
        : '<span class="empty">—</span>';
      break;
    case 'file':
      inner = v && v.url
        ? `<span class="att" data-role="file" data-url="${esc(assetUrl(v.url))}"><span class="fchip">${icon('file', 14)}</span><span>${esc(v.name || 'file')}</span></span>`
        : '<span class="empty">—</span>';
      break;
    default:
      inner = `<span>${esc(String(v))}</span>`;
  }
  return `<div class="cell">${inner}</div>`;
}

/* ------------------------- client coercion ------------------------- */
/** Convert an editor-produced value into the stored/canonical shape (mirrors server). */
export function coerceClient(col, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (col.type) {
    case 'text': return String(raw);
    case 'number': case 'currency': {
      const n = Number(raw);
      if (!isFinite(n)) return null;
      return col.subtype === 'integer' ? Math.round(n) : n;
    }
    case 'fraction': return parseFraction(raw);
    case 'boolean': return !!raw;
    case 'date': return String(raw).slice(0, 10);
    case 'time': return String(raw).slice(0, 5);
    case 'datetime': return String(raw).replace('T', ' ').slice(0, 16);
    case 'dropdown': return Array.isArray(raw) ? raw.map(String) : String(raw);
    case 'image': case 'file':
      if (typeof raw === 'string') return { url: raw, name: raw.split('/').pop() };
      return raw && typeof raw === 'object' ? { url: raw.url, name: raw.name, size: raw.size, mime: raw.mime } : null;
    default: return String(raw);
  }
}

/** Light client-side validation mirroring the server (server stays authoritative). */
export function validateClient(col, raw) {
  const opts = col.options || {};
  // Reject unparseable fraction input up front — otherwise it would silently
  // coerce to null below and clear the cell instead of showing an error.
  if (col.type === 'fraction' && raw !== null && raw !== undefined && raw !== '') {
    if (!parseFraction(raw)) return { error: 'Invalid fraction — use n/d, whole, or 1 1/2' };
  }
  const v = coerceClient(col, raw);
  if (v === null && opts.required && col.type !== 'boolean') return { error: `"${col.name}" is required` };
  if (v === null) return { ok: true };
  if ((col.type === 'number' || col.type === 'currency') && typeof v === 'number') {
    if (opts.min != null && opts.min !== '' && v < Number(opts.min)) return { error: `Must be ≥ ${opts.min}` };
    if (opts.max != null && opts.max !== '' && v > Number(opts.max)) return { error: `Must be ≤ ${opts.max}` };
  }
  if (col.type === 'text' && typeof v === 'string') {
    if (opts.min != null && opts.min !== '' && v.length < Number(opts.min)) return { error: `At least ${opts.min} characters` };
    if (opts.max != null && opts.max !== '' && v.length > Number(opts.max)) return { error: `At most ${opts.max} characters` };
    if (opts.regex) {
      try { if (!new RegExp(opts.regex).test(v)) return { error: 'Does not match pattern' }; } catch { /* ignore bad regex */ }
    }
  }
  if (col.type === 'dropdown' && opts.list && opts.list.length) {
    const list = opts.list.map(String);
    const vals = Array.isArray(v) ? v : [v];
    const bad = vals.find((x) => !list.includes(String(x)));
    if (bad !== undefined) return { error: `"${bad}" is not an option` };
  }
  return { ok: true };
}

/* --------------------------- inline editing ------------------------- */
/**
 * Start editing a cell inside `container`.
 * callbacks: { commit(raw), cancel(), busy() }
 * The container receives focusable controls; commit is called with the raw
 * value (or null to clear). Image/file editors upload straight away.
 */
export async function attachEditor(col, value, container, callbacks) {
  const empty = container;
  empty.classList.add('ce');
  empty.innerHTML = '';

  let done = false;
  const finish = (raw) => {
    if (done) return;
    done = true;
    empty.classList.remove('ce');
    callbacks.commit(raw === undefined ? null : raw);
  };
  const bail = () => {
    if (done) return;
    done = true;
    empty.classList.remove('ce');
    callbacks.cancel();
  };
  const stop = (e) => { e.stopPropagation(); };
  const commitOn = (input, { enter = true, blur = true } = {}) => {
    const grab = () => {
      const raw = input.value;
      const vr = validateClient(col, raw);
      if (!vr.ok) { input.classList.add('err'); input.focus(); return; }
      finish(col.type === 'fraction' ? parseFraction(raw) : raw);
    };
    if (enter) input.addEventListener('keydown', (e) => {
      stop(e);
      if (e.key === 'Enter' && !(col.type === 'text' && col.subtype === 'multi' && e.ctrlKey === false)) { if (col.type !== 'text' || col.subtype !== 'multi' || e.ctrlKey) { grab(); } }
      if (e.key === 'Enter' && col.type === 'text' && col.subtype === 'multi' && !e.ctrlKey) return; // newline
      if (e.key === 'Escape') { stop(e); bail(); }
    });
    if (blur) input.addEventListener('blur', () => setTimeout(grab, 0), { once: false });
  };

  switch (col.type) {
    case 'text': {
      if (col.subtype === 'multi') {
        const ta = document.createElement('textarea');
        ta.value = value == null ? '' : String(value);
        ta.rows = 4;
        empty.append(ta);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        const grab = () => {
          const raw = ta.value;
          const vr = validateClient(col, raw);
          if (!vr.ok) return ta.classList.add('err');
          finish(raw);
        };
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { stop(e); bail(); }
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { stop(e); grab(); }
        });
        ta.addEventListener('blur', () => setTimeout(grab, 80));
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value == null ? '' : String(value);
        empty.append(input);
        input.focus();
        input.select();
        commitOn(input);
      }
      break;
    }
    case 'number': case 'currency': {
      const input = document.createElement('input');
      input.type = 'number';
      if (col.subtype === 'integer') input.step = '1';
      input.value = value == null ? '' : String(value);
      empty.append(input);
      input.focus();
      input.select();
      commitOn(input);
      break;
    }
    case 'fraction': {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'e.g. 3/4 or 1 1/2';
      input.value = value && typeof value === 'object' ? fracText(value) : (value || '');
      empty.append(input);
      input.focus();
      input.select();
      commitOn(input);
      break;
    }
    case 'date': case 'time': case 'datetime': {
      const input = document.createElement('input');
      if (col.type === 'date') input.type = 'date';
      else if (col.type === 'time') input.type = 'time';
      else input.type = 'datetime-local';
      const v = value == null ? '' : String(value).replace(' ', 'T');
      input.value = v;
      empty.append(input);
      input.focus();
      if (input.showPicker) { try { input.showPicker(); } catch { /* not always available */ } }
      input.addEventListener('change', () => finish(col.type === 'datetime' ? input.value.replace('T', ' ') : input.value));
      input.addEventListener('keydown', (e) => { stop(e); if (e.key === 'Escape') bail(); });
      break;
    }
    case 'boolean': {
      // proper toggle: empty → Yes, Yes → No, No → Yes
      const cur = value === true ? true : value === false ? false : null;
      const next = cur === true ? false : true;
      finish(next);
      break;
    }
    case 'dropdown': {
      const multi = !!(col.options && col.options.multi);
      const list = (col.options && col.options.list) || [];
      if (multi) {
        const pills = Array.isArray(value) ? value : (value ? [value] : []);
        const wrap = document.createElement('div');
        wrap.className = 'optpills';
        const render = () => {
          wrap.innerHTML = '';
          pills.forEach((p, i) => {
            const pill = document.createElement('span');
            pill.className = 'pill';
            pill.innerHTML = `${esc(String(p))} <button class="icon-btn sm danger" title="Remove ${esc(String(p))}" aria-label="Remove ${esc(String(p))}" style="width:16px;height:16px;border-radius:50%">×</button>`;
            pill.querySelector('button').onclick = (e) => { stop(e); pills.splice(i, 1); render(); commitChange(); };
            wrap.append(pill);
          });
          const add = document.createElement('select');
          add.className = 'miniadd';
          add.innerHTML = `<option value="">+ add…</option>${list.filter((o) => !pills.includes(o)).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}`;
          add.onchange = () => {
            if (add.value) { pills.push(add.value); render(); commitChange(); }
          };
          wrap.append(add);
        };
        const commitChange = () => finish(pills.length ? [...pills] : null);
        render();
        empty.append(wrap);
        const first = empty.querySelector('select');
        if (first) first.focus();
      } else {
        const sel = document.createElement('select');
        sel.innerHTML = `<option value="">— none —</option>${list.map((o) => `<option value="${esc(o)}" ${String(value) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}`;
        empty.append(sel);
        sel.focus();
        sel.addEventListener('change', () => finish(sel.value === '' ? null : sel.value));
        sel.addEventListener('keydown', (e) => { stop(e); if (e.key === 'Escape') bail(); });
      }
      break;
    }
    case 'image': case 'file': {
      callbacks.busy(true);
      const label = document.createElement('label');
      label.className = 'btn sm';
      label.innerHTML = `${icon('upload', 14)} <span>Uploading…</span>`;
      empty.append(label);
      const input = document.createElement('input');
      input.type = 'file';
      if (col.type === 'image') input.accept = 'image/*';
      input.style.display = 'none';
      // user dismissed the OS file picker without choosing — bail out of the
      // editing state instead of leaving the cell stuck on “Uploading…”
      input.addEventListener('cancel', () => {
        empty.classList.remove('ce');
        callbacks.busy(false);
        callbacks.cancel();
      });
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) { empty.classList.remove('ce'); callbacks.cancel(); return; }
        callbacks.busy(true);
        try {
          const { fileToBase64 } = await import('./util.js');
          const data = await fileToBase64(f);
          const rec = await callbacks.upload(f.name, data, f.type || '');
          empty.classList.remove('ce');
          callbacks.commit(rec);
        } catch (e) {
          callbacks.busy(false);
          empty.classList.remove('ce');
          callbacks.cancel();
          const { toast } = await import('./util.js');
          toast(e.message || 'Upload failed', 'err');
        }
      };
      empty.append(input);
      input.click();
      break;
    }
    case 'formula': default:
      callbacks.cancel();
  }
}

/** Quick 'today' / 'now' for default values in editors. */
export function quickNow(type) {
  if (type === 'date') return todayISO();
  if (type === 'time') { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  if (type === 'datetime') return nowISO();
  return '';
}
