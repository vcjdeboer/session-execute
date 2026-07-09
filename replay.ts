/**
 * @vcjdeboer/session-execute — replay.ts
 *
 * The `replay` method: run a MatchSpec's captured R code + the matcher epilogue
 * in the locked env, judge the fresh run against the recorded values. Pure
 * helpers (driver assembly, fallback decision, result assembly) are extracted so
 * they unit-test without a runtime; the method takes injected runners so it too
 * unit-tests via stubs. Real nix/docker runs are integration-tested.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  buildMatcherEpilogue,
  type MatchSpec,
  MatchSpecSchema,
  type MatchVerdict,
  parseMatchVerdict,
  summarizeReplay,
} from "./matcher.ts";
// Import the nix runner from nixrun.ts (NOT session_execute.ts): session_execute
// imports replay for its model definition, so importing back would form a cycle —
// and the extension bundler forbids the dynamic import() that previously broke it.
import { type GlobalArgs, runRStdin } from "./nixrun.ts";

/** One judged return in the verdict (mirrors matcher's MatchVerdict). */
const VerdictSchema = z.object({
  name: z.string(),
  tier: z.enum(["headline", "supporting"]),
  ok: z.boolean(),
  observed: z.string(),
});

/** The replay method's typed output. */
export const ReplayResultSchema = z.object({
  specPath: z.string(),
  /** Which env actually ran the code. `none` = neither could build. */
  envUsed: z.enum(["nix", "docker", "none"]),
  /** Tier-1: did every headline return match its recorded value? */
  reproduced: z.boolean(),
  /** "ok" if a run produced a verdict; "error" if no env could run it. */
  status: z.enum(["ok", "error"]),
  returns: z.array(VerdictSchema).default([]),
  /** Tier-2 localization: first non-matching return, else null. */
  firstDivergence: z.object({
    name: z.string(),
    tier: z.enum(["headline", "supporting"]),
    observed: z.string(),
  }).nullable().default(null),
  /** Why nix was abandoned for docker (or why both failed); "" if nix ran. */
  fallbackReason: z.string().default(""),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  timestamp: z.string(),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

/**
 * Assemble the R driver: fix headless width (so tidyverse's cli does not probe
 * the absent tty), run the captured code in order, then the matcher epilogue that
 * writes the TSV verdict. No recorder is armed — replay verifies, it does not
 * re-record.
 */
export function buildReplayDriver(spec: MatchSpec, verifyPath: string): string {
  return [
    `options(width = 80, cli.width = 80)`,
    ...spec.code,
    buildMatcherEpilogue(spec.returns, verifyPath),
  ].join("\n");
}

export interface RunOutcome {
  code: number;
  stderr: string;
  /** Number of verdict rows the epilogue wrote (0 = epilogue never reached). */
  verifyRows: number;
}

/**
 * Decide whether a run's result is usable or the env failed to build. A run is
 * usable if the epilogue produced verdict rows, OR it exited cleanly (a valid run
 * that happened to declare no returns). A non-zero exit with no rows means the
 * env never ran the analysis (e.g. nix could not build it) — fall back.
 */
export function decideFallback(
  o: RunOutcome,
): { useResult: boolean; reason: string } {
  if (o.verifyRows > 0) return { useResult: true, reason: "" };
  if (o.code === 0) return { useResult: true, reason: "" };
  const tail = o.stderr.slice(-400).trim();
  return {
    useResult: false,
    reason: `env did not produce a verdict (exit ${o.code}): ${tail}`,
  };
}

/**
 * Fold a run's judged rows + the env that produced them into the typed
 * ReplayResult. `reproduced` is true only when an env actually ran AND every
 * headline return matched; `status` is "error" iff no env ran (`envUsed==none`).
 */
export function assembleReplayResult(
  specPath: string,
  _spec: MatchSpec,
  rows: MatchVerdict[],
  envUsed: "nix" | "docker" | "none",
  fallbackReason: string,
  stdout: string,
  stderr: string,
  timestamp: string,
): ReplayResult {
  const summary = summarizeReplay(rows);
  return ReplayResultSchema.parse({
    specPath,
    envUsed,
    reproduced: envUsed !== "none" && summary.reproduced,
    status: envUsed === "none" ? "error" : "ok",
    returns: rows,
    firstDivergence: summary.firstDivergence,
    fallbackReason,
    stdout,
    stderr,
    timestamp,
  });
}

/** Grace period between SIGTERM and SIGKILL when a docker run times out. */
const GRACE_MS = 2_000;

/**
 * Docker/micromamba fallback runner. Runs the driver through the container's base
 * R (via `micromamba run`) with `workdir` bind-mounted to `/work`, so R writes the
 * verify TSV to a `/work/...` path the host reads back at `verifyHostPath` (which
 * MUST live under `workdir`). The image + env come from the session-ingest Docker
 * lock.
 */
export async function runRDocker(
  dockerImage: string,
  envName: string,
  driver: string,
  workdir: string,
  _verifyHostPath: string,
  timeoutMs: number,
): Promise<
  { stdout: string; stderr: string; code: number; timedOut: boolean }
> {
  const child = new Deno.Command("docker", {
    args: [
      "run",
      "--rm",
      "-i",
      "-v",
      `${workdir}:/work`,
      "-w",
      "/work",
      dockerImage,
      "micromamba",
      "run",
      "-n",
      envName,
      "R",
      "--quiet",
      "--no-save",
      "--no-restore",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { COLUMNS: "80", LINES: "24" },
  }).spawn();

  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(driver + "\n"));
  await w.close();

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch { /* exited */ }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* exited */ }
    }, GRACE_MS);
  }, timeoutMs);

  let out: Deno.CommandOutput;
  try {
    out = await child.output();
  } finally {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }

  const dec = new TextDecoder();
  return {
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
    code: out.code,
    timedOut,
  };
}

