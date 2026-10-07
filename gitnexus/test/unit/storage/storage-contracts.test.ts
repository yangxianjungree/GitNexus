import { describe, expect, it } from 'vitest';
import { createStorageScope, deterministicChunkId } from '../../../src/core/storage/contracts.js';
import {
  resolveStorageConfig,
  storageConfigDiagnostics,
} from '../../../src/core/storage/config.js';
import { isSplitStorageEnabled } from '../../../src/core/storage/providers.js';

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
});
