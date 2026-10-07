import { Neo4jGraphStore } from './neo4j-graph-store.js';
import { PostgresVectorStore } from './postgres-vector-store.js';
import type { StorageConfig } from './config.js';
import type { GraphStore, VectorStore } from './contracts.js';

export interface SplitStorageProviders {
  readonly graph: GraphStore;
  readonly vector: VectorStore;
  close(): Promise<void>;
}

/** Explicit opt-in keeps existing Ladybug-only commands backward compatible. */
export const isSplitStorageEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.GITNEXUS_STORAGE_MODE?.trim().toLowerCase() === 'split';

export const createSplitStorageProviders = (
  config: StorageConfig,
  options: { readonly dimensions: number },
): SplitStorageProviders => {
  const graph = new Neo4jGraphStore(config.graph);
  const vector = new PostgresVectorStore(config.vector, { dimensions: options.dimensions });
  return {
    graph,
    vector,
    async close() {
      await Promise.allSettled([graph.close(), vector.close()]);
    },
  };
};
