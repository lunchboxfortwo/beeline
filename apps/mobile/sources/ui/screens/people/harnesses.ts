import type { ImageSourcePropType } from 'react-native';
import claudeLogo from '@/assets/images/agent-logos/claude.png';
import codexLogo from '@/assets/images/agent-logos/codex.png';
import geminiLogo from '@/assets/images/agent-logos/gemini.png';
import grokLogo from '@/assets/images/agent-logos/grok.png';
import museLogo from '@/assets/images/agent-logos/muse.png';
import opencodeLogo from '@/assets/images/agent-logos/opencode.png';
import piLogo from '@/assets/images/agent-logos/pi.png';
import hermesLogo from '@/assets/images/agent-logos/hermes.png';
import zcodeLogo from '@/assets/images/agent-logos/zcode.png';

type Harness = { readonly id: string; readonly name: string; readonly logo: ImageSourcePropType };

/** Today's external harnesses (formerly `ExistingAgentJoin`), in the spec's order, with their real logos. */
export const HARNESSES: readonly Harness[] = [
    { id: 'claude', name: 'Claude', logo: claudeLogo },
    { id: 'codex', name: 'Codex', logo: codexLogo },
    { id: 'gemini', name: 'Gemini', logo: geminiLogo },
    { id: 'grok', name: 'Grok Bot', logo: grokLogo },
    { id: 'muse', name: 'Muse', logo: museLogo },
    { id: 'opencode', name: 'OpenCode', logo: opencodeLogo },
    { id: 'pi', name: 'Pi', logo: piLogo },
    { id: 'hermes', name: 'Hermes', logo: hermesLogo },
    { id: 'zcode', name: 'ZCode', logo: zcodeLogo },
];
