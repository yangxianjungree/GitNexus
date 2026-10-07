import { MongoClient, type Collection, type Document } from 'mongodb';
import {
  createStorageScope,
  deterministicChunkId,
  type EmbeddingChunkRecord,
  type StorageScope,
  type StoreHealth,
  type VectorSearchHit,
  type VectorStore,
} from './contracts.js';
import type { StorageConfig } from './config.js';

interface MongoEmbeddingChunk extends Document {
  readonly _id: string;
  readonly repoId: string;
  readonly branchId: string;
  readonly chunkId: string;
  readonly nodeId: string;
  readonly chunkIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly embedding: readonly number[];
  readonly contentHash: string;
}

const vectorLiteral = (vector: readonly number[]): number[] => {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding vectors must contain finite numeric values');
  }
  return [...vector];
};

const normalizeChunk = (chunk: EmbeddingChunkRecord): EmbeddingChunkRecord => {
  if (chunk.id !== deterministicChunkId(chunk.nodeId, chunk.chunkIndex)) {
    throw new Error(`Embedding chunk ID does not match its node/chunk identity: ${chunk.nodeId}`);
  }
  if (!Number.isSafeInteger(chunk.startLine) || chunk.startLine < 0) {
    throw new Error('Embedding chunk startLine must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(chunk.endLine) || chunk.endLine < chunk.startLine) {
    throw new Error('Embedding chunk endLine must be a safe integer >= startLine');
  }
  vectorLiteral(chunk.vector);
  return chunk;
};

const validateScope = (scope: StorageScope): StorageScope =>
  createStorageScope(scope.repoId, scope.branchId);

const scopedDocumentId = (scope: StorageScope, chunkId: string): string =>
  `${encodeURIComponent(scope.repoId)}:${encodeURIComponent(scope.branchId)}:${encodeURIComponent(chunkId)}`;

/** MongoDB Atlas/Atlas Local adapter using the documented vectorSearch index and aggregation stage. */
export class MongoVectorStore implements VectorStore {
  private readonly client: MongoClient;
  private readonly database: string;
  private readonly collectionName: string;
  private readonly indexName: string;
  private readonly dimensions: number;
  private collection: Collection<MongoEmbeddingChunk> | undefined;
  private schemaReady: Promise<void> | undefined;

  constructor(
    config: StorageConfig['vector'],
    options: { readonly client?: MongoClient; readonly dimensions?: number } = {},
  ) {
    this.client = options.client ?? new MongoClient(config.url);
    this.database = config.database ?? 'gitnexus';
    this.collectionName = config.collection ?? 'embedding_chunks';
    this.indexName = config.index ?? 'gitnexus_embedding_vector';
    this.dimensions = options.dimensions ?? 384;
    if (!Number.isSafeInteger(this.dimensions) || this.dimensions <= 0) {
      throw new Error('MongoDB vector dimensions must be a positive safe integer');
    }
  }

  private async getCollection(): Promise<Collection<MongoEmbeddingChunk>> {
    await this.client.connect();
    if (!this.collection) {
      this.collection = this.client
        .db(this.database)
        .collection<MongoEmbeddingChunk>(this.collectionName);
    }
    return this.collection;
  }

  async initialize(): Promise<void> {
    this.schemaReady ??= this.createSchema();
    try {
      await this.schemaReady;
    } catch (error) {
      this.schemaReady = undefined;
      throw error;
    }
  }

  private async createSchema(): Promise<void> {
    const collection = await this.getCollection();
    const database = this.client.db(this.database);
    await database.createCollection(this.collectionName).catch((error: unknown) => {
      if ((error as { code?: number }).code !== 48) throw error;
    });
    await collection.createIndex({ repoId: 1, branchId: 1, nodeId: 1 });

    const searchIndexes = await collection.listSearchIndexes(this.indexName).toArray();
    if (searchIndexes.some((index) => index.name === this.indexName)) return;
    await collection.createSearchIndex({
      name: this.indexName,
      type: 'vectorSearch',
      definition: {
        fields: [
          {
            type: 'vector',
            path: 'embedding',
            numDimensions: this.dimensions,
            similarity: 'cosine',
          },
          { type: 'filter', path: 'repoId' },
          { type: 'filter', path: 'branchId' },
        ],
      },
    });
  }

  async health(): Promise<StoreHealth> {
    try {
      await this.client.connect();
      await this.client.db(this.database).command({ ping: 1 });
      return { provider: 'mongodb', status: 'available' };
    } catch {
      return {
        provider: 'mongodb',
        status: 'unavailable',
        message: 'Could not connect to the MongoDB vector store.',
      };
    }
  }

  async upsertChunks(scope: StorageScope, chunks: readonly EmbeddingChunkRecord[]): Promise<void> {
    scope = validateScope(scope);
    if (chunks.length === 0) return;
    await this.initialize();
    const collection = await this.getCollection();
    await collection.bulkWrite(
      chunks.map((rawChunk) => {
        const chunk = normalizeChunk(rawChunk);
        if (chunk.vector.length !== this.dimensions) {
          throw new Error(
            `Embedding vector dimensions mismatch: expected ${this.dimensions}, got ${chunk.vector.length}`,
          );
        }
        const document: MongoEmbeddingChunk = {
          _id: scopedDocumentId(scope, chunk.id),
          repoId: scope.repoId,
          branchId: scope.branchId,
          chunkId: chunk.id,
          nodeId: chunk.nodeId,
          chunkIndex: chunk.chunkIndex,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          embedding: vectorLiteral(chunk.vector),
          contentHash: chunk.contentHash,
        };
        return {
          updateOne: {
            filter: { _id: document._id },
            update: { $set: document },
            upsert: true,
          },
        };
      }),
    );
  }

  async deleteAllChunks(scope: StorageScope): Promise<void> {
    scope = validateScope(scope);
    await this.initialize();
    await (
      await this.getCollection()
    ).deleteMany({ repoId: scope.repoId, branchId: scope.branchId });
  }

  async deleteChunks(scope: StorageScope, ids: readonly string[]): Promise<void> {
    scope = validateScope(scope);
    if (ids.length === 0) return;
    await this.initialize();
    await (
      await this.getCollection()
    ).deleteMany({
      repoId: scope.repoId,
      branchId: scope.branchId,
      chunkId: { $in: ids },
    });
  }

  async deleteChunksForNodes(scope: StorageScope, nodeIds: readonly string[]): Promise<void> {
    scope = validateScope(scope);
    if (nodeIds.length === 0) return;
    await this.initialize();
    await (
      await this.getCollection()
    ).deleteMany({
      repoId: scope.repoId,
      branchId: scope.branchId,
      nodeId: { $in: nodeIds },
    });
  }

  async getContentHashes(
    scope: StorageScope,
    nodeIds: readonly string[],
  ): Promise<Map<string, string>> {
    scope = validateScope(scope);
    if (nodeIds.length === 0) return new Map();
    await this.initialize();
    const rows = await (await this.getCollection())
      .find(
        { repoId: scope.repoId, branchId: scope.branchId, nodeId: { $in: nodeIds } },
        { projection: { nodeId: 1, contentHash: 1 } },
      )
      .toArray();
    const hashes = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const row of rows) {
      if (ambiguous.has(row.nodeId)) continue;
      const previous = hashes.get(row.nodeId);
      if (previous !== undefined && previous !== row.contentHash) {
        hashes.delete(row.nodeId);
        ambiguous.add(row.nodeId);
      } else if (previous === undefined) {
        hashes.set(row.nodeId, row.contentHash);
      }
    }
    return hashes;
  }

  async searchNearest(
    scope: StorageScope,
    vector: readonly number[],
    options: { readonly limit: number; readonly maxDistance: number },
  ): Promise<VectorSearchHit[]> {
    scope = validateScope(scope);
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new Error('Vector search limit must be a positive safe integer');
    }
    if (
      !Number.isFinite(options.maxDistance) ||
      options.maxDistance < 0 ||
      options.maxDistance > 2
    ) {
      throw new Error('Vector maxDistance must be between 0 and 2');
    }
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Embedding vector dimensions mismatch: expected ${this.dimensions}, got ${vector.length}`,
      );
    }
    await this.initialize();
    const candidates = Math.max(options.limit * 10, 100);
    const rows = await (
      await this.getCollection()
    )
      .aggregate<MongoEmbeddingChunk & { readonly score?: number }>([
        {
          $vectorSearch: {
            index: this.indexName,
            path: 'embedding',
            queryVector: vectorLiteral(vector),
            numCandidates: candidates,
            limit: options.limit,
            filter: { repoId: scope.repoId, branchId: scope.branchId },
          },
        },
        {
          $project: {
            nodeId: 1,
            chunkIndex: 1,
            startLine: 1,
            endLine: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ])
      .toArray();
    return rows
      .map((row) => ({
        nodeId: row.nodeId,
        chunkIndex: row.chunkIndex,
        startLine: row.startLine,
        endLine: row.endLine,
        distance: 1 - Number(row.score ?? 0),
      }))
      .filter((row) => row.distance < options.maxDistance);
  }

  async countChunks(scope: StorageScope): Promise<number> {
    scope = validateScope(scope);
    await this.initialize();
    return (await this.getCollection()).countDocuments({
      repoId: scope.repoId,
      branchId: scope.branchId,
    });
  }

  async close(): Promise<void> {
    await this.client.close();
    this.collection = undefined;
    this.schemaReady = undefined;
  }
}
