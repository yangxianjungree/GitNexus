import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import {
  createStorageScope,
  deterministicChunkId,
  type GraphNodeRecord,
} from '../../src/core/storage/contracts.js';
import { resolveStorageConfig } from '../../src/core/storage/config.js';
import { createSplitStorageProviders } from '../../src/core/storage/providers.js';

const enabled = process.env.GITNEXUS_ALTERNATIVE_STORAGE_E2E === '1';

const vector = (hotIndex: number): number[] => {
  const values = new Array<number>(EMBEDDING_DIMS).fill(0);
  values[hotIndex] = 1;
  return values;
};

const nodes: GraphNodeRecord[] = [
  {
    id: 'Function:alternative.ts:caller',
    label: 'Function',
    properties: { name: 'caller', filePath: 'alternative.ts', startLine: 0, endLine: 2 },
  },
  {
    id: 'Function:alternative.ts:callee',
    label: 'Function',
    properties: { name: 'callee', filePath: 'alternative.ts', startLine: 4, endLine: 6 },
  },
];

describe.skipIf(!enabled)('alternative graph and vector services', () => {
  it('writes and reads isolated TuGraph and MongoDB records', async () => {
    const providers = createSplitStorageProviders(resolveStorageConfig(), {
      dimensions: EMBEDDING_DIMS,
    });
    const first = createStorageScope(`alternative-${process.pid}`, 'main');
    const second = createStorageScope(`alternative-${process.pid}-other`, 'main');
    const firstChunk = {
      id: deterministicChunkId(nodes[0].id, 0),
      nodeId: nodes[0].id,
      chunkIndex: 0,
      startLine: 0,
      endLine: 2,
      vector: vector(0),
      contentHash: 'alternative-caller-v1',
    };

    try {
      expect(providers.identity).toEqual({ graph: 'tugraph', vector: 'mongodb' });
      expect(providers.graph.queryCapabilities).toEqual({
        gitnexusCypher: 'v1',
        rawQueryLanguage: 'tugraph-opencypher',
      });
      await expect(providers.graph.health()).resolves.toMatchObject({
        provider: 'tugraph',
        status: 'available',
      });
      await expect(providers.vector.health()).resolves.toMatchObject({
        provider: 'mongodb',
        status: 'available',
      });

      await providers.graph.deleteAll(first);
      await providers.vector.deleteAllChunks(first);
      await providers.graph.deleteAll(second);
      await providers.vector.deleteAllChunks(second);

      await providers.graph.upsertNodes(first, nodes);
      await providers.graph.upsertRelationships(first, [
        {
          id: 'CALLS:alternative-caller->callee',
          sourceId: nodes[0].id,
          targetId: nodes[1].id,
          type: 'CALLS',
          properties: { confidence: 1 },
        },
      ]);
      await providers.vector.upsertChunks(first, [firstChunk]);
      await providers.vector.upsertChunks(second, [
        { ...firstChunk, contentHash: 'other-repo-v1' },
      ]);

      const graphRows = await providers.graph.query(
        first,
        `MATCH (source:GitNexusNode)-[r:CodeRelation]->(target:GitNexusNode)
         WHERE source.repoId = $repoId AND source.branchId = $branchId AND source.id = $sourceId
           AND target.repoId = $repoId AND target.branchId = $branchId AND target.id = $targetId
           AND r.type = $type
         RETURN source.id AS sourceId, target.id AS targetId, r.type AS type`,
        { sourceId: nodes[0].id, targetId: nodes[1].id, type: 'CALLS' },
      );
      expect(graphRows).toEqual([{ sourceId: nodes[0].id, targetId: nodes[1].id, type: 'CALLS' }]);
      expect(await providers.vector.countChunks(first)).toBe(1);
      expect(await providers.vector.countChunks(second)).toBe(1);
      expect(
        (await providers.vector.searchNearest(first, vector(0), { limit: 1, maxDistance: 2 }))[0],
      ).toMatchObject({
        nodeId: nodes[0].id,
        chunkIndex: 0,
      });
    } finally {
      await providers.graph.deleteAll(first).catch(() => undefined);
      await providers.vector.deleteAllChunks(first).catch(() => undefined);
      await providers.graph.deleteAll(second).catch(() => undefined);
      await providers.vector.deleteAllChunks(second).catch(() => undefined);
      await providers.close();
    }
  }, 120_000);
});
