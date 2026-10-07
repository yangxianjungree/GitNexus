# Split Storage Backends

GitNexus can keep its local index while sending graph records and semantic
embeddings to separate services. Set `GITNEXUS_STORAGE_MODE=split` to enable
this path. Without that setting, GitNexus uses its existing local storage
behavior.

## What Lives Where

The local `.gitnexus/` directory remains part of every repository index. It
stores repository metadata, parser caches, and the local analysis database
used while building an index. In split mode, GitNexus also writes the graph to
a graph service and embedding chunks to a vector service. Graph-backed MCP
queries use the configured graph service; semantic search uses the configured
vector service. Full-text search remains part of the local index.

```text
                         GitNexus analyze
                    parse, resolve, build graph
                               |
             +-----------------+------------------+
             |                 |                  |
             v                 v                  v
       .gitnexus/         Graph database     Vector database
       local index        nodes + edges      embedding chunks
       metadata/cache      graph queries       semantic search
```

The graph and vector services are independent. GitNexus does not run a
distributed transaction across them. It records which provider pair owns a
completed generation and whether a write is in progress. If a process stops
mid-write, the next analyze clears the selected vector scope and rebuilds the
external data before marking that generation ready. The local index and
external stores can be temporarily out of step while a run is active; this
marker detects incomplete runs but does not hide in-progress data from queries.

## Provider Boundaries

| Role | Built-in providers | What GitNexus requires |
| --- | --- | --- |
| Graph | Neo4j, TuGraph | Scoped node/edge CRUD plus the declared `gitnexus-cypher-v1` query subset used by GitNexus graph queries. |
| Vector | PostgreSQL with pgvector, MongoDB | Scoped embedding upsert/delete/count/search operations using GitNexus chunk IDs and dimensions. |

Graph CRUD is provider-neutral, but a raw graph query is not. A graph adapter
must declare both the GitNexus query subset it supports and its native query
dialect. A database that can store vertices and edges but cannot execute or
translate the required query subset cannot serve GitNexus graph reads yet.
Moving those reads to semantic operations is a separate compatibility project.

Applications may register additional graph and vector factories before
resolving storage configuration. This is an in-process extension point: the
CLI does not dynamically import arbitrary provider packages. A custom graph
factory must implement the same CRUD contract and explicitly declare the
GitNexus query capability. Provider names, URIs, usernames, passwords, and
options are not written to repository metadata. Connection diagnostics show
only the endpoint scheme and host.

## Configuration

Existing provider variables remain supported. For example, a Neo4j plus
PostgreSQL deployment can use:

```sh
GITNEXUS_STORAGE_MODE=split
GITNEXUS_GRAPH_PROVIDER=neo4j
GITNEXUS_NEO4J_URI=neo4j://graph.example:7687
GITNEXUS_NEO4J_USERNAME=neo4j
GITNEXUS_NEO4J_PASSWORD=...
GITNEXUS_VECTOR_PROVIDER=postgresql
GITNEXUS_PGVECTOR_URL=postgresql://user:password@vector.example/gitnexus
```

For MongoDB, use `GITNEXUS_VECTOR_PROVIDER=mongodb` and
`GITNEXUS_MONGODB_URL`. A driver seed list can include more than one host, for
example `mongodb://node-a:27017,node-b:27017/gitnexus?replicaSet=rs0`.
For a mongos seed list, list the router endpoints without a `replicaSet`
option. For an isolated single-node Docker endpoint that advertises an
unreachable in-container hostname, `directConnection=true` pins the driver to
the configured endpoint; this disables topology discovery and is not the
replica-set or mongos HA configuration.

Registered custom providers use the generic `GITNEXUS_GRAPH_URI` and
`GITNEXUS_VECTOR_URI` variables. Optional graph settings are passed through
`GITNEXUS_GRAPH_USERNAME`, `GITNEXUS_GRAPH_PASSWORD`,
`GITNEXUS_GRAPH_DATABASE`, and `GITNEXUS_GRAPH_OPTIONS`; vector settings use
`GITNEXUS_VECTOR_DATABASE` and `GITNEXUS_VECTOR_OPTIONS`. The options variables
must contain a JSON object. The importing application must register the
provider ID before configuration is resolved.

## Connection Topologies

| Backend | Driver configuration | Current support boundary |
| --- | --- | --- |
| Neo4j graph | Neo4j driver URI, including routing schemes such as `neo4j://` and secure equivalents | The driver receives the URI and can use its routing/discovery behavior. Tests cover the adapter against a single endpoint, not cluster election or failover. A `bolt://` URI is a direct endpoint. |
| TuGraph graph | One HTTP or HTTPS endpoint | GitNexus sends requests to that endpoint. Redundancy requires a stable external load balancer or service address; GitNexus does not discover TuGraph members. |
| PostgreSQL vector | One node-postgres connection URL | Use a managed database endpoint, connection proxy, or failover service when the server moves. The configured URL is not a list of hosts. Multi-host URI parsing was not supported by the current driver path. |
| MongoDB vector | MongoDB Node driver connection URI | Seed-list, replica-set, and router connection options are passed through to the driver. Unit tests verify URI parsing only; there is no live election or router-failover test in this repository. |

These are connection-path capabilities, not promises of tested high
availability. Existing service tests exercise single-node Neo4j plus
PostgreSQL and TuGraph plus MongoDB when their opt-in environment flags are
enabled. URI parsing does not prove that credentials, networking, elections,
retries, or failover work in a deployed cluster.

GitNexus does not configure database sharding, choose shard keys, place data
across shards, or test cross-shard uniqueness and query behavior. A MongoDB
cluster may expose a mongos endpoint through its normal driver URI, but the
application has no sharding-specific placement or correctness guarantee.
Treat sharded deployments as unverified until a provider defines its shard
key and uniqueness strategy and runs live distribution and recovery tests.

## Generation Recovery

`RepoMeta.splitStorage` records the graph provider, vector provider, and
generation state. Missing state is treated as an older index that has not
proved which external stores contain its data.

| State | Meaning | Next analyze |
| --- | --- | --- |
| `not-started` or missing | No completed split generation is recorded | Rebuild the selected external stores. |
| `writing` | The run began, but did not publish a final ready stamp | Clear the selected vector scope and rebuild. A hard process stop leaves this marker in place. |
| `failed` | A write threw after the generation began | Clear the selected vector scope and rebuild. |
| `ready` | Graph and vector writes completed for the recorded provider pair | A same-commit run may use the freshness fast path only while the selected pair still matches. |

Changing either provider bypasses the same-commit fast path. A vector change
or incomplete generation clears vector rows before rebuilding. If the previous
index contained embeddings and the vector scope must be reset, GitNexus
regenerates embeddings for the selected store; this may require embedding
credentials and incur model/API cost. Passing `--drop-embeddings` is the
explicit exception: it deletes the vector scope and skips regeneration.
Graph-provider-only changes rebuild the graph while retaining the existing
vector provider's rows.

This protocol supports retry and detection, not atomic cross-database commits.
If the graph write succeeds and the vector write fails, queries may observe a
partially updated generation until a retry completes. The next analyze does
not report that generation as ready.
