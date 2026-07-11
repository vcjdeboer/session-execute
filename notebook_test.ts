import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assembleNotebook,
  buildHostShim,
  buildVerifyCell,
  parsePyVerdict,
  runNotebook,
} from "./notebook.ts";

function nbWithReturns(returns: Record<string, unknown>): string {
  return JSON.stringify({
    cells: [{
      cell_type: "code",
      source: ["fit = 1\n"],
      metadata: {},
      outputs: [],
      execution_count: null,
    }],
    metadata: { swamp: { returns } },
    nbformat: 4,
    nbformat_minor: 5,
  });
}

function fakeExecCtx() {
  const written: { s: string; i: string; d: Record<string, unknown> }[] = [];
  return {
    written,
    ctx: {
      globalArgs: { timeoutMs: 1000 },
      writeResource: (s: string, i: string, d: unknown) => {
        written.push({ s, i, d: d as Record<string, unknown> });
        return Promise.resolve({ version: 1 });
      },
      logger: { info: () => {} },
    },
  };
}

Deno.test("buildVerifyCell generates isinstance + attrs checks and writes the verify TSV", () => {
  const cell = buildVerifyCell({
    fit: {
      isinstance: "sklearn.linear_model.LinearRegression",
      attrs: ["coef_"],
    },
  }, "/work/verify.tsv");
  assert(cell.includes("_rows = []"));
  assert(cell.includes("_b = fit"));
  assert(cell.includes('import_module("sklearn.linear_model")'));
  assert(cell.includes('"LinearRegression"'));
  assert(cell.includes('hasattr(_b, "coef_")'));
  assert(cell.includes('"fit"'));
  // writes the verify file at the end
  assert(cell.includes('open("/work/verify.tsv"'));
});

Deno.test("buildVerifyCell defaults a check-less return to a presence check", () => {
  const cell = buildVerifyCell({ df: {} }, "/work/v.tsv");
  assert(cell.includes("_b = df"));
  // no isinstance/attrs machinery for a presence-only return
  assert(!cell.includes("import_module"));
  assert(!cell.includes("hasattr"));
});

Deno.test("buildVerifyCell uses spec.bind when the variable name differs", () => {
  const cell = buildVerifyCell(
    { estimate: { bind: "model.fit_" } },
    "/w/v.tsv",
  );
  assert(cell.includes("_b = model.fit_"));
  assert(cell.includes('"estimate"'));
});

