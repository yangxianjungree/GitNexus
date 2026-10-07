import type { IndexGenerationState } from './contracts.js';
import type { RepoMeta } from '../../storage/repo-meta.js';

export interface SplitStorageIdentity {
  readonly graph: string;
  readonly vector: string;
}

export interface SplitStorageMigration {
  readonly rebuild: boolean;
  readonly resetVector: boolean;
  readonly graphProviderChanged: boolean;
  readonly vectorProviderChanged: boolean;
}

/** Decide whether persisted split data can be reused by the selected providers. */
export const evaluateSplitStorageMigration = (
  previous: RepoMeta['splitStorage'] | undefined,
  selected: SplitStorageIdentity,
): SplitStorageMigration => {
  const graphProviderChanged = previous?.graphProvider !== selected.graph;
  const vectorProviderChanged = previous?.vectorProvider !== selected.vector;
  const generationNotReady = previous?.state !== 'ready';

  return {
    rebuild: generationNotReady || graphProviderChanged || vectorProviderChanged,
    resetVector: generationNotReady || vectorProviderChanged,
    graphProviderChanged,
    vectorProviderChanged,
  };
};

/** Keep incomplete split writes out of same-commit freshness checks. */
export const stampSplitStorageGeneration = <T extends RepoMeta>(
  meta: T,
  identity: SplitStorageIdentity,
  state: IndexGenerationState,
): T => ({
  ...meta,
  lastCommit: state === 'ready' ? meta.lastCommit : '',
  splitStorage: {
    state,
    graphProvider: identity.graph,
    vectorProvider: identity.vector,
  },
});
