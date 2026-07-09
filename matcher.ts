/**
 * @vcjdeboer/session-execute — matcher.ts
 *
 * The recorded-value JUDGE for faithful replay (task #28). Sibling to
 * `buildEpilogue` in session_execute.ts: where `run` verifies a live R session
 * against an abstract `swamp.returns` contract, `replay` verifies it against the
 * RECORDED VALUES a session-record capture froze — judged by per-return tolerance
 * rules that were bound at ingest and sealed.
 *
 * `buildMatcherEpilogue` is a PURE function: it renders each recorded return + its
 * frozen rule into R assertion code (baking the recorded value into the generated
 * source) that writes a TSV verdict. The comparison runs in R against the live
 * binding; this module only generates the code and parses the result. Determinism
 * lives here — same (recorded value, rule) always renders the same assertion.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The frozen comparison rule for one recorded return (the rule VOCABULARY). */
export const MatchRuleSchema = z.discriminatedUnion("kind", [
  /** Numeric scalar within a relative and/or absolute tolerance. */
  z.object({
    kind: z.literal("scalar-tol"),
    rel: z.number().optional(),
    abs: z.number().optional(),
  }),
  /** Byte/value-identical (categorical, integer, or a content checksum). */
  z.object({ kind: z.literal("checksum-exact") }),
  /** Vector/data.frame/array: structural compare, tolerance on numeric leaves. */
  z.object({
    kind: z.literal("numeric-leaf"),
    rel: z.number().optional(),
    abs: z.number().optional(),
  }),
  /** A plot's UNDERLYING data: `ggplot_build(<bind>)$data`, compared as data. */
  z.object({
    kind: z.literal("figure-data"),
    rel: z.number().optional(),
    abs: z.number().optional(),
  }),
  /** Printed/console text, compared after normalization. */
  z.object({
    kind: z.literal("text-normalized"),
    normalizers: z.array(z.enum(["trim", "collapse-ws", "strip-times"]))
      .default([]),
  }),
  /** A figure/plot — v1 default `skip` (least faithful surface). */
  z.object({
    kind: z.literal("figure"),
    mode: z.enum(["skip", "structural"]).default("skip"),
  }),
]);
export type MatchRule = z.infer<typeof MatchRuleSchema>;

/** One recorded return to match: the binding, its recorded value, and its rule. */
export const MatchReturnSchema = z.object({
  /** Return name (the finding's label). */
  name: z.string(),
  /** The R binding to evaluate in the live session, e.g. `coef(fit)[1]`. */
  bind: z.string(),
  /** `headline` = the finding (Tier 1); `supporting` = localization (Tier 2). */
  tier: z.enum(["headline", "supporting"]).default("headline"),
  /** The recorded value to match against (scalar/text/raw-R-expr for numeric-leaf). */
  recorded: z.union([z.number(), z.string()]).optional(),
  /**
   * Path to a recorded BASELINE data file (RDS) for data-frame findings — tables
   * and figure-data, whose baseline is too large to bake inline. Written by the
   * instrumented baseline run at ingest.
   */
  recordedRef: z.string().optional(),
  rule: MatchRuleSchema,
});
export type MatchReturn = z.infer<typeof MatchReturnSchema>;

/** One parsed verdict row: did the live binding match its recorded value? */
export interface MatchVerdict {
  name: string;
  tier: "headline" | "supporting";
  ok: boolean;
  /** `as.character()` of the live binding (or `<error>` if it did not resolve). */
  observed: string;
}

/**
 * Parse the epilogue's `name<TAB>tier<TAB>ok<TAB>observed` TSV into typed
 * verdicts, skipping blank lines. `ok` is TRUE iff the R assertion held.
 */
export function parseMatchVerdict(text: string): MatchVerdict[] {
  const out: MatchVerdict[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [name, tier, ok, observed] = line.split("\t");
    out.push({
      name: name ?? "",
      tier: tier === "supporting" ? "supporting" : "headline",
      ok: ok === "TRUE",
      observed: observed ?? "",
    });
  }
  return out;
}

/** The overall Tier-1/Tier-2 outcome of a replay run. */
export interface ReplaySummary {
  /** True iff there is ≥1 headline row and every headline row matched (Tier 1). */
  reproduced: boolean;
  /** First non-matching row in execution order (Tier-2 localization), else null. */
  firstDivergence: {
    name: string;
    tier: "headline" | "supporting";
    observed: string;
  } | null;
}

/**
 * Fold parsed verdicts into a replay outcome. Reproduced = every headline return
 * matched (the finding stands). First divergence = the first row that failed, in
 * the order given (headline for Tier 1; supporting bindings interleaved in
 * execution order for Tier-2 localization).
 */
export function summarizeReplay(rows: MatchVerdict[]): ReplaySummary {
  const headlines = rows.filter((r) => r.tier === "headline");
  const reproduced = headlines.length > 0 && headlines.every((r) => r.ok);
  const first = rows.find((r) => !r.ok);
  return {
    reproduced,
    firstDivergence: first
      ? { name: first.name, tier: first.tier, observed: first.observed }
      : null,
  };
}

/**
 * The frozen replay contract: what session-ingest produces at ingest and
 * session-execute's `replay` method consumes. The recorded values + rules travel
 * inside it, so replay is a pure function of this spec + a fresh run. v1 is R-only.
 */
