import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const countChunksMock = vi.fn();
const searchNearestMock = vi.fn();
const getNodesByIdsMock = vi.fn();
const closeMock = vi.fn();

vi.mock('../../src/core/storage/providers.js', () => ({
  isSplitStorageEnabled: () => process.env.GITNEXUS_STORAGE_MODE === 'split',
  createSplitStorageProviders: () => ({
    vector: {
      countChunks: (...args: unknown[]) => countChunksMock(...args),
      searchNearest: (...args: unknown[]) => searchNearestMock(...args),
    },
    graph: { getNodesByIds: (...args: unknown[]) => getNodesByIdsMock(...args) },
    close: closeMock,
  }),
}));

vi.mock('../../src/core/storage/config.js', () => ({
  resolveStorageConfig: () => ({
    graph: {
      uri: 'neo4j://localhost:7687',
      username: 'neo4j',
      password: 'secret',
      database: 'neo4j',
    },
    vector: { url: 'postgresql://localhost:5432/gitnexus', schema: 'public' },
  }),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
  getEmbeddingDims: () => 3,
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

interface SemanticSearchable {
  semanticSearch(
    repo: { lbugPath: string; repoPath: string; branch?: string },
    query: string,
    limit: number,
  ): Promise<unknown[]>;
}

const repo = {
  lbugPath: '/tmp/gitnexus-split/lbug',
  repoPath: '/tmp/gitnexus-split/repo',
  branch: 'feature/search',
};

describe('LocalBackend semantic search with split storage', () => {
  beforeEach(() => {
    process.env.GITNEXUS_STORAGE_MODE = 'split';
    countChunksMock.mockReset();
    searchNearestMock.mockReset();
    getNodesByIdsMock.mockReset();
    closeMock.mockReset();
    countChunksMock.mockResolvedValue(2);
    searchNearestMock.mockResolvedValue([
      { nodeId: 'Function:src/a.ts:run', chunkIndex: 0, startLine: 2, endLine: 4, distance: 0.1 },
      { nodeId: 'Function:src/a.ts:run', chunkIndex: 1, startLine: 5, endLine: 6, distance: 0.2 },
      { nodeId: 'Class:src/a.ts:Runner', chunkIndex: 0, startLine: 8, endLine: 12, distance: 0.3 },
    ]);
    getNodesByIdsMock.mockResolvedValue([
      {
        id: 'Function:src/a.ts:run',
        label: 'Function',
        properties: { name: 'run', filePath: 'src/a.ts' },
      },
      {
        id: 'Class:src/a.ts:Runner',
        label: 'Class',
        properties: { name: 'Runner', filePath: 'src/a.ts' },
      },
    ]);
  });

  afterEach(() => {
    delete process.env.GITNEXUS_STORAGE_MODE;
  });

  it('searches pgvector, deduplicates chunks, and hydrates nodes from Neo4j', async () => {
    const backend = new LocalBackend();
    const result = await (backend as unknown as SemanticSearchable).semanticSearch(
      repo,
      'find runner',
      2,
    );

    expect(countChunksMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: '/tmp/gitnexus-split/repo', branchId: 'feature/search' }),
    );
    expect(searchNearestMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: '/tmp/gitnexus-split/repo', branchId: 'feature/search' }),
      [0.1, 0.2, 0.3],
      expect.objectContaining({ limit: 8 }),
    );
    expect(getNodesByIdsMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: '/tmp/gitnexus-split/repo', branchId: 'feature/search' }),
      ['Function:src/a.ts:run', 'Class:src/a.ts:Runner'],
    );
    expect(result).toEqual([
      {
        nodeId: 'Function:src/a.ts:run',
        name: 'run',
        type: 'Function',
        filePath: 'src/a.ts',
        distance: 0.1,
        startLine: 2,
        endLine: 4,
      },
      {
        nodeId: 'Class:src/a.ts:Runner',
        name: 'Runner',
        type: 'Class',
        filePath: 'src/a.ts',
        distance: 0.3,
        startLine: 8,
        endLine: 12,
      },
    ]);
  });
});
