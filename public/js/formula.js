/* global module */
/**
 * DataForge Formula Engine — a small Excel-style expression language.
 *
 * This file is shared between the browser (live recalculation) and the Node
 * server (exporting computed columns). It is written UMD-style so both can
 * load it:
 *   - Node:      const Fx = require('.../formula.js')
 *   - Browser:   <script src="/js/formula.js"> -> window.DataForgeFx
 *
 * Syntax
 *   - Grouping          ( ) { } — braces behave like parentheses, innermost first
 *   - Arithmetic        + - * / ^ %  (unary - and +)
 *   - Comparisons       = == <> != < <= > >=
 *   - Logic             AND(...) OR(...) NOT(x), && || !
 *   - Cell references   [Column Name]
 *   - Strings           "text" or 'text'
 *   - Numbers           12, 3.5, 1e3
 *   - Blank             BLANK()
 *
 * A formula may start with an optional '=' sign (Excel style), e.g.
 * "=ROUND([Price] * [Qty], 2)".
 *
 * The full, searchable function reference (signatures + examples) is exposed
 * as window.DataForgeFx.META and drives the column editor and Help UI.
 *
 * ctx interface: { getValue(name) -> value | undefined, today?(), now?() }
 * Values: number | string | boolean | null/undefined (blank) | Date-ish
 * ('YYYY-MM-DD', 'HH:MM', 'YYYY-MM-DD HH:MM' or ISO strings parse automatically)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DataForgeFx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ----------------------------- tokenizer ----------------------------- */

  const TOK = {
    NUMBER: 'NUMBER', STRING: 'STRING', WORD: 'WORD', OP: 'OP',
    LPAREN: 'LPAREN', RPAREN: 'RPAREN', COMMA: 'COMMA',
    COLREF: 'COLREF', EOF: 'EOF',
  };

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    const s = String(src == null ? '' : src);
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s[j])) j++;
        if (s[j] === 'e' || s[j] === 'E') { j++; if (s[j] === '+' || s[j] === '-') j++; while (j < s.length && /[0-9]/.test(s[j])) j++; }
        tokens.push({ type: TOK.NUMBER, value: parseFloat(s.slice(i, j)), pos: i });
        i = j; continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        let out = '';
        let closed = false;
        while (j < s.length) {
          if (s[j] === quote) { if (s[j + 1] === quote) { out += quote; j += 2; continue; } closed = true; j++; break; }
          out += s[j]; j++;
        }
        if (!closed) return { error: 'Unterminated string literal' };
        tokens.push({ type: TOK.STRING, value: out, pos: i });
        i = j; continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j++;
        tokens.push({ type: TOK.WORD, value: s.slice(i, j), pos: i });
        i = j; continue;
      }
      const two = s.slice(i, i + 2);
      if (['<=', '>=', '<>', '!=', '==', '&&', '||', '^='].includes(two)) {
        tokens.push({ type: TOK.OP, value: two === '^=' ? '!=' : two, pos: i });
        i += 2; continue;
      }
      if ('+-*/^%<>=!&|'.includes(ch)) {
        tokens.push({ type: TOK.OP, value: ch, pos: i });
        i++; continue;
      }
      if (ch === '(' || ch === '{') { tokens.push({ type: TOK.LPAREN, char: ch, pos: i }); i++; continue; }
      if (ch === ')' || ch === '}') { tokens.push({ type: TOK.RPAREN, char: ch, pos: i }); i++; continue; }
      if (ch === ',') { tokens.push({ type: TOK.COMMA, pos: i }); i++; continue; }
      if (ch === '[') {
        // read the whole bracketed reference verbatim so column names keep spaces
        const close = s.indexOf(']', i + 1);
        if (close === -1) return { error: 'Unterminated column reference — missing “]”' };
        let name = s.slice(i + 1, close).trim();
        if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) name = name.slice(1, -1);
        if (!name) return { error: 'Empty column reference [ ]' };
        tokens.push({ type: TOK.COLREF, value: name, pos: i });
        i = close + 1;
        continue;
      }
      return { error: `Unexpected character "${ch}"` };
    }
    tokens.push({ type: TOK.EOF, pos: s.length });
    return { tokens };
  }

  /* ------------------------------- parser ------------------------------ */

  class Parser {
    constructor(tokens) { this.tokens = tokens; this.pos = 0; }
    peek(o = 0) { return this.tokens[this.pos + o] || this.tokens[this.tokens.length - 1]; }
    next() { return this.tokens[this.pos++]; }
    atOp(v) { const t = this.peek(); return t.type === TOK.OP && t.value === v; }
    atWord(v) { const t = this.peek(); return t.type === TOK.WORD && t.value.toUpperCase() === v.toUpperCase(); }
    expectOp(v) { if (!this.atOp(v)) throw new Error(`Expected "${v}"`); this.pos++; }
    expect(type) { const t = this.next(); if (t.type !== type) throw new Error('Syntax error'); return t; }

    parse() {
      if (this.peek().type === TOK.EOF) throw new Error('Formula is empty');
      // Tolerate an Excel-style leading '=' (e.g. "=ROUND([A]*2, 0)").
      if (this.peek().type === TOK.OP && this.peek().value === '=') this.pos++;
      if (this.peek().type === TOK.EOF) throw new Error('Formula is empty');
      const e = this.orExpr();
      if (this.peek().type !== TOK.EOF) throw new Error('Unexpected token after expression');
      return e;
    }

    orExpr() {
      let left = this.andExpr();
      while (this.atOp('||')) {
        this.pos++;
        left = { op: 'OR', left, right: this.andExpr() };
      }
      return left;
    }
    andExpr() {
      let left = this.cmpExpr();
      while (this.atOp('&&')) {
        this.pos++;
        left = { op: 'AND', left, right: this.cmpExpr() };
      }
      return left;
    }
    cmpExpr() {
      const left = this.concatExpr();
      const t = this.peek();
      if (t.type === TOK.OP && ['=', '==', '<>', '!=', '<', '<=', '>', '>='].includes(t.value)) {
        this.pos++;
        return { op: t.value, left, right: this.concatExpr() };
      }
      return left;
    }
    // single '&' is text concatenation (Excel-style); '&&' is logical AND
    concatExpr() {
      let left = this.addExpr();
      while (this.atOp('&')) {
        this.pos++;
        left = { op: '&', left, right: this.addExpr() };
      }
      return left;
    }
    addExpr() {
      let left = this.mulExpr();
      while (this.peek().type === TOK.OP && (this.peek().value === '+' || this.peek().value === '-')) {
        const op = this.next().value;
        left = { op, left, right: this.mulExpr() };
      }
      return left;
    }
    mulExpr() {
      let left = this.powExpr();
      while (this.peek().type === TOK.OP && (this.peek().value === '*' || this.peek().value === '/' || this.peek().value === '%')) {
        const op = this.next().value;
        left = { op, left, right: this.powExpr() };
      }
      return left;
    }
    powExpr() {
      const left = this.unary();
      if (this.atOp('^')) { this.pos++; return { op: '^', left, right: this.powExpr() }; }
      return left;
    }
    unary() {
      const t = this.peek();
      if (t.type === TOK.OP && t.value === '-') { this.pos++; return { op: 'neg', arg: this.unary() }; }
      if (t.type === TOK.OP && t.value === '+') { this.pos++; return this.unary(); }
      if (t.type === TOK.OP && t.value === '!') { this.pos++; return { op: 'not', arg: this.unary() }; }
      return this.primary();
    }
    primary() {
      const t = this.peek();
      if (t.type === TOK.NUMBER) { this.pos++; return { type: 'num', value: t.value }; }
      if (t.type === TOK.STRING) { this.pos++; return { type: 'str', value: t.value }; }
      if (t.type === TOK.LPAREN) {
        this.pos++;
        const e = this.orExpr();
        this.expect(TOK.RPAREN);
        return e;
      }
      if (t.type === TOK.WORD) {
        const word = t.value.toUpperCase();
        // Bare TRUE / FALSE are boolean literals; TRUE() / FALSE() are functions.
        if ((word === 'TRUE' || word === 'FALSE') && this.peek(1).type !== TOK.LPAREN) {
          this.pos++;
          return { type: 'bool', value: word === 'TRUE' };
        }
        this.pos++;
        if (this.peek().type !== TOK.LPAREN) throw new Error(`Unknown name "${t.value}" — reference columns with [Name]`);
        this.pos++;
        const args = [];
        if (this.peek().type !== TOK.RPAREN) {
          args.push(this.orExpr());
          while (this.peek().type === TOK.COMMA) { this.pos++; args.push(this.orExpr()); }
        }
        this.expect(TOK.RPAREN);
        return { type: 'call', name: word, args };
      }
      if (t.type === TOK.COLREF) {
        this.pos++;
        return { type: 'col', name: t.value };
      }
      throw new Error('Expected a value');
    }
  }

  function parseFormula(src) {
    const tok = tokenize(src);
    if (tok.error) return { ok: false, error: tok.error };
    try {
      return { ok: true, ast: new Parser(tok.tokens).parse() };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  /* ---------------------------- evaluation ----------------------------- */

  const ERR = (msg) => ({ error: msg });

  function isBlank(v) { return v === null || v === undefined || v === ''; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** Interpret stored strings as dates/times when a function needs them. */
  function toDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000)); // excel serial
    if (typeof v !== 'string') return null;
    const s = v.trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return new Date(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/))) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if ((m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/))) {
      const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); return d;
    }
    const iso = new Date(s);
    return isNaN(iso.getTime()) ? null : iso;
  }

  function num(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (isBlank(v)) return NaN;
    const s = String(v).trim();
    const n = s === '' ? NaN : Number(s);
    return n;
  }

  function asString(v) {
    if (isBlank(v)) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return String(v);
    return String(v);
  }

  function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (isBlank(v)) return false;
    if (typeof v === 'number') return v !== 0;
    return true;
  }

  function gcdInt(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }

  /** Excel EVEN — round away from zero to the nearest even integer. */
  function evenAway(v) {
    if (!isNum(v)) return ERR('#VALUE!');
    const a = Math.abs(v);
    let n = Math.ceil(a);
    if (n % 2 === 1) n += 1;
    return v < 0 ? -n : n;
  }

  /** Excel ODD — round away from zero to the nearest odd integer. */
  function oddAway(v) {
    if (!isNum(v)) return ERR('#VALUE!');
    const a = Math.abs(v);
    let n = Math.ceil(a);
    if (n % 2 === 0) n += 1;
    return v < 0 ? -n : n;
  }

  const FUNCTIONS = {
    // aggregates over the argument list (each arg usually a [Column] ref)
    SUM: { args: '*', fn: (ctx, args) => { let t = 0; for (const a of args) { const v = num(a.v); if (!isNaN(v)) t += v; } return t; } },
    PRODUCT: { args: '*', fn: (ctx, args) => { let t = 1; let any = false; for (const a of args) { const v = num(a.v); if (!isNaN(v)) { t *= v; any = true; } } return any ? t : 0; } },
    AVERAGE: { args: '*', fn: (ctx, args) => { const vals = args.map((a) => num(a.v)).filter((v) => !isNaN(v)); return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : ERR('#DIV/0!'); } },
    AVG: { args: '*', alias: 'AVERAGE' },
    MIN: { args: '*', fn: (ctx, args) => { const vals = args.map((a) => num(a.v)).filter((v) => !isNaN(v)); return vals.length ? Math.min(...vals) : 0; } },
    MAX: { args: '*', fn: (ctx, args) => { const vals = args.map((a) => num(a.v)).filter((v) => !isNaN(v)); return vals.length ? Math.max(...vals) : 0; } },
    COUNT: { args: '*', fn: (ctx, args) => args.filter((a) => isNum(a.v)).length },
    COUNTA: { args: '*', fn: (ctx, args) => args.filter((a) => !isBlank(a.v)).length },

    ROUND: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const d = Math.pow(10, a.length > 1 ? Math.trunc(num(a[1].v)) || 0 : 0); return Math.round(num(a[0].v) * d) / d; } },
    ROUNDUP: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const d = Math.pow(10, a.length > 1 ? Math.trunc(num(a[1].v)) || 0 : 0); return Math.ceil(num(a[0].v) * d) / d; } },
    ROUNDDOWN: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const d = Math.pow(10, a.length > 1 ? Math.trunc(num(a[1].v)) || 0 : 0); return Math.floor(num(a[0].v) * d) / d; } },
    ABS: { args: 1, fn: (ctx, a) => Math.abs(num(a[0].v)) },
    INT: { args: 1, fn: (ctx, a) => Math.trunc(num(a[0].v)) },
    TRUNC: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const d = Math.pow(10, a.length > 1 ? Math.trunc(num(a[1].v)) || 0 : 0); return Math.trunc(num(a[0].v) * d) / d; } },
    MOD: { args: 2, fn: (ctx, a) => { const d = num(a[1].v); return d === 0 ? ERR('#DIV/0!') : num(a[0].v) % d; } },
    SQRT: { args: 1, fn: (ctx, a) => { const v = num(a[0].v); return v < 0 ? ERR('#NUM!') : Math.sqrt(v); } },
    POWER: { args: 2, fn: (ctx, a) => Math.pow(num(a[0].v), num(a[1].v)) },
    EXP: { args: 1, fn: (ctx, a) => Math.exp(num(a[0].v)) },
    LN: { args: 1, fn: (ctx, a) => { const v = num(a[0].v); return v <= 0 ? ERR('#NUM!') : Math.log(v); } },
    LOG10: { args: 1, fn: (ctx, a) => { const v = num(a[0].v); return v <= 0 ? ERR('#NUM!') : Math.log10(v); } },
    LOG: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const x = num(a[0].v); const b = a.length > 1 ? num(a[1].v) : 10; if (x <= 0 || b <= 0 || b === 1) return ERR('#NUM!'); return Math.log(x) / Math.log(b); } },
    SIGN: { args: 1, fn: (ctx, a) => Math.sign(num(a[0].v)) },
    CEILING: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const x = num(a[0].v); const sig = a.length > 1 ? num(a[1].v) : 1; if (sig === 0) return ERR('#DIV/0!'); return Math.ceil(x / sig) * sig; } },
    FLOOR: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const x = num(a[0].v); const sig = a.length > 1 ? num(a[1].v) : 1; if (sig === 0) return ERR('#DIV/0!'); return Math.floor(x / sig) * sig; } },
    EVEN: { args: 1, fn: (ctx, a) => evenAway(num(a[0].v)) },
    ODD: { args: 1, fn: (ctx, a) => oddAway(num(a[0].v)) },
    GCD: { args: '*', fn: (ctx, args) => { if (args.length < 2) return ERR('#N/A — GCD needs at least two arguments'); let g = 0; for (const a of args) { const v = num(a.v); if (isNaN(v)) return ERR('#VALUE!'); g = gcdInt(g, Math.trunc(v)); } return g; } },
    LCM: { args: '*', fn: (ctx, args) => { if (args.length < 2) return ERR('#N/A — LCM needs at least two arguments'); let l = 1; for (const a of args) { const v = num(a.v); if (isNaN(v)) return ERR('#VALUE!'); const n = Math.abs(Math.trunc(v)); if (n === 0) return 0; l = (l * n) / gcdInt(l, n); } return l; } },
    PI: { args: 0, fn: () => Math.PI },
    CBRT: { args: 1, fn: (ctx, a) => Math.cbrt(num(a[0].v)) },
    DEGREES: { args: 1, fn: (ctx, a) => num(a[0].v) * 180 / Math.PI },
    RADIANS: { args: 1, fn: (ctx, a) => num(a[0].v) * Math.PI / 180 },
    SIN: { args: 1, fn: (ctx, a) => Math.sin(num(a[0].v)) },
    COS: { args: 1, fn: (ctx, a) => Math.cos(num(a[0].v)) },
    TAN: { args: 1, fn: (ctx, a) => Math.tan(num(a[0].v)) },
    ASIN: { args: 1, fn: (ctx, a) => { const v = num(a[0].v); return v < -1 || v > 1 ? ERR('#NUM!') : Math.asin(v); } },
    ACOS: { args: 1, fn: (ctx, a) => { const v = num(a[0].v); return v < -1 || v > 1 ? ERR('#NUM!') : Math.acos(v); } },
    ATAN: { args: 1, fn: (ctx, a) => Math.atan(num(a[0].v)) },
    ATAN2: { args: 2, fn: (ctx, a) => Math.atan2(num(a[1].v), num(a[0].v)) },

    CONCAT: { args: '*', fn: (ctx, args) => args.map((a) => asString(a.v)).join('') },
    CONCATENATE: { args: '*', alias: 'CONCAT' },
    LEN: { args: 1, fn: (ctx, a) => asString(a[0].v).length },
    UPPER: { args: 1, fn: (ctx, a) => asString(a[0].v).toUpperCase() },
    LOWER: { args: 1, fn: (ctx, a) => asString(a[0].v).toLowerCase() },
    PROPER: { args: 1, fn: (ctx, a) => asString(a[0].v).toLowerCase().replace(/(^|[^a-z'])([a-z])/g, (m, p, c) => p + c.toUpperCase()) },
    TRIM: { args: 1, fn: (ctx, a) => asString(a[0].v).trim() },
    LEFT: { args: { min: 1, max: 2 }, fn: (ctx, a) => asString(a[0].v).slice(0, Math.max(0, a.length > 1 ? Math.trunc(num(a[1].v)) : 1)) },
    RIGHT: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const s = asString(a[0].v); const n = Math.max(0, a.length > 1 ? Math.trunc(num(a[1].v)) : 1); return n === 0 ? '' : s.slice(-n); } },
    MID: { args: 3, fn: (ctx, a) => { const s = asString(a[0].v); const st = Math.max(0, Math.trunc(num(a[1].v)) - 1); const n = Math.max(0, Math.trunc(num(a[2].v))); return s.slice(st, st + n); } },
    REPT: { args: 2, fn: (ctx, a) => { const n = Math.trunc(num(a[1].v)); if (isNaN(n) || n < 0 || n > 32000) return ERR('#NUM!'); return asString(a[0].v).repeat(n); } },
    SUBSTITUTE: { args: { min: 3, max: 4 }, fn: (ctx, a) => { const s = asString(a[0].v); const oldS = asString(a[1].v); const newS = asString(a[2].v); if (!oldS) return s; if (a.length > 3) { const n = Math.trunc(num(a[3].v)); if (isNaN(n) || n < 1) return s; let i = 0; let pos = -1; while (i < n) { pos = s.indexOf(oldS, pos + 1); if (pos === -1) return s; i++; } return s.slice(0, pos) + newS + s.slice(pos + oldS.length); } return s.split(oldS).join(newS); } },
    FIND: { args: { min: 2, max: 3 }, fn: (ctx, a) => { const f = asString(a[0].v); const w = asString(a[1].v); const from = a.length > 2 ? Math.trunc(num(a[2].v)) : 1; if (isNaN(from) || from < 1) return ERR('#VALUE!'); const i = w.indexOf(f, from - 1); return i === -1 ? ERR('#VALUE!') : i + 1; } },
    VALUE: { args: 1, fn: (ctx, a) => { const s = asString(a[0].v).trim(); if (s === '') return ERR('#VALUE!'); const n = Number(s); return isNaN(n) ? ERR('#VALUE!') : n; } },
    EXACT: { args: 2, fn: (ctx, a) => asString(a[0].v) === asString(a[1].v) },
    CHAR: { args: 1, fn: (ctx, a) => { const c = Math.trunc(num(a[0].v)); return c >= 1 && c <= 65535 ? String.fromCodePoint(c) : ERR('#VALUE!'); } },
    CODE: { args: 1, fn: (ctx, a) => { const s = asString(a[0].v); return s ? s.codePointAt(0) : ERR('#VALUE!'); } },
    TEXTJOIN: { args: '*', fn: (ctx, args) => { if (args.length < 2) return ERR('#N/A — TEXTJOIN needs a delimiter and at least one value'); const delim = asString(args[0].v); return args.slice(1).map((a) => asString(a.v)).filter((s) => s !== '').join(delim); } },

    IF: { args: { min: 2, max: 3 }, lazy: true, fn: (ctx, args, h) => truthy(h.evalNode(args[0], ctx)) ? h.evalNode(args[1], ctx) : (args.length > 2 ? h.evalNode(args[2], ctx) : false) },
    IFERROR: { args: { min: 2, max: 2 }, lazy: true, fn: (ctx, args, h) => { const v = h.evalNode(args[0], ctx); return v && v.error ? h.evalNode(args[1], ctx) : v; } },
    IFNA: { args: { min: 2, max: 2 }, lazy: true, fn: (ctx, args, h) => { const v = h.evalNode(args[0], ctx); return v && v.error && /#N\/A/.test(v.error) ? h.evalNode(args[1], ctx) : v; } },
    NOT: { args: 1, fn: (ctx, a) => !truthy(a[0].v) },
    AND: { args: '*', fn: (ctx, args) => args.every((a) => truthy(a.v)) },
    OR: { args: '*', fn: (ctx, args) => args.some((a) => truthy(a.v)) },
    ISBLANK: { args: 1, fn: (ctx, a) => isBlank(a[0].v) },
    ISNUMBER: { args: 1, fn: (ctx, a) => isNum(a[0].v) },
    ISTEXT: { args: 1, fn: (ctx, a) => typeof a[0].v === 'string' },
    ISERROR: { args: 1, fn: (ctx, a) => !!(a[0].v && a[0].v.error) },
    TRUE: { args: 0, fn: () => true },
    FALSE: { args: 0, fn: () => false },
    BLANK: { args: 0, fn: () => null },

    TODAY: { args: 0, fn: (ctx) => { const d = ctx.today ? ctx.today() : new Date(); return fmtDate(d); } },
    NOW: { args: 0, fn: (ctx) => { const d = ctx.now ? ctx.now() : new Date(); return fmtDateTime(d); } },
    YEAR: { args: 1, fn: (ctx, a) => { const d = toDate(a[0].v); return d ? d.getFullYear() : ERR('#VALUE!'); } },
    MONTH: { args: 1, fn: (ctx, a) => { const d = toDate(a[0].v); return d ? d.getMonth() + 1 : ERR('#VALUE!'); } },
    DAY: { args: 1, fn: (ctx, a) => { const d = toDate(a[0].v); return d ? d.getDate() : ERR('#VALUE!'); } },
    HOUR: { args: 1, fn: (ctx, a) => { const d = toDate(a[0].v); return d ? d.getHours() : ERR('#VALUE!'); } },
    MINUTE: { args: 1, fn: (ctx, a) => { const d = toDate(a[0].v); return d ? d.getMinutes() : ERR('#VALUE!'); } },
    SECOND: { args: 1, fn: (ctx, a) => { const d = toDate(a[0].v); return d ? d.getSeconds() : ERR('#VALUE!'); } },
    WEEKDAY: { args: { min: 1, max: 2 }, fn: (ctx, a) => { const d = toDate(a[0].v); if (!d) return ERR('#VALUE!'); const type = a.length > 1 ? num(a[1].v) : 1; const js = d.getDay(); if (type === 2) return js === 0 ? 7 : js; if (type === 3) return js === 0 ? 6 : js - 1; return js + 1; } },
    DAYS: { args: 2, fn: (ctx, a) => { const e = toDate(a[0].v); const s = toDate(a[1].v); return e && s ? Math.round((e - s) / 86400000) : ERR('#VALUE!'); } },
    EOMONTH: { args: 2, fn: (ctx, a) => { const d = toDate(a[0].v); if (!d) return ERR('#VALUE!'); const m = Math.trunc(num(a[1].v)); const last = new Date(d.getFullYear(), d.getMonth() + 1 + m, 0); return fmtDate(last); } },
    DATEDIFF: {
      args: 3,
      fn: (ctx, a) => {
        const s = toDate(a[0].v); const e = toDate(a[1].v);
        if (!s || !e) return ERR('#VALUE!');
        const unit = asString(a[2].v).toLowerCase();
        if (unit === 'd') return Math.round((e - s) / 86400000);
        if (unit === 'h') return Math.round((e - s) / 3600000);
        if (unit === 'm') return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
        if (unit === 'y') return e.getFullYear() - s.getFullYear();
        return ERR('#VALUE!');
      },
    },
  };

  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function fmtDateTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function evalNode(node, ctx) {
    switch (node.type) {
      case 'num': return node.value;
      case 'str': return node.value;
      case 'bool': return node.value;
      case 'col': {
        try {
          const v = ctx.getValue(node.name);
          return v === undefined ? ERR(`Unknown column "${node.name}"`) : v;
        } catch (e) { return ERR(e.message || 'Reference error'); }
      }
      case 'call': {
        const def = FUNCTIONS[node.name];
        if (!def) return ERR(`Unknown function ${node.name}()`);
        const real = def.alias ? FUNCTIONS[def.alias] : def;
        if (real.lazy) {
          return real.fn(ctx, node.args, { evalNode });
        }
        const evaled = node.args.map((a) => ({ v: evalNode(a, ctx) }));
        for (const e of evaled) if (e.v && e.v.error) return e.v;
        if (real.args !== '*') {
          const spec = real.args;
          const min = typeof spec === 'object' ? spec.min : spec;
          const max = typeof spec === 'object' ? spec.max : spec;
          if (evaled.length < min) return ERR(`#N/A — ${node.name}() needs ${min} argument${min > 1 ? 's' : ''}`);
          if (max !== undefined && evaled.length > max) return ERR(`#N/A — too many arguments for ${node.name}()`);
        }
        return real.fn(ctx, evaled);
      }
      default: {
        // Unary operators
        if (node.op === 'neg') {
          const v = evalNode(node.arg, ctx);
          return isNum(v) ? -v : ERR('#VALUE!');
        }
        if (node.op === 'not') {
          const v = evalNode(node.arg, ctx);
          return v && v.error ? v : !truthy(v);
        }
        // Binary operators
        const l = evalNode(node.left, ctx); if (l && l.error) return l;
        const r = evalNode(node.right, ctx); if (r && r.error) return r;
        if (node.op === '=' || node.op === '==') return looseEq(l, r);
        if (node.op === '<>') return !looseEq(l, r);
        if (node.op === '!=') return !looseEq(l, r);
        if (node.op === '<' || node.op === '>' || node.op === '<=' || node.op === '>=') {
          if (isNum(l) && isNum(r)) {
            return node.op === '<' ? l < r : node.op === '>' ? l > r : node.op === '<=' ? l <= r : l >= r;
          }
          const a = asString(l); const b = asString(r);
          if (isBlank(l) || isBlank(r)) return false;
          if (node.op === '<') return a < b;
          if (node.op === '>') return a > b;
          if (node.op === '<=') return a <= b;
          return a >= b;
        }
        if (node.op === '&') return asString(l) + asString(r);
        if (node.op === 'AND') return truthy(l) && truthy(r);
        if (node.op === 'OR') return truthy(l) || truthy(r);
        if (node.op === '^') {
          if (!isNum(l) || !isNum(r)) return ERR('#VALUE!');
          return Math.pow(l, r);
        }
        if (node.op === '+') {
          // date arithmetic: string date + number of days
          if ((isNum(l) && !isNum(r)) || (isNum(r) && !isNum(l))) {
            const dateSide = isNum(l) ? r : l;
            const days = isNum(l) ? l : r;
            const d = toDate(dateSide);
            if (d) { d.setDate(d.getDate() + days); return fmtDate(d); }
          }
          return isNum(l) && isNum(r) ? l + r : ERR('#VALUE!');
        }
        if (node.op === '-') return isNum(l) && isNum(r) ? l - r : ERR('#VALUE!');
        if (node.op === '*') return isNum(l) && isNum(r) ? l * r : ERR('#VALUE!');
        if (node.op === '/') {
          if (!isNum(l) || !isNum(r)) return ERR('#VALUE!');
          if (r === 0) return ERR('#DIV/0!');
          return l / r;
        }
        if (node.op === '%') {
          if (!isNum(l) || !isNum(r)) return ERR('#VALUE!');
          if (r === 0) return ERR('#DIV/0!');
          return l % r;
        }
        return ERR('Unknown operator');
      }
    }
  }

  function looseEq(l, r) {
    if (isBlank(l) && isBlank(r)) return true;
    if (isNum(l) && isNum(r)) return l === r;
    if (typeof l === 'boolean' && typeof r === 'boolean') return l === r;
    return asString(l) === asString(r);
  }

  /**
   * Evaluate an expression string against a context.
   * ctx.getValue(columnName) -> value  (value may itself be {error}).
   * Returns { ok:true, value } or { ok:false, error }.
   */
  function evaluate(expr, ctx) {
    const parsed = parseFormula(expr);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const value = evalNode(parsed.ast, ctx || { getValue: () => undefined });
    return { ok: true, value };
  }

  /** Compile once, evaluate many (used by the grid renderer). */
  function compile(expr) {
    const parsed = parseFormula(expr);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, ast: parsed.ast, run: (ctx) => evalNode(parsed.ast, ctx) };
  }

  /** Scan an expression for referenced [Column] names (for rename warnings). */
  function referencedColumns(expr) {
    const tok = tokenize(expr);
    if (tok.error) return [];
    const out = [];
    for (const t of tok.tokens) {
      if (t.type === TOK.COLREF) out.push(t.value);
    }
    return out;
  }

  /* ------------------------- reference metadata ---------------------- */

  /** Function reference (name, signature, group) shown in the UI help. */
  const META_FUNCTIONS = [
    { name: 'SUM', group: 'Math', sig: 'SUM(v1, v2, …)', desc: 'Adds every numeric argument together.', ex: 'SUM([Price], [Qty] * 2)' },
    { name: 'AVERAGE', group: 'Math', sig: 'AVERAGE(v1, v2, …)', desc: 'Mean of the numeric arguments.', ex: 'AVERAGE([Math], [Science])' },
    { name: 'AVG', group: 'Math', sig: 'AVG(v1, v2, …)', desc: 'Short alias for AVERAGE.', ex: 'AVG([Qty])' },
    { name: 'MIN', group: 'Math', sig: 'MIN(v1, v2, …)', desc: 'Smallest numeric argument.', ex: 'MIN([Low], [High])' },
    { name: 'MAX', group: 'Math', sig: 'MAX(v1, v2, …)', desc: 'Largest numeric argument.', ex: 'MAX([Q1], [Q2], [Q3])' },
    { name: 'COUNT', group: 'Math', sig: 'COUNT(v1, v2, …)', desc: 'How many arguments are numbers.', ex: 'COUNT([Price], [Note])' },
    { name: 'COUNTA', group: 'Math', sig: 'COUNTA(v1, v2, …)', desc: 'How many arguments are not blank.', ex: 'COUNTA([Name], [Email])' },
    { name: 'PRODUCT', group: 'Math', sig: 'PRODUCT(v1, v2, …)', desc: 'Multiplies every numeric argument.', ex: 'PRODUCT([Len], [Wid], [Hgt])' },
    { name: 'ROUND', group: 'Math', sig: 'ROUND(x, digits)', desc: 'Rounds x to digits decimal places (digits optional, default 0).', ex: 'ROUND([Price] * [Qty], 2)' },
    { name: 'ROUNDUP', group: 'Math', sig: 'ROUNDUP(x, digits)', desc: 'Rounds x away from zero.', ex: 'ROUNDUP([Weight], 0)' },
    { name: 'ROUNDDOWN', group: 'Math', sig: 'ROUNDDOWN(x, digits)', desc: 'Rounds x towards zero.', ex: 'ROUNDDOWN([Weight], 0)' },
    { name: 'ABS', group: 'Math', sig: 'ABS(x)', desc: 'Absolute (positive) value.', ex: 'ABS([Change])' },
    { name: 'INT', group: 'Math', sig: 'INT(x)', desc: 'Rounds down to the whole number.', ex: 'INT([Hours] / 24)' },
    { name: 'TRUNC', group: 'Math', sig: 'TRUNC(x, digits)', desc: 'Truncates to digits decimals (no rounding).', ex: 'TRUNC(19.99)' },
    { name: 'MOD', group: 'Math', sig: 'MOD(x, d)', desc: 'Remainder of x ÷ d.', ex: 'MOD([Minutes], 60)' },
    { name: 'SQRT', group: 'Math', sig: 'SQRT(x)', desc: 'Square root.', ex: 'SQRT([Area])' },
    { name: 'POWER', group: 'Math', sig: 'POWER(x, y)', desc: 'x raised to the power y.', ex: 'POWER([Side], 3)' },
    { name: 'EXP', group: 'Math', sig: 'EXP(x)', desc: 'e raised to x.', ex: 'EXP(1)' },
    { name: 'LN', group: 'Math', sig: 'LN(x)', desc: 'Natural logarithm (base e).', ex: 'LN([Value])' },
    { name: 'LOG', group: 'Math', sig: 'LOG(x, base)', desc: 'Logarithm with any base (base optional, default 10).', ex: 'LOG([Value], 2)' },
    { name: 'LOG10', group: 'Math', sig: 'LOG10(x)', desc: 'Base-10 logarithm.', ex: 'LOG10([Sound])' },
    { name: 'SIGN', group: 'Math', sig: 'SIGN(x)', desc: '-1, 0 or 1 from the sign of x.', ex: 'SIGN([Balance])' },
    { name: 'CEILING', group: 'Math', sig: 'CEILING(x, sig)', desc: 'Rounds x up to the nearest multiple of sig (sig optional, default 1).', ex: 'CEILING([Minutes], 15)' },
    { name: 'FLOOR', group: 'Math', sig: 'FLOOR(x, sig)', desc: 'Rounds x down to the nearest multiple of sig (sig optional, default 1).', ex: 'FLOOR([Minutes], 15)' },
    { name: 'EVEN', group: 'Math', sig: 'EVEN(x)', desc: 'Rounds away from zero to the nearest even integer.', ex: 'EVEN(2.1)' },
    { name: 'ODD', group: 'Math', sig: 'ODD(x)', desc: 'Rounds away from zero to the nearest odd integer.', ex: 'ODD(2.1)' },
    { name: 'GCD', group: 'Math', sig: 'GCD(a, b, …)', desc: 'Greatest common divisor of the integers.', ex: 'GCD(12, 18)' },
    { name: 'LCM', group: 'Math', sig: 'LCM(a, b, …)', desc: 'Least common multiple of the integers.', ex: 'LCM(4, 6)' },
    { name: 'PI', group: 'Math', sig: 'PI()', desc: 'The constant π ≈ 3.14159.', ex: 'PI() * [Radius] ^ 2' },
    { name: 'CBRT', group: 'Math', sig: 'CBRT(x)', desc: 'Cube root.', ex: 'CBRT([Volume])' },
    { name: 'DEGREES', group: 'Math', sig: 'DEGREES(x)', desc: 'Converts radians to degrees.', ex: 'DEGREES(PI())' },
    { name: 'RADIANS', group: 'Math', sig: 'RADIANS(x)', desc: 'Converts degrees to radians.', ex: 'RADIANS(180)' },
    { name: 'SIN', group: 'Math', sig: 'SIN(x)', desc: 'Sine of an angle in radians.', ex: 'SIN(RADIANS(30))' },
    { name: 'COS', group: 'Math', sig: 'COS(x)', desc: 'Cosine of an angle in radians.', ex: 'COS(RADIANS(60))' },
    { name: 'TAN', group: 'Math', sig: 'TAN(x)', desc: 'Tangent of an angle in radians.', ex: 'TAN(RADIANS(45))' },
    { name: 'ASIN', group: 'Math', sig: 'ASIN(x)', desc: 'Inverse sine (radians).', ex: 'DEGREES(ASIN(0.5))' },
    { name: 'ACOS', group: 'Math', sig: 'ACOS(x)', desc: 'Inverse cosine (radians).', ex: 'ACOS(0.5)' },
    { name: 'ATAN', group: 'Math', sig: 'ATAN(x)', desc: 'Inverse tangent (radians).', ex: 'ATAN(1)' },
    { name: 'ATAN2', group: 'Math', sig: 'ATAN2(x, y)', desc: 'Angle from the x-axis to point (x, y), in radians.', ex: 'ATAN2(3, 4)' },
    { name: 'CONCAT', group: 'Text', sig: 'CONCAT(t1, t2, …)', desc: 'Joins texts end-to-end.', ex: 'CONCAT([First], " ", [Last])' },
    { name: 'CONCATENATE', group: 'Text', sig: 'CONCATENATE(t1, t2, …)', desc: 'Alias of CONCAT.', ex: 'CONCATENATE([City], ", ", [Country])' },
    { name: 'TEXTJOIN', group: 'Text', sig: 'TEXTJOIN(delim, t1, t2, …)', desc: 'Joins texts with a delimiter, skipping blanks.', ex: 'TEXTJOIN(", ", [Tag1], [Tag2])' },
    { name: 'LEN', group: 'Text', sig: 'LEN(t)', desc: 'Number of characters.', ex: 'LEN([SKU])' },
    { name: 'UPPER', group: 'Text', sig: 'UPPER(t)', desc: 'Uppercases the text.', ex: 'UPPER([Code])' },
    { name: 'LOWER', group: 'Text', sig: 'LOWER(t)', desc: 'Lowercases the text.', ex: 'LOWER([Email])' },
    { name: 'PROPER', group: 'Text', sig: 'PROPER(t)', desc: 'Capitalises the first letter of each word.', ex: 'PROPER([Name])' },
    { name: 'TRIM', group: 'Text', sig: 'TRIM(t)', desc: 'Removes surrounding spaces.', ex: 'TRIM([Address])' },
    { name: 'LEFT', group: 'Text', sig: 'LEFT(t, n)', desc: 'First n characters (n optional, default 1).', ex: 'LEFT([SKU], 3)' },
    { name: 'RIGHT', group: 'Text', sig: 'RIGHT(t, n)', desc: 'Last n characters (n optional, default 1).', ex: 'RIGHT([SKU], 2)' },
    { name: 'MID', group: 'Text', sig: 'MID(t, start, n)', desc: 'n characters starting at position start.', ex: 'MID([PartNo], 3, 2)' },
    { name: 'REPT', group: 'Text', sig: 'REPT(t, n)', desc: 'Repeats text n times.', ex: 'REPT("*", [Stars])' },
    { name: 'SUBSTITUTE', group: 'Text', sig: 'SUBSTITUTE(t, old, new, n)', desc: 'Replaces text; optional n replaces only the nth occurrence.', ex: 'SUBSTITUTE([Code], "-", "")' },
    { name: 'FIND', group: 'Text', sig: 'FIND(find, within, start)', desc: 'Position (1-based) of find inside within.', ex: 'FIND("@", [Email])' },
    { name: 'VALUE', group: 'Text', sig: 'VALUE(t)', desc: 'Converts text to a number.', ex: 'VALUE([Amount]) * 2' },
    { name: 'EXACT', group: 'Text', sig: 'EXACT(a, b)', desc: 'TRUE when the two texts are identical.', ex: 'EXACT([A], [B])' },
    { name: 'CHAR', group: 'Text', sig: 'CHAR(code)', desc: 'Character for a Unicode code.', ex: 'CHAR(65)' },
    { name: 'CODE', group: 'Text', sig: 'CODE(t)', desc: 'Unicode code of the first character.', ex: 'CODE([Initial])' },
    { name: 'IF', group: 'Logic', sig: 'IF(cond, a, b)', desc: 'a when cond is true, otherwise b (optional).', ex: 'IF([Stock] > 0, "In stock", "Out")' },
    { name: 'IFERROR', group: 'Logic', sig: 'IFERROR(x, fallback)', desc: 'Returns fallback when x errors.', ex: 'IFERROR(1 / [Zero], "n/a")' },
    { name: 'IFNA', group: 'Logic', sig: 'IFNA(x, fallback)', desc: 'Returns fallback when x is #N/A.', ex: 'IFNA([Missing], "?")' },
    { name: 'AND', group: 'Logic', sig: 'AND(a, b, …)', desc: 'TRUE when every argument is true.', ex: 'AND([Paid], [Shipped])' },
    { name: 'OR', group: 'Logic', sig: 'OR(a, b, …)', desc: 'TRUE when any argument is true.', ex: 'OR([A] = "x", [B] = "y")' },
    { name: 'NOT', group: 'Logic', sig: 'NOT(x)', desc: 'Negates a condition.', ex: 'NOT([Deleted])' },
    { name: 'TRUE', group: 'Logic', sig: 'TRUE()', desc: 'The logical value true.', ex: 'IF(TRUE(), "yes", "no")' },
    { name: 'FALSE', group: 'Logic', sig: 'FALSE()', desc: 'The logical value false.', ex: 'IF(FALSE(), "yes", "no")' },
    { name: 'BLANK', group: 'Logic', sig: 'BLANK()', desc: 'An empty value (blank cell).', ex: 'IF([X] = BLANK(), "—", [X])' },
    { name: 'ISBLANK', group: 'Logic', sig: 'ISBLANK(x)', desc: 'TRUE when x is empty.', ex: 'ISBLANK([Phone])' },
    { name: 'ISNUMBER', group: 'Logic', sig: 'ISNUMBER(x)', desc: 'TRUE when x is a number.', ex: 'ISNUMBER([Qty])' },
    { name: 'ISTEXT', group: 'Logic', sig: 'ISTEXT(x)', desc: 'TRUE when x is text.', ex: 'ISTEXT([Name])' },
    { name: 'ISERROR', group: 'Logic', sig: 'ISERROR(x)', desc: 'TRUE when x evaluates to an error.', ex: 'ISERROR([Calc])' },
    { name: 'TODAY', group: 'Date & time', sig: 'TODAY()', desc: 'Today as YYYY-MM-DD.', ex: 'TODAY()' },
    { name: 'NOW', group: 'Date & time', sig: 'NOW()', desc: 'Current date and time.', ex: 'NOW()' },
    { name: 'YEAR', group: 'Date & time', sig: 'YEAR(d)', desc: 'The year of a date.', ex: 'YEAR([Ordered])' },
    { name: 'MONTH', group: 'Date & time', sig: 'MONTH(d)', desc: 'The month (1-12) of a date.', ex: 'MONTH([Ordered])' },
    { name: 'DAY', group: 'Date & time', sig: 'DAY(d)', desc: 'The day (1-31) of a date.', ex: 'DAY([Ordered])' },
    { name: 'HOUR', group: 'Date & time', sig: 'HOUR(dt)', desc: 'The hour (0-23) of a time.', ex: 'HOUR([Logged])' },
    { name: 'MINUTE', group: 'Date & time', sig: 'MINUTE(dt)', desc: 'The minute (0-59) of a time.', ex: 'MINUTE([Logged])' },
    { name: 'SECOND', group: 'Date & time', sig: 'SECOND(dt)', desc: 'The second (0-59) of a time.', ex: 'SECOND([Logged])' },
    { name: 'WEEKDAY', group: 'Date & time', sig: 'WEEKDAY(d, type)', desc: 'Day of the week — 1 = Sunday (type 1) or Monday (type 2).', ex: 'WEEKDAY([Date], 2)' },
    { name: 'DAYS', group: 'Date & time', sig: 'DAYS(end, start)', desc: 'Whole days between two dates.', ex: 'DAYS([Due], TODAY())' },
    { name: 'EOMONTH', group: 'Date & time', sig: 'EOMONTH(d, months)', desc: 'Last day of the month, months away.', ex: 'EOMONTH([Start], 1)' },
    { name: 'DATEDIFF', group: 'Date & time', sig: 'DATEDIFF(a, b, unit)', desc: 'Difference between dates in “d”, “h”, “m” or “y”.', ex: 'DATEDIFF([Start], [End], "d")' },
  ];

  /** Operators & syntax reference shown in the UI help. */
  const META_OPERATORS = [
    { sym: '( )  { }', desc: 'Grouping — braces behave exactly like parentheses. Innermost pairs evaluate first.', ex: '{2 + 3} * 4   =   (2 + 3) * 4   =   20' },
    { sym: '[Column name]', desc: 'The value of a column in the current row. Names may contain spaces and are case-insensitive.', ex: '[Unit price] * [Qty]' },
    { sym: '-x  +x  !x', desc: 'Unary minus / plus / logical NOT.', ex: '-(2 + 3),  !ISBLANK([Name])' },
    { sym: '^', desc: 'Power (right-associative). -2^2 evaluates as (-2)^2 = 4, matching Excel.', ex: '[Side] ^ 2' },
    { sym: '*  /', desc: 'Multiply and divide.', ex: '[Price] / [Qty]' },
    { sym: '%', desc: 'Remainder (modulo). Equivalent to MOD(a, b).', ex: '[Minutes] % 60' },
    { sym: '+  -', desc: 'Add and subtract. Adding a number to a date shifts the date by that many days.', ex: '[Qty] + 1,  [Due] + 14' },
    { sym: '&', desc: 'Text join (like CONCAT).', ex: '[First] & " " & [Last]' },
    { sym: '=  ==  <>  !=  <  <=  >  >=', desc: 'Comparisons. “=” and “==” are equal; “<>” and “!=” are not equal.', ex: '[Total] >= 100' },
    { sym: '&&  ||', desc: 'Logical AND / OR (same as AND(...) / OR(...)).', ex: '[Paid] && NOT([Refunded])' },
  ];

  const META = { functions: META_FUNCTIONS, operators: META_OPERATORS };

  return { parseFormula, evaluate, compile, referencedColumns, tokenize, isBlank, asString, toDate, num, FUNCTIONS, META };
});
