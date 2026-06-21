# @vcjdeboer/session-execute

The **perform** member of the swamp `session-*` suite — a headless **runtime**
for governed analysis templates. It runs a filled template's code in a pinned
nix R environment with the [`swamprecord`](https://github.com/vcjdeboer/swamprecord)
recorder **armed**, so the same typed provenance a live RStudio/Jupyter session
would capture is written headlessly, then verifies the run against the
template's `swamp.returns` contract.

In other words: take a template that
[`session-write`](https://github.com/vcjdeboer/session-write) has filled and
validated, run it for real, record everything it did, and assert it produced the
objects it promised — all without a human at the keyboard.

## Installation

```sh
swamp extension pull @vcjdeboer/session-execute
swamp model create @vcjdeboer/session-execute executor
```

## Usage

Run a filled `.qmd` template headless (records land in your `session-record`
instance, `rec`):

```sh
swamp model method run executor run \
    --input filledPath=cars.qmd \
    --input templatePath=lm-report.qmd
```

The `run` method writes an `execution { status, valid, returns[] }` resource —
`valid` is the result of checking the realized objects against the template's
`swamp.returns` contract (e.g. *the model inherits `lm`*, *the figure inherits
`ggplot`*). To run a `targets` pipeline instead and harvest one record per
target:

```sh
swamp model method run executor run-targets \
    --input pipelineDir=targets-lm
```

## Methods

- **`run`** — run a filled `.qmd` template's R chunks headless with the recorder
  armed; verify `swamp.returns`. Writes `execution { status, valid, returns[] }`.
- **`run-targets`** — run a `targets` pipeline and harvest its native provenance
  (one `session-record` entry per target). Writes
  `targets { status, targets, ok, errors }`.

## Configuration

It shells out to nix, R, swamp, and the swamprecord hook, so its definition-level
global args point at those. Defaults assume the binaries are on `PATH` and the
suite lives under the current repo — override per-definition for absolute paths:

| arg | default | purpose |
| --- | --- | --- |
| `nixBin` / `swampBin` | `nix` / `swamp` | binaries (on PATH) |
| `flakeRef` | `path:./r-env` | the R env flake (see r-env/flake.nix) |
| `hookPath` / `harvestPath` | `./swamprecord/...` | the recorder loader + targets harvester |
| `repoDir` | `.` | the swamp repo the recorder writes into |
| `recordDef` | `rec` | the `session-record` instance |
| `timeoutMs` | `300000` | kill a run that exceeds this |

## How it works

`run` parses the template's `params:` into a preamble, extracts the R chunks,
`source()`s the swamprecord hook to arm the recorder, and runs the chunks inside
`nix shell <flakeRef>#rEnv` so the R toolchain is pinned and reproducible. The
recorder ships one record per top-level expression (synchronously, because a
headless R wipes its tempdir on exit). A generated epilogue then evaluates the
`swamp.returns` contract against the live bindings and reports `valid`.
`run-targets` swaps the REPL recorder for a harvester: `tar_make()` runs each
target in its own subprocess, and the harvester reads targets' native
`tar_meta` / `tar_network` provenance into the same ledger.

## Part of the session-* suite

- [`@vcjdeboer/session-write`](https://github.com/vcjdeboer/session-write) — fill + validate a template
- [`@vcjdeboer/session-record`](https://github.com/vcjdeboer/session-record) — the ledger it writes into
- [`@vcjdeboer/session-witness`](https://github.com/vcjdeboer/session-witness) — seal the recorded session

Requires the R recorder ([`swamprecord`](https://github.com/vcjdeboer/swamprecord))
and the R env flake from [`session-suite`](https://github.com/vcjdeboer/session-suite) —
place `r-env/` at `./r-env` or set `SWAMP_R_ENV`.

## License

MIT — see LICENSE.md.
