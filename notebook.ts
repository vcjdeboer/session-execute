/**
 * @vcjdeboer/session-execute — notebook.ts
 *
 * The `run-notebook` method: run a filled `.ipynb` HEADLESS in the locked
 * conda/Docker env (papermill in micromamba) and verify it against the template's
 * `swamp.returns` contract — the Python/ipynb analog of the R/qmd `run`. Pure
 * helpers (verify-cell codegen, notebook assembly, verdict parsing) unit-test
 * without a runtime; the method takes an injected docker runner so it too
 * unit-tests via stubs. The real papermill-in-docker run is integration-tested.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** One declared Python return and how to verify it (mirrors R's inherits/through_origin). */
export interface PyReturnSpec {
  /** The notebook variable to check (default = the return name). */
  bind?: string;
  /** Fully-qualified class, e.g. "sklearn.linear_model.LinearRegression". */
  isinstance?: string;
  /** Attributes that must be present (e.g. ["coef_"] for a fitted estimator). */
  attrs?: string[];
  desc?: string;
}

/** Python string literal (double-quoted, JSON-compatible escapes). */
function pystr(v: string): string {
  return JSON.stringify(v);
}

/** Split "a.b.C" into module "a.b" and class "C". */
function splitQualified(fq: string): { module: string; cls: string } {
  const i = fq.lastIndexOf(".");
  return i < 0
    ? { module: "", cls: fq }
    : { module: fq.slice(0, i), cls: fq.slice(i + 1) };
}

/**
 * Generate the appended Python verification cell: for each declared return,
 * assert it against the live notebook namespace (isinstance + attrs), then write
 * `name\tTRUE|FALSE\t<observed type>` rows to `verifyPath`. Each return is wrapped
 * so an unbound name or failing check writes FALSE rather than crashing the cell.
 * A return with no checks is a presence check (TRUE iff the name is bound).
 */
export function buildVerifyCell(
  returns: Record<string, PyReturnSpec>,
  verifyPath: string,
): string {
  const lines: string[] = ["_rows = []"];
  for (const [name, spec] of Object.entries(returns)) {
    const bind = spec.bind ?? name;
    const checks: string[] = [];
    if (spec.isinstance) {
      const { module, cls } = splitQualified(spec.isinstance);
      checks.push(
        `isinstance(_b, getattr(__import__("importlib").import_module(${
          pystr(module)
        }), ${pystr(cls)}))`,
      );
    }
    for (const a of spec.attrs ?? []) checks.push(`hasattr(_b, ${pystr(a)})`);
    const okExpr = checks.length ? checks.join(" and ") : "True";
    lines.push(
      "try:",
      `    _b = ${bind}`,
      `    _ok = bool(${okExpr})`,
      `    _obs = type(_b).__name__`,
      "except Exception:",
      `    _ok, _obs = False, "<unresolved>"`,
      `_rows.append(${
        pystr(name)
      } + "\\t" + ("TRUE" if _ok else "FALSE") + "\\t" + _obs)`,
    );
  }
  lines.push(
    `with open(${pystr(verifyPath)}, "w") as _f:`,
    `    _f.write("\\n".join(_rows) + "\\n")`,
  );
  return lines.join("\n");
}

/**
 * Generate the prepended host-replay shim cell: define a generic `host` object
 * that replays ANY recorded host method from `hostCallsPath` (a JSON list of
 * `{method, args, response|__ref__, isError, error}` records, in call order).
 *
 * Method-agnostic — `host.<method>(*args, **kwargs)` canonicalizes to the recorded
 * `args_json` shape (mcp: `[server, tool, params]`; generic: positional args then a
 * kwargs dict) and looks up the response by `(method, args)` with sorted dict keys
 * so order doesn't matter. Duplicate identical calls are consumed in record order.
 * A call with no recording raises `UnrecordedHostCall`; a recorded error re-raises;
 * a `__ref__` response is loaded from the materialized blob.
 *
 * `mode: "replay"` (default) is offline/reproducible. `mode: "hybrid"` adds a LIVE
 * fallback: on a recording miss, an `host.mcp` call whose tool has a live adapter
 * is dispatched to the real public API the CS bundled tool wraps (e.g. query_genes
 * → mygene.info). Reproduce the sealed run exactly, extend it with live data only
 * where the recording has no answer.
 */
