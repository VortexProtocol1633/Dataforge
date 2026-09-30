/** Thin data-access facade with two interchangeable creation/storage systems.
 *
 *  - Local (default on static hosts): every table, column, row, chart, share,
 *    import and export is created and stored in the browser itself — an
 *    IndexedDB-backed layer (./localstore.js). This is what makes the site a
 *    plain HTML/CSS/JS website that runs on VS Code's Live Server (or any
 *    static host) with no backend at all.
 *
 *  - Remote (opt-in): when the page is served by the DataForge Node backend
 *    itself, or an explicit ?df_api= / window.DF_API / localStorage.df_api
 *    override points at a running backend, calls go over fetch() to that
 *    REST API (which persists to disk and adds OCR). If the backend becomes
 *    unreachable mid-session it transparently falls back to the local layer.
 */

import { localApi } from './localstore.js';

const TOKEN_KEY = 'df_token';
const USER_KEY = 'df_user';
const API_DEFAULT_PORT = 3210; // keep in sync with server/index.js (PORT)

/**
 * Where the REST API lives, relative to this page.
 *  - ''            → same origin (the page is served by the DataForge backend)
 *  - 'http://…'    → another localhost port: the page is opened through a dev
 *                    server such as VS Code's Live Server and must call back
 *                    into the backend. Override with ?df_api= or window.DF_API.
 */
function detectApiBase() {
  try {
    if (window.DF_API) return String(window.DF_API).replace(/\/+$/, '');
  } catch { /* ignore */ }
  if (typeof location === 'undefined') return '';
  try {
    const q = new URLSearchParams(location.search);
    const viaQuery = q.get('df_api');
    if (viaQuery) return viaQuery.replace(/\/+$/, '');
    const viaStorage = localStorage.getItem('df_api');
    if (viaStorage) return viaStorage.replace(/\/+$/, '');
  } catch { /* ignore */ }
  const port = location.port;
  if (!port || port === String(API_DEFAULT_PORT)) return '';
  return `http://localhost:${API_DEFAULT_PORT}`;
}

export const API_BASE = detectApiBase();

/** Absolute URL for an API path (server-relative paths are left untouched). */
export function apiUrl(path) {
  if (API_BASE === '' || /^https?:\/\//i.test(path)) return path;
  return API_BASE + (path.startsWith('/') ? path : `/${path}`);
}

/** Make a server-relative asset URL absolute in dev-server mode (data: URLs pass through). */
export function assetUrl(u) {
  if (u == null || u === '' || API_BASE === '') return u;
  if (/^(https?:|data:)/i.test(String(u))) return u;
  if (String(u).startsWith('/')) return API_BASE + u;
  return u;
}

/** Full URL to the public read-only page for a shared row token. */
export function sharePageUrl(token) {
  return `${location.origin}${location.pathname}#/share/${token}`;
}

export function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } }
export function setAuth(token, user) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user)); else localStorage.removeItem(USER_KEY);
  } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, 'Cannot reach the server — is it running?');
  }
  if (res.status === 401) {
    setAuth(null, null);
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    throw new ApiError(401, 'Session expired — please log in again');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Remote-or-local dispatch                                            */
/* ------------------------------------------------------------------ */

let mode = detectInitialMode(); // 'remote' | 'local'

/**
 * Decide which data layer serves the app before the first API call.
 *
 *  - 'remote': the DataForge backend (Node/Express) answers REST calls —
 *    used when the page is served by the backend itself (its default port)
 *    or when an explicit ?df_api= / window.DF_API / localStorage.df_api
 *    override points at a running backend.
 *  - 'local': fully standalone — everything is created and stored in the
 *    browser (IndexedDB via ./localstore.js). This is the mode used on
 *    static hosts such as VS Code's Live Server, so the site runs with no
 *    backend at all.
 */
function detectInitialMode() {
  try { if (window.DF_API) return 'remote'; } catch { /* ignore */ }
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('df_api')) return 'remote';
    if (localStorage.getItem('df_api')) return 'remote';
  } catch { /* ignore */ }
  const port = location.port;
  // Served directly by the DataForge backend on its default port → same origin.
  if (!port || port === String(API_DEFAULT_PORT)) return 'remote';
  // Any other host (Live Server, http-server, GitHub Pages, …) → browser storage.
  return 'local';
}

/**
 * Run an operation. In local mode the call is handled entirely in the
 * browser; in remote mode the backend is tried first and, on a network
 * failure (status 0), the session transparently switches to the local layer.
 * Errors from the local layer are normalised to ApiError so the views handle
 * both modes identically.
 */
