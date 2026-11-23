import type { StarterOnboardingService } from '../starter-onboarding-run.js';
import type { DaemonContext } from './context.js';
export function daemonSetStarterOnboarding(ctx: DaemonContext, service: StarterOnboardingService): void { ctx.starterOnboarding = service; }
