import type { GraphProviderName, VectorProviderName } from './contracts.js';
import { MongoClient } from 'mongodb';
import {
  hasGraphStoreProvider,
  hasVectorStoreProvider,
  listGraphStoreProviders,
  listVectorStoreProviders,
} from './provider-registry.js';

export interface StorageConfig {
  readonly graph: {
    readonly provider?: GraphProviderName;
    readonly uri: string;
    readonly username: string;
    readonly password: string;
    readonly database: string;
    readonly options: Readonly<Record<string, unknown>>;
  };
  readonly vector: {
    readonly provider?: VectorProviderName;
    readonly url: string;
    readonly schema: string;
    readonly database?: string;
    readonly collection?: string;
    readonly index?: string;
    readonly options: Readonly<Record<string, unknown>>;
  };
}

const requiredEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required to connect the split storage backends`);
  return value;
};

const parseUrl = (value: string, key: string, protocols: readonly string[]): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid connection URL`);
  }
  if (!protocols.includes(url.protocol) || !url.hostname) {
    throw new Error(`${key} must use ${protocols.join(' or ')} and include a host`);
  }
  return url;
};

const parseMongoUrl = (value: string, key: string): string => {
  try {
    const client = new MongoClient(value);
    void client.close();
  } catch {
    throw new Error(`${key} must be a valid MongoDB connection URL`);
  }
  return value;
};

const parseProviderUri = (value: string, key: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(value)) {
    throw new Error(`${key} must be a valid provider URI`);
  }
  return value;
};

const parseProviderOptions = (
  env: NodeJS.ProcessEnv,
  key: string,
): Readonly<Record<string, unknown>> => {
  const raw = env[key]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${key} must contain a JSON object`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

/** Resolve the two service endpoints without including secret values in errors. */
export const resolveStorageConfig = (env: NodeJS.ProcessEnv = process.env): StorageConfig => {
  const graphProvider = env.GITNEXUS_GRAPH_PROVIDER?.trim().toLowerCase() || 'neo4j';
  const builtinGraph = graphProvider === 'neo4j' || graphProvider === 'tugraph';
  if (!builtinGraph && !hasGraphStoreProvider(graphProvider)) {
    throw new Error(
      `Graph provider "${graphProvider}" is not registered. Available: ${listGraphStoreProviders().join(', ')}`,
    );
  }
  const graphEnv =
    graphProvider === 'tugraph'
      ? {
          uri: 'GITNEXUS_TUGRAPH_URI',
          username: 'GITNEXUS_TUGRAPH_USERNAME',
          password: 'GITNEXUS_TUGRAPH_PASSWORD',
        }
      : graphProvider === 'neo4j'
        ? {
            uri: 'GITNEXUS_NEO4J_URI',
            username: 'GITNEXUS_NEO4J_USERNAME',
            password: 'GITNEXUS_NEO4J_PASSWORD',
          }
        : undefined;
  const graphUriKey = graphEnv?.uri ?? 'GITNEXUS_GRAPH_URI';
  const graphUri = requiredEnv(env, graphUriKey);
  if (graphProvider === 'tugraph') parseUrl(graphUri, graphUriKey, ['http:', 'https:']);
  else if (graphProvider === 'neo4j') {
    parseUrl(graphUri, graphUriKey, [
      'neo4j:',
      'neo4j+s:',
      'neo4j+ssc:',
      'bolt:',
      'bolt+s:',
      'bolt+ssc:',
    ]);
  } else parseProviderUri(graphUri, graphUriKey);

  const vectorProvider = env.GITNEXUS_VECTOR_PROVIDER?.trim().toLowerCase() || 'postgresql';
  const builtinVector = vectorProvider === 'postgresql' || vectorProvider === 'mongodb';
  if (!builtinVector && !hasVectorStoreProvider(vectorProvider)) {
    throw new Error(
      `Vector provider "${vectorProvider}" is not registered. Available: ${listVectorStoreProviders().join(', ')}`,
    );
  }
  const vectorUrlKey =
    vectorProvider === 'mongodb'
      ? 'GITNEXUS_MONGODB_URL'
      : vectorProvider === 'postgresql'
        ? 'GITNEXUS_PGVECTOR_URL'
        : 'GITNEXUS_VECTOR_URI';
  const vectorUrl = requiredEnv(env, vectorUrlKey);
  if (vectorProvider === 'mongodb') parseMongoUrl(vectorUrl, vectorUrlKey);
  else if (vectorProvider === 'postgresql') {
    parseUrl(vectorUrl, vectorUrlKey, ['postgres:', 'postgresql:']);
  } else parseProviderUri(vectorUrl, vectorUrlKey);

  const schema = env.GITNEXUS_PGVECTOR_SCHEMA?.trim() || 'public';
  if (vectorProvider === 'postgresql' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('GITNEXUS_PGVECTOR_SCHEMA must be a PostgreSQL identifier');
  }

  return {
    graph: {
      provider: graphProvider,
      uri: graphUri,
      username: graphEnv
        ? requiredEnv(env, graphEnv.username)
        : env.GITNEXUS_GRAPH_USERNAME?.trim() || '',
      password: graphEnv ? requiredEnv(env, graphEnv.password) : env.GITNEXUS_GRAPH_PASSWORD || '',
      database:
        graphProvider === 'tugraph'
          ? env.GITNEXUS_TUGRAPH_GRAPH?.trim() || 'default'
          : graphProvider === 'neo4j'
            ? env.GITNEXUS_NEO4J_DATABASE?.trim() || 'neo4j'
            : env.GITNEXUS_GRAPH_DATABASE?.trim() || 'default',
      options:
        graphProvider === 'neo4j' || graphProvider === 'tugraph'
          ? {}
          : parseProviderOptions(env, 'GITNEXUS_GRAPH_OPTIONS'),
    },
    vector: {
      provider: vectorProvider,
      url: vectorUrl,
      schema,
      database:
        vectorProvider === 'mongodb'
          ? env.GITNEXUS_MONGODB_DATABASE?.trim() || 'gitnexus'
          : env.GITNEXUS_VECTOR_DATABASE?.trim() || undefined,
      collection:
        vectorProvider === 'mongodb'
          ? env.GITNEXUS_MONGODB_COLLECTION?.trim() || 'embedding_chunks'
          : undefined,
      index:
        vectorProvider === 'mongodb'
          ? env.GITNEXUS_MONGODB_VECTOR_INDEX?.trim() || 'gitnexus_embedding_vector'
          : undefined,
      options:
        vectorProvider === 'postgresql' || vectorProvider === 'mongodb'
          ? {}
          : parseProviderOptions(env, 'GITNEXUS_VECTOR_OPTIONS'),
    },
  };
};

const safeEndpoint = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}`;
};

/** Connection summaries suitable for logs; user info, database paths, and query values are omitted. */
export const storageConfigDiagnostics = (
  config: StorageConfig,
): { readonly graphEndpoint: string; readonly vectorEndpoint: string } => ({
  graphEndpoint: safeEndpoint(config.graph.uri),
  vectorEndpoint: safeEndpoint(config.vector.url),
});
