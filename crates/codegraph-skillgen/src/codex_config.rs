//! Codex-native integration written under a repo's `.codex/`: an MCP server
//! registration plus a lifecycle hook. This is the "full install" for Codex,
//! mirroring what the Claude install does via `.claude/`.
//!
//! Codex reads MCP servers from `.codex/config.toml` (`[mcp_servers.<id>]`) and
//! lifecycle hooks from `.codex/hooks.json`. Both project-scoped files load only
//! when the user trusts the project in Codex.
//!
//! Why a SessionStart hook (not PreToolUse like Claude): Codex does NOT honor
//! `additionalContext` on PreToolUse (it marks the hook run failed), and its
//! top-level `systemMessage` is UI-only and never reaches the model. SessionStart
//! `additionalContext` IS injected as model-visible developer context, so we
//! orient the agent once per session when a graph actually exists. The always-on
//! AGENTS.md block carries the same instruction persistently; the hook adds the
//! dynamic "a graph exists right now" signal that a static file can't.
//!
//! Everything here is idempotent and preserves foreign content: reinstalling
//! never duplicates our entries, and uninstall removes exactly ours (deleting a
//! file only once nothing of anyone's remains).

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use toml_edit::{value, Array, DocumentMut, Item, Table};

use crate::settings_hooks::{load_settings, write_settings};

/// Repo-relative path of the Codex MCP/config file.
const CONFIG_REL: &str = ".codex/config.toml";
/// Repo-relative path of the Codex hooks file.
const HOOKS_REL: &str = ".codex/hooks.json";
/// Repo-relative path of the hook's helper script.
const SCRIPT_REL: &str = ".codex/codegraph-hook.py";
/// The lifecycle event we hook (see the module docs for why not PreToolUse).
const HOOK_EVENT: &str = "SessionStart";

/// The hook body, as a self-contained Python script. Python (rather than a shell
/// snippet) keeps it identical across Codex's Unix shell and the Windows
/// `commandWindows` path, with no `case`/`[ -f ]` portability traps. Fails open:
/// any IO hiccup exits 0 so a session never stalls on the hook.
const HOOK_SCRIPT: &str = r#"#!/usr/bin/env python3
"""CodeGraph SessionStart hook for Codex.

Inject model-visible context, once per session, telling the agent to consult the
CodeGraph knowledge graph before grepping or reading files broadly. Only fires
when a graph exists in this repo. Fails open."""
import json
import os
import sys

# Drain the SessionStart payload on stdin; we only need the cwd (the project
# root), so the graph path stays relative.
try:
    sys.stdin.read()
except Exception:
    pass

if not os.path.isfile(os.path.join("codegraph-out", "graph.json")):
    sys.exit(0)

message = (
    "This repo has a CodeGraph knowledge graph (codegraph-out/graph.json). "
    "Before grepping or reading files broadly, query the graph: run "
    "`codegraph query \"<question>\"`, `codegraph explain <node>`, or "
    "`codegraph path <a> <b>`, or use the CodeGraph MCP tools (query_graph, "
    "get_neighbors, god_nodes, shortest_path). It is faster and surfaces calls, "
    "imports, inheritance, and impact. Read raw files once the graph has oriented you."
)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": message,
    }
}))
"#;

/// Install the Codex MCP server registration + SessionStart hook under `.codex/`.
/// Idempotent. Returns the paths written.
pub fn install(repo_root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    written.push(install_mcp_server(repo_root)?);
    written.extend(install_hook(repo_root)?);
    Ok(written)
}

/// Remove the Codex MCP server registration + hook. No-op if absent; foreign
/// servers/hooks are preserved.
pub fn uninstall(repo_root: &Path) -> std::io::Result<()> {
    uninstall_mcp_server(repo_root)?;
    uninstall_hook(repo_root)?;
    Ok(())
}

// --- MCP server (.codex/config.toml) ----------------------------------------

/// Our `[mcp_servers.codegraph]` table: launch `codegraph serve` (stdio MCP).
/// No `--graph` arg, so it defaults to `codegraph-out/graph.json` relative to the
/// server's cwd (the project root), keeping `config.toml` machine-independent
/// and safe to commit.
fn codegraph_server_table() -> Table {
    let mut server = Table::new();
    server["command"] = value("codegraph");
    let mut args = Array::new();
    args.push("serve");
    server["args"] = value(args);
    server["startup_timeout_sec"] = value(30_i64);
    server
}

