// Pulls slopalytics.com's model table and model config out of its JS bundle
// and writes data.json + index.html (from page.template.html).
//
// Usage: node build.js            fetch live
//        node build.js bundle.js  use a saved copy of the site's JS bundle
//
// Last line printed is the status the daily sync reads:
//   STATUS: CHANGED | STATUS: UNCHANGED | STATUS: FAILED <reason>
//
// The bundle is someone else's code, so everything is parsed as data and
// never eval'd. Minified variable names change between their builds, so each
// piece is found by its shape, not its name.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const DATA_FILE = path.join(DIR, 'data.json');
const LOG_FILE = path.join(DIR, 'logs', 'sync.log');
// Charts this page knows how to draw. A new upstream chart gets logged, not drawn.
const KNOWN_CHARTS = ['cost-intelligence', 'speed-intelligence', 'tokens-task', 'tokens-total', 'cost-task', 'cost-total'];

function log(line) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  console.log(line);
}

async function getBundle(arg) {
  if (arg) return { text: fs.readFileSync(arg, 'utf8'), name: path.basename(arg) };
  const html = await (await fetch('https://slopalytics.com/')).text();
  const m = html.match(/\/assets\/index-[\w-]+\.js/);
  if (!m) throw new Error('no JS bundle link on slopalytics.com');
  const res = await fetch('https://slopalytics.com' + m[0]);
  if (!res.ok) throw new Error(`bundle fetch returned ${res.status}`);
  return { text: await res.text(), name: m[0].split('/').pop() };
}

