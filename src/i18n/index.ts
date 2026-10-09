/** The product language is English. Feature copy stays typed and colocated. */
export type EnglishCatalog = Readonly<Record<string, string>>;
type Catalogs = Readonly<Record<string, EnglishCatalog>>;
export function defineCatalog<const T extends EnglishCatalog>(catalog: T): Readonly<T> {
  return Object.freeze({ ...catalog });
}
export function interpolate(message: string, parameters: Readonly<Record<string, string | number>> = {}): string {
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
    if (!(name in parameters)) throw new TypeError(`Missing copy parameter: ${name}`);
    return String(parameters[name]);
  });
}
/** An instance per app; registering a feature cannot change another client's copy. */
export function createCopyRegistry<const C extends Catalogs>(catalogs: C) {
  return {
    locale: 'en' as const,
    catalogs,
    text<N extends keyof C, K extends keyof C[N]>(namespace: N, key: K, parameters?: Readonly<Record<string, string | number>>): string {
      const message = catalogs[namespace]?.[key as string];
      if (typeof message !== 'string') throw new TypeError('Unknown copy key.');
      return interpolate(message, parameters);
    },
    withCatalog<const N extends string, const T extends EnglishCatalog>(namespace: N, catalog: T) {
      if (namespace in catalogs) throw new TypeError(`Copy namespace already registered: ${namespace}`);
      return createCopyRegistry({ ...catalogs, [namespace]: catalog } as C & Record<N, T>);
    },
  };
}
