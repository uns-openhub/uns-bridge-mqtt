// Generated UNS asset list. Run `pnpm refresh-uns` to update.
export const GeneratedAssets = {
  /** Example asset. Replace with your own names after running generate-uns-metadata. */
  "asset": "asset",
} as const;
export type GeneratedAssetName = typeof GeneratedAssets[keyof typeof GeneratedAssets];

export function resolveGeneratedAsset(name: keyof typeof GeneratedAssets): (typeof GeneratedAssets)[keyof typeof GeneratedAssets];
export function resolveGeneratedAsset<T extends string>(name: T): (typeof GeneratedAssets)[keyof typeof GeneratedAssets] | T;
export function resolveGeneratedAsset(name: string): string {
  return (GeneratedAssets as Record<string, string>)[name] ?? name;
}
