/* =========================================================================
   Living graph — the site's signature element.
   A small force-directed neural net whose edges *fire*: pulses of light
   travel node -> edge -> node (lavender cooling to cyan), like action
   potentials crossing synapses. Hand-rolled on 2D canvas, no dependencies.

   - Honors prefers-reduced-motion (renders one static frame, no loop).
   - Pauses when the tab is hidden or the hero scrolls out of view.
   ========================================================================= */
(function () {
  "use strict";

  var canvas = document.getElementById("hero-graph");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");

  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- palette ----------------------------------------------------------
  var LAV = [183, 148, 246];
  var CYAN = [103, 232, 249];
  function mix(a, b, t) { return Math.round(a + (b - a) * t); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function signal(t, a) {
    t = clamp(t, 0, 1);
    return "rgba(" + mix(LAV[0], CYAN[0], t) + "," + mix(LAV[1], CYAN[1], t) + "," + mix(LAV[2], CYAN[2], t) + "," + a + ")";
  }

  var HUB_LABELS = [
    "extract", "query_graph", "affected", "serve", "Session",
    "parse_config", "resolve_edges", "communities", "walk_calls", "shard"
  ];

  // ---- state ------------------------------------------------------------
  var W = 0, H = 0, dpr = 1;
  var nodes = [], edges = [], pulses = [];
  var pointer = { x: 0, y: 0, active: false };
  var frame = 0, running = false, rafId = 0;
  var MAX_PULSES = 5, MAX_HOPS = 5;

  function rand(a, b) { return a + Math.random() * (b - a); }

  function build() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(320, rect.width);
    H = Math.max(420, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var count = clamp(Math.round((W * H) / 16500), 20, 60);
    if (W < 620) count = clamp(count, 16, 30);

    nodes = [];
    for (var i = 0; i < count; i++) {
      // bias a little toward the right so the left stays clear for the headline
      var bx = rand(W * 0.08, W * 0.98);
      var by = rand(H * 0.1, H * 0.92);
      nodes.push({
        x: bx, y: by, hx: bx, hy: by, bx: bx, by: by,
        vx: 0, vy: 0,
        ph: rand(0, Math.PI * 2), sp: rand(0.0006, 0.0016), amp: rand(6, 16),
        r: rand(1.6, 2.8),
        hue: clamp(bx / W, 0, 1),
        deg: 0, flare: 0, label: null
      });
    }

    // k-nearest edges -> a planar-ish neural mesh
    edges = [];
    var seen = {};
    function addEdge(a, b) {
      if (a === b) return;
      var key = a < b ? a + "_" + b : b + "_" + a;
      if (seen[key]) return;
      seen[key] = 1;
      edges.push([a, b]);
      nodes[a].deg++; nodes[b].deg++;
    }
    for (var n = 0; n < nodes.length; n++) {
      var dists = [];
      for (var m = 0; m < nodes.length; m++) {
        if (m === n) continue;
        var dx = nodes[n].bx - nodes[m].bx, dy = nodes[n].by - nodes[m].by;
        dists.push([dx * dx + dy * dy, m]);
      }
      dists.sort(function (p, q) { return p[0] - q[0]; });
      var k = Math.random() < 0.4 ? 2 : 1;
      for (var j = 0; j < k && j < dists.length; j++) addEdge(n, dists[j][1]);
    }
    // a few long-range edges for signals to travel far
    var extra = Math.round(nodes.length * 0.12);
    for (var e = 0; e < extra; e++) addEdge((Math.random() * nodes.length) | 0, (Math.random() * nodes.length) | 0);

    // adjacency
    for (var a = 0; a < nodes.length; a++) nodes[a].adj = [];
    for (var ed = 0; ed < edges.length; ed++) {
      nodes[edges[ed][0]].adj.push(edges[ed][1]);
      nodes[edges[ed][1]].adj.push(edges[ed][0]);
    }

    // label a few well-connected nodes on the right half (away from headline)
    var labelable = nodes
      .map(function (nd, idx) { return { idx: idx, deg: nd.deg, x: nd.bx }; })
      .filter(function (o) { return o.x > W * 0.42; })
      .sort(function (p, q) { return q.deg - p.deg; });
    var labelCount = W < 760 ? 0 : Math.min(5, labelable.length);
    for (var L = 0; L < labelCount; L++) {
      nodes[labelable[L].idx].label = HUB_LABELS[L % HUB_LABELS.length];
      nodes[labelable[L].idx].r = Math.max(nodes[labelable[L].idx].r, 3);
    }

    pulses = [];
    MAX_PULSES = W < 620 ? 3 : 5;
  }

  function spawnPulse() {
    if (pulses.length >= MAX_PULSES) return;
    // prefer nodes with neighbours
    var tries = 0, from;
    do { from = (Math.random() * nodes.length) | 0; tries++; }
    while (nodes[from].adj.length === 0 && tries < 12);
    if (nodes[from].adj.length === 0) return;
    var to = nodes[from].adj[(Math.random() * nodes[from].adj.length) | 0];
    pulses.push({ from: from, to: to, prev: from, t: 0, hops: 0, speed: rand(0.010, 0.020) });
  }

  function step() {
    frame++;
    // breathe the home anchors for organic drift
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      nd.hx = nd.bx + Math.sin(frame * nd.sp + nd.ph) * nd.amp;
      nd.hy = nd.by + Math.cos(frame * nd.sp * 1.3 + nd.ph) * nd.amp;
    }
    // forces
    for (var a = 0; a < nodes.length; a++) {
      var p = nodes[a];
      // home spring
      p.vx += (p.hx - p.x) * 0.012;
      p.vy += (p.hy - p.y) * 0.012;
      // local repulsion
      for (var b = a + 1; b < nodes.length; b++) {
        var q = nodes[b];
        var dx = p.x - q.x, dy = p.y - q.y;
        var d2 = dx * dx + dy * dy;
        if (d2 > 0 && d2 < 12000) {
          var f = 26 / d2;
          var d = Math.sqrt(d2);
          var ux = dx / d, uy = dy / d;
          p.vx += ux * f; p.vy += uy * f;
          q.vx -= ux * f; q.vy -= uy * f;
        }
      }
      // pointer repulsion
      if (pointer.active) {
        var pdx = p.x - pointer.x, pdy = p.y - pointer.y;
        var pd2 = pdx * pdx + pdy * pdy;
        if (pd2 < 26000 && pd2 > 0.01) {
          var pd = Math.sqrt(pd2);
          var pf = (1 - pd / 161) * 1.6;
          if (pf > 0) { p.vx += (pdx / pd) * pf; p.vy += (pdy / pd) * pf; }
        }
      }
      if (p.flare > 0) p.flare *= 0.92;
    }
    // integrate
    for (var c = 0; c < nodes.length; c++) {
      var nn = nodes[c];
      nn.vx *= 0.86; nn.vy *= 0.86;
      nn.x += nn.vx; nn.y += nn.vy;
    }
    // pulses
    if (frame % 26 === 0) spawnPulse();
    for (var k = pulses.length - 1; k >= 0; k--) {
      var pu = pulses[k];
      pu.t += pu.speed;
      if (pu.t >= 1) {
        nodes[pu.to].flare = 1;
        pu.hops++;
        if (pu.hops >= MAX_HOPS) { pulses.splice(k, 1); continue; }
        var adj = nodes[pu.to].adj;
        if (!adj.length) { pulses.splice(k, 1); continue; }
        // pick a neighbour, avoid immediate backtrack when possible
        var next = adj[(Math.random() * adj.length) | 0];
        if (adj.length > 1) {
          var guard = 0;
          while (next === pu.prev && guard < 5) { next = adj[(Math.random() * adj.length) | 0]; guard++; }
        }
        pu.prev = pu.from; pu.from = pu.to; pu.to = next; pu.t -= 1;
      }
    }
  }

  function draw() {
    // trailing fade -> comet tails, soft edge glow (matches page --bg)
    ctx.globalCompositeOperation = "source-over";
    if (REDUCED) ctx.clearRect(0, 0, W, H);
    else { ctx.fillStyle = "rgba(7,7,14,0.30)"; ctx.fillRect(0, 0, W, H); }

    // edges
    ctx.lineWidth = 1;
    for (var e = 0; e < edges.length; e++) {
      var na = nodes[edges[e][0]], nb = nodes[edges[e][1]];
      ctx.strokeStyle = signal((na.hue + nb.hue) / 2, 0.12);
      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.lineTo(nb.x, nb.y);
      ctx.stroke();
    }

    // additive glow layer: nodes + pulses
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < nodes.length; i++) {
      var p = nodes[i];
      var r = p.r + p.flare * 3;
      var glow = 7 + p.flare * 14;
      var col = signal(p.hue, 0.9);
      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
      g.addColorStop(0, signal(p.hue, 0.5 + p.flare * 0.4));
      g.addColorStop(1, signal(p.hue, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, glow, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }

    for (var k = 0; k < pulses.length; k++) {
      var pu = pulses[k];
      var a = nodes[pu.from], b = nodes[pu.to];
      var x = a.x + (b.x - a.x) * pu.t, y = a.y + (b.y - a.y) * pu.t;
      var prog = clamp((pu.hops + pu.t) / MAX_HOPS, 0, 1);
      // trail along the edge
      var tt = Math.max(0, pu.t - 0.22);
      var tx = a.x + (b.x - a.x) * tt, ty = a.y + (b.y - a.y) * tt;
      var lg = ctx.createLinearGradient(tx, ty, x, y);
      lg.addColorStop(0, signal(prog, 0));
      lg.addColorStop(1, signal(prog, 0.85));
      ctx.strokeStyle = lg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
      // head
      var hg = ctx.createRadialGradient(x, y, 0, x, y, 9);
      hg.addColorStop(0, signal(prog, 0.95));
      hg.addColorStop(1, signal(prog, 0));
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
    }

    // labels
    ctx.globalCompositeOperation = "source-over";
    ctx.font = "11px ui-monospace, 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle";
    for (var L = 0; L < nodes.length; L++) {
      if (!nodes[L].label) continue;
      var nd = nodes[L];
      ctx.fillStyle = signal(nd.hue, 0.45 + nd.flare * 0.4);
      ctx.fillText(nd.label, nd.x + 9, nd.y);
    }
  }

  function loop() {
    if (!running) return;
    step();
    draw();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running || REDUCED) return;
    running = true;
    rafId = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }

  // reduced motion: settle the layout, then paint one frame
  function staticFrame() {
    for (var s = 0; s < 120; s++) step();
    draw();
  }

  // ---- events -----------------------------------------------------------
  canvas.addEventListener("pointermove", function (ev) {
    var rect = canvas.getBoundingClientRect();
    pointer.x = ev.clientX - rect.left;
    pointer.y = ev.clientY - rect.top;
    pointer.active = true;
  });
  canvas.addEventListener("pointerleave", function () { pointer.active = false; });

  var resizeT;
  window.addEventListener("resize", function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () {
      var wasRunning = running;
      stop();
      build();
      if (REDUCED) staticFrame();
      else if (wasRunning) start();
    }, 200);
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else if (!REDUCED && onScreen) start();
  });

  // pause when hero is off-screen
  var onScreen = true;
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (!onScreen) stop();
      else if (!REDUCED && !document.hidden) start();
    }, { threshold: 0.01 });
    io.observe(canvas);
  }

  // ---- go ---------------------------------------------------------------
  build();
  if (REDUCED) staticFrame();
  else { for (var w = 0; w < 40; w++) step(); start(); }
})();
