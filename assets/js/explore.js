// On-brand 3D explorer for the real Synaptic graph.
// Loads a trimmed dataset and renders it with 3d-force-graph (the same engine
// Synaptic's own graph-3d output uses), styled to the site and wired to a few
// controls: search, color-by, auto-rotate, reset, load-full, click-to-inspect.
(function () {
  "use strict";

  var stage = document.getElementById("graph");
  var loading = document.getElementById("g-loading");
  var fallback = document.getElementById("g-fallback");
  var controls = document.getElementById("g-controls");
  var info = document.getElementById("g-info");
  var hint = document.getElementById("g-hint");
  if (!stage) return;

  var REDUCE = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (typeof ForceGraph3D !== "function") { showFallback(); return; }

  // schematic palette: a chalk-on-blueprint drawing, not a neon graph.
  // communities map to tonal bands of steel/chalk; kinds get chalk tones
  // with red reserved for config (the one annotation ink). The selected node
  // and its incident edges turn red, a live blast-radius highlight.
  var CHALK = "#eef4f7", RED = "#e0563f", DIM = "#2e4d63", LINE = "#557a93";
  var KIND_COLORS = {
    function: "#eef4f7", method: "#cfe0ea", struct: "#9fbccc", enum: "#b9cdda",
    trait: "#88a7ba", config: "#e0563f", file: "#6f93a8", macro: "#c2d4df",
    constant: "#aac3d2", interface: "#9fbccc", class: "#9fbccc",
  };
  function communityColor(c) {
    var t = (Math.abs(c | 0) * 47) % 100;     // 0..99, deterministic spread
    var l = 44 + (t / 99) * 38;               // 44..82 lightness band
    return "hsl(205," + (14 + (t % 4) * 6) + "%," + l.toFixed(0) + "%)";
  }
  function kindColor(k) { return KIND_COLORS[k] || "#9fbccc"; }

  // state
  var graph = null;
  var mode = "community";
  var meta = null;
  var byId = new Map();
  var adj = new Map();
  var highlight = new Set();
  var selected = null;
  var selAdj = new Set();
  var fullLoaded = false;

  // auto-rotate (manual orbit; robust across control types)
  var rotating = !REDUCE;
  var dragging = false;
  var orbitAngle = 0;

  // frame the whole graph once it settles, pausing orbit during the move
  var fitted = false, fitting = false;
  function fitOnce() {
    if (!graph || fitted) return;
    fitted = true; fitting = true;
    graph.zoomToFit(700, 55);
    setTimeout(function () { fitting = false; }, 900);
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function shortFile(f) { if (!f) return ""; var p = f.replace(/\\/g, "/").split("/"); return p.slice(-2).join("/"); }

  function colorForNode(n) {
    // selection draws a blast radius: datum red, dependents chalk, rest dim
    if (selected) {
      if (n.id === selected.id) return RED;
      if (selAdj.has(n.id)) return CHALK;
      return DIM;
    }
    if (highlight.size && !highlight.has(n.id)) return DIM;
    return mode === "kind" ? kindColor(n.kind) : communityColor(n.community);
  }
  function colorForLink(l) {
    if (selected) {
      var s = (l.source && l.source.id != null) ? l.source.id : l.source;
      var t = (l.target && l.target.id != null) ? l.target.id : l.target;
      if (s === selected.id || t === selected.id) return RED;
    }
    return LINE;
  }
  function applyColors() { if (graph) { graph.nodeColor(colorForNode); graph.linkColor(colorForLink); } }

  function buildIndex(data) {
    byId = new Map();
    adj = new Map();
    data.nodes.forEach(function (n) { byId.set(n.id, n); adj.set(n.id, []); });
    data.links.forEach(function (l) {
      // links arrive with string ids; record adjacency before the engine
      // rewrites them into node objects
      var s = typeof l.source === "object" ? l.source.id : l.source;
      var t = typeof l.target === "object" ? l.target.id : l.target;
      if (adj.has(s)) adj.get(s).push(t);
      if (adj.has(t)) adj.get(t).push(s);
    });
  }

  function setData(data, perf) {
    meta = data.meta || { nodes: data.nodes.length, links: data.links.length };
    buildIndex(data);
    fitted = false;
    graph
      .graphData(data)
      .linkOpacity(perf.linkOpacity)
      .nodeRelSize(perf.nodeRel)
      .cooldownTicks(perf.cooldown)
      .warmupTicks(perf.warmup);
    // spread clusters out a bit (forces exist once graphData is set)
    var charge = graph.d3Force && graph.d3Force("charge");
    if (charge && charge.strength) charge.strength(-95);
    var lf = graph.d3Force && graph.d3Force("link");
    if (lf && lf.distance) lf.distance(36);
    applyColors();
    renderStats();
    renderLegend();
  }

  function initGraph(data, perf) {
    try {
      graph = ForceGraph3D({ controlType: "orbit" })(stage)
        .backgroundColor("#0d2a44")
        .nodeId("id")
        .nodeVal(function (n) { return 1 + Math.sqrt(n.deg || 1); })
        .nodeColor(colorForNode)
        .nodeOpacity(0.95)
        .nodeLabel(function (n) {
          return '<div class="g-tip"><b>' + esc(n.label) + "</b><span>" + esc(n.kind) +
            (n.file ? " &middot; " + esc(shortFile(n.file)) : "") + "</span></div>";
        })
        .linkColor(colorForLink)
        .linkWidth(0)
        .onNodeClick(selectNode)
        .onBackgroundClick(clearSelection)
        .onEngineStop(fitOnce)
        .width(stage.clientWidth)
        .height(stage.clientHeight);
    } catch (e) { showFallback(); return; }

    setData(data, perf);
    requestAnimationFrame(orbitTick);
    if (loading) loading.hidden = true;
    if (controls) controls.hidden = false;
    if (hint) hint.hidden = false;
  }

  function selectNode(n) {
    selected = n;
    selAdj = new Set(adj.get(n.id) || []);
    focus(n);
    renderInfo(n);
    applyColors();
  }
  function clearSelection() {
    if (!selected) return;
    selected = null;
    selAdj = new Set();
    if (info) info.hidden = true;
    applyColors();
  }
  function focus(n) {
    var d = 110;
    var dist = Math.hypot(n.x || 0.01, n.y || 0.01, n.z || 0.01);
    var r = 1 + d / dist;
    graph.cameraPosition({ x: (n.x || 0) * r, y: (n.y || 0) * r, z: (n.z || 0) * r }, n, 900);
  }

  function renderInfo(n) {
    if (!info) return;
    var ids = adj.get(n.id) || [];
    var seen = {};
    var neighbors = [];
    ids.forEach(function (id) {
      if (id === n.id || seen[id]) return;
      seen[id] = 1;
      var nn = byId.get(id);
      if (nn) neighbors.push(nn);
    });
    neighbors.sort(function (a, b) { return (b.deg || 0) - (a.deg || 0); });
    var top = neighbors.slice(0, 10);
    var accent = mode === "kind" ? kindColor(n.kind) : communityColor(n.community);
    var h = '<button class="g-close" aria-label="Close">&times;</button>';
    h += '<div class="g-info__kind" style="color:' + accent + '">' + esc(n.kind) + (n.vis ? " &middot; " + esc(n.vis) : "") + "</div>";
    h += '<h2 class="g-info__name">' + esc(n.label) + "</h2>";
    if (n.sig) h += '<pre class="g-info__sig">' + esc(n.sig) + "</pre>";
    if (n.file) h += '<div class="g-info__file">' + esc(n.file) + "</div>";
    h += '<div class="g-info__meta"><span>' + (n.deg || 0) + " links</span><span>community " + n.community + "</span></div>";
    if (top.length) {
      h += '<div class="g-info__nh-h">Connected to</div><div class="g-info__nh">';
      h += top.map(function (m) { return '<button class="g-chip" data-id="' + esc(m.id) + '" title="' + esc(m.label) + '">' + esc(m.label) + "</button>"; }).join("");
      if (neighbors.length > top.length) h += '<span class="g-more">+' + (neighbors.length - top.length) + " more</span>";
      h += "</div>";
    }
    info.innerHTML = h;
    info.hidden = false;
  }

  function renderStats() {
    var el = document.getElementById("g-stats");
    if (!el || !meta) return;
    el.textContent = (fullLoaded ? "Full graph " : "Core view ") + "· " +
      meta.nodes.toLocaleString() + " nodes · " + meta.links.toLocaleString() +
      " links · " + (meta.communities || "?") + " communities";
  }

  function renderLegend() {
    var el = document.getElementById("g-legend");
    if (!el) return;
    if (mode === "kind") {
      var order = ["function", "method", "struct", "enum", "trait", "config", "file"];
      el.innerHTML = order.map(function (k) {
        return '<span class="g-key"><i style="background:' + kindColor(k) + '"></i>' + k + "</span>";
      }).join("");
    } else {
      el.innerHTML = '<span class="g-key g-key--grad"><i></i>community (steel tones)</span>';
    }
  }

  // search: dim everything except label matches; Enter focuses the top match
  function runSearch(q) {
    q = (q || "").trim().toLowerCase();
    highlight = new Set();
    if (q) {
      byId.forEach(function (n) { if (String(n.label).toLowerCase().indexOf(q) !== -1) highlight.add(n.id); });
    }
    applyColors();
    return q ? bestMatch(q) : null;
  }
  function bestMatch(q) {
    var best = null, bestLen = 1e9;
    byId.forEach(function (n) {
      var lab = String(n.label).toLowerCase();
      if (lab.indexOf(q) !== -1 && lab.length < bestLen) { best = n; bestLen = lab.length; }
    });
    return best;
  }

  // manual orbit, paused while the user drags; resynced on release
  function orbitTick() {
    if (graph && rotating && !dragging && !fitting) {
      var p = graph.cameraPosition();
      var r = Math.hypot(p.x, p.z) || 220;
      orbitAngle += 0.0016;
      graph.cameraPosition({ x: r * Math.sin(orbitAngle), y: p.y, z: r * Math.cos(orbitAngle) });
    }
    requestAnimationFrame(orbitTick);
  }

  function showFallback() {
    if (loading) loading.hidden = true;
    if (fallback) fallback.hidden = false;
    if (controls) controls.hidden = true;
  }

  // perf profiles
  var CORE = { linkOpacity: 0.12, nodeRel: 4, cooldown: 90, warmup: 2 };
  var FULL = { linkOpacity: 0.05, nodeRel: 3, cooldown: 70, warmup: 0 };

  // wire controls
  var search = document.getElementById("g-search");
  if (search) {
    search.addEventListener("input", function () { runSearch(search.value); });
    search.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { var m = runSearch(search.value); if (m) selectNode(m); }
    });
  }
  var colorSel = document.getElementById("g-color");
  if (colorSel) colorSel.addEventListener("change", function () { mode = colorSel.value; applyColors(); renderLegend(); });
  var rotateBtn = document.getElementById("g-rotate");
  if (rotateBtn) {
    rotateBtn.setAttribute("aria-pressed", rotating ? "true" : "false");
    rotateBtn.classList.toggle("is-on", rotating);
    rotateBtn.addEventListener("click", function () {
      rotating = !rotating;
      rotateBtn.setAttribute("aria-pressed", rotating ? "true" : "false");
      rotateBtn.classList.toggle("is-on", rotating);
    });
  }
  var resetBtn = document.getElementById("g-reset");
  if (resetBtn) resetBtn.addEventListener("click", function () {
    clearSelection();
    if (search) search.value = "";
    runSearch("");
    if (graph) graph.zoomToFit(800, 40);
  });
  var fullBtn = document.getElementById("g-loadfull");
  if (fullBtn) fullBtn.addEventListener("click", function () {
    if (fullLoaded) return;
    fullBtn.disabled = true;
    fullBtn.textContent = "Loading…";
    fetch("assets/data/graph-full.json").then(function (r) { return r.json(); }).then(function (full) {
      fullLoaded = true;
      setData(full, FULL);
      fullBtn.textContent = "Full graph loaded";
    }).catch(function () { fullBtn.disabled = false; fullBtn.textContent = "Load full graph"; });
  });

  // pause orbit during drag, resync angle on release so it doesn't jump
  stage.addEventListener("pointerdown", function () { dragging = true; });
  window.addEventListener("pointerup", function () {
    if (!dragging) return;
    dragging = false;
    if (graph) { var p = graph.cameraPosition(); orbitAngle = Math.atan2(p.x, p.z); }
  });

  // resize
  var rt;
  window.addEventListener("resize", function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (graph) graph.width(stage.clientWidth).height(stage.clientHeight); }, 180);
  });

  // go
  fetch("assets/data/graph-core.json")
    .then(function (r) { if (!r.ok) throw new Error("data"); return r.json(); })
    .then(function (core) { initGraph(core, CORE); })
    .catch(function () { showFallback(); });
})();