async function run(remote, local) {
  if (mode === 'local') {
    try { return await local(); }
    catch (le) {
      throw le instanceof ApiError ? le : new ApiError(typeof le.status === 'number' && le.status !== 0 ? le.status : 500, le.message || String(le));
    }
  }
  try {
    const v = await remote();
    mode = 'remote';
    return v;
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) {
      mode = 'local';
      try { window.DF_API_MODE = 'local'; } catch { /* ignore */ }
      try { return await local(); } catch (le) {
        throw le instanceof ApiError ? le : new ApiError(typeof le.status === 'number' && le.status !== 0 ? le.status : 500, le.message || String(le));
      }
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* API surface                                                        */
/* ------------------------------------------------------------------ */

async function remoteExportData(id, format) {
  const res = await fetch(apiUrl(`/api/tables/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`), {
    headers: { Authorization: `Bearer ${getToken() || ''}` },
  });
  if (!res.ok) {
    let msg = 'Export failed';
    try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="?([^";]+)"?/);
  return { blob: await res.blob(), filename: m ? m[1] : `table.${format}` };
}

export const api = {
  // auth
  login: (username, password) => run(
    () => request('POST', '/api/auth/login', { username, password }),
    () => localApi.login(username, password),
  ),
  logout: () => run(
    () => request('POST', '/api/auth/logout'),
    () => localApi.logout(),
  ),
  me: () => run(
    () => request('GET', '/api/auth/me'),
    () => localApi.me(),
  ),

  // tables
  listTables: (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.includeArchived) q.set('includeArchived', '1');
    if (opts.search) q.set('search', opts.search);
    if (opts.kind) q.set('kind', opts.kind);
    return run(() => request('GET', `/api/tables?${q}`), () => localApi.list(opts).then((tables) => ({ tables })));
  },
  createTable: (body) => run(() => request('POST', '/api/tables', body), () => localApi.create(body).then((table) => ({ table }))),
  getTable: (id) => run(() => request('GET', `/api/tables/${id}`), () => localApi.get(id).then((table) => ({ table }))),
  updateTable: (id, body) => run(() => request('PATCH', `/api/tables/${id}`, body), () => localApi.updateMeta(id, body).then((table) => ({ table }))),
  duplicateTable: (id) => run(() => request('POST', `/api/tables/${id}/duplicate`), () => localApi.duplicate(id).then((table) => ({ table }))),
  setArchived: (id, archived) => run(() => request('POST', `/api/tables/${id}/${archived ? 'archive' : 'unarchive'}`), () => localApi.setArchived(id, archived)),
  deleteTable: (id) => run(() => request('DELETE', `/api/tables/${id}`), () => localApi.remove(id)),
  extract: (body) => run(() => request('POST', '/api/tables/extract', body), () => localApi.extract(body).then((table) => ({ table }))),
  detach: (id) => run(() => request('POST', `/api/tables/${id}/detach`), () => localApi.detach(id).then((table) => ({ table }))),
  putSummaries: (id, summaries) => run(() => request('PUT', `/api/tables/${id}/summaries`, { summaries }), () => localApi.putSummaries(id, summaries)),

  // columns
  addColumn: (id, body) => run(() => request('POST', `/api/tables/${id}/columns`, body), () => localApi.addColumn(id, body).then((column) => ({ column }))),
  updateColumn: (id, colId, body) => run(() => request('PATCH', `/api/tables/${id}/columns/${colId}`, body), () => localApi.updateColumn(id, colId, body).then((column) => ({ column }))),
  deleteColumn: (id, colId) => run(() => request('DELETE', `/api/tables/${id}/columns/${colId}`), () => localApi.removeColumn(id, colId)),
  reorderColumns: (id, orderedIds) => run(() => request('POST', `/api/tables/${id}/columns/reorder`, { orderedIds }), () => localApi.reorderColumns(id, orderedIds)),

  // rows
  addRow: (id, values) => run(() => request('POST', `/api/tables/${id}/rows`, { values }), () => localApi.addRow(id, values).then((row) => ({ row }))),
  updateRow: (id, rowId, values) => run(() => request('PATCH', `/api/tables/${id}/rows/${rowId}`, { values }), () => localApi.updateRow(id, rowId, values).then((row) => ({ row }))),
  deleteRows: (id, rowIds) => run(() => request('DELETE', `/api/tables/${id}/rows`, { rowIds }), () => localApi.deleteRows(id, rowIds)),
  shareRow: (id, rowId) => run(() => request('POST', `/api/tables/${id}/rows/${rowId}/share`), () => localApi.shareRow(id, rowId)),

  // files
  saveFile: (id, file) => run(() => request('POST', `/api/tables/${id}/files`, file), () => localApi.saveFile(id, file).then((f) => ({ file: f }))),

  /** Reveal a table's backend file in the OS file manager (backend mode only). */
  openFileLocation: (id) => run(
    () => request('POST', `/api/tables/${id}/open-location`),
    () => Promise.reject(new ApiError(400, 'Browser mode keeps tables inside your browser (IndexedDB). Run the app through the backend (`npm start`) and this opens the table file in your file manager.')),
  ),

  // import / export
  importParse: (filename, base64) => run(() => request('POST', '/api/import/parse', { filename, data: base64 }), () => localApi.importParse(filename, base64)),
  importCreate: (body) => run(() => request('POST', '/api/import/create', body), () => localApi.importCreate(body)),
  /** { blob, filename } for a table export — remote fetches the endpoint, local builds the file in-browser. */
  exportData: (id, format) => run(() => remoteExportData(id, format), () => localApi.exportData(id, format)),

  // charts
  listCharts: () => run(() => request('GET', '/api/charts'), () => localApi.listCharts().then((charts) => ({ charts }))),
  saveChart: (body) => run(() => request('POST', '/api/charts', body), () => localApi.saveChart(body).then((chart) => ({ chart }))),
  deleteChart: (id) => run(() => request('DELETE', `/api/charts/${id}`), () => localApi.deleteChart(id)),
  saveChartImage: (body) => run(() => request('POST', '/api/charts/export', body), () => localApi.saveChartImage(body)),

  // public share payload (no auth)
  getShare: (token) => run(
    () => request('GET', `/api/share/${encodeURIComponent(token)}`),
    () => localApi.getShare(token),
  ),
};

// expose the resolved data layer for tests / debugging
try { window.DF_API_MODE = mode; } catch { /* ignore */ }
