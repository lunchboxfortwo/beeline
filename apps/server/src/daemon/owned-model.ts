import type { StarterOnboardingService } from '../starter-onboarding-run.js';
import type { DaemonContext } from './context.js';
import type { OwnedModelConfiguration } from './values.js';

export function daemonSetOwnedModel(ctx: DaemonContext, configuration: OwnedModelConfiguration | undefined): void {
  ctx.database.ownedModelCredentials = configuration?.credentials;
}

export function daemonSetStarterOnboarding(ctx: DaemonContext, service: StarterOnboardingService): void { ctx.starterOnboarding = service; }
