import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assembleReplayResult,
  buildReplayDriver,
  decideFallback,
  ReplayResultSchema,
  runReplay,
} from "./replay.ts";
import type { MatchSpec, MatchVerdict } from "./matcher.ts";
import { GlobalArgsSchema } from "./session_execute.ts";

function fakeCtx() {
  const written: { spec: string; inst: string; data: unknown }[] = [];
  return {
    written,
    context: {
      globalArgs: GlobalArgsSchema.parse({
        nixBin: "nix",
        flakeRef: "x",
        rPackage: "rEnv",
        timeoutMs: 1000,
        repoDir: ".",
      }),
      writeResource: (spec: string, inst: string, data: unknown) => {
        written.push({ spec, inst, data });
        return Promise.resolve({ version: 1 });
      },
      logger: { info: () => {} },
    },
  };
}

const SPEC: MatchSpec = {
  registryVersion: "v1",
  language: "r",
  flakeRef: "path:./locked",
  code: ["df <- read.csv('d.csv')", "fit <- lm(y ~ x, df)"],
  returns: [{
    name: "est",
    bind: "coef(fit)[1]",
    tier: "headline",
    recorded: 3.14,
    rule: { kind: "scalar-tol", rel: 1e-6 },
  }],
};

Deno.test("ReplayResultSchema accepts a well-formed verdict and defaults optionals", () => {
  const r = ReplayResultSchema.parse({
    specPath: "/x/spec.json",
    envUsed: "nix",
    reproduced: true,
    status: "ok",
    returns: [{ name: "est", tier: "headline", ok: true, observed: "3.14159" }],
    timestamp: "2026-07-09T00:00:00Z",
  });
  assertEquals(r.firstDivergence, null);
  assertEquals(r.fallbackReason, "");
});

Deno.test("ReplayResultSchema rejects an unknown envUsed value", () => {
  assertThrows(() =>
    ReplayResultSchema.parse({
      specPath: "x",
      envUsed: "podman",
      reproduced: false,
      status: "ok",
      returns: [],
      timestamp: "t",
    })
  );
});

Deno.test("buildReplayDriver runs captured code before the matcher epilogue and fixes width", () => {
  const d = buildReplayDriver(SPEC, "/tmp/v.tsv");
  const codeIdx = d.indexOf("fit <- lm(y ~ x, df)");
  const epiIdx = d.indexOf(".swr_rows <- character(0)");
  assertEquals(codeIdx >= 0 && epiIdx >= 0 && codeIdx < epiIdx, true);
  assertEquals(d.includes("options(width = 80"), true); // headless tty guard
  assertEquals(d.includes(`writeLines(.swr_rows, "/tmp/v.tsv")`), true);
});

Deno.test("decideFallback keeps the result when the epilogue wrote verdict rows", () => {
  const d = decideFallback({ code: 0, stderr: "", verifyRows: 2 });
  assertEquals(d.useResult, true);
  assertEquals(d.reason, "");
});

Deno.test("decideFallback falls back when nix exits non-zero with no verdict rows", () => {
  const d = decideFallback({
    code: 1,
    stderr: "error: builder for '/nix/store/...-R.drv' failed",
    verifyRows: 0,
  });
  assertEquals(d.useResult, false);
  assertEquals(d.reason.length > 0, true);
});

Deno.test("decideFallback keeps a clean run even with zero returns", () => {
  const d = decideFallback({ code: 0, stderr: "", verifyRows: 0 });
  assertEquals(d.useResult, true);
});

Deno.test("assembleReplayResult folds verdicts into reproduced + localization", () => {
  const rows: MatchVerdict[] = [
    { name: "pre", tier: "supporting", ok: true, observed: "1" },
    { name: "est", tier: "headline", ok: false, observed: "9.9" },
  ];
  const r = assembleReplayResult(
    "/x/spec.json",
    SPEC,
    rows,
    "nix",
    "",
    "out",
    "err",
    "2026-07-09T00:00:00Z",
  );
  assertEquals(r.reproduced, false);
  assertEquals(r.firstDivergence?.name, "est");
  assertEquals(r.envUsed, "nix");
  assertEquals(r.status, "ok");
  assertEquals(r.returns.length, 2);
});

Deno.test("assembleReplayResult marks status error when no env ran", () => {
  const r = assembleReplayResult(
    "/x/spec.json",
    SPEC,
    [],
    "none",
    "both envs failed",
    "",
    "err",
    "t",
  );
  assertEquals(r.status, "error");
  assertEquals(r.reproduced, false);
});

Deno.test("runReplay uses the nix result when it produces verdict rows", async () => {
  const spec = {
    registryVersion: "v1",
    language: "r",
    flakeRef: "path:./locked",
    code: ["x <- 4"],
    returns: [{
      name: "s",
      bind: "x",
      tier: "headline",
      recorded: 4,
      rule: { kind: "scalar-tol", abs: 1e-9 },
    }],
  };
  const specPath = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(specPath, JSON.stringify(spec));
  const { context, written } = fakeCtx();

  const r = await runReplay({
    specPath,
    workdir: ".",
    dockerImage: "mambaorg/micromamba:latest",
    dockerEnv: "base",
    _now: () => "2026-07-09T00:00:00Z",
    // nix runner writes a passing verdict row to the verify path it is handed
    _runNix: async (_g, _driver, _cwd, verifyPath) => {
      await Deno.writeTextFile(verifyPath, "s\theadline\tTRUE\t4\n");
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    _runDocker: () => {
      throw new Error("docker must not be called");
    },
  }, context);

  await Deno.remove(specPath).catch(() => {});
  const data = written[0].data as { envUsed: string; reproduced: boolean };
  assertEquals(written[0].spec, "replay");
  assertEquals(data.envUsed, "nix");
  assertEquals(data.reproduced, true);
  assertEquals(r.dataHandles.length, 1);
});

Deno.test("runReplay falls back to docker when nix fails to build the env", async () => {
  const spec = {
    registryVersion: "v1",
    language: "r",
    flakeRef: "path:./locked",
    code: ["x <- 4"],
    returns: [{
      name: "s",
      bind: "x",
      tier: "headline",
      recorded: 4,
      rule: { kind: "scalar-tol", abs: 1e-9 },
    }],
  };
  const specPath = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(specPath, JSON.stringify(spec));
  const { context, written } = fakeCtx();

  const r = await runReplay({
    specPath,
    workdir: ".",
    dockerImage: "mambaorg/micromamba:latest",
    dockerEnv: "base",
    _now: () => "t",
    // nix "can't build": non-zero, no rows written
    _runNix: () =>
      Promise.resolve({
        stdout: "",
        stderr: "builder failed",
        code: 1,
        timedOut: false,
      }),
    _runDocker: async (_img, _env, _driver, _wd, verifyHost) => {
      await Deno.writeTextFile(verifyHost, "s\theadline\tTRUE\t4\n");
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
  }, context);

  await Deno.remove(specPath).catch(() => {});
  const data = written[0].data as {
    envUsed: string;
    fallbackReason: string;
    reproduced: boolean;
  };
  assertEquals(data.envUsed, "docker");
  assertEquals(data.reproduced, true);
  assertEquals(data.fallbackReason.length > 0, true);
  assertEquals(r.dataHandles.length, 1);
});
