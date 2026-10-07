import {
  createStorageScope,
  type GraphNodeRecord,
  type GraphRelationshipRecord,
  type GraphStore,
  type StorageScope,
  type StoreHealth,
} from './contracts.js';
import type { StorageConfig } from './config.js';

const GRAPH_BATCH_SIZE = 500;

const chunksOf = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
};

const assertIdentifier = (value: string, kind: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`TuGraph ${kind} must be a simple identifier, got "${value}"`);
  }
  return value;
};

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      normalizeValue(nested),
    ]),
  );
};

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

const toProperties = (
  scope: StorageScope,
  id: string,
  kind: string,
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  ...properties,
  id,
  repoId: scope.repoId,
  branchId: scope.branchId,
  kind,
});

const translateGraphQuery = (statement: string): string =>
  statement
    .replace(/labels\(([A-Za-z_][A-Za-z0-9_]*)\)\[0\]/g, '$1.kind')
    .replace(/labels\(([A-Za-z_][A-Za-z0-9_]*)\)\s*<>\s*'Community'/g, "$1.kind <> 'Community'");

interface TuGraphResponse {
  readonly header?: readonly { readonly name?: string }[];
  readonly result?: readonly unknown[][];
  readonly error_message?: string;
}

/** TuGraph adapter using its documented HTTP login and OpenCypher endpoints. */
export class TuGraphGraphStore implements GraphStore {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly graph: string;
  private tokenPromise: Promise<string> | undefined;

  constructor(config: StorageConfig['graph']) {
    this.baseUrl = config.uri.replace(/\/$/, '');
    this.username = config.username;
    this.password = config.password;
    this.graph = config.database;
  }

  async initialize(): Promise<void> {
    await this.login();
  }

  private async login(): Promise<string> {
    this.tokenPromise ??= (async () => {
      const response = await fetch(`${this.baseUrl}/login`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ user: this.username, password: this.password }),
      });
      const payload = (await response.json().catch(() => ({}))) as { jwt?: unknown };
      if (!response.ok || typeof payload.jwt !== 'string' || !payload.jwt) {
        throw new Error(`TuGraph login failed with HTTP ${response.status}`);
      }
      return payload.jwt;
    })();
    try {
      return await this.tokenPromise;
    } catch (error) {
      this.tokenPromise = undefined;
      throw error;
    }
  }

  private async callCypher(
    statement: string,
    parameters: Readonly<Record<string, unknown>> = {},
  ): Promise<Readonly<Record<string, unknown>>[]> {
    const token = await this.login();
    const prefixedParameters = Object.fromEntries(
      Object.entries(parameters).map(([key, value]) => [
        key.startsWith('$') ? key : `$${key}`,
        value,
      ]),
    );
    const response = await fetch(`${this.baseUrl}/cypher`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        graph: this.graph,
        script: statement,
        parameters: prefixedParameters,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as TuGraphResponse;
    if (!response.ok || payload.error_message) {
      if (response.status === 401) this.tokenPromise = undefined;
      throw new Error(
        payload.error_message || `TuGraph Cypher request failed with HTTP ${response.status}`,
      );
    }
    const headers = payload.header ?? [];
    return (payload.result ?? []).map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [
          header.name ?? `column${index}`,
          normalizeValue(row[index]),
        ]),
      ),
    );
  }

  async health(): Promise<StoreHealth> {
    try {
      await this.callCypher('RETURN 1 AS ok');
      return { provider: 'tugraph', status: 'available' };
    } catch {
      return {
        provider: 'tugraph',
        status: 'unavailable',
        message: 'Could not connect to the TuGraph graph store.',
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
        'TuGraph graph queries must include $repoId and $branchId predicates for scope isolation',
      );
    }
    await this.initialize();
    return this.callCypher(translateGraphQuery(statement), {
      ...parameters,
      repoId: scope.repoId,
      branchId: scope.branchId,
    });
  }

  async upsertNodes(scope: StorageScope, nodes: readonly GraphNodeRecord[]): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    const grouped = new Map<string, GraphNodeRecord[]>();
    for (const node of nodes) {
      const label = assertIdentifier(node.label, 'node label');
      const rows = grouped.get(label) ?? [];
      rows.push(node);
      grouped.set(label, rows);
    }
    if (grouped.size === 0) return;
    await this.initialize();
    for (const [label, rows] of grouped) {
      const query = `
        UNWIND $rows AS row
        MERGE (n:GitNexusNode:\`${label}\` {
          repoId: $repoId, branchId: $branchId, id: row.id
        })
        SET n = row.properties
      `;
      for (const batch of chunksOf(rows, GRAPH_BATCH_SIZE)) {
        await this.callCypher(query, {
          repoId: scope.repoId,
          branchId: scope.branchId,
          rows: batch.map((node) => ({
            id: node.id,
            properties: toProperties(scope, node.id, label, node.properties),
          })),
        });
      }
    }
  }

  async upsertRelationships(
    scope: StorageScope,
    relationships: readonly GraphRelationshipRecord[],
  ): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    if (relationships.length === 0) return;
    await this.initialize();
    const query = `
      UNWIND $rows AS row
      MATCH (source:GitNexusNode {repoId: $repoId, branchId: $branchId, id: row.sourceId})
      MATCH (target:GitNexusNode {repoId: $repoId, branchId: $branchId, id: row.targetId})
      MERGE (source)-[r:CodeRelation {
        repoId: $repoId, branchId: $branchId, id: row.id
      }]->(target)
      SET r = row.properties
      RETURN count(r) AS written
    `;
    for (const batch of chunksOf(relationships, GRAPH_BATCH_SIZE)) {
      const rows = await this.callCypher(query, {
        repoId: scope.repoId,
        branchId: scope.branchId,
        rows: batch.map((relationship) => ({
          id: relationship.id,
          sourceId: relationship.sourceId,
          targetId: relationship.targetId,
          properties: toProperties(
            scope,
            relationship.id,
            relationship.type,
            relationship.properties,
          ),
        })),
      });
      const written = Number(rows[0]?.written ?? 0);
      if (written !== batch.length) {
        throw new Error(
          `TuGraph stored ${written} of ${batch.length} relationships; one or more scoped endpoints are missing`,
        );
      }
    }
  }

  async getNodesByIds(scope: StorageScope, ids: readonly string[]): Promise<GraphNodeRecord[]> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    if (ids.length === 0) return [];
    const rows = await this.query(
      scope,
      `MATCH (n:GitNexusNode {repoId: $repoId, branchId: $branchId})
       WHERE n.id IN $ids
       RETURN n.id AS id, n.kind AS label, properties(n) AS properties`,
      { ids },
    );
    return rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      properties: withoutStorageMetadata(row.properties),
    }));
  }

  async deleteAll(scope: StorageScope): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    await this.query(
      scope,
      'MATCH (n:GitNexusNode {repoId: $repoId, branchId: $branchId}) DETACH DELETE n',
    );
  }

  async deleteNodes(scope: StorageScope, ids: readonly string[]): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    if (ids.length === 0) return;
    for (const batch of chunksOf(ids, GRAPH_BATCH_SIZE)) {
      await this.query(
        scope,
        `MATCH (n:GitNexusNode {repoId: $repoId, branchId: $branchId})
         WHERE n.id IN $ids
         DETACH DELETE n`,
        { ids: batch },
      );
    }
  }

  async close(): Promise<void> {
    this.tokenPromise = undefined;
  }
}
