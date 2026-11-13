import claudeLogo from '@/assets/images/agent-logos/claude.png';
import codexLogo from '@/assets/images/agent-logos/codex.png';
import grokLogo from '@/assets/images/agent-logos/grok.png';
import museLogo from '@/assets/images/agent-logos/muse.png';

type Harness = { readonly id: string; readonly name: string; readonly logo: number };

/** The four marks shown under the external-agent prompt; the full list lives at join.usebeeline.app. */
export const HARNESSES: readonly Harness[] = [
    { id: 'claude', name: 'Claude Code', logo: claudeLogo },
    { id: 'codex', name: 'Codex', logo: codexLogo },
    { id: 'grok', name: 'Grok Bot', logo: grokLogo },
    { id: 'muse', name: 'Muse', logo: museLogo },
];
