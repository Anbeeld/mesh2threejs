import { canonicalJson, sha256 } from "./hashing.js";

export interface DerivativeCacheIdentity {
  sourceHash: string;
  preparedHash: string;
  candidateHash?: string;
  profileContractHash: string;
  measurementVersion: string;
  cameraFrameHash: string;
  renderConfigHash: string;
  materialHash?: string;
}

export function derivativeCacheKey(identity: DerivativeCacheIdentity): string {
  for (const [key, value] of Object.entries(identity)) if (!value) throw new Error(`cache identity is missing ${key}`);
  return sha256(canonicalJson({ schemaVersion: 1, ...identity }));
}

export interface DerivativeCacheEntry<T> {
  key: string;
  identity: DerivativeCacheIdentity;
  value: T;
  createdAt: string;
}

export function readDerivativeCache<T>(entry: DerivativeCacheEntry<T> | undefined, identity: DerivativeCacheIdentity): T | undefined {
  const expected = derivativeCacheKey(identity);
  if (!entry || entry.key !== expected || canonicalJson(entry.identity) !== canonicalJson(identity)) return undefined;
  return entry.value;
}

export function createDerivativeCacheEntry<T>(identity: DerivativeCacheIdentity, value: T): DerivativeCacheEntry<T> {
  return { key: derivativeCacheKey(identity), identity: structuredClone(identity), value, createdAt: new Date().toISOString() };
}
