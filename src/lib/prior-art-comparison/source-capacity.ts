// Representation capacity, not permission to send or a semantic acceptance
// threshold. The finite-operation gate separately binds request/cost limits.
export const SOURCE_CAPACITY = Object.freeze({ facts:96, wireBytes:64_000, quotes:1024,
  witnessBytes:32_000, descriptorBytes:12_000 } as const);
export const LEGACY_SOURCE_CAPACITY = Object.freeze({ facts:48, wireBytes:32_000, quotes:512 } as const);
export type SourceWireCapacity = { readonly facts:number; readonly wireBytes:number; readonly quotes:number };