/// Insert/replace `[mcp_servers.codegraph]` in `.codex/config.toml`, preserving
/// every other server and key (format-preserving via `toml_edit`). Idempotent.
fn install_mcp_server(repo_root: &Path) -> std::io::Result<PathBuf> {
    let path = repo_root.join(CONFIG_REL);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing.parse::<DocumentMut>().unwrap_or_default();

    // Ensure `mcp_servers` is a table holding sub-tables. When we create it,
    // mark it `implicit` so it emits `[mcp_servers.codegraph]` rather than a bare
    // `[mcp_servers]` header. A pre-existing table is left as the user wrote it
    // (we only insert our sub-table) so any direct keys/headers they have survive.
    let servers = doc.entry("mcp_servers").or_insert_with(|| {
        let mut t = Table::new();
        t.set_implicit(true);
        Item::Table(t)
    });
    match servers {
        Item::Table(t) => {
            t.insert("codegraph", Item::Table(codegraph_server_table()));
        }
        // `mcp_servers` exists but isn't a plain table (e.g. an array/value): replace.
        other => {
            let mut t = Table::new();
            t.set_implicit(true);
            t.insert("codegraph", Item::Table(codegraph_server_table()));
            *other = Item::Table(t);
        }
    }

    write_string(&path, &doc.to_string())?;
    Ok(path)
}

/// Remove `[mcp_servers.codegraph]`, dropping the `mcp_servers` table when it
/// becomes empty and the file when nothing remains. Foreign servers are kept.
fn uninstall_mcp_server(repo_root: &Path) -> std::io::Result<()> {
    let path = repo_root.join(CONFIG_REL);
    let Ok(existing) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let mut doc = existing.parse::<DocumentMut>().unwrap_or_default();
    if let Some(Item::Table(t)) = doc.get_mut("mcp_servers") {
        t.remove("codegraph");
        if t.is_empty() {
            doc.remove("mcp_servers");
        }
    }
    let out = doc.to_string();
    if out.trim().is_empty() {
        std::fs::remove_file(&path)?;
    } else {
        std::fs::write(&path, out)?;
    }
    Ok(())
}

// --- Lifecycle hook (.codex/hooks.json + helper script) ---------------------

/// Our hook entry: run the Python helper. No `matcher` (fire on every session
/// source). `commandWindows` uses `python` (the usual Windows launcher) since
/// Codex runs the Windows override through a different shell; `timeout` bounds a
/// stuck interpreter.
fn codegraph_hook_entry() -> Value {
    json!({
        "hooks": [{
            "type": "command",
            "command": "python3 .codex/codegraph-hook.py",
            "commandWindows": "python .codex/codegraph-hook.py",
            "timeout": 30
        }]
    })
}

/// True if `entry` is one of ours: its command runs our helper script. Matching
/// on the unique script path is unambiguous (no reliance on a matcher field,
/// which SessionStart entries omit).
fn is_codegraph_hook(entry: &Value) -> bool {
    entry.to_string().contains("codegraph-hook.py")
}

