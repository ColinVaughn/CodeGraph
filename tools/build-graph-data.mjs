// Builds the web datasets for the Explore page from a Synaptic graph.json.
//
//   node tools/build-graph-data.mjs [path/to/graph.json]
//
// Default source is the sibling main repo's synaptic-out/graph.json. Writes
// two trimmed files into assets/data/:
//   graph-core.json  curated core (most-connected nodes), smooth everywhere
//   graph-full.json  the whole graph, loaded on demand
//
// Regenerate after re-extracting the repo to refresh the on-site graph.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || path.join(here, "..", "..", "CodeGraph", "synaptic-out", "graph.json");
const outDir = path.join(here, "..", "assets", "data");
const CORE_MAX = 1200;     // node budget for the default view
const SIG_MAX = 90;        // truncate signatures kept for the info panel

const raw = JSON.parse(fs.readFileSync(src, "utf8"));
const srcNodes = raw.nodes || [];
const srcLinks = raw.links || raw.edges || [];

function kindOf(n) {
  if (n.kind) return n.kind;
  if (n._node_type === "config_resource") return "config";
  return "file";
}
function clean(sig) {
  if (!sig) return undefined;
  const s = String(sig).replace(/\s+/g, " ").trim();
  return s.length > SIG_MAX ? s.slice(0, SIG_MAX - 1) + "…" : s;
}

// degree over the full graph
const deg = new Map();
const endpoint = (e) => (typeof e === "object" ? e.id : e);
for (const l of srcLinks) {
  const s = endpoint(l.source), t = endpoint(l.target);
  deg.set(s, (deg.get(s) || 0) + 1);
  deg.set(t, (deg.get(t) || 0) + 1);
}

const trimNode = (n) => {
  const o = {
    id: n.id,
    label: n.label || n.norm_label || n.id,
    kind: kindOf(n),
    community: n.community ?? 0,
    file: n.source_file || "",
    deg: deg.get(n.id) || 0,
  };
  if (n.visibility) o.vis = n.visibility;
  const sig = clean(n.signature);
  if (sig) o.sig = sig;
  return o;
};
const trimLink = (l) => ({ source: endpoint(l.source), target: endpoint(l.target), rel: l.relation || "" });

function pack(nodes, links) {
  const communities = new Set(nodes.map((n) => n.community));
  return {
    meta: {
      repo: "ColinVaughn/Synaptic",
      nodes: nodes.length,
      links: links.length,
      communities: communities.size,
      generated: new Date().toISOString().slice(0, 10),
    },
    nodes,
    links,
  };
}

// full
const fullNodes = srcNodes.map(trimNode);
const fullLinks = srcLinks.map(trimLink).filter((l) => l.source && l.target);

// core: top nodes by degree, keep internal links, drop nodes left unconnected
const keep = new Set(
  [...srcNodes].sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0)).slice(0, CORE_MAX).map((n) => n.id)
);
let coreLinks = fullLinks.filter((l) => keep.has(l.source) && keep.has(l.target));
const connected = new Set();
for (const l of coreLinks) { connected.add(l.source); connected.add(l.target); }
const coreNodes = fullNodes.filter((n) => connected.has(n.id));

fs.mkdirSync(outDir, { recursive: true });
const core = pack(coreNodes, coreLinks);
const full = pack(fullNodes, fullLinks);
fs.writeFileSync(path.join(outDir, "graph-core.json"), JSON.stringify(core));
fs.writeFileSync(path.join(outDir, "graph-full.json"), JSON.stringify(full));

const kb = (o) => Math.round(Buffer.byteLength(JSON.stringify(o)) / 1024);
console.log(`source: ${path.relative(here, src)}`);
console.log(`core: ${core.nodes.length} nodes / ${core.links.length} links  (${kb(core)} KB)`);
console.log(`full: ${full.nodes.length} nodes / ${full.links.length} links  (${kb(full)} KB)`);
console.log(`communities: core ${core.meta.communities}, full ${full.meta.communities}`);