export function buildHostShim(
  hostCallsPath: string,
  opts?: { mode?: "replay" | "hybrid" },
): string {
  const p = JSON.stringify(hostCallsPath);
  const hybrid = opts?.mode === "hybrid";
  // Live adapters: (mcp tool) → the public API the CS bundled tool wraps. stdlib
  // only (urllib) so it runs in the papermill env. Extensible per tool.
  const liveAdapters = hybrid
    ? [
      "def _live_query_genes(params):",
      "    import urllib.request as _u, urllib.parse as _up",
      "    _body = _up.urlencode({'q': ','.join(params.get('terms', [])), 'scopes': params.get('scopes', 'symbol'), 'fields': params.get('fields', 'symbol,name,entrezgene,ensembl.gene,map_location'), 'species': params.get('species', 'human')}).encode()",
      "    return {'records': _json.load(_u.urlopen(_u.Request('https://mygene.info/v3/query', data=_body), timeout=30))}",
      // AlphaFold coverage: one GET per accession to the public EBI prediction API,
      // rebuilt into the recorded {n_unique, records:[{uniprot_accession, has_model,...}]} shape.
      "def _live_alphafold_check_coverage(params):",
      "    import urllib.request as _u",
      "    accs = params.get('uniprot_accessions') or ([params['uniprot_id']] if params.get('uniprot_id') else [])",
      "    recs = []",
      "    for _acc in accs:",
      "        try:",
      "            _m = _json.load(_u.urlopen('https://alphafold.ebi.ac.uk/api/prediction/' + _acc, timeout=30))",
      "            recs.append({'uniprot_accession': _acc, 'has_model': bool(_m), 'n_models': len(_m), 'model_entity_id': (_m[0].get('entryId') if _m else None), 'latest_version': (_m[0].get('latestVersion') if _m else None)})",
      "        except Exception:",
      "            recs.append({'uniprot_accession': _acc, 'has_model': False, 'n_models': 0, 'model_entity_id': None, 'latest_version': None})",
      "    return {'n_unique': len(accs), 'n_blank_skipped': 0, 'n_duplicate_skipped': 0, 'not_processed': [], 'records': recs}",
      // PDB structure search: RCSB full-text (or uniprot) search → recorded {results:[id...], total}.
      "def _live_pdb_search_structures(params):",
      "    import urllib.request as _u, urllib.parse as _up",
      "    _crit = params.get('uniprot_accession') or params.get('query')",
      "    if not _crit: return {'results': [], 'total': 0}",
      "    _q = {'query': {'type': 'terminal', 'service': 'full_text', 'parameters': {'value': str(_crit)}}, 'return_type': 'polymer_entity', 'request_options': {'paginate': {'start': 0, 'rows': int(params.get('limit', 10))}}}",
      "    try:",
      "        _r = _json.load(_u.urlopen(_u.Request('https://search.rcsb.org/rcsbsearch/v2/query?json=' + _up.quote(_json.dumps(_q))), timeout=30))",
      "        return {'results': [x.get('identifier') for x in _r.get('result_set', [])], 'total': _r.get('total_count', 0)}",
      "    except Exception:",
      "        return {'results': [], 'total': 0}",
      "_LIVE = {'query_genes': _live_query_genes, 'alphafold_check_coverage': _live_alphafold_check_coverage, 'pdb_search_structures': _live_pdb_search_structures}",
    ]
    : [];
  return [
    "import json as _json, os as _os, sqlite3 as _sqlite",
    "class UnrecordedHostCall(Exception): pass",
    ...liveAdapters,
    "class _HostReplay:",
    "    def __init__(self, path):",
    "        self._by = {}",
    "        for _c in _json.load(open(path)):",
    "            self._by.setdefault(self._key(_c['method'], _c['args']), []).append(_c)",
    "        self._n = {}",
    "        # artifact_path returns a machine-local path (recorded response is null);",
    "        # resolve it to the MATERIALIZED artifact via an index the driver writes.",
    "        self._art = {}",
    "        _d = _os.path.dirname(path) or '.'",
    "        _ai = _os.path.join(_d, 'artifact_index.json')",
    "        if _os.path.exists(_ai): self._art = _json.load(open(_ai))",
    "        # CS-DB introspection: rebuild a local execution_log from the captured",
    "        # cells+provenance facets so host.query() self-queries run OFFLINE.",
    "        self._db = None",
    "        _el = _os.path.join(_d, 'execution_log.json')",
    "        if _os.path.exists(_el):",
    "            self._db = _sqlite.connect(':memory:')",
    "            self._db.execute('CREATE TABLE execution_log (id TEXT, cell_index INTEGER, language TEXT, source TEXT, stdout TEXT, stderr TEXT, exit_status TEXT)')",
    "            self._db.executemany('INSERT INTO execution_log VALUES (?,?,?,?,?,?,?)', [(_r.get('id'), _r.get('cell_index'), _r.get('language'), _r.get('source'), _r.get('stdout'), _r.get('stderr'), _r.get('exit_status')) for _r in _json.load(open(_el))])",
    "    def _key(self, method, args):",
    "        m = 'query_db' if method in ('query', 'query_db') else method  # alias: host.query() == recorded query_db",
    "        a = list(args)",
    "        if a and isinstance(a[-1], dict) and not a[-1]:",
    "            a = a[:-1]  # mcp records a trailing params dict; a no-kwargs call omits it",
    "        return _json.dumps([m, a], sort_keys=True, separators=(',', ':'))",
    "    def _run_query(self, args):",
    "        _sql = args[0]; _params = list(args[1]) if len(args) > 1 and args[1] is not None else []",
    "        _cur = self._db.execute(_sql, _params)",
    "        _cols = [_dd[0] for _dd in _cur.description] if _cur.description else []",
    "        return {'columns': _cols, 'rows': [list(_row) for _row in _cur.fetchall()]}",
    "    def __getattr__(self, method):",
    "        def _call(*args, **kwargs):",
    "            if method == 'artifact_path' and args:",
    "                _aid = str(args[0])",
    "                if _aid in self._art: return self._art[_aid]",
    "                # cascade-breaker: an UNCAPTURED artifact (cross-session / GC'd before",
    "                # capture) resolves to a NAMED nonexistent path, so the caller gets a clear",
    "                # FileNotFoundError (catchable) naming the id, not open(None)->TypeError.",
    "                return _os.path.join(_os.getcwd(), '_unresolved_artifact_' + _aid)",
    "            a = list(args) + ([kwargs] if kwargs else [])",
    "            k = self._key(method, a)",
    "            bucket = self._by.get(k)",
    "            if not bucket:",
    "                if method in ('query', 'query_db') and self._db is not None and a and isinstance(a[0], str):",
    "                    return self._run_query(a)  # Tier-2: run the self-query on the local execution_log",
    ...(hybrid
      ? [
        "                if method == 'mcp' and len(a) >= 2 and a[1] in _LIVE:",
        "                    return _LIVE[a[1]](a[2] if len(a) > 2 else {})",
      ]
      : []),
    "                raise UnrecordedHostCall(method, a)",
    "            i = self._n.get(k, 0); self._n[k] = i + 1",
    "            rec = bucket[min(i, len(bucket) - 1)]",
    "            if rec.get('isError'):",
    "                raise RuntimeError(rec.get('error') or ('recorded host error: ' + method))",
    "            if isinstance(rec.get('response'), dict) and '__ref__' in rec['response']:",
    "                return _json.load(open(rec['response']['__ref__']))",
    "            return rec.get('response')",
    "        return _call",
    `host = _HostReplay(${p})`,
  ].join("\n");
}

