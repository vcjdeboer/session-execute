/**
 * @vcjdeboer/session-execute — nixrun.ts
 *
 * The nix R-runner primitives, extracted so `session_execute.ts` and `replay.ts`
 * can both import them STATICALLY without forming a value-level import cycle (the
 * extension bundler forbids dynamic `import()`). `GlobalArgsSchema` is the model's
 * definition-level config; `runRStdin`/`runRscriptNix` spawn R in the pinned nix
 * env. No dependency on replay/notebook, so nothing imports back into it.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Definition-level config: nix + the R env + how the armed recorder ships. */
export const GlobalArgsSchema = z.object({
  /** nix binary — on PATH by default; override per-definition if absolute. */
  nixBin: z.string().default("nix"),
  /** Flake reference providing the R env (relative to repoDir; see r-env/flake.nix). */
  flakeRef: z.string().default("path:./r-env"),
  /** Package output in the flake that puts R/Rscript on PATH. */
  rPackage: z.string().default("rEnv"),
  /** Flake package with targets/tarchetypes for run-targets (the harvester). */
  targetsRPackage: z.string().default("rTargetsEnv"),
  /** The swamprecord loader the driver source()s to arm the recorder. */
  hookPath: z.string().default("./swamprecord/hook.R"),
  /** The targets harvester sourced by run-targets. */
  harvestPath: z.string().default("./swamprecord/targets-harvest.R"),
  /** swamp binary the recorder ships records to — on PATH by default. */
  swampBin: z.string().default("swamp"),
  /** swamp repository dir the recorder writes into (SWAMP_REPO_DIR); cwd by default. */
  repoDir: z.string().default("."),
  /** session-record model instance the recorder records into. */
  recordDef: z.string().default("rec"),
  /** Kill an R run that exceeds this many ms. */
  timeoutMs: z.number().int().positive().default(300_000),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const GRACE_MS = 2_000;

/** Run a driver script through `R` in REPL line-mode inside the nix env. */
export async function runRStdin(
  g: GlobalArgs,
  driver: string,
  cwd?: string,
): Promise<
  { stdout: string; stderr: string; code: number; timedOut: boolean }
> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(g.nixBin, {
      args: [
        "shell",
        `${g.flakeRef}#${g.rPackage}`,
        "--impure",
        "--command",
        "R",
        "--quiet",
        "--no-save",
        "--no-restore",
      ],
      // Run the captured code in the session's working dir (data lives there).
      ...(cwd ? { cwd } : {}),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      // COLUMNS/LINES give headless R a fixed terminal size, so the `cli`
      // package (loaded by the tidyverse) does not probe the absent tty and
      // throw "Cannot determine terminal size" — a benign error that would
      // otherwise be captured as a noise record in the ledger.
      env: {
        ...Deno.env.toObject(),
        SWAMP_REPO_DIR: g.repoDir,
        COLUMNS: "80",
        LINES: "24",
      },
    }).spawn();
  } catch (cause) {
    throw new Error(
      `Failed to spawn nix at '${g.nixBin}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

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
  }, g.timeoutMs);

  let output: Deno.CommandOutput;
  try {
    output = await child.output();
  } finally {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }

  const dec = new TextDecoder();
  return {
    stdout: dec.decode(output.stdout),
    stderr: dec.decode(output.stderr),
    code: output.code,
    timedOut,
  };
}

/** Run `Rscript -e <expr>` in the nix env (the targets harvester needs no REPL). */
export async function runRscriptNix(
  g: GlobalArgs,
  rPackage: string,
  expr: string,
): Promise<
  { stdout: string; stderr: string; code: number; timedOut: boolean }
> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(g.nixBin, {
      args: [
        "shell",
        `${g.flakeRef}#${rPackage}`,
        "--impure",
        "--command",
        "Rscript",
        "-e",
        expr,
      ],
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Deno.env.toObject(),
        SWAMP_REPO_DIR: g.repoDir,
        COLUMNS: "80",
        LINES: "24",
      },
    }).spawn();
  } catch (cause) {
    throw new Error(
      `Failed to spawn nix at '${g.nixBin}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
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
  }, g.timeoutMs);
  let output: Deno.CommandOutput;
  try {
    output = await child.output();
  } finally {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(output.stdout),
    stderr: dec.decode(output.stderr),
    code: output.code,
    timedOut,
  };
}
