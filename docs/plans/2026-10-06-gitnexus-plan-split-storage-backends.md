# GitNexus Engineering Plan

> Task: Replace embedded LadybugDB storage with independent graph and vector services.
> Evidence verified at commit b92c14cdd042cdd97d6a5275ff998d1c25ae5349; GitNexus index refreshed against this checkout with the local 1.6.12 build (including --pdg). The CLI does not expose pdg_query, so no statement-level PDG findings are claimed.
> Evidence provenance schema 2; global dirty digest 0429740d3d3d57af809b843d85547834691472c9861ab7a66c1aaad8d956a897; cited-path manifest 16 sorted entries; exact generated plan path excluded.

## 1. Objective

Implement the already-approved storage split: Neo4j Community is the graph database; PostgreSQL with pgvector is the vector database. PostgreSQL full-text search is the first text-search candidate, subject to relevance evaluation. Remove LadybugDB only after every graph, vector, text-search, bridge, lifecycle, CLI, and test consumer has moved.

Treat vectors and text-search rows as rebuildable indexes keyed to stable graph IDs. Use repo and branch scope on every stored record. The replacement starts from source and rebuilds indexes; it does not attempt an in-place conversion of Ladybug files. Keep the installed GitNexus and this checkout isolated in all comparisons.

## 2. Current Behaviour

[verified] Ladybug currently stores typed graph node tables, a CodeRelation table, CodeEmbedding rows and an HNSW index in the same local database. Embedding rows carry nodeId, chunkIndex, line range, vector, and contentHash: gitnexus/src/core/lbug/schema.ts:708-735.

[verified] runEmbeddingPipeline both generates vectors and issues Ladybug Cypher for selecting nodes, deleting stale chunks, inserting chunks, and building the vector index. Incremental updates compare node content hashes; stale rows are deleted immediately before replacement batches: gitnexus/src/core/embeddings/embedding-pipeline.ts:234-310, 481-515, 529-635.

[verified] run-analyze owns the larger lifecycle: it restores cached embeddings, supplies existing hashes to the embedding pipeline, saves checkpoint state during embedding, and only finalizes metadata after the run: gitnexus/src/core/run-analyze.ts:4035-4240.

[verified] LocalBackend.semanticSearch embeds the query, asks Ladybug VECTOR for nearest chunk IDs, uses exact-scan fallback when the index cannot be used, then queries Ladybug again for node names and paths: gitnexus/src/mcp/local/local-backend.ts:3867-4058. Hybrid search combines Ladybug FTS results and semantic results with reciprocal-rank fusion: gitnexus/src/core/search/hybrid-search.ts:155-192 and gitnexus/src/core/search/bm25-index.ts.

[verified] The cross-repository bridge has a separate Ladybug database and its own read cache, lock, atomic replacement and recovery lifecycle: gitnexus/src/core/group/bridge-db.ts. Replacing only the primary graph database would therefore leave Ladybug as a runtime dependency.

## 3. Relevant Architecture

[verified] The analyze path has explicit parse/build, graph-write, FTS, embedding, checkpoint, and metadata phases. A stored lastCommit is a completion claim, so it must not advance when any required store is incomplete: gitnexus/src/core/run-analyze.ts:4041-4240.

[verified] Current embedding tests lock down incremental skip/re-embed behavior, per-batch deletion ordering, interruption resume, checkpoint windows, cancellation, and fallback behavior: gitnexus/test/unit/embedding-pipeline.test.ts:443-1020, 1166-1198.

[verified] Existing atomic-swap integration tests assert that a failed rebuild leaves the prior index intact and a successful rebuild publishes the replacement: gitnexus/test/integration/analyze-atomic-swap.test.ts.

[verified] Hybrid-search tests preserve BM25-only, semantic-only, combined RRF ranking and fallback behavior: gitnexus/test/unit/hybrid-search.test.ts.

[inferred] The new stores cannot share a transaction. Graph writes should be authoritative; vector and text rows are derived from graph/code facts. An analyze generation and retryable checkpoints must expose partial completion rather than claim success.

## 4. GitNexus Findings

