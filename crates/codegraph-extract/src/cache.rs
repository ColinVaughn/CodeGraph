//! Per-file AST extraction cache. Keyed by `(path, content)` so an unchanged
//! file on a rebuild skips tree-sitter parsing. The cached value is the
//! serialized [`ExtractionResult`] under `<cache_dir>/ast/v{version}/<key>.json`.
//! The path is part of the key because node ids and scoping
//! embed it, so two files with identical bytes at different paths must not share
//! an entry. Entries are namespaced by [`AST_CACHE_VERSION`] so a release *or* an
//! extractor-logic change auto-invalidates — see that constant.

use std::path::{Path, PathBuf};

use crate::extract_source;
use crate::result::ExtractionResult;

/// On-disk cache namespace: `{crate version}-{build fingerprint}`. Entries depend
/// on the extractor *code*, not just file contents — keying on the package version
/// alone missed extractor-*behavior* changes (a walker fix that emits different
/// nodes for the same bytes), serving stale pre-fix results from a warm cache
/// within a dev cycle (the version only moves on release). `build.rs` hashes the
/// extract crate's `src/` + enabled `lang-*` features into `CODEGRAPH_EXTRACT_BUILD_ID`,
/// so the namespace rotates the instant extraction logic recompiles and stays warm
/// across identical rebuilds.
pub const AST_CACHE_VERSION: &str = concat!(
    env!("CARGO_PKG_VERSION"),
    "-",
    env!("CODEGRAPH_EXTRACT_BUILD_ID")
);

fn cache_key(path: &str, source: &[u8]) -> String {
    let mut h = blake3::Hasher::new();
    h.update(path.as_bytes());
    h.update(&[0]); // separator so (path, content) can't be ambiguous
    h.update(source);
    h.finalize().to_hex().to_string()
}

fn cache_file(cache_dir: &Path, key: &str) -> PathBuf {
    cache_dir
        .join(format!("ast/v{AST_CACHE_VERSION}"))
        .join(format!("{key}.json"))
}

/// Extract `source`, using and populating an on-disk cache when `cache_dir` is
/// `Some`. Returns `None` for unsupported (or feature-disabled) extensions,
/// which are never cached. Cache I/O is best-effort: any read/write/parse error
/// falls back to a fresh extraction, so a corrupt cache never blocks a build.
pub fn cached_extract_source(
    cache_dir: Option<&Path>,
    path: &str,
    source: &[u8],
) -> Option<ExtractionResult> {
    let Some(dir) = cache_dir else {
        return extract_source(path, source);
    };
    let file = cache_file(dir, &cache_key(path, source));
    if let Ok(bytes) = std::fs::read(&file) {
        if let Ok(res) = serde_json::from_slice::<ExtractionResult>(&bytes) {
            return Some(res);
        }
    }
    let res = extract_source(path, source)?;
    if let Some(parent) = file.parent() {
        if std::fs::create_dir_all(parent).is_ok() {
            if let Ok(bytes) = serde_json::to_vec(&res) {
                let _ = std::fs::write(&file, bytes);
            }
        }
    }
    Some(res)
}

#[cfg(all(test, feature = "lang-python"))]
mod tests {
    use super::*;

    const SRC: &[u8] = b"def f(x):\n    return x\n";

    #[test]
    fn cache_miss_then_hit_is_identical_and_writes_file() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        let r1 = cached_extract_source(Some(cache), "a.py", SRC).unwrap();
        // A cache file was written for this (path, content).
        let key = cache_key("a.py", SRC);
        assert!(cache_file(cache, &key).exists(), "cache file written");
        // Second call hits the cache and returns an identical result.
        let r2 = cached_extract_source(Some(cache), "a.py", SRC).unwrap();
        assert_eq!(r1, r2);
    }

    #[test]
    fn different_path_or_content_is_a_distinct_entry() {
        assert_ne!(cache_key("a.py", SRC), cache_key("b.py", SRC));
        assert_ne!(
            cache_key("a.py", SRC),
            cache_key("a.py", b"def g(): pass\n")
        );
    }

    #[test]
    fn corrupt_cache_entry_falls_back_to_extraction() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        let file = cache_file(cache, &cache_key("a.py", SRC));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"{ not valid json").unwrap();
        // Falls back to a real extraction instead of erroring.
        let r = cached_extract_source(Some(cache), "a.py", SRC).unwrap();
        assert!(r.nodes.iter().any(|n| n.label == "f()"));
    }

    #[test]
    fn no_cache_dir_extracts_directly() {
        let r = cached_extract_source(None, "a.py", SRC).unwrap();
        assert!(r.nodes.iter().any(|n| n.label == "f()"));
    }
}

#[cfg(test)]
mod version_tests {
    use super::AST_CACHE_VERSION;

    #[test]
    fn version_includes_build_fingerprint() {
        // `{crate version}-{16-hex build id}`: a `-` separator with a non-empty
        // fingerprint suffix proves build.rs wired CODEGRAPH_EXTRACT_BUILD_ID in.
        let (version, build_id) = AST_CACHE_VERSION
            .rsplit_once('-')
            .expect("namespace is `version-buildid`");
        assert!(!version.is_empty(), "crate version present");
        assert_eq!(build_id.len(), 16, "16-hex build fingerprint: {build_id:?}");
        assert!(
            build_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "fingerprint is hex: {build_id:?}"
        );
    }
}
