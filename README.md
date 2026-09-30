# DataForge

A **custom database & table management web app**: users create independent,
spreadsheet-like tables, enrich them with typed columns and Excel-style formulas, generate
forms and charts from the data, and import/export files — wrapped in a modern
**glassmorphic UI with light/dark mode**.

The app is a **pure static website — HTML, CSS and vanilla JS, no build step**
and no backend required. It runs anywhere a static server can serve it (VS
Code's Live Server, `npx serve`, GitHub Pages, …).

- **Front-end:** vanilla HTML/CSS/JS — glassmorphism, gradients, CSS-variable
  themes, Chart.js and SheetJS (vendored locally), a shared formula engine.
- **How data is created & stored:** everything runs in the browser. Tables,
  columns, rows, summaries, linked views, saved charts, row-share tokens and
  uploads are created and persisted client-side in **IndexedDB** via
  `public/js/localstore.js`. Imports (.xlsx/.xls/.csv/.docx/.pdf text layer)
  and exports (.xlsx/.csv/.docx) are parsed/generated in the browser too.
- **Optional Node backend:** the original Express server (`server/`, `npm
  start`) is still included for users who want disk persistence under
  `data/` + `Saves/` and OCR for scanned PDFs, but the website itself never
  needs it — when the page is served by the backend on its default port (or
  pointed at one via `?df_api=`), REST calls are used; on any other host the
  browser layer is used directly.

---

## Quick start (Live Server — no install, no backend)

1. Open this folder in VS Code with the **Live Server** extension installed.
2. Right-click `public/index.html` → **Open with Live Server**.
3. Sign in with the built-in demo account:

   | username | password    |
   | -------- | ----------- |
   | `admin`  | `admin123`  |

That's it. All data is created and stored in your browser (IndexedDB): auth,
tables, columns, formulas, forms, charts, row shares, imports
(.xlsx/.xls/.csv/.docx and text-layer PDFs) and exports (.xlsx/.csv/.docx)
all work with zero server code. You can also drag the `public/` folder onto
any static server (`npx serve public`) or host it on GitHub Pages.

**First run seeds a demo dataset** (browser mode): an *Inventory* table and a
*Sales log* table full of dates and numbers (with formulas, dropdowns,
currency, fractions, booleans and pre-set summary rows) plus two saved charts
(*Sales by region*, *Sales over time*) — so there is data to query, chart and
export the moment you sign in. The dataset lives in
`public/js/demo-data.mjs`, shared with the backend seeder
(`npm run seed-demo`) so both modes seed identical content.

> The site detects how it is being served: on any host that is not the
> DataForge backend itself, the browser storage layer is used directly — no
> failed network calls, no configuration.

Optional Node backend (disk persistence + OCR for scanned PDFs):

```bash
npm install
npm start          # → http://localhost:3210 (same UI, data saved to data/ + Saves/)
```

Optional helpers:

```bash
npm run test:standalone # headless-Chrome suite proving the app works with NO backend
npm run test:static     # headless-Chrome check: static host + no df_api → browser mode
npm run test:ui         # headless-Chrome check: modal icons + confirm dialogs (delete)
npm run test:flows      # headless-Chrome check: row form, extract + chart builder
npm run seed-demo       # wipe + create demo tables (backend mode only)
npm run test:import     # import-pipeline suite (.docx / .pdf); RUN_OCR=1 adds OCR
npm run e2e-ui          # headless-Chrome end-to-end UI test suite (needs Chrome + the server)
```

Caveats:

- Scanned PDFs (no text layer) need OCR, which only the backend provides
  (`npm start`); in browser mode the import shows a message asking you to
  switch to a text-layer PDF or run the backend.
- Browser-mode exports download the file directly; `Saves/Tables` +
  `Saves/Charts` mirrors are only written in backend mode.
- Backend mode through a dev server: start `npm start`, then open the page
  with `?df_api=http://localhost:3210` appended (or set
  `localStorage.df_api` / `window.DF_API`). If the backend runs on a
  different port, use that port in the URL instead.

Vendor files are already checked in under `public/vendor/` (kept in sync with
`node_modules` after upgrades):

```bash
cp node_modules/chart.js/dist/chart.umd.js public/vendor/chart.umd.js
cp node_modules/xlsx/dist/xlsx.full.min.js public/vendor/xlsx.full.min.js
cp node_modules/pdfjs-dist/build/pdf.mjs       public/vendor/pdfjs/pdf.js
cp node_modules/pdfjs-dist/build/pdf.worker.mjs public/vendor/pdfjs/pdf.worker.js
```

---

## What's implemented (map to the brief)

### 1. Custom tables as separate entities
- Every Table is an independent dataset: own id, name, description, schema,
  created/updated dates and rows — fully isolated (own record + own uploads).
- Rename, duplicate, archive/unarchive, delete, per-card menus.
- Dashboard lists tables as glass cards with **search** and **active/archived**
  filters.

### 2. Column data types
`text` (single/multi), `number` (integer/decimal), `fraction` (n/d,
auto-simplified, supports mixed `1 1/2`), `date`, `time`, `datetime`,
`dropdown` (single **and** multi-select with option lists), `image`
(upload + thumbnail + click-to-enlarge lightbox), `file` (attachment),
`boolean`, `currency` (custom symbol), `formula` (computed column).

Each column supports required/optional, default value, validation
(number min/max, text min/max + regex, dropdown membership) and
**drag-and-drop reordering** of columns.

### 3. Excel-like row/column functions
- Formula language (`public/js/formula.js`, shared with the server so exports
  evaluate identically) with 80+ functions across Math, Text, Logic and
  Date/time: `SUM AVERAGE MIN MAX COUNT COUNTA PRODUCT ROUND ROUNDUP
  ROUNDDOWN ABS INT TRUNC MOD EVEN ODD GCD LCM SQRT CBRT POWER EXP LN LOG
  LOG10 SIGN CEILING FLOOR PI SIN COS TAN ASIN ACOS ATAN ATAN2 DEGREES
  RADIANS` … `CONCAT TEXTJOIN LEN UPPER LOWER PROPER TRIM LEFT RIGHT MID REPT
  SUBSTITUTE FIND VALUE EXACT CHAR CODE` … `IF IFERROR IFNA AND OR NOT TRUE
  FALSE BLANK ISBLANK ISNUMBER ISTEXT ISERROR` … `TODAY NOW YEAR MONTH DAY
  HOUR MINUTE SECOND WEEKDAY DAYS EOMONTH DATEDIFF`.
- Arithmetic with real precedence (`^` powers, unary `-`, `* / %`, `+ -`,
  `&` text join, comparisons, `&& || !`), `( )` and `{ }` grouping, an
  optional Excel-style `=` prefix, and references by column name:
  `[Unit price] * [Qty]` (names may contain spaces).
- The full searchable reference (signatures + examples) ships inside the app:
  the column editor lists click-to-insert functions and Help → Formula
  columns has a live sandbox that evaluates formulas against sample rows.
- **Computed columns** recalculate automatically whenever source data changes.
- **Summary row** per column (Sum / Avg / Min / Max / Count), toggleable and
  configurable per column from the header menu.

### 4. Extract rows/columns → new table
Select rows (or use the multi-select) and columns, then extract into a brand
new table as either:
- a **snapshot copy** (detached, independent), or
- a **linked live view** (pinned row set that mirrors source edits; read-only
  until you *Detach to editable snapshot*).

### 5. Form from a single row
Every row has a row menu → **Open form view**: one input per column,
respecting each column's data type. Edits save straight back to the row.
**Share read-only link** creates a public `#/share/<token>` page (print it via
the browser's **Print / PDF** button for a PDF export).

### 6. Chart generation
- **Starter charts are automatic**: the first time a table holds data (rows +
  columns), a “_Table name_ overview” bar chart is saved for it, so the
  Charts tab is never empty. Deleting a chart keeps it gone; further charts
  are created on demand from the table workspace toolbar → **Chart**.
- The builder queries any table live (group by a column, aggregate
  count/sum/avg/min/max over one or several value columns, or raw scatter):
  bar, stacked bar, line, pie, donut, scatter, radar. Interactive tooltips,
  clickable legend toggling, live data.
- Configs can be **saved** and reopened (dashboard → Charts tab); charts
  export to **PNG/JPG** (client canvas; browser mode downloads the image,
  backend mode also saves a copy under `Saves/Charts/`).

### 7. File import
`.xlsx`, `.xls`, `.csv`, `.docx` and `.pdf` upload → the app parses the file
in the browser (or on the server in backend mode) and **auto-detects column
types**
(text/number/currency/fraction/boolean/date/time/datetime/dropdown),
previews the first rows, and lets you adjust names, types, dropdown
multi-select and skip columns before creating a fully functional table
(≤ 10,000 rows per import).
- **Word (.docx):** the largest real table is extracted directly from the
  document XML; a document with no tables imports as one text row per
  paragraph.
- **PDF:** text-layer PDFs are read with `pdfjs-dist`, including aligned
  multi-column tables reconstructed from per-word geometry. When the text
  layer is empty (scanned pages) each page is rendered via `@napi-rs/canvas`
  and run through **tesseract.js OCR**.

### 8. Export
Any table → **.xlsx / .csv / .docx** with computed formula columns evaluated,
column types preserved (numbers numeric, dates ISO, fractions `n/d`,
booleans TRUE/FALSE, currency numeric). **Word (.docx) exports embed the
uploaded photos** of Image columns right in the table cells; .xlsx/.csv carry
the file name. In browser mode the file downloads directly; in backend mode it
is also written to `Saves/Tables/` (chart images → `Saves/Charts/`).

---

## Code map

```
server/
  index.js          Express app: static files, REST routes, error handling
  auth.js           login sessions + user store (admin seeding, role field)
  store.js          per-table JSON store: CRUD, coercion, extraction, charts
  io.js             spreadsheet + Word + PDF (OCR) parsing, exports, saves
  util.js           ids, password hashing, filename sanitising
public/  ← the whole website (serve this folder on Live Server / any static host)
  index.html        SPA shell (theme bootstrap, fonts, formula + Chart.js)
  css/main.css      design system: glass, themes, tables, modals, print
  js/
    app.js          hash router + top bar chrome
    api.js          data-access facade — routes to the browser layer or REST
    localstore.js   ★ browser data layer: creates & stores everything in
                    IndexedDB (tables, columns, rows, charts, shares, files)
    formula.js      UMD Excel-style formula engine (browser + Node shared)
    types.js        column-type registry: display, inline editors, validation
    compute.js      formula recalculation + summaries
    compute-shim.js default-namespace wrapper for compute.js
    util.js  icons.js  theme.js
    views/          login · dashboard (tables + charts tab) · table · share
    components/     columnEditor · importModal · chartBuilder · rowForm ·
                    extractModal
  vendor/           chart.umd.js · xlsx.full.min.js · pdfjs/ (self-contained)

server/  ← optional legacy Node/Express backend (disk persistence + OCR)
  index.js          Express app: static files, REST routes, error handling
  auth.js           login sessions + user store (admin seeding, role field)
  store.js          per-table JSON store: CRUD, coercion, extraction, charts
  io.js             spreadsheet + Word + PDF (OCR) parsing, exports, saves
  util.js           ids, password hashing, filename sanitising
data/               runtime data (backend mode only; gitignored)
Saves/Tables        exported table files (backend mode only)
Saves/Charts        exported chart images (backend mode only)
scripts/            seed-demo.mjs · e2e-ui.mjs · test-import.mjs · e2e-flows.mjs
```

### REST API (abridged)
`/api/auth/login` · `/api/auth/me` · `/api/users` (admin) ·
`/api/tables` CRUD + `/:id/duplicate|archive|unarchive|detach|export?format=` ·
`/api/tables/extract` · columns & rows endpoints under `/api/tables/:id/…` ·
row shares `/api/tables/:id/rows/:rowId/share` ·
`/api/import/parse` · `/api/import/create` · `/api/charts` ·
`/api/charts/export` · public `GET /api/share/:token`.

---

## How to extend

### Add a new column data type
1. Register it in `public/js/types.js` `TYPES` (label, group, icon).
2. Implement `cellHTML()` + `attachEditor()` branches there.
3. Add its option fields in `public/js/components/columnEditor.js`.
4. Mirror storage coercion + validation in `server/store.js`
   (`TYPES`, `coerceValue`, `validateNumberConstraint`).

### Add a formula function
Add an entry to `FUNCTIONS` in `public/js/formula.js` — the server shares the
same file, so exports, computed columns and the editor's live check all gain
it at once. Wrap values as `{v: …}` (see existing entries); use
`lazy: true` + `(ctx, args, { evalNode })` for short-circuit functions like
`IF`.

### Add a chart type
1. Add to `CHART_TYPES` in `public/js/components/chartBuilder.js`.
2. Extend `buildData()` (grouping/aggregation rules) and `chartOptions()`
   (axes/stacking/pie handling).

### Import another file format
Import already covers `.xlsx/.xls/.csv/.docx/.pdf`. `server/io.js` is the
integration point for more formats: each parser returns a normalized
`{ sheetName, headers, rows }` shape that the whole pipeline (type detection,
preview/mapping UI, table creation) already consumes, and is registered in
`createImportJob()` by extension. Then add the extension to the accept list
in `public/js/components/importModal.js`. Notes on the current parsers:
- `.docx` is read directly from WordprocessingML (no `mammoth` needed);
  tables come from `<w:tbl>` and body text from `<w:p>`.
- `.pdf` runs `pdfjs-dist` for the text layer (column reconstruction in
  `detectColumnCenters()`/`linesToRows()`), and falls back to
  `tesseract.js` OCR of each page rendered with `@napi-rs/canvas`. Set
  `TESSDATA_DIR` to a folder that already holds `eng.traineddata` to make
  OCR fully offline; otherwise the model downloads on first use.
- tesseract.js v7 note: `worker.recognize()` must be passed
  `{ text: true, blocks: true }` — only `text` is produced by default.

### Multi-user / permissions
`server/auth.js` explains the scopes: user records carry `role`
(`admin`/`member`, seedable `superuser`) and a `perms` map; admin-only
`/api/users` endpoints already exist. Tables are filtered by `ownerId`; add a
`sharedWith` list + `requirePerm('tables', …)` for per-table sharing.

### Cloud storage / real database
Replace the `data/` and `Saves/` folder writes with S3 or a Postgres/JSONB
backend while preserving the folder layout and table document shape —
`server/store.js` and `server/io.js` are the only places that touch disk.

---

## Notes & known scope
- Auth is prototype-grade: in-memory sessions, single default admin,
  password hashing via `scrypt`.
- Linked views pin a *row set* (values stay live, membership is fixed until
  re-extraction or detach).
- Chart builder currently offers group-by + aggregation; free-form filter
  conditions are a reserved config field for a later iteration.
- Grid editing commits per cell (Enter/blur); there is no bulk paste yet.

Built and verified: backend REST suite (38 checks) + headless-Chrome UI suite
(34 checks, no uncaught page errors) + import-pipeline suite (14 checks
covering .docx tables, paragraph documents, text PDFs and OCR scans;
`npm run test:import`, `RUN_OCR=1` for the OCR leg).
