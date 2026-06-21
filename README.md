# @vcjdeboer/session-execute

The **perform** member of the swamp `session-*` suite — a headless **runtime**
for governed analysis templates. It runs a filled template's code in a pinned
nix R environment with the [`swamprecord`](https://github.com/vcjdeboer/swamprecord)
recorder **armed**, so the same typed provenance a live RStudio/Jupyter session
would capture is written headlessly, then verifies the run against the
template's `swamp.returns` contract.

## Installation

```sh
swamp extension pull @vcjdeboer/session-execute
```

## Methods

- **`run`** — run a filled `.qmd` template's R chunks headless with the recorder armed; verify `swamp.returns`. Writes `execution { status, valid, returns[] }`.
- **`run-targets`** — run a `targets` pipeline and harvest its native provenance (one record per target). Writes `targets { status, targets, ok, errors }`.

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

## Part of the session-* suite

- [`@vcjdeboer/session-write`](https://github.com/vcjdeboer/session-write) — fill + validate a template
- [`@vcjdeboer/session-record`](https://github.com/vcjdeboer/session-record) — the ledger it writes into
- [`@vcjdeboer/session-witness`](https://github.com/vcjdeboer/session-witness) — seal the recorded session

Requires the R recorder ([`swamprecord`](https://github.com/vcjdeboer/swamprecord)) and the R env flake from [`session-suite`](https://github.com/vcjdeboer/session-suite) — place `r-env/` at `./r-env` or set `SWAMP_R_ENV`.

## License

MIT — see LICENSE.md.