/// The current `hooks.<HOOK_EVENT>` array (empty if absent/misshaped).
fn event_entries(settings: &Map<String, Value>) -> Vec<Value> {
    settings
        .get("hooks")
        .and_then(|h| h.get(HOOK_EVENT))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Set `settings.hooks.<HOOK_EVENT>` to `entries`, creating the nested objects as
/// needed and preserving every other key.
fn set_event_entries(settings: &mut Map<String, Value>, entries: Vec<Value>) {
    let hooks = settings
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    if let Some(obj) = hooks.as_object_mut() {
        obj.insert(HOOK_EVENT.to_string(), Value::Array(entries));
    }
}

/// Write the hook into `.codex/hooks.json` (foreign hooks survive, reinstall
/// never duplicates) plus the helper script. Returns both paths.
fn install_hook(repo_root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let hooks_path = repo_root.join(HOOKS_REL);
    let mut settings = load_settings(&hooks_path);
    let mut entries: Vec<Value> = event_entries(&settings)
        .into_iter()
        .filter(|e| !is_codegraph_hook(e))
        .collect();
    entries.push(codegraph_hook_entry());
    set_event_entries(&mut settings, entries);
    write_settings(&hooks_path, &settings)?;

    let script_path = repo_root.join(SCRIPT_REL);
    write_string(&script_path, HOOK_SCRIPT)?;
    Ok(vec![hooks_path, script_path])
}

/// Remove our hook from `.codex/hooks.json` (dropping the now-empty event/`hooks`
/// keys and the file when nothing else remains) and delete the helper script.
/// Foreign hooks are preserved.
fn uninstall_hook(repo_root: &Path) -> std::io::Result<()> {
    let hooks_path = repo_root.join(HOOKS_REL);
    if hooks_path.exists() {
        let mut settings = load_settings(&hooks_path);
        let remaining: Vec<Value> = event_entries(&settings)
            .into_iter()
            .filter(|e| !is_codegraph_hook(e))
            .collect();
        if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
            if remaining.is_empty() {
                hooks.remove(HOOK_EVENT);
            } else {
                hooks.insert(HOOK_EVENT.to_string(), Value::Array(remaining));
            }
            if hooks.is_empty() {
                settings.remove("hooks");
            }
        }
        if settings.is_empty() {
            std::fs::remove_file(&hooks_path)?;
        } else {
            write_settings(&hooks_path, &settings)?;
        }
    }
    let _ = std::fs::remove_file(repo_root.join(SCRIPT_REL));
    Ok(())
}

