import neo4j, { type Driver } from 'neo4j-driver';
import {
  createStorageScope,
  type GraphNodeRecord,
  type GraphRelationshipRecord,
  type QueryableGraphStore,
  type StorageScope,
  type StoreHealth,
} from './contracts.js';
import type { StorageConfig } from './config.js';

const GRAPH_BATCH_SIZE = 500;
const NODE_CONSTRAINT = 'gitnexus_node_scope_id_unique';
const GRAPH_RELATIONSHIP = 'CodeRelation';

const assertGraphIdentifier = (value: string, kind: 'label' | 'type'): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Neo4j graph ${kind} must be a simple identifier, got "${value}"`);
  }
  return value;
};

const chunksOf = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
};

const graphWriteCount = (value: unknown): number => {
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return Number((value as { toNumber(): number }).toNumber());
  }
  return Number(value ?? 0);
};

/**
 * Neo4j returns its integer values as driver objects. Normalize query rows at
 * the provider boundary so callers keep receiving the plain numbers and
 * records they received from LadybugDB.
 */
const normalizeNeo4jValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if ('toNumber' in value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber();
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normalizeNeo4jValue);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      normalizeNeo4jValue(nested),
    ]),
  );
};

/**
 * The split graph stores the semantic node kind in `n.kind` as well as a
 * Neo4j label. `GitNexusNode` is a technical label required by the composite
 * constraint, so labels(n)[0] is not a stable replacement for the old
 * LadybugDB projection. Keep existing graph query text usable in Neo4j by
 * translating that projection at the adapter boundary.
 */
const translateGraphQuery = (statement: string): string =>
  statement
    .replace(/labels\(([A-Za-z_][A-Za-z0-9_]*)\)\[0\]/g, '$1.kind')
    .replace(/labels\(([A-Za-z_][A-Za-z0-9_]*)\)\s*<>\s*'Community'/g, "$1.kind <> 'Community'");

/** Neo4j property values do not contain the adapter's repo/branch metadata. */
const withoutStorageMetadata = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const {
    id: _id,
    repoId: _repoId,
    branchId: _branchId,
    kind: _kind,
    ...properties
  } = value as Record<string, unknown>;
  return properties;
};

const neo4jPropertyValue = (
  value: unknown,
): string | number | boolean | string[] | number[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return value as string[];
    if (value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
      return value as number[];
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
};

const toNeo4jProperties = (value: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalized = neo4jPropertyValue(rawValue);
    if (normalized !== undefined) properties[key] = normalized;
  }
  return properties;
};

/**
 * Neo4j adapter for the code graph. Each node and relationship carries the
 * repository and branch that own it; all reads and deletes repeat that scope.
 */
export class Neo4jGraphStore implements QueryableGraphStore {
  readonly queryCapabilities = {
    gitnexusCypher: 'v1',
    rawQueryLanguage: 'neo4j-cypher',
  } as const;

  private readonly driver: Driver;
  private readonly database: string;
  private schemaReady: Promise<void> | undefined;

  constructor(config: StorageConfig['graph'], options: { readonly driver?: Driver } = {}) {
    this.driver =
      options.driver ??
      neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password));
    this.database = config.database;
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
    const session = this.driver.session({ database: this.database });
    try {
      await session.executeWrite((transaction) =>
        transaction.run(`
          CREATE CONSTRAINT ${NODE_CONSTRAINT} IF NOT EXISTS
          FOR (n:GitNexusNode)
          REQUIRE (n.repoId, n.branchId, n.id) IS UNIQUE
        `),
      );
    } finally {
      await session.close();
    }
  }

  async health(): Promise<StoreHealth> {
    try {
      await this.driver.verifyConnectivity();
      return { provider: 'neo4j', status: 'available' };
    } catch {
      return {
        provider: 'neo4j',
        status: 'unavailable',
        message: 'Could not connect to the Neo4j graph store.',
      };
    }
  }

  async query(
    scope: StorageScope,
    statement: string,
    parameters: Readonly<Record<string, unknown>> = {},
  ): Promise<Readonly<Record<string, unknown>>[]> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    if (!statement.includes('$repoId') || !statement.includes('$branchId')) {
      throw new Error(
        'Neo4j graph queries must include $repoId and $branchId predicates for scope isolation',
      );
    }
    await this.initialize();
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.executeRead((transaction) =>
        transaction.run(translateGraphQuery(statement), {
          ...parameters,
          repoId: scope.repoId,
          branchId: scope.branchId,
        }),
      );
      return result.records.map(
        (record) => normalizeNeo4jValue(record.toObject()) as Readonly<Record<string, unknown>>,
      );
    } finally {
      await session.close();
    }
  }

  async upsertNodes(scope: StorageScope, nodes: readonly GraphNodeRecord[]): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    const grouped = new Map<string, GraphNodeRecord[]>();
    for (const node of nodes) {
      const label = assertGraphIdentifier(node.label, 'label');
      const group = grouped.get(label) ?? [];
      group.push(node);
      grouped.set(label, group);
    }
    if (grouped.size === 0) return;

    await this.initialize();
    const session = this.driver.session({ database: this.database });
    try {
      for (const [label, rows] of grouped) {
        const query = `
          UNWIND $rows AS row
          MERGE (n:GitNexusNode {repoId: $repoId, branchId: $branchId, id: row.id})
          SET n:\`${label}\`, n += row.properties,
              n.id = row.id, n.repoId = $repoId, n.branchId = $branchId, n.kind = $kind
        `;
        for (const batch of chunksOf(rows, GRAPH_BATCH_SIZE)) {
          await session.executeWrite((transaction) =>
            transaction.run(query, {
              repoId: scope.repoId,
              branchId: scope.branchId,
              kind: label,
              rows: batch.map(({ id, properties }) => ({
                id,
                properties: toNeo4jProperties(properties),
              })),
            }),
          );
        }
      }
    } finally {
      await session.close();
    }
  }

  async upsertRelationships(
    scope: StorageScope,
    relationships: readonly GraphRelationshipRecord[],
  ): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    for (const relationship of relationships) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relationship.type)) {
        throw new Error(
          `Neo4j graph relationship type must be a simple identifier, got "${relationship.type}"`,
        );
      }
    }
    if (relationships.length === 0) return;

    await this.initialize();
    const session = this.driver.session({ database: this.database });
    try {
      const query = `
        UNWIND $rows AS row
        MATCH (source:GitNexusNode {repoId: $repoId, branchId: $branchId, id: row.sourceId})
        MATCH (target:GitNexusNode {repoId: $repoId, branchId: $branchId, id: row.targetId})
        MERGE (source)-[r:${GRAPH_RELATIONSHIP} {repoId: $repoId, branchId: $branchId, id: row.id}]->(target)
        SET r += row.properties,
            r.id = row.id, r.type = row.type, r.repoId = $repoId, r.branchId = $branchId
        RETURN count(r) AS written
      `;
      for (const batch of chunksOf(relationships, GRAPH_BATCH_SIZE)) {
        await session.executeWrite(async (transaction) => {
          const result = await transaction.run(query, {
            repoId: scope.repoId,
            branchId: scope.branchId,
            rows: batch.map(({ id, sourceId, targetId, type, properties }) => ({
              id,
              sourceId,
              targetId,
              type,
              properties: toNeo4jProperties(properties),
            })),
          });
          const written = result.records.reduce(
            (sum, record) => sum + graphWriteCount(record.get('written')),
            0,
          );
          if (written !== batch.length) {
            throw new Error(
              `Neo4j stored ${written} of ${batch.length} relationships; one or more scoped endpoints are missing`,
            );
          }
        });
      }
    } finally {
      await session.close();
    }
  }

  async getNodesByIds(scope: StorageScope, ids: readonly string[]): Promise<GraphNodeRecord[]> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    if (ids.length === 0) return [];
    await this.initialize();
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.executeRead((transaction) =>
        transaction.run(
          `MATCH (n:GitNexusNode {repoId: $repoId, branchId: $branchId})
           WHERE n.id IN $ids
           RETURN n.id AS id, n.kind AS label, properties(n) AS properties
           ORDER BY n.id`,
          { repoId: scope.repoId, branchId: scope.branchId, ids },
        ),
      );
      return result.records.map((record) => ({
        id: String(record.get('id')),
        label: String(record.get('label')),
        properties: withoutStorageMetadata(normalizeNeo4jValue(record.get('properties'))),
      }));
    } finally {
      await session.close();
    }
  }

  async deleteAll(scope: StorageScope): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    await this.initialize();
    const session = this.driver.session({ database: this.database });
    try {
      await session.executeWrite((transaction) =>
        transaction.run(
          `MATCH (n:GitNexusNode {repoId: $repoId, branchId: $branchId}) DETACH DELETE n`,
          { repoId: scope.repoId, branchId: scope.branchId },
        ),
      );
    } finally {
      await session.close();
    }
  }

  async deleteNodes(scope: StorageScope, ids: readonly string[]): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    if (ids.length === 0) return;
    await this.initialize();
    const session = this.driver.session({ database: this.database });
    try {
      for (const batch of chunksOf(ids, GRAPH_BATCH_SIZE)) {
        await session.executeWrite((transaction) =>
          transaction.run(
            `MATCH (n:GitNexusNode {repoId: $repoId, branchId: $branchId})
             WHERE n.id IN $ids
             DETACH DELETE n`,
            { repoId: scope.repoId, branchId: scope.branchId, ids: batch },
          ),
        );
      }
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