[graph] Local build query for “embedding vector writes deletion search nodeId CodeEmbedding” located buildVectorIndex, deleteStaleEmbeddingRows, fetchExistingEmbeddingHashes, LocalBackend.semanticSearch, and CodeEmbedding schema/index definitions in the files cited above. The result reports index staleness status current at b92c14cdd042cdd97d6a5275ff998d1c25ae5349.

[graph] Upstream impact on buildVectorIndex was LOW and showed runEmbeddingPipeline as its direct caller.

[graph] Upstream impact on loadGraphToLbug was HIGH, exact, and showed runFullAnalysisInner, then runFullAnalysis, then CLI analyze/watch as consumers. Its direct graph-write behavior is a central migration seam.

[graph] Upstream impact on LocalBackend.semanticSearch was CRITICAL, lower-bound, with 62 impacted symbols across 17 processes and 7 modules. The index explicitly says three calls were dropped because receiver types could not be established. Text search additionally found callers in LocalBackend.query, core/search/hybrid-search.ts, and embedding-pipeline.ts; this graph result is not an all-clear for unlisted callers.

[graph] Query result for Ladybug schema and ingestion located GraphEmitSink, PdgEmitSink, CSV loading, schema declarations, run-analyze, and server graph reads. This confirms that graph persistence is not confined to one adapter file.

[verified] Existing bridge tests cover bridge storage, lookup scoping, locking, recovery, and cache behavior: gitnexus/test/unit/group/bridge-db.test.ts.

## 5. Statement-Level PDG Findings

The refreshed index contains the PDG layer, but this checkout’s CLI has no pdg_query command and no MCP query tool is available in this session. No control/data dependence edges are asserted. Source-verified ordering constraints for execution are: (1) preserve the previous published index if construction fails; (2) write graph and derived stores before advancing successful repository metadata; (3) persist embedding checkpoint state before relying on an embedding window after interruption. Revisit statement-level slices when a PDG-capable GitNexus query interface is available.

## 6. Proposed Changes

- gitnexus/src/core/storage/: add provider-neutral scope, record, and store contracts. Require repoId and branchId on every operation; use deterministic chunk IDs derived from nodeId and chunkIndex.
- gitnexus/src/core/storage/config.ts: resolve Neo4j and PostgreSQL/pgvector connection settings, validate required fields, and expose provider health diagnostics without logging credentials.
- Neo4j adapter: persist and traverse code nodes and relationships; preserve current graph IDs, labels, properties, relationship semantics, and query result ordering where observable.
- PostgreSQL/pgvector adapter: upsert chunk vectors and hashes, delete by repository/branch/file/node scope, provide nearest-neighbor and bounded exact-search paths, and expose counts/checkpoint reconciliation.
- Text-search adapter: isolate BM25 indexing and query behavior. Start with PostgreSQL FTS only after CJK, identifier, path, and short-query evaluation.
- run-analyze: coordinate graph publication, vector/text updates, generation state, retries and incomplete metadata. Do not mark lastCommit complete while a required store is behind.
- LocalBackend and query APIs: retrieve vector candidate IDs from pgvector and hydrate node metadata from Neo4j. Keep current RRF and distance filtering semantics under contract tests.
- group/bridge-db.ts: move bridge graph facts to Neo4j or a separately scoped Neo4j database and preserve lock, cache, atomic replacement, and recovery behavior.
- Remove Ladybug schema, native adapter/pool, bridge implementation, FTS/vector extensions, package dependency, old storage files and outdated documentation only after all consumers have moved.

## 7. Implementation Sequence

1. Add provider-neutral storage types and configuration parsing as an additive slice. Test repo/branch scope, deterministic chunk identity, incomplete/ready states, and secret-safe diagnostics. Existing behavior remains unchanged.
2. Implement and integration-test PostgreSQL/pgvector primitives with a dedicated test schema: schema setup, scoped upsert, content-hash reads, idempotent delete, nearest-neighbor ordering, exact-search limit, and health checks.
3. Route embedding writes, stale deletes, hash reads, counts and checkpoints through VectorStore. Preserve batch ordering, resume behavior, failed-node handling, and embedding identity.
4. Implement Neo4j graph write/read adapter. Import nodes and edges in bounded batches, validate persisted counts, then migrate one read family at a time: node lookup/context, impact/trace, PDG, process/group queries, and raw cypher policy.
5. Move semantic search hydration, hybrid search, FTS, and cross-repository bridge storage. Retain ranking and scope behavior; document any intentionally changed raw Cypher compatibility.
6. Add an analyze coordinator for generation publication, retries, reconciliation, cleanup, health diagnostics and restart recovery across two stores.
7. Run baseline-vs-candidate comparison with isolated data directories and service endpoints; update docs and CLI setup; full-rebuild from source; remove Ladybug dependencies and code in final atomic slices.

