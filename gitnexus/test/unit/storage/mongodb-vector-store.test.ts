import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import {
  createStorageScope,
  deterministicChunkId,
  type EmbeddingChunkRecord,
  type StorageScope,
} from '../../../src/core/storage/contracts.js';
import { MongoVectorStore } from '../../../src/core/storage/mongodb-vector-store.js';

class FakeCursor<T> {
  constructor(private readonly rows: T[]) {}
  async toArray(): Promise<T[]> {
    return this.rows;
  }
}

class FakeCollection {
  readonly bulkWrites: unknown[] = [];
  readonly deletes: unknown[] = [];
  readonly aggregates: unknown[] = [];
  searchIndexes: Array<{ name: string }> = [];
  aggregateRows: unknown[] = [];
  findRows: unknown[] = [];
  count = 0;

  async createIndex(): Promise<void> {}
  listSearchIndexes(): FakeCursor<{ name: string }> {
    return new FakeCursor(this.searchIndexes);
  }
  async createSearchIndex(description: { name?: string }): Promise<string> {
    this.searchIndexes.push({ name: description.name ?? '' });
    return description.name ?? '';
  }
  async bulkWrite(operations: unknown[]): Promise<void> {
    this.bulkWrites.push(operations);
  }
  async deleteMany(filter: unknown): Promise<void> {
    this.deletes.push(filter);
  }
  find(filter?: { nodeId?: { $in?: string[] } }): {
    project: () => { toArray: () => Promise<unknown[]> };
    toArray: () => Promise<unknown[]>;
  } {
    const rows = filter?.nodeId?.$in
      ? this.findRows.filter((row) =>
          filter.nodeId?.$in?.includes(String((row as { nodeId?: unknown }).nodeId)),
        )
      : this.findRows;
    return {
      project: () => ({ toArray: async () => rows }),
      toArray: async () => rows,
    };
  }
  aggregate(pipeline: unknown[]): FakeCursor<unknown> {
    this.aggregates.push(pipeline);
    return new FakeCursor(this.aggregateRows);
  }
  async countDocuments(): Promise<number> {
    return this.count;
  }
}

class FakeDb {
  constructor(readonly collectionValue: FakeCollection) {}
  collection(): FakeCollection {
    return this.collectionValue;
  }
  async createCollection(): Promise<void> {}
  async command(): Promise<{ ok: number }> {
    return { ok: 1 };
  }
}

class FakeMongoClient {
  readonly collectionValue = new FakeCollection();
  readonly dbValue = new FakeDb(this.collectionValue);
  connected = 0;
  closed = 0;
  async connect(): Promise<this> {
    this.connected += 1;
    return this;
  }
  db(): FakeDb {
    return this.dbValue;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

const scope: StorageScope = createStorageScope('repo-alpha', 'feature/mongo');
const config = {
  provider: 'mongodb' as const,
  url: 'mongodb://localhost:27017',
  schema: 'public',
  database: 'gitnexus',
  collection: 'embedding_chunks',
  index: 'gitnexus_embedding_vector',
};

const chunk: EmbeddingChunkRecord = {
  id: deterministicChunkId('Function:src/a.ts:run', 0),
  nodeId: 'Function:src/a.ts:run',
  chunkIndex: 0,
  startLine: 1,
  endLine: 4,
  vector: [0.1, 0.2, 0.3],
  contentHash: 'hash-a',
};

describe('MongoVectorStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a vector index, upserts scoped chunks, and searches with scope filters', async () => {
    const client = new FakeMongoClient();
    const store = new MongoVectorStore(config, {
      client: client as unknown as MongoClient,
      dimensions: 3,
    });
    client.collectionValue.aggregateRows = [
      { nodeId: chunk.nodeId, chunkIndex: 0, startLine: 1, endLine: 4, score: 0.9 },
    ];

    await store.upsertChunks(scope, [chunk]);
    const hits = await store.searchNearest(scope, [0.1, 0.2, 0.3], {
      limit: 5,
      maxDistance: 2,
    });

    expect(client.collectionValue.bulkWrites).toHaveLength(1);
    expect(client.collectionValue.searchIndexes).toEqual([{ name: 'gitnexus_embedding_vector' }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      nodeId: chunk.nodeId,
      chunkIndex: 0,
      startLine: 1,
      endLine: 4,
    });
    expect(hits[0].distance).toBeCloseTo(0.1);
    const pipeline = client.collectionValue.aggregates[0] as Array<Record<string, unknown>>;
    expect(pipeline[0].$vectorSearch).toMatchObject({
      index: 'gitnexus_embedding_vector',
      filter: { repoId: 'repo-alpha', branchId: 'feature/mongo' },
    });
  });

  it('keeps content hashes with more than one chunk per node only when unambiguous', async () => {
    const client = new FakeMongoClient();
    const store = new MongoVectorStore(config, {
      client: client as unknown as MongoClient,
      dimensions: 3,
    });
    client.collectionValue.findRows = [
      { nodeId: chunk.nodeId, contentHash: 'hash-a' },
      { nodeId: 'Function:src/b.ts:run', contentHash: 'hash-b1' },
      { nodeId: 'Function:src/b.ts:run', contentHash: 'hash-b2' },
    ];

    await expect(store.getContentHashes(scope, [chunk.nodeId])).resolves.toEqual(
      new Map([[chunk.nodeId, 'hash-a']]),
    );
    await expect(store.getContentHashes(scope, ['Function:src/b.ts:run'])).resolves.toEqual(
      new Map(),
    );
  });
});
