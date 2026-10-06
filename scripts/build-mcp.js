#!/usr/bin/env node
/*
 * Folds the MCP server and the whole engine into ONE file that needs nothing else: no npm packages, no src/ folder.
 * Copy that file anywhere, put the exported handwriting file next to it, and run it with Node 18 or newer.
 *
 *   node scripts/build-mcp.js              dist/handwriting-mcp.js     write_text and handwriting_status
 *   node scripts/build-mcp.js --pdf        dist/handwriting-mcp.js     plus inspect_pdf and fill_pdf (adds the PDF libraries, 2 MB)
 *   node scripts/build-mcp.js --out file   write somewhere else
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE_BUILTINS = new Set(['fs', 'path', 'zlib', 'http', 'crypto', 'child_process', 'os', 'v8', 'https']);

function build(opts) {
  const withPdf = !!(opts && opts.pdf);
  const samplesUrl = opts && opts.samplesUrl; // where this copy looks for the sealed handwriting when it is not given one
  const modules = new Map(); // id (path from the repo root) -> source
  const idOf = (from, rel) => path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, from)), rel)).split(path.sep).join('/');

  function add(id) {
    if (modules.has(id)) return;
    const file = path.join(ROOT, id.endsWith('.js') ? id : id + '.js');
    let src = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
    modules.set(id, null); // placeholder so cycles terminate
    const skipScan = !withPdf && (id.startsWith('vendor/') || id === 'mcp/pdfinfo.js');
    if (skipScan) {
      modules.delete(id);
      return;
    }
    // the vendored libraries are left as they are: their own optional requires (pdf.js tries 'canvas', inside a try) must keep failing quietly
    if (!id.startsWith('vendor/')) src = src.replace(/(?<![.\w])require\((['"])([^'"]+)\1\)/g, (all, q, name) => {
      if (NODE_BUILTINS.has(name)) return all;
      if (!name.startsWith('.')) throw new Error(`${id} requires "${name}", which is not a built-in or a file of this project`);
      let target = idOf(id, name);
      if (!fs.existsSync(path.join(ROOT, target)) || fs.statSync(path.join(ROOT, target)).isDirectory()) target += '.js';
      add(target);
      return `__req(${JSON.stringify(target)})`;
    });
    // "was this file started directly" has to compare against this bundle's own entry module
    modules.set(id, src.replace(/require\.main === module/g, '__req.main === module'));
  }
  add('mcp/server.js');

  const parts = [
    '#!/usr/bin/env node',
    `// Handwriting MCP server, one file. Built by scripts/build-mcp.js (${withPdf ? 'with' : 'without'} PDF tools). Run: node ${'handwriting-mcp.js'} --samples my-handwriting.json`,
    "'use strict';",
    withPdf ? '' : 'globalThis.__HW_NO_PDF__ = true;',
    samplesUrl ? `globalThis.__HW_DEFAULT_SAMPLES_URL__ = ${JSON.stringify(samplesUrl)};` : '',
    'const __defs = {',
  ];
  for (const [id, src] of modules) parts.push(`${JSON.stringify(id)}: function (module, exports, __req) {\n${src}\n},`);
  parts.push(
    '};',
    'const __cache = {};',
    'function __req(id) {',
    '  if (__cache[id]) return __cache[id].exports;',
    '  if (!__defs[id]) throw new Error("This build of the server does not include " + id + ". Build it with --pdf for the PDF tools.");',
    '  const m = (__cache[id] = { exports: {} });',
    '  __defs[id].call(m.exports, m, m.exports, __req);',
    '  return m.exports;',
    '}',
    // the entry module checks require.main === module to know it was started directly
    'const __entry = { exports: {} };',
    '__cache["mcp/server.js"] = __entry;',
    '__req.main = __entry;',
    '__defs["mcp/server.js"].call(__entry.exports, __entry, __entry.exports, __req);',
    ''
  );
  return parts.join('\n');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const out = path.resolve(i >= 0 ? argv[i + 1] : path.join(ROOT, 'dist', 'handwriting-mcp.js'));
  const code = build({ pdf: argv.includes('--pdf') });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  fs.chmodSync(out, 0o755);
  console.log(`Wrote ${out} (${(code.length / 1024).toFixed(0)} KB)`);
}

module.exports = { build };
