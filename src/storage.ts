import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateFeature } from "./domain.ts";
import type { FeatureState } from "./types.ts";

export class Storage {
  constructor(readonly root: string) {}
  directory(feature: string): string {
    return path.join(
      this.root,
      ".kitchen",
      "features",
      validateFeature(feature),
    );
  }
  file(feature: string): string {
    return path.join(this.directory(feature), "state.json");
  }
  read(feature: string): FeatureState {
    const state: FeatureState = JSON.parse(
      readFileSync(this.file(feature), "utf8"),
    );
    if (
      state.version !== 1 ||
      state.feature !== feature ||
      path.resolve(state.worktree) !==
        path.join(this.root, ".kitchen", "worktrees", feature)
    )
      throw new Error("Unsupported or inconsistent feature state.");
    return state;
  }
  save(state: FeatureState): void {
    mkdirSync(this.directory(state.feature), { recursive: true });
    const temp = this.file(state.feature) + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify(state, null, 2));
    renameSync(temp, this.file(state.feature));
  }
  async lock<T>(feature: string, action: () => Promise<T>): Promise<T> {
    mkdirSync(this.directory(feature), { recursive: true });
    const file = path.join(this.directory(feature), "lock.json");
    if (existsSync(file)) {
      const owner = JSON.parse(readFileSync(file, "utf8"));
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive) throw new Error(`Feature is busy in process ${owner.pid}.`);
      unlinkSync(file);
    }
    const handle = openSync(file, "wx");
    writeFileSync(
      handle,
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    );
    closeSync(handle);
    try {
      if (existsSync(this.file(feature))) {
        const state = this.read(feature);
        for (const record of Object.values(state.stations))
          if (record?.status === "running") {
            record.status = "failed";
            record.error =
              "Interrupted run recovered. Rerun this station; no approval was inferred.";
          }
        this.save(state);
      }
      return await action();
    } finally {
      unlinkSync(file);
    }
  }
}
