import { Pool, type PoolConfig } from 'pg';
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

const DEFAULT_VECTOR_DIMENSIONS = 384;
const PGVECTOR_MAX_DIMENSIONS = 16_000;
const PGVECTOR_HNSW_VECTOR_MAX_DIMENSIONS = 2_000;
const DEFAULT_TABLE = 'gitnexus_embedding_chunks';

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const qualifiedTable = (schema: string): string =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(DEFAULT_TABLE)}`;

const vectorLiteral = (vector: readonly number[]): string => {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding vectors must contain finite numeric values');
  }
  return `[${vector.join(',')}]`;
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

/**
 * PostgreSQL + pgvector adapter. Rows are always addressed by repo/branch and
 * chunk ID, so retries are idempotent and deleting one branch cannot affect another.
 */
export class PostgresVectorStore implements VectorStore {
  private readonly pool: Pool;
  private readonly table: string;
  private readonly schema: string;
  private readonly dimensions: number;
  private schemaReady: Promise<void> | undefined;

  constructor(
    config: StorageConfig['vector'],
    options: { readonly pool?: Pool; readonly dimensions?: number } = {},
  ) {
    this.pool = options.pool ?? new Pool({ connectionString: config.url } satisfies PoolConfig);
    this.schema = config.schema;
    this.table = qualifiedTable(config.schema);
    this.dimensions = options.dimensions ?? DEFAULT_VECTOR_DIMENSIONS;
    if (
      !Number.isSafeInteger(this.dimensions) ||
      this.dimensions <= 0 ||
      this.dimensions > PGVECTOR_MAX_DIMENSIONS
    ) {
      throw new Error(`Vector dimensions must be between 1 and ${PGVECTOR_MAX_DIMENSIONS}`);
    }
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
    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          repo_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          chunk_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          start_line INTEGER NOT NULL CHECK (start_line >= 0),
          end_line INTEGER NOT NULL CHECK (end_line >= start_line),
          embedding vector(${this.dimensions}) NOT NULL,
          content_hash TEXT NOT NULL,
          PRIMARY KEY (repo_id, branch_id, chunk_id)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${DEFAULT_TABLE}_scope_node_idx`)}
          ON ${this.table} (repo_id, branch_id, node_id)
      `);
      if (this.dimensions <= PGVECTOR_HNSW_VECTOR_MAX_DIMENSIONS) {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${DEFAULT_TABLE}_embedding_hnsw_idx`)}
            ON ${this.table} USING hnsw (embedding vector_cosine_ops)
        `);
      }
    } finally {
      client.release();
    }
  }

  async health(): Promise<StoreHealth> {
    try {
      await this.pool.query('SELECT 1');
      return { provider: 'postgresql', status: 'available' };
    } catch {
      return {
        provider: 'postgresql',
        status: 'unavailable',
        message: 'Could not connect to the PostgreSQL vector store.',
      };
    }
  }

  async upsertChunks(scope: StorageScope, chunks: readonly EmbeddingChunkRecord[]): Promise<void> {
    scope = validateScope(scope);
    if (chunks.length === 0) return;
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const rawChunk of chunks) {
        const chunk = normalizeChunk(rawChunk);
        if (chunk.vector.length !== this.dimensions) {
          throw new Error(
            `Embedding vector dimensions mismatch: expected ${this.dimensions}, got ${chunk.vector.length}`,
          );
        }
        await client.query(
          `INSERT INTO ${this.table}
            (repo_id, branch_id, chunk_id, node_id, chunk_index, start_line, end_line, embedding, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)
           ON CONFLICT (repo_id, branch_id, chunk_id) DO UPDATE SET
             node_id = EXCLUDED.node_id,
             chunk_index = EXCLUDED.chunk_index,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             embedding = EXCLUDED.embedding,
             content_hash = EXCLUDED.content_hash`,
          [
            scope.repoId,
            scope.branchId,
            chunk.id,
            chunk.nodeId,
            chunk.chunkIndex,
            chunk.startLine,
            chunk.endLine,
            vectorLiteral(chunk.vector),
            chunk.contentHash,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteChunks(scope: StorageScope, ids: readonly string[]): Promise<void> {
    scope = validateScope(scope);
    if (ids.length === 0) return;
    await this.initialize();
    await this.pool.query(
      `DELETE FROM ${this.table} WHERE repo_id = $1 AND branch_id = $2 AND chunk_id = ANY($3::text[])`,
      [scope.repoId, scope.branchId, ids],
    );
  }

  async deleteChunksForNodes(scope: StorageScope, nodeIds: readonly string[]): Promise<void> {
    scope = validateScope(scope);
    if (nodeIds.length === 0) return;
    await this.initialize();
    await this.pool.query(
      `DELETE FROM ${this.table} WHERE repo_id = $1 AND branch_id = $2 AND node_id = ANY($3::text[])`,
      [scope.repoId, scope.branchId, nodeIds],
    );
  }

  async getContentHashes(
    scope: StorageScope,
    nodeIds: readonly string[],
  ): Promise<Map<string, string>> {
    scope = validateScope(scope);
    if (nodeIds.length === 0) return new Map();
    await this.initialize();
    const result = await this.pool.query<{ node_id: string; content_hash: string }>(
      `SELECT node_id, MIN(content_hash) AS content_hash FROM ${this.table}
       WHERE repo_id = $1 AND branch_id = $2 AND node_id = ANY($3::text[])
       GROUP BY node_id HAVING COUNT(DISTINCT content_hash) = 1`,
      [scope.repoId, scope.branchId, nodeIds],
    );
    return new Map(result.rows.map((row) => [row.node_id, row.content_hash]));
  }

  async searchNearest(
    scope: StorageScope,
    vector: readonly number[],
    options: { readonly limit: number; readonly maxDistance: number },
  ): Promise<VectorSearchHit[]> {
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
    scope = validateScope(scope);
    await this.initialize();
    const client = await this.pool.connect();
    let committed = false;
    let result;
    try {
      await client.query('BEGIN');
      if (this.dimensions <= PGVECTOR_HNSW_VECTOR_MAX_DIMENSIONS) {
        // Scope filtering happens after HNSW's initial scan. Iterative scans
        // continue until the filtered query has enough candidates or hits its cap.
        await client.query('SET LOCAL hnsw.iterative_scan = strict_order');
      }
      result = await client.query<{
        node_id: string;
        chunk_index: number;
        start_line: number;
        end_line: number;
        distance: number;
      }>(
        `WITH nearest AS MATERIALIZED (
           SELECT node_id, chunk_index, start_line, end_line,
                  embedding <=> $3::vector AS distance
           FROM ${this.table}
           WHERE repo_id = $1 AND branch_id = $2
           ORDER BY embedding <=> $3::vector
           LIMIT $4
         )
         SELECT node_id, chunk_index, start_line, end_line, distance
         FROM nearest
         WHERE distance < $5
         ORDER BY distance`,
        [scope.repoId, scope.branchId, vectorLiteral(vector), options.limit, options.maxDistance],
      );
      await client.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    return result.rows.map((row) => ({
      nodeId: row.node_id,
      chunkIndex: row.chunk_index,
      startLine: row.start_line,
      endLine: row.end_line,
      distance: Number(row.distance),
    }));
  }

  async countChunks(scope: StorageScope): Promise<number> {
    scope = validateScope(scope);
    await this.initialize();
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.table} WHERE repo_id = $1 AND branch_id = $2`,
      [scope.repoId, scope.branchId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