/// Write `contents` to `path`, creating the parent directory (`.codex/`) first.
fn write_string(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn read(root: &Path, rel: &str) -> String {
        fs::read_to_string(root.join(rel)).unwrap()
    }

    #[test]
    fn install_writes_mcp_server_block() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root).unwrap();
        let toml = read(root, CONFIG_REL);
        assert!(toml.contains("[mcp_servers.codegraph]"), "{toml}");
        assert!(toml.contains("command = \"codegraph\""), "{toml}");
        assert!(toml.contains("serve"), "{toml}");
        // Round-trips as valid TOML with the expected command.
        let parsed: DocumentMut = toml.parse().unwrap();
        assert_eq!(
            parsed["mcp_servers"]["codegraph"]["command"].as_str(),
            Some("codegraph")
        );
    }

    #[test]
    fn install_preserves_a_foreign_mcp_server() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".codex")).unwrap();
        fs::write(
            root.join(CONFIG_REL),
            "[mcp_servers.other]\ncommand = \"thing\"\nargs = [\"x\"]\n",
        )
        .unwrap();
        install(root).unwrap();
        let toml = read(root, CONFIG_REL);
        assert!(toml.contains("[mcp_servers.other]"), "foreign kept: {toml}");
        assert!(
            toml.contains("[mcp_servers.codegraph]"),
            "ours added: {toml}"
        );
        let parsed: DocumentMut = toml.parse().unwrap();
        assert_eq!(
            parsed["mcp_servers"]["other"]["command"].as_str(),
            Some("thing")
        );
    }

    #[test]
    fn install_preserves_explicit_mcp_servers_header_with_direct_keys() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".codex")).unwrap();
        // A user who wrote an explicit [mcp_servers] header with a direct key
        // alongside a sub-table server. Both must survive next to ours.
        fs::write(
            root.join(CONFIG_REL),
            "[mcp_servers]\nenabled = true\n\n[mcp_servers.other]\ncommand = \"x\"\n",
        )
        .unwrap();
        install(root).unwrap();
        let toml = read(root, CONFIG_REL);
        let parsed: DocumentMut = toml.parse().unwrap();
        assert_eq!(
            parsed["mcp_servers"]["enabled"].as_bool(),
            Some(true),
            "direct key survives: {toml}"
        );
        assert_eq!(
            parsed["mcp_servers"]["other"]["command"].as_str(),
            Some("x"),
            "foreign server survives: {toml}"
        );
        assert_eq!(
            parsed["mcp_servers"]["codegraph"]["command"].as_str(),
            Some("codegraph"),
            "ours added: {toml}"
        );
    }

    #[test]
    fn install_preserves_unrelated_top_level_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".codex")).unwrap();
        fs::write(
            root.join(CONFIG_REL),
            "model = \"gpt-5\"\n\n[history]\npersistence = \"save-all\"\n",
        )
        .unwrap();
        install(root).unwrap();
        let toml = read(root, CONFIG_REL);
        assert!(toml.contains("model = \"gpt-5\""), "{toml}");
        assert!(toml.contains("[history]"), "{toml}");
        assert!(toml.contains("[mcp_servers.codegraph]"), "{toml}");
    }

    #[test]
    fn install_writes_sessionstart_hook_and_script() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root).unwrap();
        let hooks = read(root, HOOKS_REL);
        // The hook is registered under SessionStart (NOT PreToolUse, which Codex
        // does not honor additionalContext on), with a Windows override.
        let v: Value = serde_json::from_str(&hooks).unwrap();
        let entry = &v["hooks"]["SessionStart"][0]["hooks"][0];
        assert_eq!(entry["type"], json!("command"));
        assert!(
            entry["command"]
                .as_str()
                .is_some_and(|c| c.contains("codegraph-hook.py")),
            "{hooks}"
        );
        assert!(
            entry.get("commandWindows").is_some(),
            "win override: {hooks}"
        );
        // The script exists and uses the model-visible additionalContext channel.
        assert!(root.join(SCRIPT_REL).exists());
        let script = read(root, SCRIPT_REL);
        assert!(script.contains("graph.json"), "{script}");
        assert!(script.contains("additionalContext"), "{script}");
        assert!(script.contains("SessionStart"), "{script}");
    }

    #[test]
    fn install_preserves_a_foreign_hook() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".codex")).unwrap();
        // A foreign hook on a different event must survive when we add ours.
        fs::write(
            root.join(HOOKS_REL),
            r#"{"hooks":{"PreToolUse":[{"matcher":"apply_patch","hooks":[{"type":"command","command":"echo keep-me"}]}]}}"#,
        )
        .unwrap();
        install(root).unwrap();
        let hooks = read(root, HOOKS_REL);
        assert!(hooks.contains("keep-me"), "foreign kept: {hooks}");
        assert!(hooks.contains("codegraph-hook.py"), "ours added: {hooks}");
        let v: Value = serde_json::from_str(&hooks).unwrap();
        assert!(v["hooks"]["PreToolUse"].is_array(), "foreign event kept");
        assert!(v["hooks"]["SessionStart"].is_array(), "our event added");
    }

    #[test]
    fn install_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root).unwrap();
        install(root).unwrap();
        let toml = read(root, CONFIG_REL);
        assert_eq!(
            toml.matches("[mcp_servers.codegraph]").count(),
            1,
            "no duplicate server: {toml}"
        );
        let hooks = read(root, HOOKS_REL);
        let v: Value = serde_json::from_str(&hooks).unwrap();
        let entries = v["hooks"]["SessionStart"].as_array().unwrap();
        let ours = entries.iter().filter(|e| is_codegraph_hook(e)).count();
        assert_eq!(ours, 1, "no duplicate hook: {hooks}");
    }

    #[test]
    fn uninstall_removes_ours_and_keeps_foreign() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".codex")).unwrap();
        fs::write(
            root.join(CONFIG_REL),
            "[mcp_servers.other]\ncommand = \"thing\"\n",
        )
        .unwrap();
        fs::write(
            root.join(HOOKS_REL),
            r#"{"hooks":{"PreToolUse":[{"matcher":"apply_patch","hooks":[{"type":"command","command":"echo keep-me"}]}]}}"#,
        )
        .unwrap();
        install(root).unwrap();
        uninstall(root).unwrap();

        let toml = read(root, CONFIG_REL);
        assert!(!toml.contains("codegraph"), "our server gone: {toml}");
        assert!(toml.contains("[mcp_servers.other]"), "foreign kept: {toml}");

        let hooks = read(root, HOOKS_REL);
        assert!(!hooks.contains("codegraph"), "our hook gone: {hooks}");
        assert!(hooks.contains("keep-me"), "foreign kept: {hooks}");

        assert!(!root.join(SCRIPT_REL).exists(), "hook script removed");
    }

    #[test]
    fn uninstall_removes_now_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root).unwrap();
        uninstall(root).unwrap();
        assert!(
            !root.join(CONFIG_REL).exists(),
            "config with only our server is removed"
        );
        assert!(
            !root.join(HOOKS_REL).exists(),
            "hooks with only our entry is removed"
        );
        assert!(!root.join(SCRIPT_REL).exists(), "script removed");
    }

    #[test]
    fn uninstall_on_missing_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        assert!(uninstall(dir.path()).is_ok());
    }
}