Deno.test("assembleNotebook appends the verify cell as the last code cell", () => {
  const nb = JSON.stringify({
    cells: [{
      cell_type: "code",
      source: ["x = 1\n"],
      metadata: {},
      outputs: [],
      execution_count: null,
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
  const out = assembleNotebook(nb, "_rows = []\nprint(1)");
  const parsed = JSON.parse(out);
  assertEquals(parsed.cells.length, 2);
  const last = parsed.cells[parsed.cells.length - 1];
  assertEquals(last.cell_type, "code");
  assert(JSON.stringify(last.source).includes("_rows = []"));
  // the original cell is preserved
  assert(JSON.stringify(parsed.cells[0].source).includes("x = 1"));
  // still a valid nbformat envelope
  assertEquals(parsed.nbformat, 4);
});

Deno.test("assembleNotebook throws on a non-notebook (no cells array)", () => {
  assertThrows(() => assembleNotebook("{}", "x = 1"));
});

Deno.test("buildHostShim generates a generic host replayer reading the calls file", () => {
  const cell = buildHostShim("/work/host_calls.json");
  assert(cell.includes("/work/host_calls.json"));
  assert(cell.includes("class UnrecordedHostCall"));
  // generic dispatch via __getattr__, not a hardcoded per-method surface
  assert(cell.includes("__getattr__"));
  assert(cell.includes("host = "));
  // sorted-keys canonicalization for order-independent matching
  assert(cell.includes("sort_keys=True"));
  // artifact-aware: artifact_path resolves the MATERIALIZED local path via an index
  assert(cell.includes("artifact_path"));
  assert(cell.includes("artifact_index.json"));
});

Deno.test("buildHostShim replay mode (default) has no live fallback", () => {
  const cell = buildHostShim("/work/host_calls.json");
  assert(!cell.includes("_LIVE"));
  assert(!cell.includes("mygene.info"));
});

Deno.test("buildHostShim hybrid mode adds a live fallback on a recording miss", () => {
  const cell = buildHostShim("/work/host_calls.json", { mode: "hybrid" });
  assert(cell.includes("_LIVE")); // live-adapter registry
  assert(cell.includes("mygene.info")); // query_genes live adapter
  // the miss path consults _LIVE before raising
  assert(cell.includes("UnrecordedHostCall")); // still raises when no adapter
  assert(cell.indexOf("_LIVE") < cell.lastIndexOf("host = "));
});

Deno.test("buildHostShim hybrid mode registers the bio live adapters + endpoints", () => {
  const cell = buildHostShim("/work/host_calls.json", { mode: "hybrid" });
  // each tool is both defined and wired into the _LIVE registry
  for (
    const tool of [
      "query_genes",
      "alphafold_check_coverage",
      "pdb_search_structures",
    ]
  ) {
    assert(cell.includes(`_live_${tool}`), `missing adapter fn for ${tool}`);
    assert(cell.includes(`'${tool}':`), `missing _LIVE entry for ${tool}`);
  }
  // public endpoints (stdlib urllib only — runs in the papermill env)
  assert(cell.includes("alphafold.ebi.ac.uk/api/prediction/"));
  assert(cell.includes("search.rcsb.org/rcsbsearch/v2/query"));
  // replay mode still has NO adapters
  assert(!buildHostShim("/work/x.json").includes("alphafold.ebi.ac.uk"));
});

Deno.test("parsePyVerdict parses ok/fail rows and ignores blanks", () => {
  const v = parsePyVerdict(
    "fit\tTRUE\tLinearRegression\nmissing\tFALSE\t<unresolved>\n\n",
  );
  assertEquals(v.length, 2);
  assertEquals(v[0], { name: "fit", ok: true, observed: "LinearRegression" });
  assertEquals(v[1], { name: "missing", ok: false, observed: "<unresolved>" });
});

Deno.test("runNotebook verifies returns via papermill (injected) and writes an execution result", async () => {
  const dir = await Deno.makeTempDir();
  const filled = `${dir}/filled.ipynb`;
  await Deno.writeTextFile(
    filled,
    nbWithReturns({
      fit: {
        isinstance: "sklearn.linear_model.LinearRegression",
        attrs: ["coef_"],
      },
    }),
  );
  const { ctx, written } = fakeExecCtx();
  const r = await runNotebook({
    filledPath: filled,
    image: "img",
    env: "base",
    workdir: dir,
    _now: () => "t",
    _runDocker: async (_img, _env, wd, _in, _out) => {
      await Deno.writeTextFile(
        `${wd}/verify.tsv`,
        "fit\tTRUE\tLinearRegression\n",
      );
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
  }, ctx);
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  assertEquals(written[0].s, "execution");
  const res = written[0].d as {
    valid: boolean;
    status: string;
    returns: { name: string; ok: boolean }[];
  };
  assertEquals(res.status, "ok");
  assertEquals(res.valid, true);
  assertEquals(res.returns[0].name, "fit");
  assertEquals(res.returns[0].ok, true);
  assertEquals(r.dataHandles.length, 1);
});

Deno.test("runNotebook prepends the host shim and materializes host_calls when hostCallsPath is set", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/hc.json`,
    JSON.stringify([{
      method: "mcp",
      args: ["s", "t", {}],
      response: 1,
      isError: false,
    }]),
  );
  const filled = `${dir}/filled.ipynb`;
  await Deno.writeTextFile(filled, nbWithReturns({ r: {} }));
  const { ctx } = fakeExecCtx();
  let firstCell = "";
  let sawWorkdirCalls = false;
  await runNotebook({
    filledPath: filled,
    image: "img",
    env: "base",
    workdir: dir,
    hostCallsPath: `${dir}/hc.json`,
    _now: () => "t",
    _runDocker: async (_i: string, _e: string, wd: string) => {
      const nb = JSON.parse(await Deno.readTextFile(`${wd}/in.ipynb`));
      firstCell = JSON.stringify(nb.cells[0].source);
      sawWorkdirCalls = await Deno.stat(`${wd}/host_calls.json`).then(() =>
        true
      )
        .catch(() => false);
      await Deno.writeTextFile(`${wd}/verify.tsv`, "r\tTRUE\tint\n");
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
  }, ctx);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  assert(firstCell.includes("_HostReplay")); // shim is the FIRST cell
  assertEquals(sawWorkdirCalls, true); // calls file materialized into the workdir
});

Deno.test("runNotebook marks invalid when a declared return fails", async () => {
  const dir = await Deno.makeTempDir();
  const filled = `${dir}/filled.ipynb`;
  await Deno.writeTextFile(
    filled,
    nbWithReturns({ fit: { attrs: ["coef_"] } }),
  );
  const { ctx, written } = fakeExecCtx();
  await runNotebook({
    filledPath: filled,
    image: "img",
    env: "base",
    workdir: dir,
    _now: () => "t",
    _runDocker: async (_img, _env, wd) => {
      await Deno.writeTextFile(
        `${wd}/verify.tsv`,
        "fit\tFALSE\t<unresolved>\n",
      );
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
  }, ctx);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  assertEquals((written[0].d as { valid: boolean }).valid, false);
});