/** An nbformat code cell whose source is `src`. */
function codeCell(src: string): Record<string, unknown> {
  // nbformat stores source as a list of lines, each terminated by \n except the
  // last — split preserving that convention.
  const parts = src.split("\n");
  const source = parts.map((l, i) => (i < parts.length - 1 ? l + "\n" : l));
  return {
    cell_type: "code",
    metadata: {},
    execution_count: null,
    outputs: [],
    source,
  };
}

/**
 * Append the generated verify cell as the LAST code cell of a filled `.ipynb`,
 * preserving every existing cell and the nbformat envelope. Throws on anything
 * that is not a notebook (no `cells` array).
 */
export function assembleNotebook(
  filledIpynb: string,
  verifyCellSrc: string,
): string {
  const nb = JSON.parse(filledIpynb) as { cells?: unknown[] };
  if (!nb || !Array.isArray(nb.cells)) {
    throw new Error(
      "assembleNotebook: input is not a notebook (missing a `cells` array)",
    );
  }
  nb.cells.push(codeCell(verifyCellSrc));
  return JSON.stringify(nb);
}

/** Prepend `src` as the FIRST code cell of a notebook (e.g. the host-replay shim). */
export function prependCell(ipynb: string, src: string): string {
  const nb = JSON.parse(ipynb) as { cells?: unknown[] };
  if (!nb || !Array.isArray(nb.cells)) {
    throw new Error(
      "prependCell: input is not a notebook (missing a `cells` array)",
    );
  }
  nb.cells.unshift(codeCell(src));
  return JSON.stringify(nb);
}

