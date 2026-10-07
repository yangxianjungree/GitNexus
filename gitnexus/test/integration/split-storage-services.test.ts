import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import {
  createStorageScope,
  deterministicChunkId,
  type GraphNodeRecord,
} from '../../src/core/storage/contracts.js';
import { resolveStorageConfig } from '../../src/core/storage/config.js';
import { createSplitStorageProviders } from '../../src/core/storage/providers.js';

const enabled = process.env.GITNEXUS_SPLIT_STORAGE_E2E === '1';

const vector = (hotIndex: number): number[] => {
  const values = new Array<number>(EMBEDDING_DIMS).fill(0);
  values[hotIndex] = 1;
  return values;
};

const nodes: GraphNodeRecord[] = [
  {
    id: 'Function:e2e.ts:caller',
    label: 'Function',
    properties: { name: 'caller', filePath: 'e2e.ts', startLine: 0, endLine: 2 },
  },
  {
    id: 'Function:e2e.ts:callee',
    label: 'Function',
    properties: { name: 'callee', filePath: 'e2e.ts', startLine: 4, endLine: 6 },
  },
];

describe.skipIf(!enabled)('split storage real services', () => {
  it('writes and reads isolated Neo4j graph and pgvector records', async () => {
    const providers = createSplitStorageProviders(resolveStorageConfig(), {
      dimensions: EMBEDDING_DIMS,
    });
    const first = createStorageScope(`e2e-${process.pid}`, 'main');
    const second = createStorageScope(`e2e-${process.pid}-other`, 'main');
    const firstChunk = {
      id: deterministicChunkId(nodes[0].id, 0),
      nodeId: nodes[0].id,
      chunkIndex: 0,
      startLine: 0,
      endLine: 2,
      vector: vector(0),
      contentHash: 'e2e-caller-v1',
    };
    const secondChunk = {
      id: deterministicChunkId(nodes[1].id, 0),
      nodeId: nodes[1].id,
      chunkIndex: 0,
      startLine: 4,
      endLine: 6,
      vector: vector(1),
      contentHash: 'e2e-callee-v1',
    };

    try {
      expect(providers.identity).toEqual({ graph: 'neo4j', vector: 'postgresql' });
      expect(providers.graph.queryCapabilities).toEqual({
        gitnexusCypher: 'v1',
        rawQueryLanguage: 'neo4j-cypher',
      });
      await expect(providers.graph.health()).resolves.toMatchObject({
        provider: 'neo4j',
        status: 'available',
      });
      await expect(providers.vector.health()).resolves.toMatchObject({
        provider: 'postgresql',
        status: 'available',
      });

      await providers.graph.deleteAll(first);
      await providers.vector.deleteAllChunks(first);
      await providers.graph.deleteAll(second);
      await providers.vector.deleteAllChunks(second);

      await providers.graph.upsertNodes(first, nodes);
      await providers.graph.upsertRelationships(first, [
        {
          id: 'CALLS:caller->callee',
          sourceId: nodes[0].id,
          targetId: nodes[1].id,
          type: 'CALLS',
          properties: { confidence: 1 },
        },
      ]);
      await providers.vector.upsertChunks(first, [firstChunk, secondChunk]);
      await providers.vector.upsertChunks(second, [
        { ...firstChunk, contentHash: 'other-repo-v1' },
      ]);

      const graphRows = await providers.graph.query(
        first,
        `MATCH (source:GitNexusNode {repoId: $repoId, branchId: $branchId, id: $sourceId})
           MATCH (target:GitNexusNode {repoId: $repoId, branchId: $branchId, id: $targetId})
           MATCH (source)-[r:CodeRelation]->(target)
           WHERE r.type = $type
           RETURN source.id AS sourceId, target.id AS targetId, r.type AS type`,
        { sourceId: nodes[0].id, targetId: nodes[1].id, type: 'CALLS' },
      );
      expect(graphRows).toEqual([{ sourceId: nodes[0].id, targetId: nodes[1].id, type: 'CALLS' }]);

      expect(await providers.vector.countChunks(first)).toBe(2);
      expect(await providers.vector.countChunks(second)).toBe(1);
      expect(await providers.vector.getContentHashes(first, [nodes[0].id])).toEqual(
        new Map([[nodes[0].id, 'e2e-caller-v1']]),
      );
      const hits = await providers.vector.searchNearest(first, vector(0), {
        limit: 2,
        maxDistance: 2,
      });
      expect(hits[0]).toMatchObject({ nodeId: nodes[0].id, chunkIndex: 0 });
      expect(await providers.graph.getNodesByIds(first, [nodes[0].id])).toHaveLength(1);
    } finally {
      await providers.graph.deleteAll(first).catch(() => undefined);
      await providers.vector.deleteAllChunks(first).catch(() => undefined);
      await providers.graph.deleteAll(second).catch(() => undefined);
      await providers.vector.deleteAllChunks(second).catch(() => undefined);
      await providers.close();
    }
  }, 120_000);
});
