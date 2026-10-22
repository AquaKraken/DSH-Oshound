// scripts/build-client.mjs
// Bundles src/client/index.jsx into lib/client.js for DSH's client loader.
// Recipe follows the installed dsh-pocket plugin (client/build.mjs):
// esbuild cjs/browser bundle with `react` external, wrapped so the client
// module loader can require it. The wrapper MUST bind `var React` before
// the bundle body (otherwise the compiled JSX references an unbound React).
// Includes a pure-JS Babel fallback if the platform-specific esbuild binary
// is unavailable in offline cross-platform environments.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'lib');
await mkdir(outDir, { recursive: true });

async function buildWithEsbuild() {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [path.join(root, 'src', 'client', 'index.jsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'chrome100',
    jsx: 'transform',
    external: ['react'],
    write: false,
    minify: true,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

function buildWithBabelFallback() {
  const req = createRequire(import.meta.url);
  const babelPaths = [root, '/usr/share/nodejs', '/usr/lib/nodejs'];
  const babel = req(req.resolve('@babel/core', { paths: babelPaths }));
  const presetReact = req.resolve('@babel/preset-react', { paths: babelPaths });
  const pluginCjs = req.resolve('@babel/plugin-transform-modules-commonjs', { paths: babelPaths });

  const entry = path.join(root, 'src', 'client', 'index.jsx');
  const modules = new Map();

  function bundleModule(absPath) {
    if (modules.has(absPath)) return;
    const src = readFileSync(absPath, 'utf8');
    const dir = path.dirname(absPath);
    const transformed = babel.transformSync(src, {
      filename: absPath,
      presets: [presetReact],
      plugins: [pluginCjs],
      compact: true,
      comments: false,
    });
    let code = transformed.code;
    code = code.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
      if (spec === 'react') return '__ext_require("react")';
      if (spec.startsWith('.')) {
        let target = path.resolve(dir, spec);
        if (!existsSync(target)) {
          for (const ext of ['.js', '.jsx']) {
            if (existsSync(target + ext)) {
              target = target + ext;
              break;
            }
          }
        }
        bundleModule(target);
        const rel = path.relative(root, target).replace(/\\/g, '/');
        return `__require(${JSON.stringify(rel)})`;
      }
      throw new Error(`Unexpected external require: ${spec} in ${absPath}`);
    });
    const rel = path.relative(root, absPath).replace(/\\/g, '/');
    modules.set(absPath, { rel, code });
  }

  bundleModule(entry);
  const entriesCode = [...modules.values()]
    .map((m) => `${JSON.stringify(m.rel)}:function(module,exports,__require,__ext_require){${m.code}}`)
    .join(',');

  return [
    `var __modules={${entriesCode}};`,
    `var __cache={};`,
    `function __require(id){if(__cache[id])return __cache[id].exports;var m={exports:{}};__cache[id]=m;__modules[id](m,m.exports,__require,require);return m.exports;}`,
    `module.exports=__require("src/client/index.jsx");`,
  ].join('\n');
}

let code;
try {
  code = await buildWithEsbuild();
} catch {
  code = buildWithBabelFallback();
}

const wrapped = `window.__ModuleLoader__.load({
  id: 'dsh-osound',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    ${code}
    return module.exports;
  }
});
`;

const outPath = path.join(outDir, 'client.js');
await writeFile(outPath, wrapped);
console.log(`built ${outPath} (${Buffer.byteLength(wrapped)} bytes)`);
