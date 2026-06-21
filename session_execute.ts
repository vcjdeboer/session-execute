/**
 * @vcjdeboer/session-execute — the runtime of the `session-*` provenance suite.
 *
 * The Perform member (Compose → Perform → Record → Master = session-write →
 * session-execute → session-record → session-witness). It RUNS a filled analysis
 * template's R code HEADLESS in a held nix session, with the `swamprecord`
 * recorder ARMED — so the executor writes the SAME typed session-record slots a
 * live interactive run would (code, value, plot, warnings, inputs, and now the
 * functions[] dependency edges). "The executor writes to the same slots the
 * recorder does": when swamp is the runtime, provenance capture is built in.
 *
 * It then DYNAMICALLY VERIFIES the run against the template's `swamp.returns`
 * contract — the output counterpart to session-write's `swamp.slots` input
 * contract. session-write proves the FILL honors its contract (statically);
 * session-execute proves the RUN produced the contracted objects (a real lm
 * through the origin, a real ggplot), asserted in the live R session that holds
 * them. The loop is closed and verifiable end to end.
 *
 * EXECUTION MODEL (reused from @vcjdeboer/r-bridge): runs on swamp's in-process
 * `raw` driver and shells out to `nix shell <flakeRef>#<rPackage> --command R`,
 * feeding the driver script on stdin in REPL line-mode (`R --no-save --no-restore
 * --quiet < script`) so the recorder's addTaskCallback fires per top-level
 * expression — the per-chunk granularity an interactive run has. The recorder
 * ships records ASYNC to the host swamp binary (a separate model, separate lock),
 * so there is no lock contention with this method's own model.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { parse as parseYaml } from "npm:yaml@2.5.0";

/** Definition-level config: nix + the R env + how the armed recorder ships. */
const GlobalArgsSchema = z.object({
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

const RunArgsSchema = z.object({
  /** Path to the filled template .qmd to run (params filled, body frozen). */
  filledPath: z.string().min(1),
  /**
   * Optional path to the ORIGINAL template, to read the `swamp.returns` contract
   * from (governance: the contract comes from the template, not the fill). When
   * omitted, returns are read from the filled file (they are byte-identical after
   * a governed session-write fill).
   */
  templatePath: z.string().default(""),
});

const RunTargetsArgsSchema = z.object({
  /** Directory containing the targets pipeline (_targets.R, R/, params.yaml). */
  pipelineDir: z.string().min(1),
  /** session-record model instance the harvester records into. */
  recordDef: z.string().default("rec"),
});

/** The executor's typed result for a harvested targets run. */
const TargetsResultSchema = z.object({
  pipelineDir: z.string(),
  /** "ok" all targets succeeded; "partial" some errored; "error" nothing ran. */
  status: z.enum(["ok", "partial", "error"]),
  targets: z.number().int().default(0),
  ok: z.number().int().default(0),
  errors: z.number().int().default(0),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  timestamp: z.string(),
});

/** One dynamic-verification result for a declared return. */
const ReturnResultSchema = z.object({
  name: z.string(),
  /** The R binding asserted on. */
  bind: z.string().default(""),
  ok: z.boolean(),
  /** The observed class(<bind>)[1] from the live run. */
  observedClass: z.string().default(""),
  /** Human-readable expectation (from the returns spec). */
  expected: z.string().default(""),
});

/** The executor's own typed output — the run's status + contract verification. */
const ExecResultSchema = z.object({
  template: z.string().default(""),
  filled: z.string(),
  /** "ok" if the driver completed and wrote the verification file. */
  status: z.enum(["ok", "error"]),
  /** True iff every declared return was satisfied (the dynamic contract held). */
  valid: z.boolean(),
  returns: z.array(ReturnResultSchema).default([]),
  /** Number of R chunks extracted and run. */
  chunks: z.number().int().default(0),
  recorderArmed: z.boolean().default(true),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  timestamp: z.string(),
});

interface ReturnSpec {
  bind?: string;
  inherits?: string;
  through_origin?: boolean;
  desc?: string;
}

/** R string literal for an arbitrary value (double-quoted, JSON-compatible escapes). */
function rq(v: unknown): string {
  return JSON.stringify(String(v));
}

/** Split a .qmd into YAML frontmatter and body. */
function splitQmd(text: string): { yaml: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { yaml: m[1], body: m[2] } : { yaml: "", body: text };
}

/** Extract the `r` code chunks in order, dropping `#|` chunk options. */
export function extractRChunks(body: string): string[] {
  const re = /```\{r[^}]*\}\r?\n([\s\S]*?)\r?\n```/g;
  const chunks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const lines = m[1].split("\n").filter((l) => !l.trim().startsWith("#|"));
    const code = lines.join("\n").trim();
    if (code) chunks.push(code);
  }
  return chunks;
}

/** Build `params <- list(k = "v", ...)` from the frontmatter params block. */
export function buildParamsPreamble(params: Record<string, unknown>): string {
  const entries = Object.entries(params).map(([k, v]) => `${k} = ${rq(v)}`);
  return `params <- list(${entries.join(", ")})`;
}

/** Generate the R verification epilogue from the `swamp.returns` contract. */
export function buildEpilogue(
  returns: Record<string, ReturnSpec>,
  verifyPath: string,
): string {
  const lines = [".swr_rows <- character(0)"];
  for (const [name, spec] of Object.entries(returns)) {
    const bind = spec.bind ?? name;
    const checks: string[] = [];
    if (spec.inherits) checks.push(`inherits(${bind}, ${rq(spec.inherits)})`);
    if (spec.through_origin) {
      checks.push(`!("(Intercept)" %in% names(coef(${bind})))`);
    }
    const okExpr = checks.length ? checks.join(" && ") : "TRUE";
    lines.push(
      `.swr_rows <- c(.swr_rows, tryCatch(` +
        `paste(${rq(name)}, ${
          rq(bind)
        }, isTRUE(${okExpr}), class(${bind})[1], sep = "\\t"), ` +
        `error = function(e) paste(${rq(name)}, ${
          rq(bind)
        }, "FALSE", "<unresolved>", sep = "\\t")))`,
    );
  }
  lines.push(`writeLines(.swr_rows, ${rq(verifyPath)})`);
  return lines.join("\n");
}

/** Human-readable expectation string for a declared return. */
function expectationOf(spec: ReturnSpec): string {
  const parts: string[] = [];
  if (spec.inherits) parts.push(`inherits ${spec.inherits}`);
  if (spec.through_origin) parts.push("through origin (no intercept)");
  return parts.join(", ");
}

const GRACE_MS = 2_000;

/** Run a driver script through `R` in REPL line-mode inside the nix env. */
export async function runRStdin(
  g: GlobalArgs,
  driver: string,
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
  let killTimer: number | undefined;
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
  let killTimer: number | undefined;
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

const CAP = 8_000; // chars of stdout/stderr stored
function cap(s: string): string {
  return s.length > CAP
    ? s.slice(0, CAP) + `\n...[truncated ${s.length - CAP} chars]`
    : s;
}

/** The session-execute model definition. */
export const model = {
  type: "@vcjdeboer/session-execute",
  version: "2026.06.21.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    "execution": {
      description:
        "Result of running a filled template headless: status + returns-contract verification",
      schema: ExecResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "targets": {
      description:
        "Result of a harvested targets run (tar_make + tar_meta -> session-record)",
      schema: TargetsResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    "run": {
      description:
        "Run a filled template's R code headless in the nix session (recorder armed) and verify it against the template's swamp.returns contract",
      arguments: RunArgsSchema,
      execute: async (
        args: z.infer<typeof RunArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            instanceName: string,
            data: unknown,
          ) => Promise<{ version: number }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;
        const filledText = await Deno.readTextFile(args.filledPath);
        const { yaml: filledYaml, body } = splitQmd(filledText);
        const fm = (parseYaml(filledYaml) ?? {}) as {
          params?: Record<string, unknown>;
          swamp?: { returns?: Record<string, ReturnSpec> };
        };

        // The contract is read from the TEMPLATE when provided (governance), else
        // the filled file (byte-identical swamp block after a governed fill).
        let returns = fm.swamp?.returns ?? {};
        if (args.templatePath) {
          const tText = await Deno.readTextFile(args.templatePath).catch(() =>
            ""
          );
          if (tText) {
            const tfm = (parseYaml(splitQmd(tText).yaml) ?? {}) as {
              swamp?: { returns?: Record<string, ReturnSpec> };
            };
            if (tfm.swamp?.returns) returns = tfm.swamp.returns;
          }
        }

        const params = fm.params ?? {};
        const chunks = extractRChunks(body);
        const verifyPath = await Deno.makeTempFile({ suffix: ".tsv" });

        // Driver: set params, ARM the recorder, run the chunks (recorded per
        // top-level expression), STOP recording, then run the verification
        // epilogue (unrecorded — it is not part of the analysis).
        const driver = [
          // sync ship: headless R wipes tempdir() on exit, so async record
          // children would race the cleanup and read empty --input files.
          `options(swamprecord.repo = ${rq(g.repoDir)}, swamprecord.swamp = ${
            rq(g.swampBin)
          }, swamprecord.def = ${rq(g.recordDef)}, swamprecord.sync = TRUE)`,
          // fixed width so cli/tidyverse never probes the absent tty
          `options(width = 80, cli.width = 80)`,
          buildParamsPreamble(params),
          `source(${rq(g.hookPath)})`,
          ...chunks,
          `stop_swamp()`,
          buildEpilogue(returns, verifyPath),
        ].join("\n");

        context.logger.info(
          "Running {n} chunk(s) of {filled} headless in {ref} (recorder -> {def})",
          {
            n: chunks.length,
            filled: args.filledPath,
            ref: `${g.flakeRef}#${g.rPackage}`,
            def: g.recordDef,
          },
        );

        const r = await runRStdin(g, driver);
        if (r.timedOut) {
          await Deno.remove(verifyPath).catch(() => {});
          throw new Error(`session-execute timed out after ${g.timeoutMs}ms`);
        }

        const verifyText = await Deno.readTextFile(verifyPath).catch(() => "");
        await Deno.remove(verifyPath).catch(() => {});

        // Parse verification rows: name<TAB>bind<TAB>ok<TAB>class
        const observed = new Map<
          string,
          { ok: boolean; cls: string; bind: string }
        >();
        for (const line of verifyText.split("\n")) {
          if (!line.trim()) continue;
          const [name, bind, ok, cls] = line.split("\t");
          observed.set(name, {
            ok: ok === "TRUE",
            cls: cls ?? "",
            bind: bind ?? "",
          });
        }

        const returnResults = Object.entries(returns).map(([name, spec]) => {
          const o = observed.get(name);
          return {
            name,
            bind: spec.bind ?? name,
            ok: o?.ok ?? false,
            observedClass: o?.cls ?? "<unresolved>",
            expected: expectationOf(spec),
          };
        });

        // status: the driver reached and wrote the epilogue (verification file
        // had rows) => ok. valid: every declared return held.
        const reachedEpilogue = observed.size > 0 ||
          Object.keys(returns).length === 0;
        const status: "ok" | "error" = reachedEpilogue && r.code === 0
          ? "ok"
          : "error";
        const valid = returnResults.length > 0 &&
          returnResults.every((x) => x.ok);

        const handle = await context.writeResource("execution", "result", {
          template: args.templatePath,
          filled: args.filledPath,
          status,
          valid,
          returns: returnResults,
          chunks: chunks.length,
          recorderArmed: true,
          stdout: cap(r.stdout),
          stderr: cap(r.stderr),
          timestamp: new Date().toISOString(),
        });

        context.logger.info(
          "session-execute {status}: contract {valid} ({nok}/{n} returns), {chunks} chunks",
          {
            status,
            valid,
            nok: returnResults.filter((x) => x.ok).length,
            n: returnResults.length,
            chunks: chunks.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "run-targets": {
      description:
        "Run a targets pipeline headless (tar_make) and harvest its native tar_meta provenance into session-record",
      arguments: RunTargetsArgsSchema,
      execute: async (
        args: z.infer<typeof RunTargetsArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            s: string,
            i: string,
            d: unknown,
          ) => Promise<{ version: number }>;
          logger: { info: (m: string, p?: Record<string, unknown>) => void };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;
        // Fail fast with a clear error if the dir is not a targets pipeline.
        try {
          await Deno.stat(`${args.pipelineDir.replace(/\/+$/, "")}/_targets.R`);
        } catch {
          throw new Error(
            `run-targets: no _targets.R in pipelineDir '${args.pipelineDir}'`,
          );
        }
        const summaryPath = await Deno.makeTempFile({ suffix: ".tsv" });
        const expr = `source(${rq(g.harvestPath)}); ` +
          `harvest_targets(dir=${rq(args.pipelineDir)}, swamp=${
            rq(g.swampBin)
          }, ` +
          `def=${rq(args.recordDef)}, repo=${rq(g.repoDir)}, summaryPath=${
            rq(summaryPath)
          })`;

        context.logger.info("Harvesting targets pipeline {dir} -> {def}", {
          dir: args.pipelineDir,
          def: args.recordDef,
        });

        const r = await runRscriptNix(g, g.targetsRPackage, expr);
        if (r.timedOut) {
          await Deno.remove(summaryPath).catch(() => {});
          throw new Error(`run-targets timed out after ${g.timeoutMs}ms`);
        }
        const summary = (await Deno.readTextFile(summaryPath).catch(() => ""))
          .trim();
        await Deno.remove(summaryPath).catch(() => {});
        // Infra failure (nix can't build the env, source() error, R crash before the
        // harvester wrote its summary) is NOT an empty pipeline: surface it.
        if (r.code !== 0 && !summary) {
          throw new Error(
            `run-targets harvester failed (exit ${r.code}): ${cap(r.stderr)}`,
          );
        }
        const [n, ok, err] = summary.split("\t").map((x) => Number(x) || 0);
        const targets = n || 0, okN = ok || 0, errN = err || 0;
        const status: "ok" | "partial" | "error" = targets === 0
          ? "error"
          : errN > 0
          ? "partial"
          : "ok";

        const instance =
          (args.pipelineDir.replace(/\/+$/, "").split("/").pop() || "targets")
            .replace(/[^A-Za-z0-9_-]/g, "_");
        const handle = await context.writeResource("targets", instance, {
          pipelineDir: args.pipelineDir,
          status,
          targets,
          ok: okN,
          errors: errN,
          stdout: cap(r.stdout),
          stderr: cap(r.stderr),
          timestamp: new Date().toISOString(),
        });
        context.logger.info(
          "run-targets {status}: {targets} targets ({ok} ok, {err} error) -> {def}",
          { status, targets, ok: okN, err: errN, def: args.recordDef },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
