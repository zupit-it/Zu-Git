/**
 * Review conversations already on GitHub, shown read-only in the PR diff view
 * the way GitHub shows them: under their line while the latest diff still has
 * it, in an Outdated list with the code they were written on once it changed.
 */

import { invoke } from "@tauri-apps/api/core";

export interface GhComment {
  author: string;
  avatarUrl: string;
  body: string;
  createdAt: string;
  url: string;
  /** In the viewer's own review, not submitted yet on GitHub. */
  pending: boolean;
  /** Why GitHub hides it ("outdated", "spam"…); null when shown. */
  minimized: string | null;
}

export interface GhThread {
  id: string;
  path: string;
  /** Last line of the range on the latest diff; null when outdated or on the whole file. */
  line: number | null;
  startLine: number | null;
  /** Where it was written, on `originalCommit`. */
  originalLine: number | null;
  originalStartLine: number | null;
  originalCommit: string;
  side: "new" | "old";
  resolved: boolean;
  resolvedBy: string | null;
  outdated: boolean;
  /** The hunk it was written on, down to its line. */
  diffHunk: string;
  comments: GhComment[];
  /** Replies left to read on GitHub. */
  moreComments: number;
}

export function getPrThreads(repo: string, number: number): Promise<GhThread[]> {
  return invoke<GhThread[]>("fetch_pr_threads", { repo, number });
}

/** Resolves a conversation on GitHub at once, or opens it again; resolves to whether it is resolved now. */
export function resolveThread(threadId: string, resolved: boolean): Promise<boolean> {
  return invoke<boolean>("pr_thread_resolve", { threadId, resolved });
}

/** The PR's latest commit on GitHub: an open diff compares it with its own. */
export function getPrHead(repo: string, number: number): Promise<string> {
  return invoke<string>("fetch_pr_head", { repo, number });
}

/** What changes on GitHub worth a redraw: new replies, resolutions, threads gone outdated. */
export function threadsSignature(threads: GhThread[]): string {
  return threads
    .map(t => `${t.id}:${t.comments.length + t.moreComments}:${t.resolved ? 1 : 0}:${t.outdated ? 1 : 0}:${t.line ?? ""}`)
    .join(",");
}
