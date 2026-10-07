import { describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { createStorageScope, deterministicChunkId } from '../../../src/core/storage/contracts.js';
import {
  resolveStorageConfig,
  storageConfigDiagnostics,
} from '../../../src/core/storage/config.js';
import {
  createSplitStorageProviders,
  isSplitStorageEnabled,
  registerGraphStoreProvider,
  registerVectorStoreProvider,
} from '../../../src/core/storage/providers.js';
import type { GraphStore, VectorStore } from '../../../src/core/storage/contracts.js';
import {
  evaluateSplitStorageMigration,
  stampSplitStorageGeneration,
} from '../../../src/core/storage/split-storage-state.js';
import type { RepoMeta } from '../../../src/storage/repo-meta.js';

describe('split storage contracts', () => {
  it('requires a repository and branch scope for every storage operation', () => {
    expect(createStorageScope('repo-1', 'feature/search')).toEqual({
      repoId: 'repo-1',
      branchId: 'feature/search',
    });
    expect(() => createStorageScope(' ', 'main')).toThrow(/repoId/);
    expect(() => createStorageScope('repo-1', '')).toThrow(/branchId/);
  });

  it('gives each node chunk a stable ID that cannot collide across node IDs', () => {
    expect(deterministicChunkId('Function:src/a.ts:run', 0)).toBe(
      deterministicChunkId('Function:src/a.ts:run', 0),
    );
    expect(deterministicChunkId('Function:src/a.ts:run', 1)).not.toBe(
      deterministicChunkId('Function:src/a.ts:run', 0),
    );
    expect(deterministicChunkId('Function:a:b', 2)).not.toBe(deterministicChunkId('Function:a', 2));
    expect(() => deterministicChunkId('', 0)).toThrow(/nodeId/);
    expect(() => deterministicChunkId('Function:x', -1)).toThrow(/chunkIndex/);
  });

  it('requires valid Neo4j and PostgreSQL connection settings', () => {
    expect(() => resolveStorageConfig({})).toThrow(/GITNEXUS_NEO4J_URI/);
    expect(() =>
      resolveStorageConfig({
        GITNEXUS_NEO4J_URI: 'http://graph.local:7474',
        GITNEXUS_NEO4J_USERNAME: 'neo4j',
        GITNEXUS_NEO4J_PASSWORD: 'graph-secret',
        GITNEXUS_PGVECTOR_URL: 'postgresql://vector-secret@vector.local/gitnexus',
      }),
    ).toThrow(/neo4j|bolt/i);
    expect(() =>
      resolveStorageConfig({
        GITNEXUS_NEO4J_URI: 'neo4j://localhost:7687',
        GITNEXUS_NEO4J_USERNAME: 'neo4j',
        GITNEXUS_NEO4J_PASSWORD: 'graph-secret',
        GITNEXUS_PGVECTOR_URL: 'http://vector.local/gitnexus',
      }),
    ).toThrow(/postgres/i);
  });

  it('keeps credentials out of connection diagnostics', () => {
    const config = resolveStorageConfig({
      GITNEXUS_NEO4J_URI: 'neo4j+s://graph-user:graph-secret@graph.local:7687',
      GITNEXUS_NEO4J_USERNAME: 'graph-user',
      GITNEXUS_NEO4J_PASSWORD: 'graph-secret',
      GITNEXUS_PGVECTOR_URL:
        'postgresql://vector-user:vector-secret@vector.local:5432/gitnexus?sslmode=require',
    });

    const diagnostics = JSON.stringify(storageConfigDiagnostics(config));
    expect(diagnostics).toContain('graph.local:7687');
    expect(diagnostics).toContain('vector.local:5432');
    expect(diagnostics).not.toContain('graph-secret');
    expect(diagnostics).not.toContain('vector-secret');
    expect(diagnostics).not.toContain('graph-user');
    expect(diagnostics).not.toContain('vector-user');
  });

  it('requires an explicit split-storage opt-in', () => {
    expect(isSplitStorageEnabled({})).toBe(false);
    expect(isSplitStorageEnabled({ GITNEXUS_STORAGE_MODE: 'ladybug' })).toBe(false);
    expect(isSplitStorageEnabled({ GITNEXUS_STORAGE_MODE: ' SPLIT ' })).toBe(true);
  });

  it('resolves TuGraph and MongoDB endpoints without exposing credentials', () => {
    const config = resolveStorageConfig({
      GITNEXUS_GRAPH_PROVIDER: 'tugraph',
      GITNEXUS_TUGRAPH_URI: 'http://graph.local:7071',
      GITNEXUS_TUGRAPH_USERNAME: 'admin',
      GITNEXUS_TUGRAPH_PASSWORD: 'graph-secret',
      GITNEXUS_TUGRAPH_GRAPH: 'default',
      GITNEXUS_VECTOR_PROVIDER: 'mongodb',
      GITNEXUS_MONGODB_URL: 'mongodb://vector-user:vector-secret@vector.local:27017',
      GITNEXUS_MONGODB_DATABASE: 'gitnexus',
    });

    expect(config.graph).toMatchObject({ provider: 'tugraph', database: 'default' });
    expect(config.vector).toMatchObject({
      provider: 'mongodb',
      database: 'gitnexus',
      collection: 'embedding_chunks',
    });
    const diagnostics = JSON.stringify(storageConfigDiagnostics(config));
    expect(diagnostics).toContain('graph.local:7071');
    expect(diagnostics).toContain('vector.local:27017');
    expect(diagnostics).not.toContain('graph-secret');
    expect(diagnostics).not.toContain('vector-secret');
  });

  it('registers additional providers without adding selection branches', async () => {
    const graph = {
      queryCapabilities: { gitnexusCypher: 'v1', rawQueryLanguage: 'custom-cypher' },
      query: async () => [],
      close: async () => {},
    } as unknown as GraphStore & {
      queryCapabilities: { gitnexusCypher: 'v1'; rawQueryLanguage: string };
      close(): Promise<void>;
    };
    const vector = { close: async () => {} } as unknown as VectorStore & {
      close(): Promise<void>;
    };
    const unregisterGraph = registerGraphStoreProvider('custom-graph', (config) => {
      expect(config.options).toEqual({ cluster: 'east' });
      return graph;
    });
    const unregisterVector = registerVectorStoreProvider('custom-vector', (config) => {
      expect(config.options).toEqual({ index: 'embeddings-v2' });
      return vector;
    });

    try {
      const config = resolveStorageConfig({
        GITNEXUS_GRAPH_PROVIDER: 'custom-graph',
        GITNEXUS_GRAPH_URI: 'custom+tcp://graph-user:graph-secret@graph.local:7610',
        GITNEXUS_GRAPH_OPTIONS: '{"cluster":"east"}',
        GITNEXUS_VECTOR_PROVIDER: 'custom-vector',
        GITNEXUS_VECTOR_URI: 'custom+tcp://vector-user:vector-secret@vector.local:7810',
        GITNEXUS_VECTOR_OPTIONS: '{"index":"embeddings-v2"}',
      });
      const diagnostics = JSON.stringify(storageConfigDiagnostics(config));
      expect(diagnostics).not.toContain('graph-secret');
      expect(diagnostics).not.toContain('vector-secret');
      expect(diagnostics).not.toContain('east');
      expect(diagnostics).not.toContain('embeddings-v2');

      const providers = createSplitStorageProviders(config, { dimensions: 3 });
      expect(providers.identity).toEqual({ graph: 'custom-graph', vector: 'custom-vector' });
      expect(providers.graph).toBe(graph);
      expect(providers.vector).toBe(vector);
      await providers.close();
    } finally {
      unregisterVector();
      unregisterGraph();
    }
  });

  it('rejects graph adapters that do not declare the GitNexus query capability', () => {
    const graph = { close: async () => {} } as unknown as GraphStore & {
      close(): Promise<void>;
    };
    const unregisterGraph = registerGraphStoreProvider('raw-query-missing', () => graph);

    try {
      const config = resolveStorageConfig({
        GITNEXUS_GRAPH_PROVIDER: 'raw-query-missing',
        GITNEXUS_GRAPH_URI: 'custom+tcp://graph.local:7610',
        GITNEXUS_VECTOR_PROVIDER: 'postgresql',
        GITNEXUS_PGVECTOR_URL: 'postgresql://vector.local/gitnexus',
      });

      expect(() => createSplitStorageProviders(config, { dimensions: 3 })).toThrow(
        /raw-query-missing.*gitnexus-cypher-v1/i,
      );
    } finally {
      unregisterGraph();
    }
  });

  it('rejects unregistered provider IDs and malformed provider options', () => {
    expect(() =>
      resolveStorageConfig({
        GITNEXUS_GRAPH_PROVIDER: 'missing-graph',
        GITNEXUS_GRAPH_URI: 'custom+tcp://graph.local:7610',
      }),
    ).toThrow(/not registered/i);

    const register = registerVectorStoreProvider('bad-options-test', () => {
      throw new Error('factory should not run');
    });
    try {
      expect(() =>
        resolveStorageConfig({
          GITNEXUS_GRAPH_PROVIDER: 'neo4j',
          GITNEXUS_NEO4J_URI: 'neo4j://graph.local:7687',
          GITNEXUS_NEO4J_USERNAME: 'neo4j',
          GITNEXUS_NEO4J_PASSWORD: 'secret',
          GITNEXUS_VECTOR_PROVIDER: 'bad-options-test',
          GITNEXUS_VECTOR_URI: 'custom+tcp://vector.local:7810',
          GITNEXUS_VECTOR_OPTIONS: '[]',
        }),
      ).toThrow(/JSON object/i);
    } finally {
      register();
    }
  });

  it('preserves driver-native Neo4j routing and MongoDB replica and mongos seed lists', async () => {
    const config = resolveStorageConfig({
      GITNEXUS_NEO4J_URI: 'neo4j://router.local:7687',
      GITNEXUS_NEO4J_USERNAME: 'neo4j',
      GITNEXUS_NEO4J_PASSWORD: 'secret',
      GITNEXUS_VECTOR_PROVIDER: 'mongodb',
      GITNEXUS_MONGODB_URL:
        'mongodb://mongo-a.local:27017,mongo-b.local:27017/gitnexus?replicaSet=rs0',
    });
    const replicaClient = new MongoClient(config.vector.url);
    const mongosConfig = resolveStorageConfig({
      GITNEXUS_NEO4J_URI: 'neo4j://router.local:7687',
      GITNEXUS_NEO4J_USERNAME: 'neo4j',
      GITNEXUS_NEO4J_PASSWORD: 'secret',
      GITNEXUS_VECTOR_PROVIDER: 'mongodb',
      GITNEXUS_MONGODB_URL: 'mongodb://mongos-a.local:27017,mongos-b.local:27017/gitnexus',
    });
    const mongosClient = new MongoClient(mongosConfig.vector.url);
    try {
      expect(config.graph.uri).toBe('neo4j://router.local:7687');
      expect(replicaClient.options.replicaSet).toBe('rs0');
      expect(replicaClient.options.hosts.map((host) => host.toString())).toEqual([
        'mongo-a.local:27017',
        'mongo-b.local:27017',
      ]);
      expect(replicaClient.options.directConnection).toBe(false);
      expect(mongosClient.options.replicaSet).toBeUndefined();
      expect(mongosClient.options.hosts.map((host) => host.toString())).toEqual([
        'mongos-a.local:27017',
        'mongos-b.local:27017',
      ]);
      expect(mongosClient.options.directConnection).toBe(false);
    } finally {
      await Promise.all([replicaClient.close(), mongosClient.close()]);
    }
  });

  it('forces recovery when provider identity changes or generation is not ready', () => {
    const identity = { graph: 'neo4j', vector: 'postgresql' };
    const ready = {
      state: 'ready',
      graphProvider: 'neo4j',
      vectorProvider: 'postgresql',
    } as const;

    expect(evaluateSplitStorageMigration(ready, identity)).toEqual({
      rebuild: false,
      resetVector: false,
      graphProviderChanged: false,
      vectorProviderChanged: false,
    });
    expect(
      evaluateSplitStorageMigration(ready, { graph: 'tugraph', vector: 'postgresql' }),
    ).toEqual({
      rebuild: true,
      resetVector: false,
      graphProviderChanged: true,
      vectorProviderChanged: false,
    });
    expect(evaluateSplitStorageMigration(ready, { graph: 'neo4j', vector: 'mongodb' })).toEqual({
      rebuild: true,
      resetVector: true,
      graphProviderChanged: false,
      vectorProviderChanged: true,
    });
    expect(evaluateSplitStorageMigration({ ...ready, state: 'writing' }, identity)).toMatchObject({
      rebuild: true,
      resetVector: true,
    });
    expect(evaluateSplitStorageMigration(undefined, identity)).toMatchObject({
      rebuild: true,
      resetVector: true,
    });
  });

  it('clears commit freshness until a split generation is ready', () => {
    const meta = {
      repoPath: '/repo',
      lastCommit: 'abc123',
      indexedAt: '2026-10-07T00:00:00.000Z',
    } satisfies RepoMeta;
    const identity = { graph: 'tugraph', vector: 'mongodb' };

    const writing = stampSplitStorageGeneration(meta, identity, 'writing');
    expect(writing.lastCommit).toBe('');
    expect(writing.splitStorage).toEqual({
      state: 'writing',
      graphProvider: 'tugraph',
      vectorProvider: 'mongodb',
    });
    expect(stampSplitStorageGeneration(writing, identity, 'failed').lastCommit).toBe('');
    expect(stampSplitStorageGeneration(writing, identity, 'ready').lastCommit).toBe('');
    expect(stampSplitStorageGeneration(meta, identity, 'ready').lastCommit).toBe('abc123');
  });
});
