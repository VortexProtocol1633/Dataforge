/*
 * Seed the demo dataset through the REST API (backend mode).
 * Same content as the browser auto-seed — both read public/js/demo-data.js.
 * Wipes existing tables + charts first so the seed is idempotent.
 *   npm run seed-demo        (needs `npm start` running on :3210)
 */
import { DEMO_TABLES, DEMO_CHARTS } from '../public/js/demo-data.mjs';

const BASE = 'http://localhost:3210';
let TOK = null;
const r = async (m, p, b) => {
  const res = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${m} ${p} ${res.status} ${JSON.stringify(j)}`);
  return j;
};
TOK = (await r('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).token;

// wipe existing data so the seed is idempotent
const existing = (await r('GET', '/api/tables?includeArchived=1')).tables;
for (const t of existing) await r('DELETE', `/api/tables/${t.id}`);
for (const c of (await r('GET', '/api/charts')).charts) await r('DELETE', `/api/charts/${c.id}`);

// create the demo tables + rows + summaries
const ids = {};
for (const def of DEMO_TABLES) {
  const created = await r('POST', '/api/tables', { name: def.name, description: def.description, columns: def.columns });
  const t = created.table;
  ids[def.name] = t.id;
  const colId = (n) => t.columns.find((c) => c.name === n).id;
  for (const rw of def.rows || []) {
    const values = {};
    for (const k in rw) values[colId(k)] = rw[k];
    await r('POST', `/api/tables/${t.id}/rows`, { values });
  }
  if (def.summaries && def.summaries.length) {
    await r('PUT', `/api/tables/${t.id}/summaries`, { summaries: def.summaries.map((s) => ({ columnId: colId(s.column), func: s.func })) });
  }
}

// saved charts (name -> id mapping; order kept so “Sales by region” is newest)
for (const c of DEMO_CHARTS) {
  const table = (await r('GET', `/api/tables/${ids[c.table]}`)).table;
  const colId = (n) => table.columns.find((x) => x.name === n).id;
  await r('POST', '/api/charts', {
    name: c.name,
    config: {
      tableId: ids[c.table],
      type: c.type,
      xColumn: colId(c.xColumn),
      yColumns: (c.yColumns || []).map(colId),
      aggregate: c.aggregate,
      title: c.title,
      stacked: c.stacked,
      showLegend: c.showLegend,
    },
  });
}

console.log('seeded:', Object.values(ids).join(' '));