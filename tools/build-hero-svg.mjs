// Renders the hero "drawing": the real graph-core as an ENGINEERING SCHEMATIC,
// not a force-directed hairball. Open-circle nodes, thin chalk construction
// lines, a red datum node, red callout balloons in the right margin pointing
// at real symbols, and a dimension line reading the core's true node/edge count.
// Deterministic (seeded) so it does not churn.
//
//   node tools/build-hero-svg.mjs
//
// Reads assets/data/graph-core.json, writes assets/img/hero-graph.svg.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = JSON.parse(fs.readFileSync(path.join(here, "..", "assets", "data", "graph-core.json"), "utf8"));

// palette (baked: this is an <img>, page CSS vars do not reach inside it)
const CHALK = "#eef4f7", CHALK_DIM = "#9fbccc", CHALK_FAINT = "#557a93", RED = "#e0563f", SHEET = "#0d2a44";

const N = 90;                 // legible schematic, not a hairball
const W = 760, H = 560, PAD = 26;
const DRAW_R = W * 0.64;      // drawing area width; right margin holds callouts
const TOPGAP = 34, BOTGAP = 46;
const AW = DRAW_R - PAD * 2, AH = H - PAD - TOPGAP - BOTGAP;
const MAX_EDGE = 150;         // skip long criss-cross construction lines

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260623);

const top = [...core.nodes].sort((a, b) => (b.deg || 0) - (a.deg || 0)).slice(0, N);
const keep = new Set(top.map((n) => n.id));
const links = core.links.filter((l) => keep.has(l.source) && keep.has(l.target));
const used = new Set();
links.forEach((l) => { used.add(l.source); used.add(l.target); });
const nodes = top.filter((n) => used.has(n.id));
const idx = new Map(nodes.map((n, i) => [n.id, i]));
const L = links.map((l) => [idx.get(l.source), idx.get(l.target)]);

// seed spread, then light relaxation (declump + gentle spring)
const P = nodes.map(() => ({ x: rnd() * AW, y: rnd() * AH, vx: 0, vy: 0 }));
for (let it = 0; it < 130; it++) {
  const cool = 1 - it / 130;
  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = dx * dx + dy * dy || 0.01;
      if (d2 < 9000) {
        let d = Math.sqrt(d2), f = 520 / d2, ux = dx / d, uy = dy / d;
        P[i].vx += ux * f; P[i].vy += uy * f; P[j].vx -= ux * f; P[j].vy -= uy * f;
      }
    }
  }
  for (const [a, b] of L) {
    let dx = P[b].x - P[a].x, dy = P[b].y - P[a].y, d = Math.hypot(dx, dy) || 0.01;
    let f = (d - 70) * 0.013, ux = dx / d, uy = dy / d;
    P[a].vx += ux * f; P[a].vy += uy * f; P[b].vx -= ux * f; P[b].vy -= uy * f;
  }
  for (const p of P) {
    p.vx += (AW / 2 - p.x) * 0.0008; p.vy += (AH / 2 - p.y) * 0.0008;
    p.x += p.vx * cool; p.y += p.vy * cool; p.vx *= 0.82; p.vy *= 0.82;
    p.x = Math.max(0, Math.min(AW, p.x)); p.y = Math.max(0, Math.min(AH, p.y));
  }
}

