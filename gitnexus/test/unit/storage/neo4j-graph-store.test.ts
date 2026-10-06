import { describe, expect, it } from 'vitest';
import { Neo4jGraphStore } from '../../../src/core/storage/neo4j-graph-store.js';
import type {
  GraphNodeRecord,
  GraphRelationshipRecord,
  StorageScope,
} from '../../../src/core/storage/contracts.js';
import type { Driver } from 'neo4j-driver';

interface QueryCall {
  readonly text: string;
  readonly parameters: Record<string, unknown>;
}

class FakeNeo4jSession {
  readonly calls: QueryCall[] = [];
  closeCount = 0;
  writeCommits = 0;
  writeRollbacks = 0;

  constructor(private readonly relationshipWriteCount?: number) {}

  async run(text: string, parameters: Record<string, unknown> = {}) {
    this.calls.push({ text, parameters });
    if (text.includes('RETURN count(r) AS written')) {
      return {
        records: [
          {
            get: () => this.relationshipWriteCount ?? (parameters.rows as unknown[]).length,
          },
        ],
      };
    }
    if (text.includes('RETURN n.id AS id')) {
      return {
        records: [
          {
            get: (key: string) =>
              ({
                id: 'Function:src/a.ts:run',
                label: 'Function',
                properties: {
                  id: 'Function:src/a.ts:run',
                  repoId: 'repo-alpha',
                  branchId: 'feature/graph',
                  kind: 'Function',
                  name: 'run',
                  filePath: 'src/a.ts',
                },
              })[key],
          },
        ],
      };
    }
    return { records: [] };
  }

  async executeWrite<T>(work: (transaction: this) => Promise<T>): Promise<T> {
    try {
      const result = await work(this);
      this.writeCommits++;
      return result;
    } catch (error) {
      this.writeRollbacks++;
      throw error;
    }
  }

  async executeRead<T>(work: (transaction: this) => Promise<T>): Promise<T> {
    return work(this);
  }

  async close() {
    this.closeCount++;
  }
}

class FakeNeo4jDriver {
  readonly sessions: FakeNeo4jSession[] = [];
  verified = false;
  closed = false;
  relationshipWriteCount: number | undefined;

  session() {
    const session = new FakeNeo4jSession(this.relationshipWriteCount);
    this.sessions.push(session);
    return session;
  }

  async verifyConnectivity() {
    this.verified = true;
  }

  async close() {
    this.closed = true;
  }
}

const scope: StorageScope = { repoId: 'repo-alpha', branchId: 'feature/graph' };
const config = {
  uri: 'neo4j://localhost:7687',
  username: 'neo4j',
  password: 'secret',
  database: 'neo4j',
};

const source: GraphNodeRecord = {
  id: 'Function:src/a.ts:run',
  label: 'Function',
  properties: { name: 'run', filePath: 'src/a.ts' },
};
const target: GraphNodeRecord = {
  id: 'Class:src/a.ts:Runner',
  label: 'Class',
  properties: { name: 'Runner', filePath: 'src/a.ts' },
};
const relationship: GraphRelationshipRecord = {
  id: 'CALLS:Function:src/a.ts:run->Class:src/a.ts:Runner',
  sourceId: source.id,
  targetId: target.id,
  type: 'CALLS',
  properties: { confidence: 1 },
};

const makeStore = (driver: FakeNeo4jDriver) =>
  new Neo4jGraphStore(config, { driver: driver as unknown as Driver });

describe('Neo4jGraphStore', () => {
  it('writes nodes with repository and branch identity and groups by validated labels', async () => {
    const driver = new FakeNeo4jDriver();
    const store = makeStore(driver);

    await store.upsertNodes(scope, [source, target]);

    const calls = driver.sessions.flatMap((session) => session.calls);
    expect(
      calls.some((call) => call.text.includes('CREATE CONSTRAINT gitnexus_node_scope_id_unique')),
    ).toBe(true);
    const nodeWrites = calls.filter((call) => call.text.includes('UNWIND $rows AS row'));
    expect(nodeWrites).toHaveLength(2);
    for (const call of nodeWrites) {
      expect(call.parameters).toMatchObject({ repoId: 'repo-alpha', branchId: 'feature/graph' });
    }
    expect(nodeWrites.some((call) => call.text.includes('SET n:`Function`'))).toBe(true);
    expect(nodeWrites.some((call) => call.text.includes('SET n:`Class`'))).toBe(true);
    await store.close();
  });

  it('writes scoped relationships and hydrates nodes without storage metadata', async () => {
    const driver = new FakeNeo4jDriver();
    const store = makeStore(driver);

    await store.upsertRelationships(scope, [relationship]);
    const nodes = await store.getNodesByIds(scope, [source.id]);

    const calls = driver.sessions.flatMap((session) => session.calls);
    const relationshipWrite = calls.find((call) =>
      call.text.includes('RETURN count(r) AS written'),
    );
    expect(relationshipWrite?.parameters).toMatchObject({
      repoId: 'repo-alpha',
      branchId: 'feature/graph',
    });
    expect(relationshipWrite?.text).toContain('MERGE (source)-[r:`CALLS`');
    expect(nodes).toEqual([
      {
        id: source.id,
        label: 'Function',
        properties: { name: 'run', filePath: 'src/a.ts' },
      },
    ]);
    await store.close();
  });

  it('rolls back a partial relationship batch when a scoped endpoint is missing', async () => {
    const driver = new FakeNeo4jDriver();
    driver.relationshipWriteCount = 0;
    const store = makeStore(driver);

    await expect(store.upsertRelationships(scope, [relationship])).rejects.toThrow(
      /stored 0 of 1 CALLS relationships/,
    );

    const relationshipSession = driver.sessions.at(-1);
    expect(relationshipSession?.writeCommits).toBe(0);
    expect(relationshipSession?.writeRollbacks).toBe(1);
    await store.close();
  });

  it('rejects untrusted labels, relationship types, and incomplete scope values', async () => {
    const driver = new FakeNeo4jDriver();
    const store = makeStore(driver);

    await expect(
      store.upsertNodes(scope, [{ ...source, label: 'Function) DELETE n //' }]),
    ).rejects.toThrow(/label/);
    await expect(
      store.upsertRelationships(scope, [{ ...relationship, type: 'CALLS] DELETE n //' }]),
    ).rejects.toThrow(/type/);
    await expect(
      store.deleteNodes({ repoId: 'repo-alpha', branchId: '' }, [source.id]),
    ).rejects.toThrow(/branchId/);
    expect(driver.sessions).toHaveLength(0);
    await store.close();
  });
});
