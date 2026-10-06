export interface StorageConfig {
  readonly graph: {
    readonly uri: string;
    readonly username: string;
    readonly password: string;
    readonly database: string;
  };
  readonly vector: {
    readonly url: string;
    readonly schema: string;
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
  const graphUri = requiredEnv(env, 'GITNEXUS_NEO4J_URI');
  parseUrl(graphUri, 'GITNEXUS_NEO4J_URI', [
    'neo4j:',
    'neo4j+s:',
    'neo4j+ssc:',
    'bolt:',
    'bolt+s:',
    'bolt+ssc:',
  ]);

  const vectorUrl = requiredEnv(env, 'GITNEXUS_PGVECTOR_URL');
  parseUrl(vectorUrl, 'GITNEXUS_PGVECTOR_URL', ['postgres:', 'postgresql:']);
  const schema = env.GITNEXUS_PGVECTOR_SCHEMA?.trim() || 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('GITNEXUS_PGVECTOR_SCHEMA must be a PostgreSQL identifier');
  }

  return {
    graph: {
      uri: graphUri,
      username: requiredEnv(env, 'GITNEXUS_NEO4J_USERNAME'),
      password: requiredEnv(env, 'GITNEXUS_NEO4J_PASSWORD'),
      database: env.GITNEXUS_NEO4J_DATABASE?.trim() || 'neo4j',
    },
    vector: { url: vectorUrl, schema },
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