const X = (p) => +(PAD + p.x).toFixed(1);
const Y = (p) => +(PAD + TOPGAP + p.y).toFixed(1);
function esc(t) { return String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// construction lines
let edges = "";
for (const [a, b] of L) {
  const x1 = X(P[a]), y1 = Y(P[a]), x2 = X(P[b]), y2 = Y(P[b]);
  if (Math.hypot(x2 - x1, y2 - y1) > MAX_EDGE) continue;
  edges += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
}

// nodes: open circles, hubs bigger, datum (highest degree) in red
const order = nodes.map((n, i) => ({ n, i })).sort((x, y) => (y.n.deg || 0) - (x.n.deg || 0));
const datumI = order[0].i;
let circs = "", hubs = "";
nodes.forEach((n, i) => {
  const r = Math.min(8, 2.6 + Math.sqrt(n.deg || 1) * 0.6);
  if (i === datumI) return; // drawn last
  circs += `<circle cx="${X(P[i])}" cy="${Y(P[i])}" r="${r.toFixed(1)}" fill="${SHEET}" stroke="${CHALK_DIM}" stroke-width="1"/>`;
});
for (const { i } of order.slice(0, 9)) {
  if (i === datumI) continue;
  hubs += `<circle cx="${X(P[i])}" cy="${Y(P[i])}" r="1.4" fill="${CHALK}"/>`;
}

// callouts: top symbols pulled out to the right margin with red balloons + leaders
const picks = order.slice(0, 3);
const mx = DRAW_R + 6;                 // callout column left edge
let callouts = "";
picks.forEach(({ n, i }, k) => {
  const cy = TOPGAP + 24 + k * ((H - TOPGAP - BOTGAP - 24) / 2.2);
  const nx = X(P[i]), ny = Y(P[i]);
  const bx = mx + 13, by = cy;
  // leader from node to balloon
  callouts += `<polyline points="${nx},${ny} ${(mx - 12).toFixed(1)},${ny} ${(mx - 12).toFixed(1)},${by.toFixed(1)} ${(bx - 11).toFixed(1)},${by.toFixed(1)}" fill="none" stroke="${RED}" stroke-width="1"/>`;
  // a tick on the referenced node
  callouts += `<circle cx="${nx}" cy="${ny}" r="3.4" fill="none" stroke="${RED}" stroke-width="1.4"/>`;
  // balloon
  callouts += `<circle cx="${bx}" cy="${by.toFixed(1)}" r="11" fill="none" stroke="${RED}" stroke-width="1.4"/>`;
  callouts += `<text x="${bx}" y="${(by + 4).toFixed(1)}" text-anchor="middle" fill="${RED}" font-family="ui-monospace,'Spline Sans Mono',monospace" font-size="12" font-weight="600">${k + 1}</text>`;
  // label box
  const lx = bx + 17;
  callouts += `<text x="${lx}" y="${(by - 1).toFixed(1)}" fill="${CHALK}" font-family="ui-monospace,'Spline Sans Mono',monospace" font-size="12">${esc((n.label || "").slice(0, 18))}</text>`;
  callouts += `<text x="${lx}" y="${(by + 13).toFixed(1)}" fill="${CHALK_FAINT}" font-family="ui-monospace,'Spline Sans Mono',monospace" font-size="9.5" letter-spacing="0.06em">${esc(String(n.kind || "node").toUpperCase())} - DEG ${n.deg || 0}</text>`;
});

// datum node (drawn on top), the redline reference part
const dx = X(P[datumI]), dy = Y(P[datumI]);
let datum = `<circle cx="${dx}" cy="${dy}" r="7.5" fill="${RED}"/><circle cx="${dx}" cy="${dy}" r="2.4" fill="${SHEET}"/>`;
datum += `<circle cx="${dx}" cy="${dy}" r="12.5" fill="none" stroke="${RED}" stroke-width="1" stroke-dasharray="3 3"/>`;

// bottom dimension line, reading the core's real counts
const dimY = H - BOTGAP + 18, dimX1 = PAD, dimX2 = DRAW_R - 6;
const dimLabel = `${(core.meta?.nodes || nodes.length).toLocaleString("en-US")} NODES  /  ${(core.meta?.links || L.length).toLocaleString("en-US")} EDGES  -  CORE`;
let dim = `<g stroke="${CHALK_FAINT}" stroke-width="1">`;
dim += `<line x1="${dimX1}" y1="${dimY}" x2="${dimX2}" y2="${dimY}"/>`;
dim += `<line x1="${dimX1}" y1="${dimY - 4}" x2="${dimX1}" y2="${dimY + 4}"/>`;
dim += `<line x1="${dimX2}" y1="${dimY - 4}" x2="${dimX2}" y2="${dimY + 4}"/></g>`;
dim += `<rect x="${(W * 0.3).toFixed(0)}" y="${dimY - 9}" width="200" height="18" fill="${SHEET}"/>`;
dim += `<text x="${((dimX1 + dimX2) / 2).toFixed(0)}" y="${(dimY + 4).toFixed(0)}" text-anchor="middle" fill="${CHALK_DIM}" font-family="ui-monospace,'Spline Sans Mono',monospace" font-size="10.5" letter-spacing="0.08em">${dimLabel}</text>`;

// detail tag, top-left of the drawing
const tag = `<text x="${PAD}" y="${TOPGAP - 12}" fill="${CHALK_FAINT}" font-family="ui-monospace,'Spline Sans Mono',monospace" font-size="10.5" letter-spacing="0.12em">FIG.1  DEPENDENCY GRAPH</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="An engineering-schematic drawing of the Synaptic codebase dependency graph">
${tag}
<g stroke="${CHALK_FAINT}" stroke-opacity="0.5" stroke-width="0.8">${edges}</g>
<g class="plot-nodes">${circs}</g>
<g>${hubs}</g>
${datum}
${callouts}
${dim}
</svg>
`;

fs.mkdirSync(path.join(here, "..", "assets", "img"), { recursive: true });
fs.writeFileSync(path.join(here, "..", "assets", "img", "hero-graph.svg"), svg);
console.log(`hero-graph.svg: ${nodes.length} nodes / ${L.length} links, 3 callouts  (${Math.round(Buffer.byteLength(svg) / 1024)} KB)`);