/** Grace period between SIGTERM and SIGKILL when a docker run times out. */
const GRACE_MS = 2_000;

/**
 * Spawn `docker <args>`, enforce a wall timeout (SIGTERM→SIGKILL), and return the
 * captured output. No stdin (papermill reads the notebook file from the mount).
 * Mirrors replay.ts's runRDocker timeout handling; kept self-contained so the
 * merged replay path is untouched.
 */
async function spawnDockerRun(
  args: string[],
  timeoutMs: number,
): Promise<
  { stdout: string; stderr: string; code: number; timedOut: boolean }
> {
  const child = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
    env: { COLUMNS: "80", LINES: "24" },
  }).spawn();

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

/**
 * Run a notebook headless via papermill in the locked micromamba env. `workdir`
 * is bind-mounted to `/work`, so `<inName>` (the assembled notebook) is read from
 * there and papermill writes `<outName>` + the verify TSV back to the host.
 * `env` must provide papermill (see the design's papermill-availability note).
 */
export function runPapermillDocker(
  image: string,
  env: string,
  workdir: string,
  inName: string,
  outName: string,
  timeoutMs: number,
  kernel = "python3",
): Promise<
  { stdout: string; stderr: string; code: number; timedOut: boolean }
> {
  return spawnDockerRun([
    "run",
    "--rm",
    "-v",
    `${workdir}:/work`,
    "-w",
    "/work",
    image,
    "micromamba",
    "run",
    "-n",
    env,
    "papermill",
    `/work/${inName}`,
    `/work/${outName}`,
    // The assembled notebook has no kernelspec metadata, so papermill needs an
    // explicit kernel; ipykernel's default in the locked env is `python3`.
    "-k",
    kernel,
  ], timeoutMs);
}

/** One judged return read back from the verify TSV. */
export interface ReturnVerdict {
  name: string;
  ok: boolean;
  observed: string;
}

/** Parse the verify TSV (`name\tTRUE|FALSE\t<observed>` per line); blanks ignored. */
export function parsePyVerdict(tsv: string): ReturnVerdict[] {
  return tsv
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const [name, ok, observed = ""] = l.split("\t");
      return { name, ok: ok === "TRUE", observed };
    });
}

/** Read a notebook's `metadata.swamp.returns` contract (empty if absent). */
async function readNotebookReturns(
  path: string,
): Promise<Record<string, PyReturnSpec>> {
  const nb = JSON.parse(await Deno.readTextFile(path)) as {
    metadata?: { swamp?: { returns?: Record<string, PyReturnSpec> } };
  };
  return nb.metadata?.swamp?.returns ?? {};
}

export const RunNotebookArgsSchema = z.object({
  /** Path to the filled .ipynb to run (params filled, body frozen). */
  filledPath: z.string().min(1),
  /** Optional path to the ORIGINAL template to read `swamp.returns` from (governance). */
  templatePath: z.string().default(""),
  /** The locked Docker image (from the session-ingest Docker lock). */
  image: z.string().min(1),
  /** micromamba env inside the image that provides papermill + the analysis stack. */
  env: z.string().default("base"),
  /** Working dir bind-mounted to /work (holds in/out.ipynb + verify.tsv). Default temp. */
  workdir: z.string().default(""),
  /** Jupyter kernel papermill runs the notebook with (ipykernel default: python3). */
  kernel: z.string().default("python3"),
  /** Path to a captured host-calls JSON; if set, prepend a host-replay shim. */
  hostCallsPath: z.string().default(""),
  /** Host shim mode: "replay" (offline/reproducible) or "hybrid" (live fallback on a miss). */
  hostMode: z.enum(["replay", "hybrid"]).default("replay"),
});

