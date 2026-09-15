import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
await Promise.all([
  esbuild.build({entryPoints:['src/standalone/main.ts'],bundle:true,platform:'node',target:'es2022',format:'cjs',outfile:'dist/coach.cjs',external:['vscode']}),
  esbuild.build({entryPoints:['src/core/parse-worker.ts'],bundle:true,platform:'node',target:'es2022',format:'cjs',outfile:'dist/parse-worker.js',external:['vscode']}),
  esbuild.build({entryPoints:['src/standalone/dashboard.ts'],bundle:true,platform:'browser',target:'es2022',format:'iife',outfile:'dist/standalone/dashboard.js'}),
]);
await fs.mkdir('dist/standalone',{recursive:true});
await Promise.all(['dashboard.html','dashboard.css'].map(file=>fs.copyFile(`src/standalone/${file}`,`dist/standalone/${file}`)));
console.log('Standalone coach built. Run npm run coach.');
