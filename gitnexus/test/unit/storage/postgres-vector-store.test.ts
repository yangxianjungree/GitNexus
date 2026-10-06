import { describe, expect, it } from 'vitest';
import { deterministicChunkId, type StorageScope } from '../../../src/core/storage/contracts.js';
import { PostgresVectorStore } from '../../../src/core/storage/postgres-vector-store.js';
import type { Pool } from 'pg';

interface QueryCall {
  readonly text: string;
  readonly values?: readonly unknown[];
}

class FakePostgresPool {
  readonly calls: QueryCall[] = [];
  readonly directCalls: QueryCall[] = [];

  private rowsFor(text: string) {
    if (text.includes('COUNT(*)::text')) return [{ count: '3' }];
    if (text.includes('MIN(content_hash)')) {
      return [{ node_id: 'Function:src/a.ts:run', content_hash: 'hash-a' }];
    }
    if (text.includes('WITH nearest AS MATERIALIZED')) {
      return [
        {
          node_id: 'Function:src/a.ts:run',
          chunk_index: 1,
          start_line: 12,
          end_line: 19,
          distance: '0.125',
        },
      ];
    }
    return [];
  }

  async query(text: string, values?: readonly unknown[]) {
    this.directCalls.push({ text, values });
    return { rows: this.rowsFor(text) };
  }

  async connect() {
    return {
      query: async (text: string, values?: readonly unknown[]) => {
        this.calls.push({ text, values });
        return { rows: this.rowsFor(text) };
      },
      release: () => undefined,
    };
  }

  async end() {}
}

const scope: StorageScope = { repoId: 'repo-alpha', branchId: 'feature/vector' };
const config = { url: 'postgresql://localhost/gitnexus', schema: 'gitnexus_test' };

const makeStore = (pool: FakePostgresPool) =>
  new PostgresVectorStore(config, { pool: pool as unknown as Pool, dimensions: 3 });

describe('PostgresVectorStore', () => {
  it('creates a scoped pgvector schema and idempotently upserts stable chunk IDs', async () => {
    const pool = new FakePostgresPool();
    const store = makeStore(pool);
    const chunk = {
      id: deterministicChunkId('Function:src/a.ts:run', 0),
      nodeId: 'Function:src/a.ts:run',
      chunkIndex: 0,
      startLine: 1,
      endLine: 9,
      vector: [0.1, 0.2, 0.3],
      contentHash: 'hash-a',
    };

    await store.upsertChunks(scope, [chunk]);

    const insert = pool.calls.find((call) => call.text.includes('ON CONFLICT'));
    expect(insert?.values).toEqual([
      'repo-alpha',
      'feature/vector',
      chunk.id,
      chunk.nodeId,
      0,
      1,
      9,
      '[0.1,0.2,0.3]',
      'hash-a',
    ]);
    expect(insert?.text).toContain('ON CONFLICT (repo_id, branch_id, chunk_id) DO UPDATE');
    expect(pool.calls.filter((call) => call.text.includes('CREATE INDEX'))).toHaveLength(2);
    await store.close();
  });

  it('scopes deletes, hashes, counts, and nearest-neighbor search to repo and branch', async () => {
    const pool = new FakePostgresPool();
    const store = makeStore(pool);

    await store.deleteChunksForNodes(scope, ['Function:src/a.ts:run']);
    const hashes = await store.getContentHashes(scope, ['Function:src/a.ts:run']);
    const count = await store.countChunks(scope);
    const hits = await store.searchNearest(scope, [0.1, 0.2, 0.3], { limit: 5, maxDistance: 0.4 });

    const scopedCalls = [...pool.directCalls, ...pool.calls].filter((call) =>
      /FROM .*gitnexus_embedding_chunks/.test(call.text),
    );
    expect(scopedCalls).toHaveLength(4);
    for (const call of scopedCalls) {
      expect(call.text).toMatch(/repo_id\s*=\s*\$1/);
      expect(call.text).toMatch(/branch_id\s*=\s*\$2/);
      expect(call.values?.[0]).toBe('repo-alpha');
      expect(call.values?.[1]).toBe('feature/vector');
    }
    expect(
      pool.calls.some((call) => call.text.includes('SET LOCAL hnsw.iterative_scan = strict_order')),
    ).toBe(true);
    expect(pool.calls.some((call) => call.text.includes('WITH nearest AS MATERIALIZED'))).toBe(
      true,
    );
    expect(hashes.get('Function:src/a.ts:run')).toBe('hash-a');
    expect(count).toBe(3);
    expect(hits).toEqual([
      {
        nodeId: 'Function:src/a.ts:run',
        chunkIndex: 1,
        startLine: 12,
        endLine: 19,
        distance: 0.125,
      },
    ]);
    await store.close();
  });

  it('rejects a chunk identity or vector width that does not match the store contract', async () => {
    const pool = new FakePostgresPool();
    const store = makeStore(pool);

    await expect(
      store.upsertChunks(scope, [
        {
          id: 'chunk:wrong:0',
          nodeId: 'Function:src/a.ts:run',
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          vector: [0.1, 0.2, 0.3],
          contentHash: 'hash-a',
        },
      ]),
    ).rejects.toThrow(/chunk ID/);
    await expect(
      store.upsertChunks(scope, [
        {
          id: deterministicChunkId('Function:src/a.ts:run', 0),
          nodeId: 'Function:src/a.ts:run',
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          vector: [0.1, 0.2],
          contentHash: 'hash-a',
        },
      ]),
    ).rejects.toThrow(/dimensions mismatch/);
    await store.close();
  });

  it('uses an exact scan without an HNSW index above vector HNSW dimensions', async () => {
    const pool = new FakePostgresPool();
    const store = new PostgresVectorStore(config, {
      pool: pool as unknown as Pool,
      dimensions: 2_001,
    });

    await store.initialize();

    expect(pool.calls.some((call) => call.text.includes('embedding_hnsw_idx'))).toBe(false);
    expect(pool.calls.some((call) => call.text.includes('vector(2001)'))).toBe(true);
    await store.close();
  });

  it('rejects incomplete repo/branch scopes before running storage queries', async () => {
    const pool = new FakePostgresPool();
    const store = makeStore(pool);

    await expect(store.countChunks({ repoId: 'repo-alpha', branchId: ' ' })).rejects.toThrow(
      /branchId/,
    );
    expect(pool.calls).toHaveLength(0);
    await store.close();
  });
});
