/**
 * @license
 * Copyright 2020 Google LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// esbuild/typescript configuration and launcher for Neuroglancer.

'use strict';

const svgInlineLoader = require('./esbuild_svg_inline_loader');

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const bundleConfig = require('./bundle-config');
const {spawn} = require('child_process');

function createEntryPointFile(cacheId, bundleName, sources) {
  const tempEntryPointDir =
      path.resolve(__dirname, '..', 'node_modules', '.cache', 'esbuild-entry-points', cacheId);
  sources = sources.map(x => {
    // Ensure all paths are relative and use forward slashes.
    if (path.isAbsolute(x)) {
      x = path.relative(tempEntryPointDir, x);
    }
    if (path.sep === '\\') {
      x = x.replace(/\\/g, '/');
    }
    return x;
  });
  if (bundleName === undefined) {
    sources = sources.slice();
    sources.sort();
    bundleName =
        require('crypto').createHash('sha256').update(JSON.stringify(sources)).digest('hex') +
        '.js';
  }
  fs.mkdirSync(tempEntryPointDir, {recursive: true});
  const bundleInputPath = path.resolve(tempEntryPointDir, bundleName);
  const source = sources.map(path => `import ${JSON.stringify(path)};\n`).join('');
  fs.writeFileSync(bundleInputPath, source);
  return bundleInputPath;
}

exports.createEntryPointFile = createEntryPointFile;

function getCommonPlugins() {
  return [svgInlineLoader({removeSVGTagAttrs: false, removeTags: true})];
}
exports.getCommonPlugins = getCommonPlugins;

class Builder {
  constructor(options = {}) {
    const {id = 'min'} = options;
    const {
      outDir = path.resolve(__dirname, '..', 'dist', id),
      python = false,
      module: moduleBuild = false,
      define = {},
      inject = [],
      minify = true,
      googleTagManager = undefined,
    } = options;
    this.outDir = outDir;
    this.cacheId = id;
    const viewerConfig = bundleConfig.getViewerOptions({}, {
      python,
      module: moduleBuild,
    });
    this.module = options.module;
    this.bundleSources = bundleConfig.getBundleSources(viewerConfig);
    this.minify = minify;
    this.python = options.python;
    this.srcDir = path.resolve(__dirname, '..', 'src');
    this.plugins = getCommonPlugins();
    this.define = define;
    this.inject = inject;
    this.googleTagManager = googleTagManager;
  }

  // Deletes .js/.css/.html files from `this.outDir`.  Can safely be used on
  // `python/neuroglancer/static` directory.
  async clearOutput() {
    try {
      const pattern = /\.(js|js\.map|html|css)$/;
      const paths = await fs.promises.readdir(this.outDir);
      for (const filename of paths) {
        const p = path.resolve(this.outDir, filename);
        if (!pattern.test(p)) continue;
        try {
          await fs.promises.unlink(p);
        } catch {
          // Ignore errors removing output files
        }
      }
    } catch  {
      // ignore errors listing output directory (e.g. if it does not already exist)
    }
  }

  async writeIndex() {
    let indexHtml = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>neuroglancer</title>
    <link href="main.bundle.css" rel="stylesheet">
`;

    const {googleTagManager} = this;
    if (googleTagManager) {
      indexHtml += `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer',${JSON.stringify(googleTagManager)});</script>
<!-- End Google Tag Manager -->
`;
    }

    indexHtml += `  </head>
  <body>
    <div id="neuroglancer-container"></div>
    <script src="main.bundle.js"></script>
  </body>
</html>
`;

    await fs.promises.writeFile(path.resolve(this.outDir, 'index.html'), indexHtml);
  }

  getBaseEsbuildConfig() {
    return {
      outdir: this.outDir,
      define: {...this.bundleSources.defines, ...this.define},
      inject: this.inject,
      minify: this.minify,
      target: 'es2019',
      plugins: this.plugins,
      loader: {'.wasm': 'dataurl'},
      // TODO(jbms): Remove this workaround once evanw/esbuild#1202 is fixed.
      banner: {
        js: 'function require(x) { throw new Error(\'Cannot require \' + x) }',
      },
    };
  }

  getWorkerEntrypoints() {
    return Object.entries(this.bundleSources.workers)
        .map(([key, sources]) => createEntryPointFile(this.cacheId, key + '.bundle.js', sources));
  }

  getMainEntrypoint(name = 'main.bundle.js') {
    return createEntryPointFile(this.cacheId, name, this.bundleSources.main);
  }

  async build() {
    const startTime = Date.now();
    try {
      await fs.promises.mkdir(this.outDir, {recursive: true});
      if (this.module) {
        await this.buildModule();
      } else {
        await this.buildNonModule();
      }
    } catch (e) {
      console.log(`Error: ${e.message}`);
      throw e;
    } finally {
      console.log(`Built in ${(Date.now() - startTime) / 1000.0} seconds`);
    }
  }

  async buildNonModule() {
    await this.writeIndex();
    if (!this.python) {
      await fs.promises.copyFile(
          path.resolve(this.srcDir, 'neuroglancer/datasource/boss/bossauth.html'),
          path.resolve(this.outDir, 'bossauth.html'));
    }
    await esbuild.build({
      ...this.getBaseEsbuildConfig(),
      entryPoints: [this.getMainEntrypoint(), ...this.getWorkerEntrypoints()],
      bundle: true,
      sourcemap: true,
    });
  }

  async buildModule() {
    await fs.promises.rmdir(this.outDir, {recursive: true});
    const {outDir} = this;
    // Build workers and main bundle.  The main bundle won't be saved, it is
    // just to analyze dependencies and to generate the CSS bundle.
    const [mainBuildResult, workerBuildResult] = await Promise.all([
      esbuild.build({
        ...this.getBaseEsbuildConfig(),
        entryPoints: [this.getMainEntrypoint('main.bundle.js')],
        bundle: true,
        write: false,
        metafile: true,
      }),
      esbuild.build({
        ...this.getBaseEsbuildConfig(),
        entryPoints: this.getWorkerEntrypoints(),
        bundle: true,
      })
    ]);
    const metaEntry = mainBuildResult.metafile;
    const cssEntry =
        mainBuildResult.outputFiles.find(entry => entry.path.endsWith('.css')).contents;
    await fs.promises.writeFile(path.resolve(this.outDir, 'main.css'), cssEntry);
    const srcDirPrefix = this.srcDir + path.sep;
    const dependencies = Object.keys(metaEntry.inputs).filter(x => x.startsWith('src/'));
    const buildResult = await esbuild.build({
      ...this.getBaseEsbuildConfig(),
      entryPoints: dependencies,
      bundle: false,
      write: false,
      format: 'esm',
    });
    for (const entry of buildResult.outputFiles) {
      if (entry.path.endsWith('.css')) continue;
      await fs.promises.mkdir(path.dirname(entry.path), {recursive: true});
      await fs.promises.writeFile(entry.path, entry.contents);
    }
  }

  async typeCheck() {
    const startTime = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath, [require.resolve('typescript/lib/tsc.js'), '--noEmit'],
            {stdio: 'inherit'});
        child.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`tsc exited with code: ${code}`));
          }
        });
      });
    } finally {
      console.log(`Type checked in ${(Date.now() - startTime) / 1000.0} seconds`);
    }
  }

  typeCheckWatch() {
    const child = spawn(
        process.execPath,
        [
          require.resolve('typescript/lib/tsc.js'),
          '--noEmit',
          '--watch',
          '--preserveWatchOutput',
        ],
        {stdio: 'inherit'});
  }

  async buildAndTypeCheck(options) {
    const buildPromise = this.build();
    if (!options.skipTypeCheck) {
      await this.typeCheck();
    }
    await buildPromise;
  }

  async buildOrExit(options) {
    try {
      await this.buildAndTypeCheck(options);
    } catch (e) {
      process.exit(1);
    }
  }
}
exports.Builder = Builder;
