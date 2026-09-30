/**
 * Auto-generated form for a single row: one input per column respecting the
 * column type. Editing a field saves straight back to the row. Can also create
 * a shareable read-only link (rendered at #/share/:token, printable to PDF).
 */
import { api, assetUrl, sharePageUrl } from '../api.js';
import { icon } from '../icons.js';
import { h, el, modal, toast, confirmDialog } from '../util.js';
import { cellHTML, attachEditor, typeMeta, validateClient } from '../types.js';
import compute from '../compute-shim.js';

export async function openRowForm({ table, row, onRowChanged }) {
  const fxList = compute.compileFormulas(table);
  let rowValues = { ...row.values };

  const m = modal({
    wide: true, tall: true, scroll: true, locked: true,
    title: 'Row form',
    sub: `${table.name} — editing row ${(table.rows || []).findIndex((r) => r.id === row.id) + 1}`,
  });

  const grid = h('div', { class: 'rowform' });
  const stateEls = [];

  function readRow() {
    return { ...row, values: rowValues };
  }
  function currentVal(col) {
    const v = rowValues[col.id];
    if (col.type === 'formula') {
      const res = compute.evalRowWith(fxList, { columns: table.columns, rows: [{ id: row.id, values: rowValues }] }, { id: row.id, values: rowValues })[col.id];
      return res;
    }
    return v;
  }

  function fieldHTML(col) {
    if (col.type === 'formula') {
      const res = currentVal(col);
      const text = res && res.err ? `#${res.err}` : (res && res.ok ? compute.formulaText(res) : '');
      return h('div', { class: 'cur fcell' + (!text ? ' empty' : '') },
        res && res.err
          ? h('span', { class: 'err', title: String(res.err), text: text })
          : h('span', { class: 'val', text: text || '—' }));
    }
    const wrap = h('div', { class: 'cur', html: cellHTML(col, currentVal(col)) });
    const img = wrap.querySelector('[data-role="img"]');
    const file = wrap.querySelector('[data-role="file"]');
    const boolview = wrap.querySelector('[data-role="boolview"]');
    const openImage = () => {
      const overlay = h('div', { class: 'lightbox' });
      overlay.append(h('img', { src: img.src, alt: '' }));
      overlay.addEventListener('click', () => overlay.remove());
      document.body.append(overlay);
    };
    if (img) img.addEventListener('click', (e) => { e.stopPropagation(); openImage(); });
    if (file) file.addEventListener('click', (e) => { e.stopPropagation(); window.open(file.dataset.url || (currentVal(col) && currentVal(col).url ? assetUrl(currentVal(col).url) : null), '_blank'); });
    wrap.addEventListener('click', () => startEdit(col, wrap));
    if (boolview) {
      // clicking the toggle in a form opens the editor (cycles state)
      boolview.addEventListener('click', (e) => { e.stopPropagation(); startEdit(col, wrap); });
    }
    return wrap;
  }

  /** Photo column shown as a passport-sized frame — always top & centre. */
  function passportItem(col) {
    const v = rowValues[col.id];
    const url = v && v.url ? assetUrl(v.url) : null;
    const meta = typeMeta(col.type);
    const frame = h('div', { class: 'pp-frame' + (url ? '' : ' empty'), title: url ? 'Click the photo to enlarge' : 'No photo yet — click to add one' },
      url
        ? h('img', { src: url, alt: col.name, 'data-role': 'img' })
        : el(`<span class="pp-ph">${icon('image', 22)}</span>`),
    );
    const item = h('div', { class: 'fitem passport' },
      h('div', { class: 'pp' },
        frame,
        h('div', { class: 'pp-meta' },
          h('div', { class: 'pp-label' },
            h('span', { class: 'pp-ic' }, el(icon(meta.icon, 13))),
            h('span', { text: col.name }),
            col.options && col.options.required ? h('span', { class: 'req', text: '*' }) : null,
          ),
          h('span', { class: 'pp-file', text: (v && v.name) || 'click to add a photo' }),
        ),
      ),
    );
    // Click the photo itself → lightbox; click anywhere else in the frame → upload/change.
    const img = frame.querySelector('[data-role="img"]');
    if (img) img.addEventListener('click', (e) => { e.stopPropagation(); openImage(img); });
    if (!table.linked) {
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-role="img"]')) return; // handled by the lightbox above
        startEdit(col, frame);
      });
    }
    return item;
  }

  const openImage = (img) => {
    const overlay = h('div', { class: 'lightbox' });
    overlay.append(h('img', { src: img.src, alt: '' }));
    overlay.addEventListener('click', () => overlay.remove());
    document.body.append(overlay);
  };

  function render() {
    grid.innerHTML = '';
    stateEls.length = 0;
    const cols = table.columns || [];
    // Image columns get display priority: they render as a passport gallery
    // at the very top (centred), regardless of where the column sits.
    const imgCols = cols.filter((c) => c.type === 'image');
    if (imgCols.length) {
      const strip = h('div', { class: 'rowform-imgs' });
      for (const col of imgCols) strip.append(passportItem(col));
      grid.append(strip);
    }
    for (const col of cols.filter((c) => c.type !== 'image')) {
      const meta = typeMeta(col.type);
      const item = h('div', { class: 'fitem' },
        h('label', { title: meta.label },
          h('span', { style: { color: 'var(--indigo)', display: 'inline-flex' } }, el(icon(meta.icon, 13))),
          h('span', { text: col.name }),
          col.type === 'formula' ? h('span', { class: 'fx-badge', html: `${icon('fx', 11)}&nbsp;formula` }) : null,
          col.options && col.options.required ? h('span', { class: 'req', text: '*' }) : null,
        ),
        fieldHTML(col));
      stateEls.push({ col, item });
      grid.append(item);
    }
  }

  async function startEdit(col, wrapEl) {
    const meta = typeMeta(col.type);
    if (meta.group === 'Computed') return;
    wrapEl.classList.add('editing');
    wrapEl.innerHTML = '';
    await attachEditor(col, currentVal(col), wrapEl, {
      commit: async (raw) => {
        let vr = { ok: true };
        if (raw !== null) {
          vr = validateClient(col, raw);
          if (!vr.ok) { toast(`${col.name}: ${vr.error}`, 'err'); render(); return; }
        }
        try {
          const res = await api.updateRow(table.id, row.id, { [col.id]: raw });
          rowValues = { ...res.row.values };
          if (onRowChanged) await onRowChanged(res.row);
          render();
        } catch (e) { toast(e.message, 'err'); render(); }
      },
      cancel: () => render(),
      busy: (b) => { if (b) wrapEl.innerHTML = ''; },
      upload: async (name, data, mime) => {
        const rec = await api.saveFile(table.id, { filename: name, data, mime });
        await api.updateRow(table.id, row.id, { [col.id]: rec.file });
        rowValues = { ...rowValues, [col.id]: rec.file };
        if (onRowChanged) onRowChanged(rowValues);
        return rec.file;
      },
    });
    const first = wrapEl.querySelector('input,textarea,select');
    if (first && first.focus) first.focus();
  }

  render();
  m.body.append(grid);

  // ---- footer actions ----
  const shareBtn = h('button', { class: 'btn', html: `${icon('link', 14)} Share…` });
  const delBtn = h('button', { class: 'btn danger', html: `${icon('trash', 14)} Delete row` });
  m.foot.append(delBtn, shareBtn, h('button', { class: 'btn', text: 'Done', onclick: () => m.close() }));

  shareBtn.addEventListener('click', async () => {
    try {
      const res = await api.shareRow(table.id, row.id);
      const url = sharePageUrl(res.token);
      try { await navigator.clipboard.writeText(url); toast('Share link copied to clipboard', 'ok'); }
      catch { toast(`Share link: ${url}`, 'info', 6000); }
      const open = h('button', { class: 'btn sm primary', text: 'Open read-only page', onclick: () => { m.close(); window.open(url, '_blank'); } });
      m.foot.insertBefore(open, shareBtn.nextSibling);
    } catch (e) { toast(e.message, 'err'); }
  });

  delBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this row?',
      message: 'This removes the row from the table permanently.',
      confirmLabel: 'Delete row',
    });
    if (!ok) return;
    try {
      await api.deleteRows(table.id, [row.id]);
      toast('Row deleted', 'ok');
      m.close();
      if (onRowChanged) onRowChanged(null, true);
    } catch (e) { toast(e.message, 'err'); }
  });
}