// Return the balanced {...} or [...] literal that starts at index `start`.
function balanced(src, start) {
  const open = src[start], close = open === '{' ? '}' : ']';
  let depth = 0, quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (c === '`' || c === '"') { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced literal');
}

// Minified object literal to JSON: backtick strings, bare keys, !0/!1, .5 numbers.
function toJSON(lit) {
  let out = '', i = 0;
  const last = () => out.trimEnd().slice(-1);
  while (i < lit.length) {
    const c = lit[i];
    if (c === '`' || c === '"') {
      const j = lit.indexOf(c, i + 1);
      out += JSON.stringify(lit.slice(i + 1, j));
      i = j + 1;
    } else if (lit.startsWith('!0', i)) { out += 'true'; i += 2; }
    else if (lit.startsWith('!1', i)) { out += 'false'; i += 2; }
    else if (/[A-Za-z_$]/.test(c) && /[{,]/.test(last())) {
      const m = lit.slice(i).match(/^([A-Za-z_$][\w$]*):/);
      if (m) { out += JSON.stringify(m[1]) + ':'; i += m[0].length; }
      else { out += c; i++; }
    } else if (c === '.' && /[:,\[]/.test(last())) { out += '0.'; i++; }
    else if (c === '-' && lit[i + 1] === '.') { out += '-0.'; i += 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out);
}

function parseAt(src, idx, what) {
  if (idx < 0) throw new Error(`${what} not found`);
  return toJSON(balanced(src, idx));
}

function extract(src) {
  const warn = [];
  const rowsAt = src.lastIndexOf('[', src.indexOf('{id:`'));
  const rows = parseAt(src, rowsAt, 'model table');
  if (!Array.isArray(rows) || rows.length < 50 || !('intelligence' in rows[0])) throw new Error('model table looks wrong');

  const piece = (what, fn) => { try { return fn(); } catch (e) { warn.push(`${what}: ${e.message}`); return undefined; } };

  // Frontier map: {"family":{tier:`Large`,color:`light-dark(...)`},...}
  const frontierAt = src.search(/\{"[\w.-]+":\{tier:`/);
  if (frontierAt < 0) warn.push('frontier: not found');
  const frontierLit = frontierAt >= 0 ? piece('frontier', () => balanced(src, frontierAt)) : undefined;
  const frontier = frontierLit && piece('frontier', () => toJSON(frontierLit));
  // Notable map and hidden set follow the frontier map directly.
  let notable, hidden;
  if (frontierLit) {
    const after = src.slice(frontierAt + frontierLit.length, frontierAt + frontierLit.length + 3000);
    const nm = after.match(/^,[\w$]+=(\{"[\w.-]+":\{color:)/);
    notable = piece('notable', () => toJSON(balanced(after, after.indexOf(nm[1]))));
    const hm = after.match(/new Set\(\[([^\]]*)\]\)/);
    hidden = piece('hidden', () => (hm[1].match(/`([^`]+)`/g) || []).map(s => s.slice(1, -1)));
  }
  const labs = piece('labs', () => parseAt(src, src.search(/\[\{id:`[\w-]+`,name:`[^`]+`,color:`light-dark/), 'labs'));
  const defaultOff = piece('defaultOff', () => {
    const m = src.match(/withDefault\(Object\.keys\([\w$]+\)\.filter\([\w$]+=>([^)]*)\)\)/);
    return (m[1].match(/!==`([^`]+)`/g) || []).map(s => s.slice(4, -1));
  });
  const defaultExcluded = piece('defaultExcluded', () => {
    const m = src.match(/excluded:[^,]*?\.withDefault\(\[([^\]]*)\]\)/);
    return (m[1].match(/`([^`]+)`/g) || []).map(s => s.slice(1, -1));
  });
  const charts = piece('charts', () => parseAt(src, src.indexOf('[{id:`cost-intelligence`'), 'charts'));
  if (charts) {
    const unknown = charts.filter(c => !KNOWN_CHARTS.includes(c.id)).map(c => c.label);
    if (unknown.length) warn.push(`new upstream chart(s) not drawn here yet: ${unknown.join(', ')}`);
  }
  return { rows, config: { frontier, notable, hidden, labs, defaultOff, defaultExcluded }, warn };
}

(async () => {
  const prev = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : null;
  const bundle = await getBundle(process.argv[2]);
  const { rows, config, warn } = extract(bundle.text);
  for (const w of warn) log(`WARN ${w}`);

  // A config piece that failed to parse keeps yesterday's value.
  for (const k of Object.keys(config)) {
    if (config[k] === undefined || config[k] === null) {
      if (prev?.config?.[k] !== undefined) config[k] = prev.config[k];
      else throw new Error(`config "${k}" missing and no earlier copy to fall back on`);
    }
  }

  const keep = ['id', 'family', 'name', 'variant', 'lab', 'labName', 'released', 'open', 'deprecated', 'effort', 'effortLabel',
    'effortOrder', 'estimated', 'intelligence', 'cost', 'costTotal', 'tokens', 'tokensTotal', 'speed', 'time'];
  const slim = rows.map(r => Object.fromEntries(keep.map(k => [k, r[k] ?? null])));
  const content = { rows: slim, config };
  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
  const changed = !prev || prev.hash !== hash;

  const data = {
    snapshot: changed ? new Date().toLocaleDateString('en-CA') : prev.snapshot,
    checked: new Date().toLocaleDateString('en-CA'),
    bundle: bundle.name,
    hash,
    ...content,
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  const tpl = fs.readFileSync(path.join(DIR, 'page.template.html'), 'utf8');
  if (!tpl.includes('/*DATA*/null')) throw new Error('template is missing the /*DATA*/null slot');
  fs.writeFileSync(path.join(DIR, 'index.html'), tpl.replace('/*DATA*/null', () => JSON.stringify(data)));

  const famCount = new Set(slim.map(r => r.family)).size;
  log(`${slim.length} rows, ${famCount} models, ${Object.keys(config.frontier).length} frontier, bundle ${bundle.name}`);
  if (changed && prev) {
    const before = new Set(prev.rows.map(r => r.id));
    const added = slim.filter(r => !before.has(r.id)).map(r => r.variant);
    if (added.length) log(`new variants: ${added.slice(0, 20).join('; ')}${added.length > 20 ? ` (+${added.length - 20} more)` : ''}`);
  }
  log(`STATUS: ${changed ? 'CHANGED' : 'UNCHANGED'}`);
})().catch(e => { log(`STATUS: FAILED ${e.message}`); process.exit(1); });
