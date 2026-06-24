/* =========================================================================
   Shared site behaviour: nav state, mobile menu, scroll reveals, copy.
   Progressive enhancement only — the page is fully readable without JS.
   ========================================================================= */
(function () {
  "use strict";

  // --- sticky nav state --------------------------------------------------
  var nav = document.getElementById("nav");
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // --- mobile menu -------------------------------------------------------
  var toggle = document.querySelector(".nav__toggle");
  var links = document.getElementById("nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // --- scroll reveals ----------------------------------------------------
  var revealables = [].slice.call(document.querySelectorAll(".reveal, [data-inview]"));
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!("IntersectionObserver" in window) || reduce) {
    revealables.forEach(function (el) { el.classList.add("is-inview"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-inview");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.16, rootMargin: "0px 0px -8% 0px" });
    revealables.forEach(function (el) { io.observe(el); });
  }

  // --- rail section index (scrollspy) ------------------------------------
  var indexLinks = [].slice.call(document.querySelectorAll(".rail__index a"));
  if (indexLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    var sections = indexLinks.map(function (a) {
      var id = a.getAttribute("href").slice(1);
      byId[id] = a;
      return document.getElementById(id);
    }).filter(Boolean);
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = byId[entry.target.id];
        if (!link) return;
        if (entry.isIntersecting) {
          indexLinks.forEach(function (l) { l.classList.remove("is-here"); });
          link.classList.add("is-here");
        }
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    sections.forEach(function (s) { spy.observe(s); });
  }

  // --- copy buttons ------------------------------------------------------
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".copy-btn");
    if (!btn) return;
    var text = btn.getAttribute("data-copy");
    if (!text) {
      var holder = btn.closest("[data-copy-src]");
      text = holder ? holder.getAttribute("data-copy-src") : "";
    }
    if (!text) return;
    var done = function () {
      var prev = btn.textContent;
      btn.textContent = "copied";
      btn.classList.add("copied");
      setTimeout(function () { btn.textContent = prev; btn.classList.remove("copied"); }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else {
      var ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (err) {}
      document.body.removeChild(ta);
    }
  });

  // --- footer year -------------------------------------------------------
  var yr = document.getElementById("year");
  if (yr) yr.textContent = String(new Date().getFullYear());
})();
