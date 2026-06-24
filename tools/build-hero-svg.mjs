// Renders a static SVG of the real graph-core for the hero background.
// Seeds nodes spread across the canvas, then lightly relaxes (declump +
// gentle spring) so it keeps an airy constellation look instead of
// collapsing into a hairball. Deterministic (seeded) so it does not churn.
//
//   node tools/build-hero-svg.mjs
//
// Reads assets/data/graph-core.json, writes assets/img/hero-graph.svg.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = JSON.parse(fs.readFileSync(path.join(here, "..", "assets", "data", "graph-core.json"), "utf8"));

const N = 480;             // nodes in the backdrop
const W = 1600, H = 1000, PAD = 50;
const LEFTGAP = 0.28;      // keep the left clear for the headline
const AW = 1280, AH = 940; // layout box
const MAX_EDGE = 240;      // skip long criss-cross edges (screen units)

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

// seed spread, then light relaxation
const P = nodes.map(() => ({ x: rnd() * AW, y: rnd() * AH, vx: 0, vy: 0 }));
for (let it = 0; it < 120; it++) {
  const cool = 1 - it / 120;
  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = dx * dx + dy * dy || 0.01;
      if (d2 < 8000) {
        let d = Math.sqrt(d2), f = 440 / d2, ux = dx / d, uy = dy / d;
        P[i].vx += ux * f; P[i].vy += uy * f; P[j].vx -= ux * f; P[j].vy -= uy * f;
      }
    }
  }
  for (const [a, b] of L) {
    let dx = P[b].x - P[a].x, dy = P[b].y - P[a].y, d = Math.hypot(dx, dy) || 0.01;
    let f = (d - 64) * 0.012, ux = dx / d, uy = dy / d;
    P[a].vx += ux * f; P[a].vy += uy * f; P[b].vx -= ux * f; P[b].vy -= uy * f;
  }
  for (const p of P) {
    p.vx += (AW / 2 - p.x) * 0.0006; p.vy += (AH / 2 - p.y) * 0.0006;
    p.x += p.vx * cool; p.y += p.vy * cool; p.vx *= 0.82; p.vy *= 0.82;
    p.x = Math.max(0, Math.min(AW, p.x)); p.y = Math.max(0, Math.min(AH, p.y));
  }
}

const usableW = W * (1 - LEFTGAP) - PAD;
const s = Math.min(usableW / AW, (H - 2 * PAD) / AH);
const offX = W * LEFTGAP, offY = (H - AH * s) / 2;
const X = (p) => (offX + p.x * s).toFixed(1);
const Y = (p) => (offY + p.y * s).toFixed(1);

function communityColor(c) { return "hsl(" + (188 + (Math.abs(c | 0) * 47) % 104) + ",70%,64%)"; }
function esc(t) { return String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

let edges = "";
for (const [a, b] of L) {
  const x1 = +X(P[a]), y1 = +Y(P[a]), x2 = +X(P[b]), y2 = +Y(P[b]);
  if (Math.hypot(x2 - x1, y2 - y1) > MAX_EDGE) continue;
  edges += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
}

const order = nodes.map((n, i) => ({ n, i })).sort((x, y) => (y.n.deg || 0) - (x.n.deg || 0));
let halos = "";
for (const { n, i } of order.slice(0, 12)) halos += `<circle cx="${X(P[i])}" cy="${Y(P[i])}" r="${(8 + Math.sqrt(n.deg || 1)).toFixed(1)}" fill="${communityColor(n.community)}" opacity="0.14"/>`;
let circs = "";
nodes.forEach((n, i) => { circs += `<circle cx="${X(P[i])}" cy="${Y(P[i])}" r="${(1.7 + Math.sqrt(n.deg || 1) * 0.55).toFixed(1)}" fill="${communityColor(n.community)}"/>`; });
let labels = "";
for (const { n, i } of order.slice(0, 6)) labels += `<text x="${(+X(P[i]) + 9).toFixed(1)}" y="${(+Y(P[i]) + 4).toFixed(1)}">${esc(n.label)}</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="A force-directed view of the Synaptic codebase graph">
<g stroke="#8893d0" stroke-opacity="0.11" stroke-width="0.7">${edges}</g>
<g>${halos}</g>
<g fill-opacity="0.92">${circs}</g>
<g fill="#b6bce0" opacity="0.5" font-family="ui-monospace, 'JetBrains Mono', monospace" font-size="13">${labels}</g>
</svg>
`;

fs.mkdirSync(path.join(here, "..", "assets", "img"), { recursive: true });
fs.writeFileSync(path.join(here, "..", "assets", "img", "hero-graph.svg"), svg);
console.log(`hero-graph.svg: ${nodes.length} nodes / ${L.length} links (drawn shorter than ${MAX_EDGE})  (${Math.round(Buffer.byteLength(svg) / 1024)} KB)`);
