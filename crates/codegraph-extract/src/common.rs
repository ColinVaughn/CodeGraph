//! Shared accumulation + call-resolution machinery for the hand-written
//! extractors (Go, Rust) whose scoping rules don't fit the generic
//! `LanguageConfig` walker. Provides the shared node/edge/`ensure_named_node`/
//! call-pass helpers used by the Go and Rust extractors.

use std::collections::{HashMap, HashSet};

use codegraph_core::{make_id, Confidence, Edge, FileType, Node, NodeId};
use serde_json::Map;

use crate::result::{ExtractionResult, ImportRecord, RawCall};

/// `extra` carrying the AST-provenance tag (so the build-stage ghost remap can
/// tell AST nodes from semantic ones).
fn ast_origin() -> Map<String, serde_json::Value> {
    let mut m = Map::new();
    m.insert(
        "_origin".to_string(),
        serde_json::Value::String("ast".to_string()),
    );
    m
}

/// Accumulates nodes/edges/raw-calls/imports for one source file, deduping node
/// ids via `seen`.
pub(crate) struct Builder {
    pub path: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub raw_calls: Vec<RawCall>,
    pub imports: Vec<ImportRecord>,
    pub seen: HashSet<NodeId>,
}

impl Builder {
    pub fn new(path: &str) -> Self {
        Builder {
            path: path.to_string(),
            nodes: Vec::new(),
            edges: Vec::new(),
            raw_calls: Vec::new(),
            imports: Vec::new(),
            seen: HashSet::new(),
        }
    }

    /// Add a located node (in the current file) unless its id was already seen.
    pub fn add_node(&mut self, id: NodeId, label: String, line: usize) {
        self.add_node_typed(id, label, FileType::Code, line);
    }

    /// Add a located node with an explicit `file_type` — e.g. a `concept` node
    /// for a .NET TargetFramework/SDK, or a `document` node for a Markdown
    /// heading. Otherwise identical to `add_node` (located at the current file,
    /// deduped by id, AST-origin).
    pub fn add_node_typed(&mut self, id: NodeId, label: String, file_type: FileType, line: usize) {
        if self.seen.insert(id.clone()) {
            self.nodes.push(Node {
                id,
                label,
                file_type,
                source_file: self.path.clone(),
                source_location: Some(format!("L{line}")),
                community: None,
                repo: None,
                extra: ast_origin(),
            });
        }
    }

    /// Add an external stub node (no source file) so an edge to an out-of-corpus
    /// target (e.g. an imported package) survives build's dangling-edge drop.
    pub fn add_external_node(&mut self, id: NodeId, label: String) {
        if self.seen.insert(id.clone()) {
            self.nodes.push(Node {
                id,
                label,
                file_type: FileType::Code,
                source_file: String::new(),
                source_location: None,
                community: None,
                repo: None,
                extra: ast_origin(),
            });
        }
    }

    pub fn add_edge(
        &mut self,
        source: NodeId,
        target: NodeId,
        relation: &str,
        line: usize,
        context: Option<&str>,
    ) {
        self.edges.push(Edge {
            source,
            target,
            relation: relation.to_string(),
            confidence: Confidence::Extracted,
            source_file: self.path.clone(),
            source_location: Some(format!("L{line}")),
            confidence_score: None,
            weight: 1.0,
            context: context.map(str::to_string),
            cross_repo: false,
            extra: Map::new(),
        });
    }

    /// Resolve `name` to an existing scoped node id, else a global id (creating a
    /// stub when unseen).
    pub fn ensure_named_node(&mut self, name: &str, scope: &str, line: usize) -> NodeId {
        let local = NodeId(make_id(&[scope, name]));
        if self.seen.contains(&local) {
            return local;
        }
        let global = NodeId(make_id(&[name]));
        if !self.seen.contains(&global) {
            self.add_node(global.clone(), name.to_string(), line);
        }
        global
    }

    /// Map a node label to its id for intra-file call resolution: `foo()`→`foo`,
    /// `.bar()`→`bar` (last-write-wins on collision).
    pub fn label_index(&self) -> HashMap<String, NodeId> {
        let mut idx = HashMap::new();
        for n in &self.nodes {
            let key = n
                .label
                .trim_matches(|c| c == '(' || c == ')')
                .trim_start_matches('.')
                .to_string();
            idx.insert(key, n.id.clone());
        }
        idx
    }

    /// Resolve one call: if `callee` maps to a different node, emit a `calls`
    /// edge (deduped per `seen_pairs`); otherwise — when `enqueue_raw` — record a
    /// `RawCall` for the cross-file resolver (B3). Builtin filtering is the
    /// caller's responsibility.
    #[allow(clippy::too_many_arguments)]
    pub fn resolve_call(
        &mut self,
        caller: &NodeId,
        callee: &str,
        is_member: bool,
        line: usize,
        index: &HashMap<String, NodeId>,
        seen_pairs: &mut HashSet<(NodeId, NodeId)>,
        enqueue_raw: bool,
    ) {
        // Resolved to a *different* node: `calls` edge; otherwise (unresolved or
        // self-call) fall back to a RawCall for the cross-file resolver (B3).
        let resolved = index.get(callee).filter(|tgt| *tgt != caller);
        if let Some(tgt) = resolved {
            if seen_pairs.insert((caller.clone(), tgt.clone())) {
                self.add_edge(caller.clone(), tgt.clone(), "calls", line, Some("call"));
            }
        } else if enqueue_raw {
            self.raw_calls.push(RawCall {
                caller: caller.clone(),
                callee: callee.to_string(),
                is_member_call: is_member,
                source_file: self.path.clone(),
                source_location: Some(format!("L{line}")),
            });
        }
    }

    pub fn into_result(self) -> ExtractionResult {
        ExtractionResult {
            nodes: self.nodes,
            edges: self.edges,
            raw_calls: self.raw_calls,
            imports: self.imports,
        }
    }
}
