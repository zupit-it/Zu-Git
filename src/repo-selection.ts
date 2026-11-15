// The repositories picked in the list's selector. GitHub is asked only about
// those: the others are neither loaded nor counted anywhere. Between the click
// that turns one off and the next refresh its PRs are still in the snapshot,
// so whatever counts or lists PRs goes through `inSelectedRepos`.

/** `prs` without those of the repositories turned off in the selector. */
export function inSelectedRepos<T extends { repo: string }>(prs: T[], hiddenRepos: string[]): T[] {
  return hiddenRepos.length === 0 ? prs : prs.filter((pr) => !hiddenRepos.includes(pr.repo));
}

/**
 * Whether `repo`, just turned on, was left out of the last read of GitHub:
 * its PRs are not in the snapshot, and only a refresh brings them.
 */
export function wasNotLoaded(repoSyncs: { repo: string; skipped?: boolean }[], repo: string): boolean {
  return repoSyncs.some((sync) => sync.repo === repo && sync.skipped === true);
}
