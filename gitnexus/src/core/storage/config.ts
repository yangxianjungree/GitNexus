import type { GraphProviderName, VectorProviderName } from './contracts.js';

export interface StorageConfig {
  readonly graph: {
    readonly provider?: GraphProviderName;
    readonly uri: string;
    readonly username: string;
    readonly password: string;
    readonly database: string;
  };
  readonly vector: {
    readonly provider?: VectorProviderName;
    readonly url: string;
    readonly schema: string;
    readonly database?: string;
    readonly collection?: string;
    readonly index?: string;
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

/** Resolve the two service endpoints without including secret values in errors. */
export const resolveStorageConfig = (env: NodeJS.ProcessEnv = process.env): StorageConfig => {
  const graphProvider = (env.GITNEXUS_GRAPH_PROVIDER?.trim().toLowerCase() ||
    'neo4j') as GraphProviderName;
  if (graphProvider !== 'neo4j' && graphProvider !== 'tugraph') {
    throw new Error('GITNEXUS_GRAPH_PROVIDER must be neo4j or tugraph');
  }
  const graphEnv =
    graphProvider === 'tugraph'
      ? {
          uri: 'GITNEXUS_TUGRAPH_URI',
          username: 'GITNEXUS_TUGRAPH_USERNAME',
          password: 'GITNEXUS_TUGRAPH_PASSWORD',
        }
      : {
          uri: 'GITNEXUS_NEO4J_URI',
          username: 'GITNEXUS_NEO4J_USERNAME',
          password: 'GITNEXUS_NEO4J_PASSWORD',
        };
  const graphUri = requiredEnv(env, graphEnv.uri);
  parseUrl(
    graphUri,
    graphEnv.uri,
    graphProvider === 'tugraph'
      ? ['http:', 'https:']
      : ['neo4j:', 'neo4j+s:', 'neo4j+ssc:', 'bolt:', 'bolt+s:', 'bolt+ssc:'],
  );

  const vectorProvider = (env.GITNEXUS_VECTOR_PROVIDER?.trim().toLowerCase() ||
    'postgresql') as VectorProviderName;
  if (vectorProvider !== 'postgresql' && vectorProvider !== 'mongodb') {
    throw new Error('GITNEXUS_VECTOR_PROVIDER must be postgresql or mongodb');
  }
  const vectorUrlKey =
    vectorProvider === 'mongodb' ? 'GITNEXUS_MONGODB_URL' : 'GITNEXUS_PGVECTOR_URL';
  const vectorUrl = requiredEnv(env, vectorUrlKey);
  parseUrl(
    vectorUrl,
    vectorUrlKey,
    vectorProvider === 'mongodb' ? ['mongodb:', 'mongodb+srv:'] : ['postgres:', 'postgresql:'],
  );
  const schema = env.GITNEXUS_PGVECTOR_SCHEMA?.trim() || 'public';
  if (vectorProvider === 'postgresql' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('GITNEXUS_PGVECTOR_SCHEMA must be a PostgreSQL identifier');
  }

  return {
    graph: {
      provider: graphProvider,
      uri: graphUri,
      username: requiredEnv(env, graphEnv.username),
      password: requiredEnv(env, graphEnv.password),
      database:
        graphProvider === 'tugraph'
          ? env.GITNEXUS_TUGRAPH_GRAPH?.trim() || 'default'
          : env.GITNEXUS_NEO4J_DATABASE?.trim() || 'neo4j',
    },
    vector: {
      provider: vectorProvider,
      url: vectorUrl,
      schema,
      database: env.GITNEXUS_MONGODB_DATABASE?.trim() || 'gitnexus',
      collection: env.GITNEXUS_MONGODB_COLLECTION?.trim() || 'embedding_chunks',
      index: env.GITNEXUS_MONGODB_VECTOR_INDEX?.trim() || 'gitnexus_embedding_vector',
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
