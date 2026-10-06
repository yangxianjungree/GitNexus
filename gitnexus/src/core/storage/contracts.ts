/**
 * Provider-neutral boundaries for the split graph, vector, and text stores.
 *
 * Every operation carries a repository + branch scope. Implementations must
 * apply both values to reads and writes so that two repositories (or two
 * branches of one repository) cannot see or delete each other's index rows.
 */

export interface StorageScope {
  readonly repoId: string;
  readonly branchId: string;
}

export const createStorageScope = (repoId: string, branchId: string): StorageScope => {
  const normalizedRepoId = repoId.trim();
  const normalizedBranchId = branchId.trim();
  if (!normalizedRepoId) throw new Error('Storage scope repoId must not be empty');
  if (!normalizedBranchId) throw new Error('Storage scope branchId must not be empty');
  return Object.freeze({ repoId: normalizedRepoId, branchId: normalizedBranchId });
};

/** Stable across retries and independent of which database stores the chunk. */
export const deterministicChunkId = (nodeId: string, chunkIndex: number): string => {
  if (!nodeId.trim()) throw new Error('Embedding chunk nodeId must not be empty');
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('Embedding chunk chunkIndex must be a non-negative safe integer');
  }
  return `chunk:${encodeURIComponent(nodeId)}:${chunkIndex}`;
};

export interface GraphNodeRecord {
  readonly id: string;
  readonly label: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface GraphRelationshipRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface EmbeddingChunkRecord {
  /** Usually deterministicChunkId(nodeId, chunkIndex). */
  readonly id: string;
  readonly nodeId: string;
  readonly chunkIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly vector: readonly number[];
  readonly contentHash: string;
}

export interface VectorSearchHit {
  readonly nodeId: string;
  readonly chunkIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  /** Cosine distance, in the same [0, 2] range used by semantic search today. */
  readonly distance: number;
}

export interface TextSearchDocument {
  readonly nodeId: string;
  readonly name: string;
  readonly filePath: string;
  readonly searchableText: string;
}

export interface TextSearchHit {
  readonly nodeId: string;
  readonly score: number;
  readonly startLine?: number;
  readonly endLine?: number;
}

export type StoreHealthStatus = 'available' | 'degraded' | 'unavailable';

export interface StoreHealth {
  readonly provider: 'neo4j' | 'postgresql';
  readonly status: StoreHealthStatus;
  /** Safe, user-facing explanation. It must never include connection credentials. */
  readonly message?: string;
}

/** Cross-store indexing is not one transaction; callers persist this state to detect partial runs. */
export type IndexGenerationState = 'not-started' | 'writing' | 'ready' | 'failed';

export interface GraphStore {
  health(): Promise<StoreHealth>;
  upsertNodes(scope: StorageScope, nodes: readonly GraphNodeRecord[]): Promise<void>;
  upsertRelationships(
    scope: StorageScope,
    relationships: readonly GraphRelationshipRecord[],
  ): Promise<void>;
  getNodesByIds(scope: StorageScope, ids: readonly string[]): Promise<GraphNodeRecord[]>;
  deleteNodes(scope: StorageScope, ids: readonly string[]): Promise<void>;
}

export interface VectorStore {
  health(): Promise<StoreHealth>;
  upsertChunks(scope: StorageScope, chunks: readonly EmbeddingChunkRecord[]): Promise<void>;
  deleteChunks(scope: StorageScope, ids: readonly string[]): Promise<void>;
  deleteChunksForNodes(scope: StorageScope, nodeIds: readonly string[]): Promise<void>;
  getContentHashes(scope: StorageScope, nodeIds: readonly string[]): Promise<Map<string, string>>;
  searchNearest(
    scope: StorageScope,
    vector: readonly number[],
    options: { readonly limit: number; readonly maxDistance: number },
  ): Promise<VectorSearchHit[]>;
  countChunks(scope: StorageScope): Promise<number>;
}

export interface TextSearchStore {
  health(): Promise<StoreHealth>;
  upsertDocuments(scope: StorageScope, documents: readonly TextSearchDocument[]): Promise<void>;
  deleteDocuments(scope: StorageScope, nodeIds: readonly string[]): Promise<void>;
  search(scope: StorageScope, query: string, limit: number): Promise<TextSearchHit[]>;
}