Live-service integration must wait until Neo4j and pgvector images are available. At that point report exact tested image tags before asking Stephen to pull them. Unit tests and type checks may use injected/fake clients meanwhile.

## 8. Test Strategy

- Add contract tests independent of vendor query syntax for scope isolation, idempotent upsert/delete, chunk-to-node mapping, missing-index versus empty-result versus backend-failure states, and lifecycle incompleteness.
- Extend embedding-pipeline tests for per-batch order, unchanged-hash skips, stale hash replacement, interrupted checkpoint replay, and deletion of nodes that are no longer embeddable.
- Extend semantic/hybrid tests for candidate hydration, distance thresholds, exact fallback limits, RRF merge stability, BM25-only and semantic-only degradation.
- Use real Neo4j/PostgreSQL integration tests for generated schemas, writes, traversal, vector filtering, restarts, and concurrent analyze/read behavior once images are pulled.
- Preserve pipeline graph golden behavior and atomic publication/failure guarantees. Compare query IDs and ordered outputs on a fixed fixture repository.
- Run unit tests and typecheck for each slice. Before final removal, run the full CLI suite and package/build checks. Do not report service integration as tested before the external services run.

## 9. Risk and Impact Analysis

- HIGH: loadGraphToLbug and run-analyze control graph import and successful-index publication.
- CRITICAL: LocalBackend.semanticSearch affects 62 indexed dependants, with three untyped call sites omitted from the graph result. Confirm with source search as each consumer is migrated.
- No distributed transaction: generation/checkpoint and reconciliation are mandatory to prevent an incomplete mixed index from appearing fresh.
- Query compatibility: Neo4j and Ladybug’s Cypher subsets differ; do not promise raw Cypher equivalence without explicit compatibility tests.
- Search quality: changing FTS tokenization/ranking can alter CJK, code identifier, and path recall; compare fixed queries and RRF ranks.
- Cost and setup: two services increase local setup and operational requirements. Health checks and explicit setup errors are required.
- Bridge storage is a distinct Ladybug lifecycle and can be overlooked if only the main repo index is migrated.

## 10. Files Expected to Change

