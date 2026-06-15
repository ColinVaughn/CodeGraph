# Development

This page covers building, testing, and the repository layout for contributors.

## Toolchain

- **Rust 1.95**, pinned in `rust-toolchain.toml` (with `rustfmt` and `clippy` components).
- Edition 2021. The workspace `rust-version` is `1.95`.

## Build, test, lint

These are the exact commands CI runs:

```sh
# Format check
cargo fmt --all --check

# Lint (warnings are errors)
cargo clippy --workspace --all-targets --all-features -- -D warnings

# Full test suite
cargo test --workspace --all-features
```

A release build of just the binary:

```sh
cargo build --release --locked -p codegraph
```

## Per-language testing

Every language extractor can be built and tested in isolation so a grammar bump that
silently drops nodes or edges fails on its own:

```sh
cargo test -p codegraph-extract --no-default-features --features lang-rust
```

CI runs this across a matrix of grammar-backed languages. See [Languages](Languages).

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request with three jobs:

- **lint** - `cargo fmt --all --check` and `cargo clippy ... -D warnings`.
- **test** - `cargo test --workspace --all-features` on Linux, macOS, and Windows.
- **extract-langs** - a matrix that tests each grammar-backed language on its own
  (`--no-default-features --features lang-<name>`).

`.github/workflows/release.yml` runs on `v*` tags (and manual dispatch): it cross-compiles
the binary for Linux (`x86_64`), macOS (`x86_64` and `aarch64`), and Windows (`x86_64`),
packages each with the README/LICENSE/CHANGELOG, and publishes a GitHub Release.

## Benchmarks

Several crates ship Criterion benchmarks (for example `codegraph-extract`,
`codegraph-detect`, `codegraph-output`). Run them with:

```sh
cargo bench
```

## Repository layout

```
crates/
  codegraph-core/         data model + graph.json DTO + validation
  codegraph-detect/       discovery, classification, ignore rules
  codegraph-extract/      tree-sitter + regex extractors (lang-* features)
  codegraph-graph/        build, dedup, clustering, analysis
  codegraph-semantic/     LLM semantic pass
  codegraph-llm/          LLM client + provider registry
  codegraph-query/        query / path / explain / affected
  codegraph-output/       graph.json + viewers + exports
  codegraph-report/       GRAPH_REPORT.md
  codegraph-ingest/       external-source ingestion
  codegraph-server/       MCP server + REST
  codegraph-prs/          PR dashboard
  codegraph-incremental/  incremental rebuild, watch, hooks
  codegraph-workspace/    multi-repo federation
  codegraph-skillgen/     assistant skill + hooks generation
bin/
  codegraph/              the CLI
```

See [Architecture](Architecture) for what each crate does and how the pipeline fits together.

## Conventions

- All shared dependencies are declared once in the root `Cargo.toml` `[workspace.dependencies]`
  and referenced with `workspace = true` from member crates.
- The graph output is deterministic; tests assert byte-stable `graph.json` where relevant, so
  avoid introducing nondeterministic iteration order.
- Edges carry an explicit confidence level; prefer `INFERRED`/`AMBIGUOUS` over `EXTRACTED`
  when a relationship is heuristic.
