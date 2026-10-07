import type { GraphStore, VectorStore } from './contracts.js';
import type { StorageConfig } from './config.js';

export type GraphStoreFactory = (
  config: StorageConfig['graph'],
) => GraphStore & { close(): Promise<void> };

export type VectorStoreFactory = (
  config: StorageConfig['vector'],
  options: { readonly dimensions: number },
) => VectorStore & { close(): Promise<void> };

const graphFactories = new Map<string, GraphStoreFactory>();
const vectorFactories = new Map<string, VectorStoreFactory>();

const normalizeProviderId = (name: string): string => {
  const id = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`Storage provider ID must be a lowercase name, got "${name}"`);
  }
  return id;
};

const register = <T extends Function>(
  registry: Map<string, T>,
  name: string,
  factory: T,
): (() => void) => {
  const id = normalizeProviderId(name);
  if (registry.has(id)) throw new Error(`Storage provider "${id}" is already registered`);
  registry.set(id, factory);
  return () => {
    if (registry.get(id) === factory) registry.delete(id);
  };
};

export const registerGraphStoreProvider = (
  name: string,
  factory: GraphStoreFactory,
): (() => void) => register(graphFactories, name, factory);

export const registerVectorStoreProvider = (
  name: string,
  factory: VectorStoreFactory,
): (() => void) => register(vectorFactories, name, factory);

export const getGraphStoreFactory = (name: string): GraphStoreFactory | undefined =>
  graphFactories.get(normalizeProviderId(name));

export const getVectorStoreFactory = (name: string): VectorStoreFactory | undefined =>
  vectorFactories.get(normalizeProviderId(name));

export const hasGraphStoreProvider = (name: string): boolean =>
  graphFactories.has(normalizeProviderId(name));

export const hasVectorStoreProvider = (name: string): boolean =>
  vectorFactories.has(normalizeProviderId(name));

export const listGraphStoreProviders = (): string[] => [...graphFactories.keys()].sort();

export const listVectorStoreProviders = (): string[] => [...vectorFactories.keys()].sort();
