import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { errorWith } from "../test-helpers.ts";
import { runJobManually } from "./manual-run.ts";
import type { ManualRunDeps } from "./manual-run.ts";
import type { CronCommandJob, CronJobDef, CronRunResult } from "./types.ts";

const JOB: CronCommandJob = {
  kind: "command",
  name: "my-job.yaml",
  schedule: "* * * * *",
  command: "true",
};

/** 呼び出しを記録する fake の依存関係を作る。 */
function makeDeps(opts: {
  registered: boolean;
  allow: boolean;
  result?: CronRunResult;
}) {
  const calls = { consume: 0, run: [] as CronJobDef[] };
  const deps: ManualRunDeps = {
    findJob: (name) => (opts.registered && name === JOB.name ? JOB : undefined),
    runJob: (job) => {
      calls.run.push(job);
      return Promise.resolve(opts.result ?? "succeeded");
    },
    limiter: {
      tryConsume: () => {
        calls.consume += 1;
        return opts.allow;
      },
    },
  };
  return { deps, calls };
}

describe("runJobManually", () => {
  for (const result of ["succeeded", "failed", "skipped"] as const) {
    test(`登録済みで枠があれば、枠を 1 つ消費して runJob の結果 (${result}) を返すこと`, async () => {
      const { deps, calls } = makeDeps({
        registered: true,
        allow: true,
        result,
      });

      assert.deepStrictEqual(await runJobManually(JOB.name, deps), result);
      assert.deepStrictEqual(calls.consume, 1);
      assert.deepStrictEqual(calls.run, [JOB]);
    });
  }

  test("枠が尽きていれば rate-limited を返し、runJob を呼ばないこと", async () => {
    const { deps, calls } = makeDeps({ registered: true, allow: false });

    assert.deepStrictEqual(
      await runJobManually(JOB.name, deps),
      "rate-limited",
    );
    assert.deepStrictEqual(calls.consume, 1);
    assert.deepStrictEqual(calls.run, []);
  });

  test("未登録のジョブは job not found を throw し、枠を消費しないこと", async () => {
    const { deps, calls } = makeDeps({ registered: false, allow: true });

    await assert.rejects(
      runJobManually("missing.yaml", deps),
      errorWith(Error, "job not found: missing.yaml"),
    );
    assert.deepStrictEqual(calls.consume, 0);
    assert.deepStrictEqual(calls.run, []);
  });

  test("未登録のジョブは、枠が尽きていても job not found を throw すること", async () => {
    const { deps } = makeDeps({ registered: false, allow: false });

    await assert.rejects(
      runJobManually("missing.yaml", deps),
      errorWith(Error, "job not found: missing.yaml"),
    );
  });
});
