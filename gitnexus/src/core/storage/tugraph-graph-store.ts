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
const VERTEX_LABEL = 'GitNexusNode';
const EDGE_LABEL = 'CodeRelation';

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
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const {
    _LABEL_: _label,
    _VID_: _vid,
    id: _id,
    repoId: _repoId,
    branchId: _branchId,
    kind: _kind,
    propertiesJson,
    ...properties
  } = value as Record<string, unknown>;
  let stored: Record<string, unknown> = {};
  if (typeof propertiesJson === 'string' && propertiesJson.length > 0) {
    try {
      const parsed: unknown = JSON.parse(propertiesJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        stored = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep the fixed schema fields when an older/corrupt JSON payload is found.
    }
  }
  return { ...properties, ...stored };
};

const scopedNodeId = (scope: StorageScope, id: string): string =>
  `${encodeURIComponent(scope.repoId)}:${encodeURIComponent(scope.branchId)}:${encodeURIComponent(id)}`;

const asOptionalString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const asOptionalInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const asOptionalBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const cypherLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    return `'${value
      .replaceAll('\\', '\\\\')
      .replaceAll("'", "\\'")
      .replaceAll('\r', '\\r')
      .replaceAll('\n', '\\n')}'`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`TuGraph cannot encode value of type ${typeof value} as a Cypher literal`);
};

const cypherStringList = (values: readonly string[]): string =>
  `[${values.map(cypherLiteral).join(', ')}]`;

const toNodeProperties = (
  scope: StorageScope,
  id: string,
  kind: string,
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  _scopeId: scopedNodeId(scope, id),
  id,
  repoId: scope.repoId,
  branchId: scope.branchId,
  kind,
  name: asOptionalString(properties.name),
  filePath: asOptionalString(properties.filePath),
  content: asOptionalString(properties.content),
  startLine: asOptionalInt(properties.startLine),
  endLine: asOptionalInt(properties.endLine),
  isExported: asOptionalBoolean(properties.isExported),
  description: asOptionalString(properties.description),
  propertiesJson: JSON.stringify(normalizeValue(properties)),
});

const toEdgeProperties = (
  scope: StorageScope,
  id: string,
  type: string,
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  id,
  repoId: scope.repoId,
  branchId: scope.branchId,
  sourceId: properties.sourceId ?? null,
  targetId: properties.targetId ?? null,
  type,
  propertiesJson: JSON.stringify(normalizeValue(properties)),
});

