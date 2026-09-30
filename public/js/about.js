/**
 * About — a tabbed explainer for what DataForge is and what it does.
 * Opened from the top-bar "About" button, right beside Help.
 *
 * Tabs: About · From the Creator · Changelog · Credits.
 * The "From the Creator" pane carries the creator profile card and a Support
 * link that opens a "Buy Me a Coffee" QR pop-up.
 */
import { h, el, modal } from './util.js';
import { icon, logoMark } from './icons.js';

export function openAbout() {
  const m = modal({
    wide: true, tall: true, scroll: true,
    title: '',
  });
  m.panel.classList.add('about-panel');
  m.body.style.padding = '0';

  // ---- hero ----
  const hero = h('div', { class: 'about-hero' },
    el(logoMark(62)),
    h('h2', { html: 'Data<span>Forge</span>' }),
    h('p', { class: 'about-tag', text: 'Spreadsheets, but they think for you.' }),
    h('p', { class: 'about-desc', text: 'DataForge is a private, in-browser data workspace. Build typed tables — with dropdowns, dates, currencies, booleans, images and file columns — then layer on Excel-style formulas, live charts, row forms and shareable read-only links. Everything is stored in your browser by default and nothing leaves your machine.' }),
  );

  // ---- tab bar + panes ----
  const tabs = h('div', { class: 'about-tabs', role: 'tablist' });
  const panes = h('div', { class: 'about-panes' });
  const TABS = [
    { id: 'about', label: 'About', icon: 'info', pane: aboutPane(m) },
    { id: 'creator', label: 'From the Creator', icon: 'user', pane: creatorPane() },
    { id: 'changelog', label: 'Changelog', icon: 'clock', pane: changelogPane() },
    { id: 'credits', label: 'Credits', icon: 'heart', pane: creditsPane() },
  ];
  const tabButtons = new Map();

  function selectTab(id) {
    for (const t of TABS) {
      const on = t.id === id;
      const btn = tabButtons.get(t.id);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      t.pane.classList.toggle('active', on);
    }
  }

  for (const t of TABS) {
    const btn = h('button', {
      type: 'button', class: 'about-tab', role: 'tab',
      'aria-selected': t.id === 'about' ? 'true' : 'false',
      html: `${icon(t.icon, 14)} <span>${t.label}</span>`,
      onclick: () => selectTab(t.id),
    });
    tabButtons.set(t.id, btn);
    tabs.append(btn);
    panes.append(t.pane);
  }
  selectTab('about');

  m.body.append(hero, h('div', { class: 'about-body' }, tabs, panes));
  m.foot.innerHTML = '';
  m.foot.append(h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }));
}

/* ------------------------------- About pane ------------------------------- */
function aboutPane(m) {
  const FEATURES = [
    { icon: 'layers', title: 'Typed columns', body: 'Twelve data types (text, number, fraction, currency, date, time, dropdown, boolean, image, file, formula…) with validation, defaults and required flags — so bad data never gets in.' },
    { icon: 'fx', title: 'Formula columns', body: 'Write Excel-style expressions that reference other columns and recalculate live: 80+ functions, arithmetic with real precedence, ( ) / { } grouping, IF and IFERROR logic, dates, text and more.' },
    { icon: 'chart', title: 'Charts on autopilot', body: 'Every table gets a starter chart as soon as it holds data. Open the Chart builder from any table to tweak the type, grouping, aggregation or styling — charts always read live data.' },
    { icon: 'list', title: 'Row forms & sharing', body: 'Each row has a form view with fields matched to column types, and can be shared as a public read-only link that prints cleanly to PDF.' },
    { icon: 'upload', title: 'Import & export', body: 'Bring in .xlsx, .xls, .csv, .docx or text-layer .pdf files (scanned PDFs need OCR in backend mode) and export everything to Excel, CSV or Word.' },
    { icon: 'zap', title: 'Private by design', body: 'Runs on a static host (Live Server, GitHub Pages…) with every table stored in IndexedDB, or against the optional Node backend for on-disk saves and OCR. Your call, your data.' },
  ];
  const grid = h('div', { class: 'about-grid' });
  for (const f of FEATURES) {
    grid.append(
      h('div', { class: 'about-card' },
        h('div', { class: 'about-ic' }, el(icon(f.icon, 18))),
        h('div', { class: 'grow' },
          h('h4', { text: f.title }),
          h('p', { text: f.body }),
        ),
      ),
    );
  }

  const how = h('div', { class: 'about-how' },
    h('h4', { text: 'How it works' }),
    h('ol', {},
      h('li', { html: '<b>Create a table</b> from the dashboard — it is its own dataset with its own schema.' }),
      h('li', { html: '<b>Add typed columns and rows.</b> Validation keeps entries clean; formula columns compute as you type.' }),
      h('li', { html: '<b>Watch a chart appear</b> automatically, then refine it with the Chart builder in the toolbar.' }),
      h('li', { html: '<b>Share, extract and export.</b> Turn any row subset into a new table (linked live view or snapshot), send a read-only link, or download the dataset.' }),
    ),
  );

  const cta = h('div', { class: 'about-cta' },
    h('button', {
      class: 'btn primary lg', html: `${icon('grid', 16)} Explore your tables`,
      onclick: () => { m.close(); location.hash = '#/'; },
    }),
    h('button', {
      class: 'btn lg', html: `${icon('help', 16)} Open the help guide`,
      onclick: async () => {
        m.close();
        const { openHelp } = await import('./help.js');
        openHelp({});
      },
    }),
  );

  return h('div', { class: 'about-pane active', role: 'tabpanel' }, grid, how, cta);
}

