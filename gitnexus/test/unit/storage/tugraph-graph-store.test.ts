import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageScope } from '../../../src/core/storage/contracts.js';
import { TuGraphGraphStore } from '../../../src/core/storage/tugraph-graph-store.js';

const scope: StorageScope = { repoId: 'repo-alpha', branchId: 'feature/tugraph' };
const config = {
  provider: 'tugraph' as const,
  uri: 'http://localhost:7071',
  username: 'admin',
  password: 'test-password',
  database: 'default',
};

describe('TuGraphGraphStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('logs in and maps the documented REST Cypher response while injecting scope parameters', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/login')) {
          return new Response(JSON.stringify({ jwt: 'jwt-token' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            header: [{ name: 'id' }, { name: 'count' }],
            result: [['Function:src/a.ts:run', 3]],
          }),
          { status: 200 },
        );
      }),
    );

    const store = new TuGraphGraphStore(config);
    const rows = await store.query(
      scope,
      'MATCH (n:Function {repoId: $repoId, branchId: $branchId}) RETURN n.id AS id, 3 AS count',
      { limit: 1 },
    );

    expect(rows).toEqual([{ id: 'Function:src/a.ts:run', count: 3 }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('http://localhost:7071/cypher');
    expect(calls[1].init?.headers).toMatchObject({ authorization: 'Bearer jwt-token' });
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
      graph: 'default',
      parameters: { $repoId: 'repo-alpha', $branchId: 'feature/tugraph', $limit: 1 },
    });
  });

  it('rejects graph queries without repository and branch predicates before contacting TuGraph', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = new TuGraphGraphStore(config);

    await expect(store.query(scope, 'MATCH (n:Function) RETURN n.id AS id')).rejects.toThrow(
      /repoId and \$branchId/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
