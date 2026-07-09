# @vcjdeboer/session-execute

**The headless runtime of the [`session-*`](https://github.com/vcjdeboer/session-record) suite — run a governed template, or *replay* a captured session, deterministically.**

Part of the session-* suite for provenance and governed authoring in interactive
data science, built on [swamp](https://github.com/swamp-club/swamp). This is the
**Perform** step: it runs analysis code headless and either records the same typed
provenance a live session would, or judges a fresh run against a frozen contract.

## Methods

| Method | Runs |
| --- | --- |
| `run` | a filled `.qmd` template's R code headless in a pinned **nix** R env, recorder armed, then verifies it against the template's `swamp.returns` contract (e.g. *the result inherits `lm`*) |
| `run-targets` | a `targets` pipeline (`tar_make`), harvesting its native `tar_meta` provenance into `session-record` |
| `run-notebook` | a filled `.ipynb` headless via **papermill in the locked conda/Docker env**, verifying `swamp.returns` with an appended Python check cell — the Python/ipynb analog of `run` |
| `replay` | faithfully re-runs a frozen **MatchSpec**'s captured R code in the locked env (nix preferred, docker fallback) and judges the fresh run against the recorded values via per-return tolerance rules |

## Replaying a foreign session

`run-notebook` also drives **[session-ingest](https://github.com/vcjdeboer/session-ingest)**
replays: it prepends a captured session's used **skills** and a **host-replay shim**
that serves recorded `host.*` calls offline (`hostMode: replay`) — or, in `hybrid`
mode, falls through to the *live* public API a Claude Science tool wraps (e.g.
`query_genes → mygene.info`) only for calls the recording can't answer. So a
Claude Science analysis can be reproduced *exactly*, or *extended* with live data.

## Install

```sh
swamp extension pull @vcjdeboer/session-execute
swamp model create @vcjdeboer/session-execute executor
```

Configure the env via global arguments (`nixBin`, `flakeRef`, `rPackage`, …) in the
local model definition; portable defaults ship with the type.

## License

See [LICENSE.md](./LICENSE.md). MIT. Part of a swamp workspace; each component is
independently installable.
