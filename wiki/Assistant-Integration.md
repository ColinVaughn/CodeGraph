# Assistant Integration

`codegraph install` wires the CodeGraph skill into a host AI assistant so it
queries the graph before falling back to broad file exploration. It writes a
per-platform skill file (where the platform has one), injects an always-on
instructions section into the platform's instructions file, and (for Claude
Code) registers `PreToolUse` hooks in `.claude/settings.json`. All writes are
idempotent and target the current working directory.

The companion `codegraph uninstall` reverses it, and `codegraph skill
check`/`bless` guard the generated artifacts against drift (a dev/CI tool).

## Install

```
codegraph install [platform]
```

`platform` defaults to `claude`. Files are written under the current directory
(the repo root). The command prints each path it wrote.

```
codegraph install
codegraph install agents
codegraph install copilot
```

### Supported platforms

| Argument(s) | Skill file | Always-on instructions file | settings.json hooks |
|---|---|---|---|
| `claude` | `.claude/skills/codegraph/SKILL.md` | `CLAUDE.md` | yes |
| `agents`, `agent`, `codex`, `opencode` | none | `AGENTS.md` | no |
| `gemini` | none | `GEMINI.md` | no |
| `cursor` | none | `.cursorrules` | no |
| `copilot`, `github-copilot` | none | `.github/copilot-instructions.md` | no |
| `kilo`, `kilocode` | none | `.kilocode/rules/codegraph.md` | no |

Platform names are case-insensitive. `codex` and `opencode` both map onto the
`agents` platform because both read `AGENTS.md`. Only Claude gets a dedicated
`SKILL.md`; the other platforms consume the always-on instructions file directly.
Any needed parent directories (for example `.github/`, `.kilocode/rules/`) are
created.

### What gets written

1. **Skill file** (Claude only): `.claude/skills/codegraph/SKILL.md`. It carries
   frontmatter (`name: codegraph`) and instructs the assistant to query the graph
   before grepping or broad reading, listing the build/query CLI commands and the
   MCP tools (see [MCP-Server](MCP-Server)).

2. **Always-on section**: a marked block injected into the platform's
   instructions file:

   ```
   <!-- codegraph:start -->
   ## CodeGraph

   This repo has a CodeGraph knowledge graph (`codegraph-out/graph.json`). Query it
   before broad file exploration: `codegraph query "<question>"`, `codegraph affected
   <node>`, or run `codegraph serve` for the MCP tools. Rebuild with `codegraph
   extract .` / `codegraph update <files>`.
   <!-- codegraph:end -->
   ```

   The block is delimited by `<!-- codegraph:start -->` and
   `<!-- codegraph:end -->`. On reinstall it is replaced in place (never
   duplicated), and any prose around it is preserved. A new instructions file is
   created if none exists.

3. **PreToolUse hooks** (Claude only): two entries merged into
   `.claude/settings.json` under `hooks.PreToolUse` (see below).

### Idempotency

Install can be run repeatedly without piling up duplicates:

- The always-on block is matched by its marker and replaced in place. A truncated
  or hand-edited block (a dangling start marker) is repaired into a single clean
  block.
- The settings hooks are matched by matcher plus the literal `codegraph` in the
  body; any prior CodeGraph hooks are removed before the current pair is appended,
  so a reinstall keeps exactly two. Foreign hooks and unrelated top-level
  settings keys are preserved. A corrupt `settings.json` is treated as empty and
  rewritten.

## How the hooks nudge the assistant

For Claude, two `PreToolUse` hooks are written into `.claude/settings.json`. They
**nudge, never block** (they fail open, so a legitimate tool call always
proceeds), and they only fire when `codegraph-out/graph.json` exists. Each hook's
shell snippet parses the tool input with `python3`.

- **Bash matcher**: fires when a shell command looks like a search
  (`grep`, `rg`, `ripgrep`, `find`, `fd`, `ack`, `ag`). It injects additional
  context telling the assistant to run `codegraph query "<question>"` before
  grepping raw files.
- **Read|Glob matcher**: fires when a `Read`/`Glob` targets a source or doc file
  (by extension, for example `.py .js .ts .go .rs .java .md` and many others)
  outside `codegraph-out/`. It injects context telling the assistant to run
  `codegraph query` / `codegraph explain` / `codegraph path` first, and to carry
  the same rule into subagent prompts.

When a hook fires, Claude Code receives the `additionalContext` text as a
`PreToolUse` hook output, steering the assistant toward the graph before it reads
or greps. Because the hook is gated on `codegraph-out/graph.json`, nothing fires
until a graph has been built (see [Quickstart](Quickstart) and
[Extraction](Extraction)).

## Uninstall

```
codegraph uninstall [platform]
codegraph uninstall --all
```

`platform` defaults to `claude`. Uninstall removes the dedicated skill file (if
any), tidies now-empty skill directories, and strips the always-on marker block
from the instructions file. If nothing else remains in that file, the file is
removed; otherwise the surrounding prose and its blank-line spacing are
preserved. For Claude it also removes exactly the CodeGraph `PreToolUse` hooks,
leaving foreign hooks intact. `--all` uninstalls from every supported platform.

## Skill drift commands

The skill artifacts are generated by pure slot substitution over an embedded
template, with a committed golden snapshot tree (`expected/`) next to the
skillgen crate source. These commands are dev/CI tools run from a repo checkout:

```
codegraph skill check
codegraph skill bless
```

- `codegraph skill check` re-renders every artifact (one per platform plus the
  shared always-on section) and byte-diffs it against the committed snapshots
  (ignoring line-ending style). It prints `skill artifacts are in sync with
  expected/.` when clean, or lists each drift and exits non-zero. A `cargo test`
  run also fails on drift.
- `codegraph skill bless` rewrites the committed snapshot tree from the current
  render, printing the paths written. Run it after an intentional template
  change.

Note: because the snapshot tree is resolved relative to the crate source, these
commands are meaningful only from a repo checkout; an installed binary reports the
snapshots missing by design.

## See also

- [MCP-Server](MCP-Server) -- run `codegraph serve` and the tools the skill
  points an assistant at.
- [Quickstart](Quickstart) -- build a graph first so the hooks activate.
- [Configuration](Configuration) -- environment variables and settings.
- [Commands](Commands) -- the full CLI reference.
