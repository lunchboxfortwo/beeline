import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2];
let source = readFileSync(path, 'utf8');
const start = 'server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {';
const end = '    });\n    return server;';
if (source.split(start).length !== 2 || source.split(end).length !== 2)
  throw new Error('Pinned Squire call owner changed; review the receipt integration');
source =
  'import { ownedSquireCall } from "/opt/beeline/squire-operation-receipts.mjs";\n' +
  source
    .replace(
      start,
      'server.setRequestHandler(CallToolRequestSchema, (req, extra) => ownedSquireCall(requestingAgent, req, async () => {',
    )
    .replace(end, '    }));\n    return server;');
writeFileSync(path, source);
