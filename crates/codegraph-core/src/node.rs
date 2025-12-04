use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::file_type::FileType;
use crate::id::NodeId;

/// A graph node. The required fields are the ones in `REQUIRED_NODE_FIELDS`.
/// Optional fields are omitted from `graph.json` when unset so output stays in
/// the node-link format. `extra` captures any additional keys (`norm_label`,
/// `_origin`, `source_url`, …) so round-trips are lossless.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub label: String,
    pub file_type: FileType,
    pub source_file: String,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub community: Option<u32>,
    /// Federation namespace tag; absent for single-repo graphs.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub repo: Option<String>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Node {
        Node {
            id: NodeId("auth".into()),
            label: "auth.py".into(),
            file_type: FileType::Code,
            source_file: "src/auth.py".into(),
            source_location: Some("L42".into()),
            community: None,
            repo: None,
            extra: Map::new(),
        }
    }

    #[test]
    fn omits_unset_optional_fields() {
        let json = serde_json::to_value(sample()).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("source_location"));
        assert!(!obj.contains_key("community")); // None -> omitted
        assert!(!obj.contains_key("repo"));
        // Nodes carry no confidence key (confidence is an edge-level property).
        assert!(!obj.contains_key("confidence"));
    }

    #[test]
    fn required_keys_present_with_canonical_names() {
        let json = serde_json::to_value(sample()).unwrap();
        let obj = json.as_object().unwrap();
        for k in ["id", "label", "file_type", "source_file"] {
            assert!(obj.contains_key(k), "missing {k}");
        }
        assert_eq!(obj["file_type"], serde_json::json!("code"));
    }

    #[test]
    fn unknown_keys_roundtrip_via_extra() {
        let raw = serde_json::json!({
            "id": "auth",
            "label": "auth.py",
            "file_type": "code",
            "source_file": "src/auth.py",
            "community": 3,
            "norm_label": "auth.py",
            "_origin": "ast"
        });
        let node: Node = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(node.community, Some(3));
        assert_eq!(node.extra.get("norm_label").unwrap(), "auth.py");
        assert_eq!(node.extra.get("_origin").unwrap(), "ast");
        // Re-serialize: typed + extra keys both present, no data lost.
        let back = serde_json::to_value(&node).unwrap();
        let obj = back.as_object().unwrap();
        assert_eq!(obj["community"], serde_json::json!(3));
        assert_eq!(obj["norm_label"], serde_json::json!("auth.py"));
        assert_eq!(obj["_origin"], serde_json::json!("ast"));
    }
}
