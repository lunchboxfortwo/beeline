import type { AcpClient } from './acp.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  applyAgentModelSelectionWithUpdatedCatalog,
  appliedModelBeforeFailure,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentModelConfigOption } from './model-types.js';

export type RunningModelReport = { model?: string; selected?: string; reason?: string };

/**
 * Tells the server which model one session runs. Like the optional reads, the
 * write goes out after the session's first prompt, so it never holds delivery;
 * the newest report before then wins.
 */
export class RunningModelReporter {
  private prompted = false;
  private pending?: RunningModelReport;

  constructor(private readonly api: Pick<DaemonApiClient, 'execute'>, private readonly agentId: string) {}

  /** A fresh session: hold reports until its first prompt. */
  reset(): void {
    this.prompted = false;
    this.pending = undefined;
  }

  report(report: RunningModelReport): void {
    this.pending = report;
    if (this.prompted) this.flush();
  }

  /** The session sent a prompt; reports go out at once from now on. */
  prompt(): void {
    this.prompted = true;
    this.flush();
  }

  private flush(): void {
    const report = this.pending;
    this.pending = undefined;
    if (!report) return;
    void this.api
      .execute('postAgentRunningModel', {
        agentId: this.agentId,
        ...(report.model ? { model: report.model } : {}),
        ...(report.selected ? { selected: report.selected } : {}),
        ...(report.reason ? { reason: report.reason } : {}),
      })
      .catch((error) => console.warn('[body] running model not reported:', error));
  }
}

/**
 * Switch a live session to a newer selection the same unawaited way startup
 * reconciles, then report what runs: the applied model, or the old one and
 * the harness's refusal.
 */
export function switchLiveModel(input: {
  client: AcpClient;
  sessionId: string;
  catalog: AgentModelConfigOption[];
  selection: { model?: string; effort?: string; fastMode?: boolean };
  applied(options: AgentModelConfigOption[]): void;
  report(report: RunningModelReport): void;
}): void {
  const { client, sessionId, catalog, selection } = input;
  const running = catalog.find((option) => option.category === 'model')?.currentValue;
  void applyAgentModelSelectionWithUpdatedCatalog(client, sessionId, catalog, selection)
    .then((applied) => {
      input.applied(applied.options);
      input.report({ model: applied.appliedSelection.model ?? running, selected: selection.model });
    })
    .catch((error) => {
      console.warn('[body] model selection could not be applied:', error);
      input.report({
        model: appliedModelBeforeFailure(error) ?? running,
        selected: selection.model,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * After a session opens: read its live catalog, send any differing selection
 * through the setter, tell the agent which model it runs, and report that
 * model. The live catalog owns the verdict. A model change returns the apply,
 * which settles (never rejects) once the harness answers, so the first prompt
 * can follow the switch; effort and Fast Mode alone stay unawaited.
 */
export function reconcileStartupModel(input: {
  client: AcpClient;
  sessionId: string;
  raw: unknown;
  selection: { model?: string; effort?: string; fastMode?: boolean };
  notes: string[];
  /** Persona and reviewer settings came from the cached configuration. */
  cached: boolean;
  placeId: string;
  current(): boolean;
  remember(catalog: AgentModelConfigOption[]): void;
  report(report: RunningModelReport): void;
}): Promise<void> | undefined {
  const { client, selection, notes } = input;
  let applying: Promise<void> | undefined;
  const catalog = filterAllowedModelConfigOptions(parseAdvertisedConfigOptions(input.raw));
  input.remember(catalog);
  const advertisedDefault = catalog.find((option) => option.category === 'model')?.currentValue;
  const runningModel = advertisedDefault ?? 'the agent default';
  const available = catalog.some(
    (option) =>
      option.category === 'model' && option.options.some((value) => value.id === selection.model),
  );
  const reconcilingModel = Boolean(selection.model && selection.model !== runningModel && available);
  const configurationNote = `persona and reviewer skills use ${input.cached ? 'cached configuration' : 'the agent default'}. Optional context and capability status: read(facet:session).`;
  const effortAxis = catalog.find((option) =>
    ['thought_level', 'effort', 'reasoning_effort'].includes(option.category),
  );
  const fastAxis = catalog.find((option) => option.id === 'fast-mode');
  // Effort and Fast Mode apply on their own when the model already runs.
  const axesDiffer =
    Boolean(selection.effort && effortAxis && effortAxis.currentValue !== selection.effort) ||
    Boolean(
      selection.fastMode !== undefined &&
      fastAxis &&
      fastAxis.currentValue !== (selection.fastMode ? 'on' : 'off'),
    );
  const modelChange = Boolean(selection.model && selection.model !== runningModel);
  if (modelChange || axesDiffer) {
    if (!modelChange || available) {
      applying = applyAgentModelSelectionWithUpdatedCatalog(
        client,
        input.sessionId,
        catalog,
        modelChange ? selection : { effort: selection.effort, fastMode: selection.fastMode },
      )
        .then((applied) => {
          input.report({
            model: modelChange ? (applied.appliedSelection.model ?? advertisedDefault) : advertisedDefault,
            selected: selection.model,
          });
          if (input.current()) input.remember(applied.options);
          const index = input.current() ? notes.indexOf(configurationNote) : -1;
          if (index !== -1 && applied.appliedSelection.model)
            notes[index] = `This session uses ${applied.appliedSelection.model}; ${configurationNote}`;
        })
        .catch((error) => {
          console.warn('[body] model selection could not be applied:', error);
          input.report({
            model: appliedModelBeforeFailure(error) ?? advertisedDefault,
            selected: selection.model,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    } else {
      notes.push(
        `Selected model ${selection.model} is unavailable at startup; this session runs with ${runningModel}.`,
      );
      console.warn(`[body] place ${input.placeId}: selected model ${selection.model} is not offered; running ${runningModel}`);
      input.report({
        model: advertisedDefault,
        selected: selection.model,
        reason: `This agent's harness does not offer ${selection.model}.`,
      });
    }
  }
  if (!modelChange) input.report({ model: advertisedDefault, selected: selection.model });
  notes.push(`${reconcilingModel ? '' : `This session uses ${runningModel}; `}${configurationNote}`);
  return modelChange ? applying : undefined;
}
