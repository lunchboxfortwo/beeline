import type { OpenRouterRouting } from './openrouter-routing.js';

/**
 * Pin ONE model inside pi's `models.json` without touching operator custom
 * providers or any other model: the routing lands on
 * `providers.openrouter.modelOverrides[<model>].compat.openRouterRouting`,
 * pi's topmost per-model layer, and the model's live input modalities land
 * beside it on the same override as `input` (C87 — without it a custom-model
 * entry defaults the model to text and pi strips every image from the prompt),
 * and the routed endpoints' `contextWindow` and `maxTokens` land there too.
 * With no model to pin, the object form still gains an empty `providers` map
 * (pi's schema requires the key).
 */
export function withOpenRouterModelRouting(
  value: unknown,
  pin:
    | {
        model: string;
        routing: OpenRouterRouting;
        input?: Array<'text' | 'image'>;
        /** `contextWindow` is absent when the listing named no window. */
        limits?: { contextWindow?: number; maxTokens: number };
      }
    | undefined,
): Record<string, unknown> {
  const root =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  const applyOverride = (provider: Record<string, unknown>): Record<string, unknown> => {
    if (!pin) return provider;
    const overrides =
      provider.modelOverrides &&
      typeof provider.modelOverrides === 'object' &&
      !Array.isArray(provider.modelOverrides)
        ? { ...(provider.modelOverrides as Record<string, unknown>) }
        : {};
    const existing = overrides[pin.model];
    const override =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    const compat =
      override.compat && typeof override.compat === 'object' && !Array.isArray(override.compat)
        ? { ...(override.compat as Record<string, unknown>) }
        : {};
    override.compat = { ...compat, openRouterRouting: pin.routing };
    if (pin.input) override.input = pin.input;
    if (pin.limits?.contextWindow) override.contextWindow = pin.limits.contextWindow;
    if (pin.limits) override.maxTokens = pin.limits.maxTokens;
    overrides[pin.model] = override;
    return { ...provider, modelOverrides: overrides };
  };
  if (Array.isArray(root.providers)) {
    if (!pin) return root;
    const providers = root.providers.map((provider) =>
      provider && typeof provider === 'object'
        ? { ...(provider as Record<string, unknown>) }
        : provider,
    );
    const index = providers.findIndex(
      (provider) => provider && typeof provider === 'object' && provider.name === 'openrouter',
    );
    const current = applyOverride(
      index >= 0 ? (providers[index] as Record<string, unknown>) : { name: 'openrouter' },
    );
    if (index >= 0) providers[index] = current;
    else providers.push(current);
    root.providers = providers;
    return root;
  }
  const providers =
    root.providers && typeof root.providers === 'object'
      ? { ...(root.providers as Record<string, unknown>) }
      : {};
  if (pin) {
    const current =
      providers.openrouter &&
      typeof providers.openrouter === 'object' &&
      !Array.isArray(providers.openrouter)
        ? { ...(providers.openrouter as Record<string, unknown>) }
        : {};
    providers.openrouter = applyOverride(current);
  }
  root.providers = providers;
  return root;
}

/**
 * The OpenRouter model id behind a catalog selection: `openrouter/<id>` from
 * pi's namespaced catalog, or a bare `<vendor>/<model>` id when the runtime's
 * only provider credential is an OpenRouter key (the connect wizard stores the
 * bare id). Anything else is not an OpenRouter model.
 */
export function openRouterModelId(
  model: string | undefined,
  env: Record<string, string | undefined> = {},
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('openrouter/')) {
    const id = trimmed.slice('openrouter/'.length);
    return id.includes('/') ? id : undefined;
  }
  if (env.OPENROUTER_API_KEY?.trim() && /^[^/\s]+\/[^/\s][^\s]*$/.test(trimmed)) return trimmed;
  return undefined;
}
