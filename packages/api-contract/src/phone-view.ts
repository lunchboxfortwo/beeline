type Decl = { readonly read: (item: Record<string, unknown>) => unknown; readonly required: boolean };
type Value<F> = F extends { readonly read: (...args: never[]) => infer R } ? Exclude<R, undefined | null> : never;
type Fields<S> = { [K in keyof S as S[K] extends { readonly required: true } ? K : never]: Value<S[K]> } & { [K in keyof S as S[K] extends { readonly required: false } ? K : never]?: Value<S[K]> };
type Missing<A, B> = Exclude<keyof A, keyof B>;

/** One field list. Required keys are present; optional keys are omitted when unread. */
export type ViewOf<S> = Readonly<Fields<S>>;
export type Align<Fields, Spec> = Missing<Fields, Spec> extends never ? Missing<Spec, Fields> extends never ? Spec : { readonly 'reader with no field': Missing<Spec, Fields> } : { readonly 'field with no reader': Missing<Fields, Spec> };

export const required = <T>(read: (item: Record<string, unknown>) => T | undefined | null) => ({ read, required: true as const });
export const optional = <T>(read: (item: Record<string, unknown>) => T | undefined | null) => ({ read, required: false as const });

export function view<S extends Record<string, Decl>>(spec: S) {
  return {
    read(value: unknown): ViewOf<S> | null {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      const item = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, declared] of Object.entries(spec)) {
        const part = declared.read(item);
        if (part === undefined || part === null) {
          if (declared.required) return null;
          continue;
        }
        out[key] = part;
      }
      return out as ViewOf<S>;
    },
  };
}
