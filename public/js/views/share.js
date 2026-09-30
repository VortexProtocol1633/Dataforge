/**
 * Public, unauthenticated read-only page for a single shared row.
 * Rendering here is print-friendly: use the browser's “Save as PDF” for a PDF
 * export of the row form.
 */
import { el, h, loadingSection } from '../util.js';
import { cellHTML, typeMeta } from '../types.js';
import { api, assetUrl } from '../api.js';
import computeNs from '../compute-shim.js';
import { icon, logoMark } from '../icons.js';

const compute = computeNs;

export default async function render(wrap, token) {
  wrap.append(loadingSection('Loading shared row…'));
  let data;
  try {
    data = await api.getShare(token);
  } catch (e) {
    wrap.innerHTML = '';
    wrap.append(h('div', { class: 'glass share-card' },
      h('h1', { style: { fontSize: '20px' }, text: 'Link unavailable' }),
      h('p', { class: 'muted', text: e.message || 'This share link may have expired or been removed.' }),
    ));
    return;
  }
  wrap.innerHTML = '';

  const head = h('div', { class: 'share-head no-print' },
    el(logoMark(28)),
    h('h1', { text: 'DataForge' }),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn sm', text: 'Print / PDF', onclick: () => window.print() }),
  );
  const card = h('div', { class: 'glass share-card' },
    h('div', { class: 'share-head', style: { marginBottom: '4px' } },
      h('h1', { text: data.tableName || 'Shared row' }),
    ),
    h('div', { class: 'share-sub', text: `${new Date(data.sharedAt).toLocaleString()} · read-only view of a single record` }),
  );

  const grid = h('div', { class: 'rowform' });
  const fxList = compute.compileFormulas({ columns: data.columns });
  const row = data.row;
  const cols = data.columns || [];

  // Mirrors the editable row form: image columns render as a passport gallery
  // at the very top (centred), every other column as a labelled field below.
  const imgCols = cols.filter((c) => c.type === 'image');
  if (imgCols.length) {
    const strip = h('div', { class: 'rowform-imgs' });
    for (const col of imgCols) strip.append(passportItem(col));
    grid.append(strip);
  }
  for (const col of cols.filter((c) => c.type !== 'image')) {
    const meta = typeMeta(col.type);
    const fitem = h('div', { class: 'fitem' },
      h('label', { title: meta.label },
        h('span', { style: { color: 'var(--indigo)', display: 'inline-flex' } }, el(icon(meta.icon, 13))),
        h('span', { text: col.name }),
        col.type === 'formula' ? h('span', { class: 'fx-badge', html: `${icon('fx', 11)}&nbsp;formula` }) : null,
        col.options && col.options.required ? h('span', { class: 'req', text: '*' }) : null,
      ),
      fieldHTML(col),
    );
    grid.append(fitem);

    /** Same field wrapper the editable row form uses (read-only content here). */
    function fieldHTML(col) {
      if (col.type === 'formula') {
        const res = compute.evalRowWith(fxList, { columns: data.columns }, row)[col.id];
        const text = res && res.err ? `#${res.err}` : (res && res.ok ? compute.formulaText(res) : '');
        return h('div', { class: 'cur fcell' + (!text ? ' empty' : '') },
          res && res.err
            ? h('span', { class: 'err', title: String(res.err), text: text })
            : h('span', { class: 'val', text: text || '—' }));
      }
      return h('div', { class: 'cur', html: cellHTML(col, row.values && row.values[col.id]) });
    }
  }
  card.append(grid);

  /** Read-only version of the form view's passport photo frame. */
  function passportItem(col) {
    const v = row.values && row.values[col.id];
    const url = v && v.url ? assetUrl(v.url) : null;
    const meta = typeMeta(col.type);
    const frame = h('div', { class: 'pp-frame' + (url ? '' : ' empty'), title: url ? 'Click the photo to enlarge' : 'No photo uploaded' },
      url
        ? h('img', { src: url, alt: col.name, 'data-role': 'img' })
        : el(`<span class="pp-ph">${icon('image', 22)}</span>`),
    );
    return h('div', { class: 'fitem passport' },
      h('div', { class: 'pp' },
        frame,
        h('div', { class: 'pp-meta' },
          h('div', { class: 'pp-label' },
            h('span', { class: 'pp-ic' }, el(icon(meta.icon, 13))),
            h('span', { text: col.name }),
            col.options && col.options.required ? h('span', { class: 'req', text: '*' }) : null,
          ),
          h('span', { class: 'pp-file', text: (v && v.name) || 'no photo' }),
        ),
      ),
    );
  }
  wrap.append(head, card);

  // attach image lightbox (client-side only, no edit)
  wrap.addEventListener('click', (e) => {
    const img = e.target.closest('[data-role="img"]');
    if (img) {
      const ov = el('<div class="lightbox"></div>');
      ov.append(h('img', { src: img.getAttribute('src'), alt: '' }));
      ov.addEventListener('click', () => ov.remove());
      document.body.append(ov);
    }
  });
}
