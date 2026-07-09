/**
 * Tests for @vcjdeboer/session-execute matcher.ts — the recorded-value judge.
 *
 * Pure unit tests (no runtime): the matcher renders each recorded return + frozen
 * rule into an R verification epilogue (baking the recorded value into generated
 * assertion code) and parses the TSV verdict the epilogue writes. Whether the
 * generated R actually passes/fails against a live binding is an INTEGRATION
 * concern (needs nix R) covered separately.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildMatcherEpilogue,
  type MatchReturn,
  MatchSpecSchema,
  parseMatchVerdict,
  summarizeReplay,
} from "./matcher.ts";

Deno.test("buildMatcherEpilogue bakes recorded value + tolerance into a bounded compare for a scalar-tol return", () => {
  const returns: MatchReturn[] = [{
    name: "estimate",
    bind: "coef(fit)[1]",
    tier: "headline",
    recorded: 3.14159,
    rule: { kind: "scalar-tol", rel: 1e-6 },
  }];
  const epi = buildMatcherEpilogue(returns, "/tmp/verify.tsv");

  // one verdict-append per return
  assertEquals(epi.split(".swr_rows <- c(.swr_rows,").length - 1, 1);
  // the binding under test appears
  assert(epi.includes("coef(fit)[1]"), "epilogue references the R binding");
  // the recorded value is baked in
  assert(epi.includes("3.14159"), "epilogue bakes the recorded value");
  // the tolerance is baked in and used in a bounded (<=) comparison
  assert(epi.includes("0.000001"), "epilogue bakes the relative tolerance");
  assert(epi.includes("<="), "epilogue uses a bounded comparison");
  // results are written to the given verify path
  assert(
    epi.includes(`writeLines(.swr_rows, "/tmp/verify.tsv")`),
    "epilogue writes rows to the verify path",
  );
});

Deno.test("parseMatchVerdict parses TSV rows into typed verdicts, ok TRUE->true, skipping blank lines", () => {
  const text =
    "estimate\theadline\tTRUE\t3.14159\n\nslope\tsupporting\tFALSE\t2.5\n";
  const rows = parseMatchVerdict(text);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], {
    name: "estimate",
    tier: "headline",
    ok: true,
    observed: "3.14159",
  });
  assertEquals(rows[1], {
    name: "slope",
    tier: "supporting",
    ok: false,
    observed: "2.5",
  });
});

Deno.test("summarizeReplay reports reproduced when every headline row passes", () => {
  const s = summarizeReplay([
    { name: "a", tier: "headline", ok: true, observed: "1" },
    { name: "b", tier: "headline", ok: true, observed: "2" },
  ]);
  assertEquals(s.reproduced, true);
  assertEquals(s.firstDivergence, null);
});

Deno.test("summarizeReplay is not reproduced when there are no headline rows", () => {
  const s = summarizeReplay([
    { name: "x", tier: "supporting", ok: true, observed: "1" },
  ]);
  assertEquals(s.reproduced, false);
});

Deno.test("summarizeReplay localizes the first divergence in order when a headline row fails", () => {
  const s = summarizeReplay([
    { name: "pre", tier: "supporting", ok: true, observed: "ok" },
    { name: "fit", tier: "supporting", ok: false, observed: "3.2" },
    { name: "estimate", tier: "headline", ok: false, observed: "9.9" },
  ]);
  assertEquals(s.reproduced, false);
  assertEquals(s.firstDivergence, {
    name: "fit",
    tier: "supporting",
    observed: "3.2",
  });
});

Deno.test("buildMatcherEpilogue renders exact value identity for a checksum-exact return", () => {
  const returns: MatchReturn[] = [{
    name: "n_groups",
    bind: "nlevels(df$grp)",
    tier: "headline",
    recorded: "4",
    rule: { kind: "checksum-exact" },
  }];
  const epi = buildMatcherEpilogue(returns, "/tmp/v.tsv");
  assert(epi.includes("identical("), "uses identical() for exact match");
  assert(epi.includes("nlevels(df$grp)"), "references the binding");
  assert(epi.includes(`"4"`), "bakes the recorded value as a string literal");
});

Deno.test("buildMatcherEpilogue normalizes both sides in R for a text-normalized return", () => {
  const returns: MatchReturn[] = [{
    name: "summary_line",
    bind: "capture.output(print(x))[1]",
    tier: "headline",
    recorded: "Estimate:  3.14",
    rule: { kind: "text-normalized", normalizers: ["trim", "collapse-ws"] },
  }];
  const epi = buildMatcherEpilogue(returns, "/tmp/v.tsv");
  assert(
    epi.includes("identical("),
    "compares normalized strings with identical()",
  );
  assert(epi.includes("trimws("), "applies the trim normalizer in R");
  assert(epi.includes("gsub("), "applies the collapse-ws normalizer in R");
  assert(
    epi.includes("capture.output(print(x))[1]"),
    "references the binding under normalization",
  );
});

Deno.test("buildMatcherEpilogue renders all.equal with tolerance for a numeric-leaf return", () => {
  const returns: MatchReturn[] = [{
    name: "coefs",
    bind: "unname(coef(fit))",
    tier: "headline",
    recorded: "c(1.5, -2.0)",
    rule: { kind: "numeric-leaf", rel: 1e-8 },
  }];
  const epi = buildMatcherEpilogue(returns, "/tmp/v.tsv");
  assert(
    epi.includes("all.equal("),
    "uses all.equal for structural numeric compare",
  );
  assert(epi.includes("unname(coef(fit))"), "references the binding");
  assert(epi.includes("c(1.5, -2.0)"), "bakes the recorded vector expression");
  assert(epi.includes("tolerance = 1e-8"), "passes the tolerance");
});

Deno.test("buildMatcherEpilogue skips figure returns (no verdict row) but keeps others", () => {
  const returns: MatchReturn[] = [
    {
      name: "plot1",
      bind: "last_plot()",
      tier: "supporting",
      rule: { kind: "figure", mode: "skip" },
    },
    {
      name: "est",
      bind: "coef(fit)[1]",
      tier: "headline",
      recorded: 1.0,
      rule: { kind: "scalar-tol", abs: 1e-9 },
    },
  ];
  const epi = buildMatcherEpilogue(returns, "/tmp/v.tsv");
  assertEquals(
    epi.split(".swr_rows <- c(.swr_rows,").length - 1,
    1,
    "only the non-figure return produces a verdict row",
  );
  assert(!epi.includes("last_plot()"), "figure binding is not asserted");
  assert(epi.includes("coef(fit)[1]"), "the scalar return is asserted");
});

Deno.test("MatchSpecSchema validates a well-formed spec and defaults return tier to headline", () => {
  const spec = MatchSpecSchema.parse({
    registryVersion: "2026.07.09.1",
    language: "r",
    flakeRef: "path:./locked-env",
    code: ["fit <- lm(y ~ x, df)"],
    returns: [{
      name: "est",
      bind: "coef(fit)[1]",
      recorded: 3.14,
      rule: { kind: "scalar-tol", rel: 1e-6 },
    }],
  });
  assertEquals(spec.returns[0].tier, "headline");
  assertEquals(spec.language, "r");
  assertEquals(spec.registryVersion, "2026.07.09.1");
});

Deno.test("MatchSpecSchema rejects a non-R language in v1", () => {
  assertThrows(() =>
    MatchSpecSchema.parse({
      registryVersion: "1",
      language: "python",
      flakeRef: "x",
      code: [],
      returns: [],
    })
  );
});

Deno.test("buildMatcherEpilogue renders ggplot_build data compare for a figure-data return", () => {
  const returns: MatchReturn[] = [{
    name: "scatter",
    bind: "p",
    tier: "headline",
    recordedRef: "/base/scatter.rds",
    rule: { kind: "figure-data", rel: 1e-8 },
  }];
  const epi = buildMatcherEpilogue(returns, "/tmp/v.tsv");
  assert(
    epi.includes("ggplot_build(p)$data"),
    "extracts the plot's built data",
  );
  assert(epi.includes("all.equal("), "compares structurally with tolerance");
  assert(epi.includes("readRDS("), "loads the recorded baseline data file");
  assert(epi.includes("/base/scatter.rds"), "references the baseline path");
  assert(epi.includes("tolerance = 1e-8"), "passes the tolerance");
});