/** The docker runner shape (real = runPapermillDocker; injected in unit tests). */
type DockerRunner = (
  image: string,
  env: string,
  workdir: string,
  inName: string,
  outName: string,
  timeoutMs: number,
  kernel: string,
) => Promise<
  { stdout: string; stderr: string; code: number; timedOut: boolean }
>;

/**
 * The `run-notebook` method: assemble the filled notebook + the verify cell, run
 * it headless via papermill in the locked micromamba/Docker env, and judge the
 * fresh run against the template's `swamp.returns`. Writes an `execution` record
 * (`ExecResult` shape). Injected `_runDocker`/`_now` keep it unit-testable.
 */
export async function runNotebook(
  args: z.input<typeof RunNotebookArgsSchema> & {
    _runDocker?: DockerRunner;
    _now?: () => string;
  },
  context: {
    globalArgs?: { timeoutMs?: number };
    writeResource: (
      s: string,
      i: string,
      d: unknown,
    ) => Promise<{ version: number }>;
    logger: { info: (m: string, p?: Record<string, unknown>) => void };
  },
): Promise<{ dataHandles: unknown[] }> {
  const now = args._now ?? (() => new Date().toISOString());
  const runDocker = args._runDocker ?? runPapermillDocker;
  const timeoutMs = context.globalArgs?.timeoutMs ?? 300_000;
  const env = args.env ?? "base";

  // Contract from the template (governance) if given, else the filled notebook.
  const returns = await readNotebookReturns(
    args.templatePath || args.filledPath,
  );

  const workdir = args.workdir ||
    await Deno.makeTempDir({ prefix: "swamp-nb-" });
  const verifyCell = buildVerifyCell(returns, "/work/verify.tsv");
  let assembled = assembleNotebook(
    await Deno.readTextFile(args.filledPath),
    verifyCell,
  );
  // If host calls were captured, materialize them into the workdir and prepend a
  // generic host-replay shim as the first cell (so host.* calls replay recordings).
  if (args.hostCallsPath) {
    const dest = `${workdir}/host_calls.json`;
    // Guard against a self-copy (caller may pass a path already at dest), which
    // would truncate the file.
    if (
      await Deno.realPath(args.hostCallsPath).catch(() =>
        args.hostCallsPath
      ) !==
        await Deno.realPath(dest).catch(() => dest)
    ) {
      await Deno.copyFile(args.hostCallsPath, dest);
    }
    assembled = prependCell(
      assembled,
      buildHostShim("/work/host_calls.json", {
        mode: args.hostMode ?? "replay",
      }),
    );
  }
  await Deno.writeTextFile(`${workdir}/in.ipynb`, assembled);

  const run = await runDocker(
    args.image,
    env,
    workdir,
    "in.ipynb",
    "out.ipynb",
    timeoutMs,
    args.kernel ?? "python3",
  );
  const verdicts = parsePyVerdict(
    await Deno.readTextFile(`${workdir}/verify.tsv`).catch(() => ""),
  );
  const ranOk = run.code === 0 && !run.timedOut;
  const valid = ranOk && verdicts.length > 0 && verdicts.every((v) => v.ok);

  const result = {
    template: args.templatePath ?? "",
    filled: args.filledPath,
    status: ranOk ? "ok" : "error",
    valid,
    returns: verdicts.map((v) => ({
      name: v.name,
      bind: returns[v.name]?.bind ?? v.name,
      ok: v.ok,
      observedClass: v.observed,
      expected: returns[v.name]?.isinstance ?? "",
    })),
    chunks: 0,
    recorderArmed: false,
    stdout: run.stdout,
    stderr: run.stderr,
    timestamp: now(),
  };

  const inst =
    args.filledPath.split("/").pop()?.replace(/[^A-Za-z0-9_-]/g, "_") ??
      "notebook";
  const handle = await context.writeResource("execution", inst, result);
  context.logger.info(
    "run-notebook {filled}: valid={valid} ({n} returns)",
    { filled: args.filledPath, valid, n: verdicts.length },
  );
  return { dataHandles: [handle] };
}