/** Injected runner signatures (real ones default inside runReplay). */
type NixRunner = (
  g: GlobalArgs,
  driver: string,
  cwd: string | undefined,
  verifyPath: string,
) => Promise<
  { stdout: string; stderr: string; code: number; timedOut: boolean }
>;
type DockerRunner = (
  img: string,
  env: string,
  driver: string,
  workdir: string,
  verifyHost: string,
  timeoutMs: number,
) => Promise<
  { stdout: string; stderr: string; code: number; timedOut: boolean }
>;

export const RunReplayArgsSchema = z.object({
  /** Path to the MatchSpec JSON that session-ingest froze. */
  specPath: z.string().min(1),
  /** Working directory the captured code runs in (data lives here). Default cwd. */
  workdir: z.string().default("."),
  /** Docker image for the fallback (from the session-ingest Docker lock). */
  dockerImage: z.string().default("mambaorg/micromamba:latest"),
  /** micromamba env name inside the image. */
  dockerEnv: z.string().default("base"),
});

/** Count non-blank TSV rows a run wrote (0 = epilogue never reached). */
async function countRows(path: string): Promise<number> {
  const t = await Deno.readTextFile(path).catch(() => "");
  return t.split("\n").filter((l) => l.trim()).length;
}

/**
 * The `replay` method: faithfully re-run a frozen MatchSpec's captured code in the
 * locked env (nix preferred, docker fallback) and judge the fresh run against the
 * recorded values. Injected `_runNix`/`_runDocker`/`_now` make it unit-testable.
 */
export async function runReplay(
  args: z.infer<typeof RunReplayArgsSchema> & {
    _runNix?: NixRunner;
    _runDocker?: DockerRunner;
    _now?: () => string;
  },
  context: {
    globalArgs: GlobalArgs;
    writeResource: (
      s: string,
      i: string,
      d: unknown,
    ) => Promise<{ version: number }>;
    logger: { info: (m: string, p?: Record<string, unknown>) => void };
  },
): Promise<{ dataHandles: unknown[] }> {
  const g = context.globalArgs;
  const now = args._now ?? (() => new Date().toISOString());

  // Parse the frozen contract FIRST — the nix runner default needs its flakeRef.
  const spec: MatchSpec = MatchSpecSchema.parse(
    JSON.parse(await Deno.readTextFile(args.specPath)),
  );

  const runNix: NixRunner = args._runNix ??
    // verifyPath is embedded in the driver; point nix at the locked flake.
    ((gg, driver, cwd, _verifyPath) =>
      runRStdin({ ...gg, flakeRef: spec.flakeRef }, driver, cwd));
  const runDocker: DockerRunner = args._runDocker ?? runRDocker;

  // 1) Try nix (the preferred, higher-fidelity substrate).
  const nixVerify = await Deno.makeTempFile({ suffix: ".tsv" });
  const nixDriver = buildReplayDriver(spec, nixVerify);
  const nixRun = await runNix(g, nixDriver, args.workdir, nixVerify);
  const nixRows = await countRows(nixVerify);
  const decision = decideFallback({
    code: nixRun.code,
    stderr: nixRun.stderr,
    verifyRows: nixRows,
  });

  let result: ReplayResult;
  if (decision.useResult) {
    const rows = parseMatchVerdict(
      await Deno.readTextFile(nixVerify).catch(() => ""),
    );
    result = assembleReplayResult(
      args.specPath,
      spec,
      rows,
      "nix",
      "",
      nixRun.stdout,
      nixRun.stderr,
      now(),
    );
  } else {
    // 2) Fall back to docker/micromamba. Verify file must live under workdir so
    //    the container's /work mount exposes it back to the host.
    const dVerifyHost = `${
      args.workdir.replace(/\/+$/, "")
    }/.swamp-replay-verify.tsv`;
    const dDriver = buildReplayDriver(spec, "/work/.swamp-replay-verify.tsv");
    const dRun = await runDocker(
      args.dockerImage,
      args.dockerEnv,
      dDriver,
      args.workdir,
      dVerifyHost,
      g.timeoutMs,
    );
    const dRows = await countRows(dVerifyHost);
    if (dRows > 0 || dRun.code === 0) {
      const rows = parseMatchVerdict(
        await Deno.readTextFile(dVerifyHost).catch(() => ""),
      );
      result = assembleReplayResult(
        args.specPath,
        spec,
        rows,
        "docker",
        decision.reason,
        dRun.stdout,
        dRun.stderr,
        now(),
      );
    } else {
      result = assembleReplayResult(
        args.specPath,
        spec,
        [],
        "none",
        `nix: ${decision.reason} | docker: exit ${dRun.code}`,
        dRun.stdout,
        dRun.stderr,
        now(),
      );
    }
    await Deno.remove(dVerifyHost).catch(() => {});
  }
  await Deno.remove(nixVerify).catch(() => {});

  const inst =
    args.specPath.split("/").pop()?.replace(/[^A-Za-z0-9_-]/g, "_") ??
      "replay";
  const handle = await context.writeResource("replay", inst, result);
  context.logger.info(
    "replay {env}: reproduced={ok} ({n} returns)",
    { env: result.envUsed, ok: result.reproduced, n: result.returns.length },
  );
  return { dataHandles: [handle] };
}