| File | Symbols | Reason |
| --- | --- | --- |
| gitnexus/src/core/storage/* | new storage contracts/configuration | Define stable provider boundaries |
| gitnexus/src/core/run-analyze.ts | runFullAnalysisInner | Coordinate completion across stores |
| gitnexus/src/core/embeddings/embedding-pipeline.ts | runEmbeddingPipeline, batchInsertEmbeddings | Move vector writes and stale-row lifecycle |
| gitnexus/src/mcp/local/local-backend.ts | LocalBackend.semanticSearch, LocalBackend.query | Route vector retrieval and graph hydration |
| gitnexus/src/core/group/bridge-db.ts | writeBridgeUnlocked and bridge lifecycle | Remove secondary Ladybug DB |
| gitnexus/test/unit/*storage* and existing embedding/search/group tests | contract scenarios | Preserve behavior and test failures |
| gitnexus/package.json and gitnexus/package-lock.json | Ladybug and selected drivers | Runtime dependency replacement |

## 11. Reusable Implementation Context

~~~~yaml
implementation_context:
  task_summary: "Replace LadybugDB with independent Neo4j graph and PostgreSQL/pgvector vector storage; initially add provider-neutral contracts/configuration, then migrate consumers incrementally."
  acceptance_criteria:
    - "Every graph/vector/text record is isolated by repoId and branchId."
    - "Semantic search returns stable nodeId/chunk metadata and hydrates graph metadata from Neo4j."
    - "Interrupted/partial store updates remain detectable and retryable; incomplete runs never advance lastCommit."
    - "BM25, semantic, hybrid, graph traversal, PDG, group bridge, and raw cypher behavior have explicit contract coverage."
    - "The final runtime contains no LadybugDB dependency or storage path."
    - "Old installed CLI and modified checkout are tested with separate binaries, GITNEXUS_HOME values, storage paths, and service databases."
  evidence_provenance:
    schema_version: 2
    head_commit: "b92c14cdd042cdd97d6a5275ff998d1c25ae5349"
    generated_plan_path: "docs/plans/2026-10-06-gitnexus-plan-split-storage-backends.md"
    global_dirty_digest:
      algorithm: "sha256"
      canonicalization: "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records"
      value: "0429740d3d3d57af809b843d85547834691472c9861ab7a66c1aaad8d956a897"
    cited_path_manifest:
      - path: ".stephen/storage-replacement-plan.md"
        object_kind:
          head: "absent"
          index: "absent"
          worktree: "absent"
          untracked: "regular"
        state: "untracked"
        rename_from: null
        rename_to: null
        head_digest: "absent"
        index_digest: "absent"
        worktree_digest: "absent"
        untracked_digest: "sha256:fdb3d58d8c645a9811ec4513009201ecec567d212989d4028b97d605ed4b80c2"
      - path: "gitnexus/package.json"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:a6f51e87132af5e240cf77ddd26b8551aeb1cdf5938ee93af51af79a3ce15c89"
        index_digest: "sha256:a6f51e87132af5e240cf77ddd26b8551aeb1cdf5938ee93af51af79a3ce15c89"
        worktree_digest: "sha256:a6f51e87132af5e240cf77ddd26b8551aeb1cdf5938ee93af51af79a3ce15c89"
        untracked_digest: "absent"
      - path: "gitnexus/src/core/embeddings/embedding-pipeline.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:478aa0473e0ed3fdbadff4e3128f1ef4829c39cf567771c396b5c3d72ebf8853"
        index_digest: "sha256:478aa0473e0ed3fdbadff4e3128f1ef4829c39cf567771c396b5c3d72ebf8853"
        worktree_digest: "sha256:478aa0473e0ed3fdbadff4e3128f1ef4829c39cf567771c396b5c3d72ebf8853"
        untracked_digest: "absent"
      - path: "gitnexus/src/core/embeddings/types.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:d8ecf90c8817286711d950d79f75afb43bbd902c7a5f3bcea4cfab2f7f77eb58"
        index_digest: "sha256:d8ecf90c8817286711d950d79f75afb43bbd902c7a5f3bcea4cfab2f7f77eb58"
        worktree_digest: "sha256:d8ecf90c8817286711d950d79f75afb43bbd902c7a5f3bcea4cfab2f7f77eb58"
        untracked_digest: "absent"
      - path: "gitnexus/src/core/group/bridge-db.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:6392bd41dcb2c3616fe09dee6e58b5a3e3481f423c5390db273cca85a3f12ded"
        index_digest: "sha256:6392bd41dcb2c3616fe09dee6e58b5a3e3481f423c5390db273cca85a3f12ded"
        worktree_digest: "sha256:6392bd41dcb2c3616fe09dee6e58b5a3e3481f423c5390db273cca85a3f12ded"
        untracked_digest: "absent"
      - path: "gitnexus/src/core/lbug/lbug-adapter.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:f5d14e78d65d32e0e1a8b5ba725a079e3a9f02d34a1a76a2c87a2690bbd6250c"
        index_digest: "sha256:f5d14e78d65d32e0e1a8b5ba725a079e3a9f02d34a1a76a2c87a2690bbd6250c"
        worktree_digest: "sha256:f5d14e78d65d32e0e1a8b5ba725a079e3a9f02d34a1a76a2c87a2690bbd6250c"
        untracked_digest: "absent"
      - path: "gitnexus/src/core/lbug/schema.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:57a470e62b295d363a3fb0cd56cfa01bdf8400eb249976d1cba8df040c41d77d"
        index_digest: "sha256:57a470e62b295d363a3fb0cd56cfa01bdf8400eb249976d1cba8df040c41d77d"
        worktree_digest: "sha256:57a470e62b295d363a3fb0cd56cfa01bdf8400eb249976d1cba8df040c41d77d"
        untracked_digest: "absent"
      - path: "gitnexus/src/core/run-analyze.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:4f0da748279f1ccbb25f9813d763e366e0d263eb0fe7b893dc0ce9e77dc396d0"
        index_digest: "sha256:4f0da748279f1ccbb25f9813d763e366e0d263eb0fe7b893dc0ce9e77dc396d0"
        worktree_digest: "sha256:4f0da748279f1ccbb25f9813d763e366e0d263eb0fe7b893dc0ce9e77dc396d0"
        untracked_digest: "absent"
      - path: "gitnexus/src/core/search/bm25-index.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:61a7a3b87902237928863edae03368e12bf1718564e4ee2f59caf4f7a92c52f3"
        index_digest: "sha256:61a7a3b87902237928863edae03368e12bf1718564e4ee2f59caf4f7a92c52f3"
        worktree_digest: "sha256:61a7a3b87902237928863edae03368e12bf1718564e4ee2f59caf4f7a92c52f3"
        untracked_digest: "absent"
      - path: "gitnexus/src/core/search/hybrid-search.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:710d5bd9209a439fa6b182d6efd26a31b876c49882fdcf219930ebd2ded9f750"
        index_digest: "sha256:710d5bd9209a439fa6b182d6efd26a31b876c49882fdcf219930ebd2ded9f750"
        worktree_digest: "sha256:710d5bd9209a439fa6b182d6efd26a31b876c49882fdcf219930ebd2ded9f750"
        untracked_digest: "absent"
      - path: "gitnexus/src/mcp/local/local-backend.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:b29fa580f2bdf08f4edf5fb87113bad939886c484ad82e357f66dfba55ca3b69"
        index_digest: "sha256:b29fa580f2bdf08f4edf5fb87113bad939886c484ad82e357f66dfba55ca3b69"
        worktree_digest: "sha256:b29fa580f2bdf08f4edf5fb87113bad939886c484ad82e357f66dfba55ca3b69"
        untracked_digest: "absent"
      - path: "gitnexus/test/integration/analyze-atomic-swap.test.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:a75a2328cf58335aad77bdc53261e2360227e959238b9631e5ad49dcedc45e30"
        index_digest: "sha256:a75a2328cf58335aad77bdc53261e2360227e959238b9631e5ad49dcedc45e30"
        worktree_digest: "sha256:a75a2328cf58335aad77bdc53261e2360227e959238b9631e5ad49dcedc45e30"
        untracked_digest: "absent"
      - path: "gitnexus/test/integration/pipeline-graph-golden.test.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:d8a4d9922e92bfd14f96e1307eadfd994e9143ccda4515f5eadb98b9079b3048"
        index_digest: "sha256:d8a4d9922e92bfd14f96e1307eadfd994e9143ccda4515f5eadb98b9079b3048"
        worktree_digest: "sha256:d8a4d9922e92bfd14f96e1307eadfd994e9143ccda4515f5eadb98b9079b3048"
        untracked_digest: "absent"
      - path: "gitnexus/test/unit/embedding-pipeline.test.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:28a326cd83a5aab88dc296ce19ac03130c60754f93987830f007d123a5a3e28f"
        index_digest: "sha256:28a326cd83a5aab88dc296ce19ac03130c60754f93987830f007d123a5a3e28f"
        worktree_digest: "sha256:28a326cd83a5aab88dc296ce19ac03130c60754f93987830f007d123a5a3e28f"
        untracked_digest: "absent"
      - path: "gitnexus/test/unit/group/bridge-db.test.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:ba08dac49a4b3b364062d3f85ec59db1926a6db9d4d2dfd4f9adfe5208e67049"
        index_digest: "sha256:ba08dac49a4b3b364062d3f85ec59db1926a6db9d4d2dfd4f9adfe5208e67049"
        worktree_digest: "sha256:ba08dac49a4b3b364062d3f85ec59db1926a6db9d4d2dfd4f9adfe5208e67049"
        untracked_digest: "absent"
      - path: "gitnexus/test/unit/hybrid-search.test.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:acf885b26693d08d38465fcdbcd6143fa9366cf8b12febc403bac884224117c9"
        index_digest: "sha256:acf885b26693d08d38465fcdbcd6143fa9366cf8b12febc403bac884224117c9"
        worktree_digest: "sha256:acf885b26693d08d38465fcdbcd6143fa9366cf8b12febc403bac884224117c9"
        untracked_digest: "absent"
  primary_symbols:
    - symbol: "LocalBackend.semanticSearch"
      file: "gitnexus/src/mcp/local/local-backend.ts"
      lines: "3867-4058"
      role: "Retrieve semantic candidates and join them back to code graph metadata."
    - symbol: "runFullAnalysisInner"
      file: "gitnexus/src/core/run-analyze.ts"
      lines: "4041-4240"
      role: "Coordinate graph, embedding checkpoint, and completion state."
  related_symbols:
    - symbol: "loadGraphToLbug"
      relationship: "CALLS from runFullAnalysisInner"
      relevance: "Current graph publication seam; HIGH upstream risk."
    - symbol: "runEmbeddingPipeline"
      relationship: "CALLS batchInsertEmbeddings/buildVectorIndex"
      relevance: "Current vector indexing and incremental-update path."
    - symbol: "hybridSearch"
      relationship: "CALLS semantic search and BM25 search"
      relevance: "Combines two independently stored search lanes with RRF."
    - symbol: "writeBridgeUnlocked"
      relationship: "USES separate bridge database lifecycle"
      relevance: "Second Ladybug database requiring removal."
  execution_path:
    - "Analyze parses the repository into graph nodes and relationships."
    - "The current writer publishes graph rows to Ladybug and builds FTS/vector indexes."
    - "The target coordinator writes graph facts to Neo4j and derived search rows to PostgreSQL."
    - "Semantic search queries pgvector for stable chunk IDs, then hydrates code-node metadata from Neo4j."
    - "Only reconciled stores advance repository freshness metadata."
  pdg_constraints: []
  architectural_patterns:
    - pattern: "Keep provider-specific query and lifecycle details behind store interfaces; use explicit scope on every operation."
      example_location: "gitnexus/src/core/group/bridge-db.ts"
      usage_guidance: "Preserve locking, atomic replacement, cache and recovery guarantees while changing storage provider."
    - pattern: "Publish fresh metadata only after the index is actually complete."
      example_location: "gitnexus/src/core/run-analyze.ts:4041-4240"
      usage_guidance: "Retain checkpoint-only writes during in-flight embedding and treat partial results as incomplete."
  files_to_modify:
    - file: "gitnexus/src/core/storage/"
      symbols: []
      intended_change: "First slice: add storage scope, provider contracts, and validated connection configuration without changing defaults."
    - file: "gitnexus/test/unit/storage-contracts.test.ts"
      symbols: []
      intended_change: "Cover stable IDs, repo/branch isolation, and configuration/diagnostic behavior."
    - file: "gitnexus/src/core/embeddings/embedding-pipeline.ts"
      symbols: ["runEmbeddingPipeline", "batchInsertEmbeddings"]
      intended_change: "Later route vector writes, deletes, and hash reads through VectorStore."
    - file: "gitnexus/src/mcp/local/local-backend.ts"
      symbols: ["LocalBackend.semanticSearch", "LocalBackend.query"]
      intended_change: "Later query vectors from pgvector and hydrate from Neo4j."
    - file: "gitnexus/src/core/run-analyze.ts"
      symbols: ["runFullAnalysisInner"]
      intended_change: "Later coordinate store writes, checkpoint and complete-generation state."
    - file: "gitnexus/src/core/group/bridge-db.ts"
      symbols: ["writeBridgeUnlocked"]
      intended_change: "Later move separate group bridge storage off Ladybug."
  tests:
    - file: "gitnexus/test/unit/storage-contracts.test.ts"
      scenarios:
        - "Same node/chunk yields the same vector record ID across runs; different chunk indices produce different IDs."
        - "Identical node IDs in different repo/branch scopes remain distinct."
        - "Invalid or missing service configuration produces a safe actionable error with no credential value."
        - "A partial generation is not reported ready until graph and derived stores reconcile."
    - file: "gitnexus/test/unit/embedding-pipeline.test.ts"
      scenarios:
        - "Unchanged hashes skip vector writes; changed hashes replace only stale node chunks."
        - "Checkpoint recovery replays pending nodes without losing successful chunks."
    - file: "gitnexus/test/unit/hybrid-search.test.ts"
      scenarios:
        - "BM25-only, semantic-only, and combined results preserve RRF ordering and metadata."
    - file: "gitnexus/test/unit/group/bridge-db.test.ts"
      scenarios:
        - "Bridge IDs stay scoped; replacement and lock/recovery behavior survive backend change."
    - file: "gitnexus/test/integration/pipeline-graph-golden.test.ts"
      scenarios:
        - "Graph nodes, relationships, and stable IDs match the committed golden fixture."
    - file: "gitnexus/test/integration/analyze-atomic-swap.test.ts"
      scenarios:
        - "Failed staging leaves prior generation available; successful rebuild publishes one complete generation."
  verification_commands:
    - "cd gitnexus && npm test -- test/unit/storage-contracts.test.ts"
    - "cd gitnexus && npx tsc --noEmit"
    - "cd gitnexus && npm run test:unit"
    - "cd gitnexus && npm test"
    - "cd gitnexus && npm run build"
  risks:
    - "Neo4j/Ladybug Cypher behavior differs; graph query migration needs per-family golden tests."
    - "Neo4j and PostgreSQL have no shared transaction; generation reconciliation is required."
    - "Service-backed tests remain unrun until Stephen pulls the agreed image tags."
    - "Existing user lockfile modifications must be preserved and reviewed independently."
  assumptions:
    - "The approved prototype baseline is Neo4j Community for graph, PostgreSQL/pgvector for vectors, and PostgreSQL FTS for initial text-search evaluation; confirm service versions before live testing."
    - "Fresh indexes can be rebuilt from source; in-place conversion of Ladybug storage files is not required."
    - "The CLI and MCP can accept connection configuration through environment/config values without changing external API result shapes."
  open_questions:
    - "At first live integration test, agree and pull exact Neo4j and pgvector image tags, then bind tests to those versions."
    - "After fixed-corpus evaluation, decide whether PostgreSQL FTS is sufficient for CJK and code identifiers."
    - "Set the supported contract for the public raw cypher tool after Neo4j query parity is measured."
  avoid:
    - "Do not edit or stage pre-existing lockfile changes as part of the first contract slice."
    - "Do not delete or rename Ladybug implementations until their consumers have migrated and detect_changes plus tests account for them."
    - "Do not treat empty graph/vector results as proof of safety when impact is UNKNOWN or lower-bound."
    - "Do not test the installed CLI with this checkout's index or service data."
~~~~
## 12. Assumptions and Open Questions

Assumptions:
- The approved first prototype stack is Neo4j Community + PostgreSQL/pgvector; PostgreSQL FTS is a candidate to measure, not an irreversible decision.
- Existing indexes can be rebuilt from source; preserving old Ladybug database files is not a migration requirement.
- Candidate and installed GitNexus runs can be isolated with separate CLI artifacts, home directories, index paths, and database namespaces.

Open questions:
- Which exact service image tags will be used for the first live integration run? Select and report them immediately before that test so Stephen can pull them.
- Does PostgreSQL FTS provide acceptable CJK and code-identifier recall on the fixed evaluation corpus?
- What compatibility promise, if any, should raw cypher offer beyond the selected Neo4j dialect?

Deferred:
- Multi-user authentication, hosted-service operations, HA/backup policy, and packaging bundled databases are outside the first migration prototype unless required by service tests.

## 13. Definition of Done

- Provider-neutral contracts and validated config exist with deterministic scoped IDs and meaningful tests.
- Neo4j and PostgreSQL/pgvector adapters pass both provider-independent contracts and real service tests at agreed image versions.
- Graph, semantic, hybrid, BM25, PDG, group-bridge, incremental update, restart and failure-recovery scenarios are verified.
- Baseline comparison uses /usr/local/bin/gitnexus while candidate tests use node gitnexus/dist/cli/index.js; all mutable homes, indexes and database namespaces remain distinct.
- A failed or partial store write never reports the candidate repo as complete.
- Ladybug code, package, indexes, native extensions, bridge store, and misleading documentation are removed only after every consumer is migrated.
