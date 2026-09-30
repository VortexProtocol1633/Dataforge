/**
 * Table appearance — pick a colour + icon for a table so it is easy to spot
 * on the dashboard. Reused by the dashboard card menu and the table
 * workspace header. Persisted through api.updateTable({ color, icon }).
 */
import { api } from '../api.js';
import { icon } from '../icons.js';
import { el, h, modal, toast } from '../util.js';

export const TABLE_COLORS = ['#6366f1', '#8b5cf6', '#2dd4bf', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#a855f7'];

/** Icons that exist in icons.js and read well as table markers. */
export const TABLE_ICONS = ['table', 'layers', 'grid', 'list', 'chart', 'file', 'image', 'calendar', 'clock', 'link', 'zap', 'dollar'];

/** Default table icon shown when a table has no custom icon. */
export function tableIcon(t) {
  if (t.icon) return t.icon;
  if (t.kind === 'linked') return 'link';
  return 'table';
}

export function openTableAppearance({ table, onApplied }) {
  const m = modal({
    title: 'Table appearance',
    sub: `Make “${table.name}” easy to spot — colour and icon show on the dashboard card and the table header.`,
  });
  m.foot.append(h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }));
  const save = h('button', { class: 'btn primary', text: 'Save' });
  m.foot.append(save);

  const draft = { color: table.color || null, icon: table.icon || null };

  // ---- colour swatches (Auto falls back to a deterministic default) ----
  const swatches = h('div', { class: 'swatches' });
  const autoSw = h('button', {
    type: 'button',
    class: 'swatch auto' + (!draft.color ? ' sel' : ''),
    title: 'Auto — pick automatically',
    'aria-label': 'Auto colour',
    onclick: () => { draft.color = null; paint(); },
  }, el(icon('zap', 14)));
  swatches.append(autoSw);
  for (const hex of TABLE_COLORS) {
    const b = h('button', {
      type: 'button', class: 'swatch' + (draft.color === hex ? ' sel' : ''),
      style: { background: hex }, title: hex, 'aria-label': `Colour ${hex}`,
      onclick: () => { draft.color = hex; paint(); },
    });
    if (draft.color === hex) b.innerHTML = icon('check', 13);
    swatches.append(b);
  }

  // ---- icon set ----
  const icons = h('div', { class: 'iconpick' });
  for (const name of TABLE_ICONS) {
    const b = h('button', {
      type: 'button', class: 'iconpick-btn' + (draft.icon === name ? ' sel' : ''),
      title: name, 'aria-label': `Icon ${name}`,
      onclick: () => { draft.icon = name; paint(); },
    }, el(icon(name, 17)));
    if (draft.icon === name) b.classList.add('sel');
    icons.append(b);
  }

  function paint() {
    autoSw.classList.toggle('sel', !draft.color);
    swatches.querySelectorAll('.swatch:not(.auto)').forEach((s) => {
      const hex = s.style.background;
      const on = !!draft.color && draft.color.toLowerCase() === hex;
      s.classList.toggle('sel', on);
      s.innerHTML = on ? icon('check', 13) : '';
    });
    icons.querySelectorAll('.iconpick-btn').forEach((b) => {
      const on = b.getAttribute('aria-label') === `Icon ${draft.icon}`;
      b.classList.toggle('sel', !!draft.icon && on);
    });
  }

  m.body.append(
    h('div', { class: 'field' },
      h('label', { text: 'Colour' }),
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 8px' }, text: 'Used for the card accent and the icon badge.' }),
      swatches),
    h('div', { class: 'field' },
      h('label', { text: 'Icon' }),
      h('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 8px' }, text: 'A distinct marker next to the table name.' }),
      icons),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: 0 }, text: 'Tip: give important tables their own colour so they stand out in a busy dashboard.' }),
  );

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api.updateTable(table.id, { color: draft.color, icon: draft.icon });
      toast('Appearance saved', 'ok');
      m.close();
      if (onApplied) onApplied({ color: draft.color, icon: draft.icon });
    } catch (e) { toast(e.message, 'err'); save.disabled = false; }
  });
}
