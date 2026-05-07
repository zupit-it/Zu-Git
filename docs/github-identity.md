# Git author identity vs GitHub account identity

## The short version

A git commit contains a plain-text `author.email` field that has **nothing to do** with GitHub authentication. GitHub links a commit to an account only when that email is registered as a verified email on the profile. If the two don't match — and they often don't — GitHub cannot tell who made the commit, even though you are the one who pushed it.

---

## Why they are different

Git was designed in 2005, years before GitHub existed. A commit records two pieces of identity:

- **`author`** — the person who wrote the change (`git config user.name` / `user.email`)
- **`committer`** — the person who applied the commit to the repo (often the same)

Both are **free-form text**. Git does not authenticate or validate them in any way. You can set `user.email` to anything:

```bash
git config user.email "linus@torvalds.com"
```

Git will happily use it. There is no check.

GitHub, on the other hand, authenticates every push via SSH key or HTTPS token. It knows **with certainty** who pushed a branch. But it does not automatically merge that knowledge with the commit metadata, because doing so would be wrong in many legitimate cases:

- Cherry-picks and rebases carry commits authored by other people
- Pair-programming commits may use a shared or rotating email
- A commit made locally days ago might be pushed by a different teammate later

So GitHub's rule is conservative: **a commit is attributed to an account if and only if `author.email` matches a verified email on that account**. Push identity is tracked separately and is not used to override commit attribution.

---

## What this means in practice

| API / method | What it matches on | Reliable? |
|---|---|---|
| `GET /repos/{repo}/commits?author={login}` | Looks up verified emails for `login`, matches against commit `author.email` | Only if local email = verified GitHub email |
| `GET /repos/{repo}/commits?author={email}` | Matches commit `author.email` directly | Only if that email is in your git config |
| GraphQL `commit.author.user.login` | Resolves `author.email` → GitHub account | `null` when email is not verified on any account |
| `GET /repos/{repo}/activity?actor={login}` | **Who pushed**, authenticated at push time | Always correct |

---

## The common mismatch scenario

A developer at a company often has:

- A GitHub account created with a personal email (e.g. via Google OAuth): `giorgio@gmail.com`
- A local git config using a company email: `giorgio.betta@company.com`

The company email is never added as a verified email on the GitHub profile. Result: every commit from this developer has `author=(no github user)` in GitHub's GraphQL API, and `?author=giorgio-betta-zupit` returns zero results — even though every branch was pushed by that account.

---

## How ZuGit handles it

ZuGit uses `GET /repos/{repo}/activity?actor={login}&time_period=month` to find the most recently pushed branch without an open PR. This endpoint tracks the GitHub account that performed the push, not the git commit author. It is immune to the email mismatch problem.

The Activity API was introduced in GitHub REST API version `2022-11-28` and is available on GitHub.com and GitHub Enterprise Server 3.8+.
