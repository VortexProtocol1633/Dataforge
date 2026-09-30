/**
 * Demo dataset — the original demo tables (Inventory, Sales log) enriched
 * with more dates and numbers so formulas, summaries, filters and charts have
 * plenty to work with. It is the single source of truth for demo content:
 *
 *   - browser / standalone mode: auto-seeded on first run by localstore.js
 *   - backend mode:               created by scripts/seed-demo.mjs
 *
 * Rows are keyed by COLUMN NAME; each consumer maps names to the stored
 * column ids of the table it just created.
 */

export const DEMO_TABLES = [
  {
    name: 'Inventory',
    description: 'Demo stock with formulas (Total = Unit price × Qty) and typed columns.',
    columns: [
      { name: 'Item', type: 'text', options: { required: true } },
      { name: 'Category', type: 'dropdown', options: { list: ['Furniture', 'Lighting', 'Storage'], multi: false } },
      { name: 'Unit price', type: 'currency', options: { symbol: '$' } },
      { name: 'Qty', type: 'number', subtype: 'integer', options: {} },
      { name: 'Total', type: 'formula', options: { formula: 'ROUND([Unit price] * [Qty], 2)' } },
      { name: 'Weight kg', type: 'fraction', options: {} },
      { name: 'In stock', type: 'boolean', options: {} },
      { name: 'First stocked', type: 'date', options: {} },
      { name: 'Photo', type: 'image', options: {} },
    ],
    rows: [
      { Item: 'Office chair', Category: 'Furniture', 'Unit price': 89.9, Qty: 12, 'Weight kg': '5 1/2', 'In stock': true, 'First stocked': '2024-01-12' },
      { Item: 'Standing desk', Category: 'Furniture', 'Unit price': 329.5, Qty: 4, 'Weight kg': '22/3', 'In stock': false, 'First stocked': '2023-11-02' },
      { Item: 'LED lamp', Category: 'Lighting', 'Unit price': 24.99, Qty: 40, 'Weight kg': '3/4', 'In stock': true, 'First stocked': '2024-02-28' },
      { Item: 'Bookshelf', Category: 'Storage', 'Unit price': 149, Qty: 7, 'Weight kg': '12', 'In stock': true, 'First stocked': '2024-04-05' },
      { Item: 'Desk lamp', Category: 'Lighting', 'Unit price': 18.5, Qty: 60, 'Weight kg': '1 1/4', 'In stock': true, 'First stocked': '2024-05-19' },
      { Item: 'Filing cabinet', Category: 'Storage', 'Unit price': 210.75, Qty: 3, 'Weight kg': '15 1/2', 'In stock': false, 'First stocked': '2023-08-30' },
    ],
    summaries: [
      { column: 'Unit price', func: 'avg' },
      { column: 'Qty', func: 'sum' },
      { column: 'Total', func: 'sum' },
    ],
  },
  {
    name: 'Sales log',
    description: 'Demo table for charting and queries — dates, quantities and money, with Amount computed from Qty × Unit price.',
    columns: [
      { name: 'Date', type: 'date', options: {} },
      { name: 'Region', type: 'dropdown', options: { list: ['North', 'South', 'East', 'West'], multi: false } },
      { name: 'Product', type: 'dropdown', options: { list: ['Office chair', 'Standing desk', 'LED lamp', 'Desk lamp', 'Bookshelf', 'Filing cabinet'], multi: false } },
      { name: 'Qty', type: 'number', subtype: 'integer', options: {} },
      { name: 'Unit price', type: 'currency', options: { symbol: '$' } },
      { name: 'Amount', type: 'formula', options: { formula: 'ROUND([Qty] * [Unit price], 2)' } },
      { name: 'Closed at', type: 'datetime', options: {} },
      { name: 'Notes', type: 'text', subtype: 'multi', options: {} },
    ],
    rows: [
      { Date: '2024-06-03', Region: 'North', Product: 'Office chair', Qty: 12, 'Unit price': 89.9, 'Closed at': '2024-06-03 09:15', Notes: 'Enterprise renewal' },
      { Date: '2024-06-03', Region: 'East', Product: 'Standing desk', Qty: 2, 'Unit price': 329.5, 'Closed at': '2024-06-03 11:40', Notes: 'New client' },
      { Date: '2024-06-04', Region: 'South', Product: 'LED lamp', Qty: 30, 'Unit price': 24.99, 'Closed at': '2024-06-04 14:05', Notes: '' },
      { Date: '2024-06-05', Region: 'North', Product: 'Desk lamp', Qty: 24, 'Unit price': 18.5, 'Closed at': '2024-06-05 16:30', Notes: '' },
      { Date: '2024-06-06', Region: 'West', Product: 'Bookshelf', Qty: 5, 'Unit price': 149, 'Closed at': '2024-06-06 10:20', Notes: 'POS order' },
      { Date: '2024-06-07', Region: 'South', Product: 'Filing cabinet', Qty: 3, 'Unit price': 210.75, 'Closed at': '2024-06-07 13:55', Notes: 'Bulk deal' },
    ],
    summaries: [
      { column: 'Unit price', func: 'avg' },
      { column: 'Qty', func: 'sum' },
      { column: 'Amount', func: 'sum' },
    ],
  },
];

/**
 * Saved chart configs. `table`/`xColumn`/`yColumns` are names; consumers map
 * them to the ids of the seeded tables. Order matters for the Charts tab
 * (newest first) — keep the flagship chart last.
 */
export const DEMO_CHARTS = [
  {
    name: 'Sales over time',
    table: 'Sales log',
    type: 'line',
    xColumn: 'Date',
    yColumns: ['Amount'],
    aggregate: 'sum',
    title: 'Sales over time',
    stacked: false,
    showLegend: true,
  },
  {
    name: 'Sales by region',
    table: 'Sales log',
    type: 'bar',
    xColumn: 'Region',
    yColumns: ['Amount'],
    aggregate: 'sum',
    title: 'Sales by region',
    stacked: false,
    showLegend: true,
  },
];