export const MatchSpecSchema = z.object({
  /** The rule-registry version the rules were bound from (for provenance). */
  registryVersion: z.string(),
  /** Analysis language. v1 = R only (Python/Jupyter rides parked execute work). */
  language: z.literal("r"),
  /** The locked-env flake reference replay points nix at (falls back to Docker). */
  flakeRef: z.string(),
  /** The captured analysis code, ordered, run before the matcher epilogue. */
  code: z.array(z.string()),
  /** The recorded returns to match, each with its frozen rule. */
  returns: z.array(MatchReturnSchema),
});
export type MatchSpec = z.infer<typeof MatchSpecSchema>;

/** R string literal (double-quoted, JSON-compatible escapes). */
function rstr(v: string): string {
  return JSON.stringify(v);
}

/** R numeric literal — JS number formatting is valid R (`1e-06` → `1e-6` etc.). */
function rnum(n: number): string {
  return String(n);
}

/** Wrap an R string expression in the requested normalizer transforms. */
function rNormalize(expr: string, normalizers: string[]): string {
  let e = expr;
  for (const n of normalizers) {
    if (n === "strip-times") {
      // ISO-8601-ish timestamps -> "" (dates/times are non-reproducible noise)
      e = `gsub("[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:]+", "", ${e})`;
    } else if (n === "collapse-ws") {
      e = `gsub("[[:space:]]+", " ", ${e})`;
    } else if (n === "trim") {
      e = `trimws(${e})`;
    }
  }
  return e;
}

/**
 * A SAFE R expression for the observed column — never an object/data.frame that
 * `as.character` cannot coerce (which would throw). Scalars/text render their
 * value; data-frame/figure findings render a short label.
 */
function observedExpr(r: MatchReturn): string {
  switch (r.rule.kind) {
    case "numeric-leaf":
      return rstr("<data>");
    case "figure-data":
      return rstr("<figure-data>");
    default:
      return r.bind;
  }
}

/** The R boolean expression that is TRUE iff the live binding matches the record. */
function okExpr(r: MatchReturn): string {
  const rule = r.rule;
  switch (rule.kind) {
    case "scalar-tol": {
      const rec = typeof r.recorded === "number"
        ? r.recorded
        : Number(r.recorded);
      const rel = rule.rel ?? 0;
      const abs = rule.abs ?? 0;
      // |bind - recorded| <= abs + rel*|recorded|
      return `abs((${r.bind}) - (${rnum(rec)})) <= (${rnum(abs)}) + (${
        rnum(rel)
      }) * abs((${rnum(rec)}))`;
    }
    case "checksum-exact": {
      // Exact value identity for a live binding (categorical/integer/label):
      // compare the character rendering to the recorded string.
      return `identical(as.character(${r.bind}), ${
        rstr(String(r.recorded ?? ""))
      })`;
    }
    case "numeric-leaf": {
      // Structural compare of a vector/data.frame/array with tolerance on numeric
      // leaves. Baseline is a file (`recordedRef` -> readRDS) when present, else a
      // raw R expression in `recorded` (same trust model as `bind`, injected raw).
      const tol = rule.rel ?? rule.abs ?? 1e-8;
      const baseline = r.recordedRef
        ? `readRDS(${rstr(r.recordedRef)})`
        : String(r.recorded ?? "");
      return `isTRUE(all.equal(${r.bind}, ${baseline}, tolerance = ${
        rnum(tol)
      }))`;
    }
    case "figure-data": {
      // Check the DATA behind a ggplot, not its pixels: compare the computed
      // geometry (`ggplot_build(p)$data`) against the recorded baseline RDS.
      const tol = rule.rel ?? rule.abs ?? 1e-8;
      return `isTRUE(all.equal(ggplot2::ggplot_build(${r.bind})$data, ` +
        `readRDS(${rstr(r.recordedRef ?? "")}), tolerance = ${rnum(tol)}))`;
    }
    case "text-normalized": {
      // Normalize BOTH the live binding and the recorded literal with the SAME R
      // transforms, then compare — so normalization can never drift between the
      // TS side and the R side (both run in R).
      const live = rNormalize(`as.character(${r.bind})`, rule.normalizers);
      const rec = rNormalize(rstr(String(r.recorded ?? "")), rule.normalizers);
      return `identical(${live}, ${rec})`;
    }
    default:
      throw new Error(
        `buildMatcherEpilogue: unsupported rule kind '${rule.kind}'`,
      );
  }
}

/**
 * Generate the R verification epilogue that matches each recorded return against
 * the live session, writing `name<TAB>tier<TAB>ok<TAB>observed` rows to
 * `verifyPath`. Mirrors session_execute.ts `buildEpilogue`.
 */
export function buildMatcherEpilogue(
  returns: MatchReturn[],
  verifyPath: string,
): string {
  const lines = [".swr_rows <- character(0)"];
  for (const r of returns) {
    if (r.rule.kind === "figure") {
      // v1: figures are the least faithful surface — `skip` renders no assertion.
      if (r.rule.mode === "structural") {
        throw new Error(
          "buildMatcherEpilogue: figure 'structural' not supported in v1",
        );
      }
      continue;
    }
    const ok = okExpr(r);
    const obs = observedExpr(r);
    // Compute ok and observed under SEPARATE guards so a failure to render the
    // observed value (e.g. as.character on a ggplot object) can never flip ok.
    lines.push(
      `.swr_ok <- tryCatch(isTRUE(${ok}), error = function(e) FALSE)`,
      `.swr_obs <- tryCatch(as.character(${obs})[1], error = function(e) "<obs-error>")`,
      `.swr_rows <- c(.swr_rows, paste(${rstr(r.name)}, ${rstr(r.tier)}, ` +
        `.swr_ok, .swr_obs, sep = "\\t"))`,
    );
  }
  lines.push(`writeLines(.swr_rows, ${rstr(verifyPath)})`);
  return lines.join("\n");
}
