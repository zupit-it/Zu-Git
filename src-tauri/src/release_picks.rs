//! Which of a story's PRs on main reached a release branch.
//!
//! A story can land on main more than once: its first release, then a rework
//! after a reject — same Jira key in the title, `feat` or `fix` alike. A
//! release branch has it only when every one of those PRs was picked, so
//! "some commit of the story is on the branch" is not enough.

/// A merge of the story: PR number (0 when unknown) and RFC 3339 date.
#[derive(Debug, Clone, Copy)]
pub struct Merge<'a> {
    pub number: u64,
    pub merged_at: &'a str,
}

/// For each of `main` (oldest first), whether it is on the branch.
///
/// - a pick naming the PR — `(#123)` kept by a cherry-pick — settles it;
/// - otherwise a PR merged on main before the latest pick of the story is taken
///   as picked (picks come after the merge they bring), one merged after it
///   cannot be there yet;
/// - with no pick at all since the branch's last tag, only the last PR is known
///   to be missing: the earlier ones may have shipped with that tag.
pub fn pick_status(main: &[Merge], picks: &[Merge]) -> Vec<Option<bool>> {
    let Some(latest_pick) = picks.iter().map(|p| p.merged_at).max() else {
        let last = main.len().saturating_sub(1);
        return (0..main.len()).map(|i| if i == last { Some(false) } else { None }).collect();
    };
    main.iter()
        .map(|m| {
            let named = m.number != 0 && picks.iter().any(|p| p.number == m.number);
            // RFC 3339 timestamps from the same API compare correctly as strings.
            Some(named || m.merged_at <= latest_pick)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(number: u64, merged_at: &str) -> Merge<'_> {
        Merge { number, merged_at }
    }

    #[test]
    fn rework_merged_after_the_last_pick_is_not_on_the_branch() {
        let main = [m(10, "2026-05-02T10:00:00Z"), m(14, "2026-05-08T10:00:00Z")];
        let picks = [m(31, "2026-05-04T10:00:00Z")];
        assert_eq!(pick_status(&main, &picks), vec![Some(true), Some(false)]);
    }

    #[test]
    fn rework_picked_too_means_the_whole_story_is_there() {
        let main = [m(10, "2026-05-02T10:00:00Z"), m(14, "2026-05-08T10:00:00Z")];
        let picks = [m(31, "2026-05-04T10:00:00Z"), m(0, "2026-05-09T10:00:00Z")];
        assert_eq!(pick_status(&main, &picks), vec![Some(true), Some(true)]);
    }

    #[test]
    fn a_pick_naming_the_pr_counts_even_when_dates_disagree() {
        let main = [m(10, "2026-05-02T10:00:00Z"), m(14, "2026-05-08T10:00:00Z")];
        // Cherry-pick of #14 committed with an old author date carried over.
        let picks = [m(14, "2026-05-01T10:00:00Z")];
        assert_eq!(pick_status(&main, &picks), vec![Some(false), Some(true)]);
    }

    #[test]
    fn no_pick_since_the_tag_only_flags_the_last_pr() {
        let main = [m(10, "2026-05-02T10:00:00Z"), m(14, "2026-05-08T10:00:00Z")];
        assert_eq!(pick_status(&main, &[]), vec![None, Some(false)]);
        assert_eq!(pick_status(&[], &[]), Vec::<Option<bool>>::new());
    }
}