/* --------------------------- From the Creator pane ------------------------ */
function creatorPane() {
  const photo = h('img', {
    src: 'assets/creator/creator.jpg', alt: 'Portrait of the creator',
    class: 'creator-photo',
    onerror: (e) => {
      e.currentTarget.style.display = 'none';
      const mono = e.currentTarget.nextElementSibling;
      if (mono) mono.style.display = 'flex';
    },
  });
  const card = h('div', { class: 'creator-card' },
    h('div', { class: 'creator-photo-wrap' },
      photo,
      h('div', { class: 'creator-monogram', style: { display: 'none' }, text: 'MS' }),
    ),
    h('div', { class: 'creator-info' },
      h('h4', { class: 'creator-name', text: 'Md Masrur Masuk Shopnil' }),
      h('p', { class: 'creator-tagline', html: '&ldquo;You lose only when you give up trying&rdquo;' }),
      h('div', { class: 'creator-contacts' },
        h('a', { class: 'creator-btn', href: 'mailto:smasrur1633@hotmail.com', html: `${icon('mail', 14)} <span>Email</span>` }),
        h('a', { class: 'creator-btn', href: 'https://github.com/VortexProtocol1633', target: '_blank', rel: 'noopener', html: `${icon('github', 14)} <span>GitHub</span>` }),
      ),
    ),
  );

  const aboutMe = h('div', { class: 'about-section' },
    h('h5', { html: `${icon('quote', 15)} A little about me` }),
    h('p', { text: 'Hi — I’m the person behind DataForge. I did not go to design school; I studied at MIST (Military Institute of Science and Technology, Bangladesh), which taught me a lot about engineering and approximately nothing about colour theory. Everything you see here is self-taught, mildly obsessive, hobbyist-grade web design.' }),
    h('p', { text: 'What I do know is the special kind of tedium that comes from fighting a spreadsheet for an hour just to total a column, or hunting for the one row where a formula quietly broke. One day I got fed up enough to build a tool instead of complaining about it. DataForge keeps your data typed, validates it on the way in, and recalculates formulas, charts and summaries live — like a very patient analyst who never fat-fingers a cell.' }),
    h('p', { text: 'It started as a weekend fix for my own messy tables and quietly turned into… this. I hope it saves you as much time (and head-scratching) as it’s saved me.' }),
  );

  const support = h('div', { class: 'about-section' },
    h('h5', { html: `${icon('mug', 15)} Support` }),
    h('p', {}, 'If DataForge is useful to you, a coffee (or just a kind word) goes a long way. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openCoffee(); }, text: 'Buy me a coffee ☕' })),
  );

  return h('div', { class: 'about-pane', role: 'tabpanel' }, card, aboutMe, support);
}

/* ------------------------------- Changelog pane --------------------------- */
function changelogPane() {
  const ENTRIES = [
    ['r4', 'Formula lab & reference: a searchable function reference (80+ functions) with click-to-insert and a live sandbox that evaluates formulas against sample rows inside Help → Formula columns.'],
    ['r3', 'Streamlined data management: summary row plus row-wise summary (RΣ) column, drop-down multi-select, and typed validation with number ranges and text patterns.'],
    ['r2', 'Import & export: .xlsx/.xls/.csv/.docx and text-layer .pdf import with auto-detected column types (≤ 10,000 rows), and Excel/CSV/Word export with formula columns evaluated and image columns embedded.'],
    ['r1', 'The workspace: a private, in-browser data app — typed tables with 12 column types, Excel-style formula columns, auto-generated charts with a live Chart builder, per-row form view and shareable read-only links.'],
  ];
  const list = h('ul', { class: 'changelog' });
  for (const [ver, text] of ENTRIES) {
    list.append(h('li', {}, h('span', { class: 'chg-ver', text: ver }), h('span', { text })));
  }
  return h('div', { class: 'about-pane', role: 'tabpanel' },
    h('p', { class: 'about-lede', text: 'Everything that has shipped so far, newest first.' }),
    list,
  );
}

/* -------------------------------- Credits pane ---------------------------- */
function creditsPane() {
  const LIBS = [
    ['https://www.chartjs.org/', 'Chart.js', 'live charts and chart builder'],
    ['https://sheetjs.com/', 'SheetJS', '.xlsx / .xls import & export'],
    ['https://mozilla.github.io/pdf.js/', 'PDF.js', 'PDF text extraction for import'],
    ['https://github.com/dolanmiu/docx', 'docx', 'Word (.docx) generation'],
    ['https://tesseract.projectnaptha.com/', 'tesseract.js', 'OCR for scanned PDFs (backend mode)'],
    ['https://expressjs.com/', 'Express', 'the optional Node backend'],
    ['https://fonts.google.com', 'Sora & Inter', 'typefaces'],
  ];
  const list = h('ul', { class: 'credits-list' });
  for (const [href, name, what] of LIBS) {
    list.append(h('li', {},
      h('a', { href, target: '_blank', rel: 'noopener', text: name }),
      ` — ${what}`,
    ));
  }
  return h('div', { class: 'about-pane', role: 'tabpanel' },
    h('p', { class: 'about-lede', text: 'DataForge runs on these wonderful open-source libraries:' }),
    list,
    h('p', { class: 'about-footnote', html: 'Made with 💜 — no servers required, no tracking, just your browser.' }),
  );
}

/* --------------------- Buy Me a Coffee QR pop-up -------------------------- */
function openCoffee() {
  const overlay = el('<div class="overlay coffee-overlay"></div>');
  const box = el('<div class="coffee-box"></div>');

  const img = h('img', {
    src: 'assets/creator/coffee.png',
    alt: 'Donation QR code — scan with your phone camera to buy the creator a coffee',
  });
  const fallback = h('div', { class: 'coffee-qr-fallback', style: { display: 'none' } },
    el(icon('grid', 34)),
    h('span', { html: 'Couldn&rsquo;t load the QR image — look for <em>assets/creator/coffee.png</em> ☕' }),
  );
  img.addEventListener('error', () => { img.style.display = 'none'; fallback.style.display = 'flex'; });

  box.append(
    h('div', { class: 'coffee-aura', 'aria-hidden': 'true' }),
    h('button', { class: 'coffee-close', 'aria-label': 'Close pop-up', html: icon('x', 16), onclick: close }),
    h('div', { class: 'coffee-head' },
      h('div', { class: 'coffee-mug', 'aria-hidden': 'true' }, el(icon('mug', 26))),
      h('h4', { text: 'Buy Me a Coffee' }),
      h('p', { text: 'If DataForge saved you time (or a spreadsheet), a coffee keeps it brewing ☕' }),
    ),
    h('div', { class: 'coffee-qr-frame' }, img, fallback),
    h('p', { class: 'coffee-hint', html: `${icon('camera', 13)} Point your phone camera at the code` }),
  );

  overlay.append(box);
  document.getElementById('modal-root').appendChild(overlay);

  function onOverlay(e) { if (e.target === overlay) close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 190);
    overlay.removeEventListener('click', onOverlay);
    document.removeEventListener('keydown', onKey);
  }
  overlay.addEventListener('click', onOverlay);
  document.addEventListener('keydown', onKey);
}
