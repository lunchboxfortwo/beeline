import { OwnedModelRefusal } from '../owned-model-errors.js';
import { OwnedModelCredentials } from '../owned-model-credential.js';
import type { StarterOnboardingService } from '../starter-onboarding-run.js';
import type { DaemonContext } from './context.js';
import { OwnedModelConfiguration, OwnedModelNegotiation, OwnedModelClaimCapability } from './values.js';


  /** Root installs this only after schema/signer rollout proof. */
  export function daemonSetOwnedModel(ctx: DaemonContext, configuration: OwnedModelConfiguration | undefined): void { ctx.ownedModel = configuration; }

  export function daemonOwnedModelReady(ctx: DaemonContext): boolean { return ctx.ownedModel?.ready() === true; }


  export async function daemonNegotiateOwnedModel(ctx: DaemonContext, agentId: string, installed: boolean): Promise<OwnedModelNegotiation> {
    const free = (await ctx.database.query<{ eligible: boolean }>(`SELECT removed_at IS NULL
      AND model_token_hash IS NOT NULL eligible FROM free_agents WHERE agent_id=$1`, [agentId])).rows[0];
    if (!free) return { freeAgent: false };
    const configuration = ctx.ownedModel;
    if (!installed || !free.eligible || !configuration?.ready()) return { freeAgent: true };
    const capability = Object.freeze({}) as OwnedModelClaimCapability;
    // The capability object is the negotiated grant; no socket is recorded.
    ctx.modelClaims.set(capability, { agentId, configuration });
    return { freeAgent: true, capability };
  }


  export function daemonModelClaimCredentials(ctx: DaemonContext, capability: OwnedModelClaimCapability | undefined,
    agentId: string): OwnedModelCredentials {
    const claim = capability && ctx.modelClaims.get(capability), configuration = ctx.ownedModel;
    if (!claim || !configuration || claim.configuration !== configuration || !configuration.ready() || claim.agentId !== agentId)
      throw new OwnedModelRefusal();
    return configuration.credentials;
  }

  export function daemonSetStarterOnboarding(ctx: DaemonContext, service: StarterOnboardingService): void { ctx.starterOnboarding = service; }
