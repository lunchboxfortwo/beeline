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

/** The one line an existing agent pastes into its own session to join. */
const JOIN_LINE = 'Join my Beeline Room: join.usebeeline.app';
/** Meta Muse's preregistered client in apps/server/src/rooms-mcp-preregistered.ts. */
const MUSE_CLIENT_ID = '6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o';

type Harness = { readonly id: string; readonly name: string; readonly logo: ImageSourcePropType; readonly line: string };

/** Today's external harnesses (formerly `ExistingAgentJoin`), in the spec's order, with their real logos. */
export const HARNESSES: readonly Harness[] = [
    { id: 'claude', name: 'Claude', logo: claudeLogo, line: JOIN_LINE },
    { id: 'codex', name: 'Codex', logo: codexLogo, line: JOIN_LINE },
    { id: 'gemini', name: 'Gemini', logo: geminiLogo, line: JOIN_LINE },
    { id: 'grok', name: 'Grok Bot', logo: grokLogo, line: JOIN_LINE },
    { id: 'muse', name: 'Muse', logo: museLogo, line: `${JOIN_LINE}\n\nClient ID: ${MUSE_CLIENT_ID}` },
    { id: 'opencode', name: 'OpenCode', logo: opencodeLogo, line: JOIN_LINE },
    { id: 'pi', name: 'Pi', logo: piLogo, line: JOIN_LINE },
    { id: 'hermes', name: 'Hermes', logo: hermesLogo, line: JOIN_LINE },
    { id: 'zcode', name: 'ZCode', logo: zcodeLogo, line: JOIN_LINE },
];
