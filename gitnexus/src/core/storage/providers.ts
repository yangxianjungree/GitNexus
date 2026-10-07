import { Neo4jGraphStore } from './neo4j-graph-store.js';
import { MongoVectorStore } from './mongodb-vector-store.js';
import { PostgresVectorStore } from './postgres-vector-store.js';
import { TuGraphGraphStore } from './tugraph-graph-store.js';
import type { StorageConfig } from './config.js';
import type { QueryableGraphStore, RawGraphQueryStore, VectorStore } from './contracts.js';
import {
  getGraphStoreFactory,
  getVectorStoreFactory,
  listGraphStoreProviders,
  listVectorStoreProviders,
  registerGraphStoreProvider,
  registerVectorStoreProvider,
} from './provider-registry.js';

registerGraphStoreProvider('neo4j', (config) => new Neo4jGraphStore(config));
registerGraphStoreProvider('tugraph', (config) => new TuGraphGraphStore(config));
registerVectorStoreProvider(
  'postgresql',
  (config, options) => new PostgresVectorStore(config, { dimensions: options.dimensions }),
);
registerVectorStoreProvider(
  'mongodb',
  (config, options) => new MongoVectorStore(config, { dimensions: options.dimensions }),
);

export interface SplitStorageProviders {
  readonly graph: QueryableGraphStore & { close(): Promise<void> };
  readonly vector: VectorStore & { close(): Promise<void> };
  readonly identity: { readonly graph: string; readonly vector: string };
  close(): Promise<void>;
}

const hasGitNexusQueryCapability = (
  graph: ReturnType<NonNullable<ReturnType<typeof getGraphStoreFactory>>>,
): graph is QueryableGraphStore & { close(): Promise<void> } => {
  const query = graph as Partial<RawGraphQueryStore>;
  return (
    typeof query.query === 'function' &&
    query.queryCapabilities?.gitnexusCypher === 'v1' &&
    typeof query.queryCapabilities.rawQueryLanguage === 'string'
  );
};

/** Explicit opt-in keeps existing Ladybug-only commands backward compatible. */
export const isSplitStorageEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.GITNEXUS_STORAGE_MODE?.trim().toLowerCase() === 'split';

export const createSplitStorageProviders = (
  config: StorageConfig,
  options: { readonly dimensions: number },
): SplitStorageProviders => {
  const graphProvider = config.graph.provider ?? 'neo4j';
  const vectorProvider = config.vector.provider ?? 'postgresql';
  const graphFactory = getGraphStoreFactory(graphProvider);
  if (!graphFactory) {
    throw new Error(
      `Graph provider "${graphProvider}" is not registered. Available: ${listGraphStoreProviders().join(', ')}`,
    );
  }
  const vectorFactory = getVectorStoreFactory(vectorProvider);
  if (!vectorFactory) {
    throw new Error(
      `Vector provider "${vectorProvider}" is not registered. Available: ${listVectorStoreProviders().join(', ')}`,
    );
  }

  const graph = graphFactory(config.graph);
  if (!hasGitNexusQueryCapability(graph)) {
    void graph.close();
    throw new Error(
      `Graph provider "${graphProvider}" must implement and declare the GitNexus raw-query capability (gitnexus-cypher-v1).`,
    );
  }

  let vector: ReturnType<typeof vectorFactory>;
  try {
    vector = vectorFactory(config.vector, options);
  } catch (error) {
    void graph.close();
    throw error;
  }

  return {
    graph,
    vector,
    identity: { graph: graphProvider, vector: vectorProvider },
    async close() {
      await Promise.allSettled([graph.close(), vector.close()]);
    },
  };
};

export { registerGraphStoreProvider, registerVectorStoreProvider };
