/**
 * R7 REPLAY lines (LAYOUT R7; locked in Task 1). A test that belongs to an R7 suite records its line on
 * its own task meta; the replay reporter (Task 14) reads `meta.replay` from each finished test and prints
 * the suites in order, under one banner whose count is the union of `files`.
 *
 *   it("DAO: act_proposal is callable", ({ task }) => { …; replayLine(task, "classifier labels (recorded dry-runs)", "…", [file]); });
 */
import type { TaskMeta } from "vitest";

export type ReplaySuite = "protocol refusals" | "classifier labels (recorded dry-runs)" | "key hygiene";

export interface ReplayMeta {
  suite: ReplaySuite;
  /** The line the reporter prints, ≤100 columns. */
  line: string;
  /** Fixture file names the line rests on, relative to demo/fixtures/. */
  files: string[];
}

declare module "vitest" {
  interface TaskMeta {
    replay?: ReplayMeta;
  }
}

/** Sets `task.meta.replay`. Pass the test context's `task`. */
export function replayLine(task: { meta: TaskMeta }, suite: ReplaySuite, line: string, files: string[] = []): void {
  task.meta.replay = { suite, line, files: [...files] };
}
