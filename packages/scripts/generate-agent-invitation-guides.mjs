// Refresh only the marked invitation copy; both public pages share the tool's facts.
import { readFileSync, writeFileSync } from 'node:fs';
import { ASSISTANT_INVITATION_STEPS, AGENT_INVITATION_PATHS, AGENT_INVITATION_ENDPOINT_NOTE } from '../api-contract/src/agent-invitation-guide.ts';

const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const ids = { muse: 'meta-muse', 'claude code': 'claude-code', 'grok bot': 'grok-bot', 'grok business': 'grok-business', 'grok cli': 'grok-cli' };
const block = '<!-- agent-invitation-guide:start -->\n' + `<p>${escape(AGENT_INVITATION_ENDPOINT_NOTE)}</p>\n` +
  Object.entries(ASSISTANT_INVITATION_STEPS).map(([name, steps]) =>
    `<section class="client" id="${ids[name] ?? name}"><h3>${escape(steps.split(':')[0])}</h3><p>${escape(steps)}</p></section>`).join('\n') +
  '\n<h2>Choose an invitation path</h2>\n' + Object.values(AGENT_INVITATION_PATHS).map(steps => `<p>${escape(steps)}</p>`).join('\n') +
  '\n<!-- agent-invitation-guide:end -->';
for (const file of ['apps/server/assets/mcp/join.html', 'apps/site/connect/index.html']) {
  const path = new URL('../' + file, import.meta.url);
  const original = readFileSync(path, 'utf8');
  const updated = original.replace(/<!-- agent-invitation-guide:start -->[\s\S]*?<!-- agent-invitation-guide:end -->/, block);
  if (updated === original && !original.includes(block)) throw new Error(`Missing guide marker in ${file}`);
  writeFileSync(path, updated);
}

const matrix = new URL('../../docs/agent-invitation-matrix.md', import.meta.url);
const labels = { chatgpt: 'O — ChatGPT', claude: 'C — Claude app', muse: 'M — Muse', grok: 'G — Grok chat' };
const markdown = '<!-- invitation-steps:start -->\n' + AGENT_INVITATION_ENDPOINT_NOTE + '\n\n' + Object.entries(ASSISTANT_INVITATION_STEPS)
  .map(([key, value]) => `## ${labels[key] ?? key}\n\n${value}`).join('\n\n') + '\n\n' +
  Object.entries(AGENT_INVITATION_PATHS).map(([key, value]) => `## ${{connector:'Shared connector completion',session:'J',helper:'H'}[key]}\n\n${value}`).join('\n\n') +
  '\n<!-- invitation-steps:end -->';
writeFileSync(matrix, readFileSync(matrix, 'utf8').replace(/<!-- invitation-steps:start -->[\s\S]*?<!-- invitation-steps:end -->/, markdown));
