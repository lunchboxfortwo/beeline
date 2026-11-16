import {build} from 'esbuild';
await build({entryPoints:['apps/site/marketing/demo-source.mjs'],outfile:'apps/site/marketing/demo.js',bundle:true,minify:true,format:'esm',target:'es2022',legalComments:'eof'});