const schemaStatements = {
  vertex: `CALL db.createLabel('vertex', '${VERTEX_LABEL}', '_scopeId',
    ['_scopeId', 'string', false], ['id', 'string', true], ['repoId', 'string', true],
    ['branchId', 'string', true], ['kind', 'string', true], ['name', 'string', true],
    ['filePath', 'string', true], ['content', 'string', true], ['startLine', 'int64', true],
    ['endLine', 'int64', true], ['isExported', 'bool', true], ['description', 'string', true],
    ['propertiesJson', 'string', true])`,
  edge: `CALL db.createLabel('edge', '${EDGE_LABEL}', '[]',
    ['id', 'string', true], ['repoId', 'string', true], ['branchId', 'string', true],
    ['sourceId', 'string', true], ['targetId', 'string', true], ['type', 'string', true],
    ['propertiesJson', 'string', true])`,
} as const;

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
  private schemaReady: Promise<void> | undefined;

  constructor(config: StorageConfig['graph']) {
    this.baseUrl = config.uri.replace(/\/$/, '');
    this.username = config.username;
    this.password = config.password;
    this.graph = config.database;
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
    await this.login();
    const [vertexLabels, edgeLabels] = await Promise.all([
      this.callCypher('CALL db.vertexLabels()'),
      this.callCypher('CALL db.edgeLabels()'),
    ]);
    if (!vertexLabels.some((row) => row.label === VERTEX_LABEL)) {
      await this.callCypher(schemaStatements.vertex);
    }
    if (!edgeLabels.some((row) => row.label === EDGE_LABEL)) {
      await this.callCypher(schemaStatements.edge);
    }
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
      for (const batch of chunksOf(rows, GRAPH_BATCH_SIZE)) {
        for (const node of batch) {
          const properties = toNodeProperties(scope, node.id, label, node.properties);
          const assignments = Object.entries(properties)
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([key, value]) => `n.${key} = ${cypherLiteral(value)}`)
            .join(',\n          ');
          await this.callCypher(`
            MERGE (n:${VERTEX_LABEL} {_scopeId: ${cypherLiteral(properties._scopeId)}})
            SET ${assignments}
          `);
        }
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
    for (const batch of chunksOf(relationships, GRAPH_BATCH_SIZE)) {
      for (const relationship of batch) {
        const properties = toEdgeProperties(scope, relationship.id, relationship.type, {
          ...relationship.properties,
          sourceId: relationship.sourceId,
          targetId: relationship.targetId,
        });
        const propertyMap = Object.entries(properties)
          .map(([key, value]) => `${key}: ${cypherLiteral(value)}`)
          .join(', ');
        await this.callCypher(`
          MATCH ()-[old:${EDGE_LABEL}]->()
          WHERE old.id = ${cypherLiteral(relationship.id)}
            AND old.repoId = ${cypherLiteral(scope.repoId)}
            AND old.branchId = ${cypherLiteral(scope.branchId)}
          DELETE old
        `);
        const rows = await this.callCypher(`
          MATCH (source:${VERTEX_LABEL} {_scopeId: ${cypherLiteral(scopedNodeId(scope, relationship.sourceId))}}),
                (target:${VERTEX_LABEL} {_scopeId: ${cypherLiteral(scopedNodeId(scope, relationship.targetId))}})
          CREATE (source)-[r:${EDGE_LABEL} {${propertyMap}}]->(target)
          RETURN count(r) AS written
        `);
        const written = Number(rows[0]?.written ?? 0);
        if (written !== 1) {
          throw new Error(
            `TuGraph stored ${written} relationship(s) for ${relationship.id}; one or more scoped endpoints are missing`,
          );
        }
      }
    }
  }

  async getNodesByIds(scope: StorageScope, ids: readonly string[]): Promise<GraphNodeRecord[]> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    if (ids.length === 0) return [];
    const rows = await this.query(
      scope,
      `MATCH (n:${VERTEX_LABEL})
       WHERE n.repoId = $repoId AND n.branchId = $branchId AND n.id IN ${cypherStringList(ids)}
       RETURN n.id AS id, n.kind AS label, n.propertiesJson AS propertiesJson`,
    );
    return rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      properties: withoutStorageMetadata({ propertiesJson: row.propertiesJson }),
    }));
  }

  async deleteAll(scope: StorageScope): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    await this.query(
      scope,
      `MATCH (n:${VERTEX_LABEL})-[r:${EDGE_LABEL}]->()
       WHERE n.repoId = $repoId AND n.branchId = $branchId
       DELETE r`,
    );
    await this.query(
      scope,
      `MATCH ()-[r:${EDGE_LABEL}]->(n:${VERTEX_LABEL})
       WHERE n.repoId = $repoId AND n.branchId = $branchId
       DELETE r`,
    );
    await this.query(
      scope,
      `MATCH (n:${VERTEX_LABEL})
       WHERE n.repoId = $repoId AND n.branchId = $branchId
       DELETE n`,
    );
  }

  async deleteNodes(scope: StorageScope, ids: readonly string[]): Promise<void> {
    scope = createStorageScope(scope.repoId, scope.branchId);
    if (ids.length === 0) return;
    for (const batch of chunksOf(ids, GRAPH_BATCH_SIZE)) {
      await this.query(
        scope,
        `MATCH (n:${VERTEX_LABEL})-[r:${EDGE_LABEL}]->()
         WHERE n.repoId = $repoId AND n.branchId = $branchId AND n.id IN ${cypherStringList(batch)}
         DELETE r`,
      );
      await this.query(
        scope,
        `MATCH ()-[r:${EDGE_LABEL}]->(n:${VERTEX_LABEL})
         WHERE n.repoId = $repoId AND n.branchId = $branchId AND n.id IN ${cypherStringList(batch)}
         DELETE r`,
      );
      await this.query(
        scope,
        `MATCH (n:${VERTEX_LABEL})
         WHERE n.repoId = $repoId AND n.branchId = $branchId AND n.id IN ${cypherStringList(batch)}
         DELETE n`,
      );
    }
  }

  async close(): Promise<void> {
    this.tokenPromise = undefined;
  }
}
