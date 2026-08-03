/* tracetap observatory — vanilla JS, no deps, hash-routed. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ utils
  var view = document.getElementById("view");

  // Hooks pane filter. Held here rather than per-render so the choice survives
  // pane switches within a session; the list is stashed so the toggle can
  // re-render without another fetch.
  var hooksShowObserveOnly = false;
  var hooksForPane = [];

  var INSPECTOR_EMPTY =
    '<div class="dim inspector-empty">Select a row to inspect its payload</div>';

  /**
   * The one detail surface, shared by every pane.
   *
   * A docked panel rather than a hover popover, and that is a correctness
   * choice more than a taste one: a popover has to compute its own position,
   * flip near edges, out-race a hide timer, and win a z-index fight against
   * every scroll container it floats over. A panel in normal flow has none of
   * those failure modes, and its text can be selected, copied, and reached
   * with a keyboard for free.
   *
   * Sources register by `data-inspect="<type>:<id>"` and are resolved lazily,
   * so nothing has to be stringified into a DOM attribute to be inspectable.
   */
  var Inspector = (function () {
    var current = null;
    var token = 0;
    /**
     * Drill-downs only. Selecting a PEER (clicking another row, arrowing to the
     * next one) replaces the top of the stack; following an action that changes
     * what you are looking at pushes. Without that distinction, arrowing down a
     * list of 238 tools would build a 238-deep history nobody wants to unwind.
     */
    var stack = [];
    // Set by an action that navigates: the row it lands on becomes a
    // drill-down (so `back` returns here) without teaching every caller of
    // show() about the stack.
    var pushNext = false;

    function host() {
      return document.getElementById("inspector");
    }

    function clear() {
      var el = host();
      current = null;
      stack.length = 0;
      token += 1;
      if (el) {
        el.innerHTML = INSPECTOR_EMPTY;
        el.classList.remove("open");
      }
      document
        .querySelectorAll("[data-inspect].selected")
        .forEach(function (n) {
          n.classList.remove("selected");
          n.removeAttribute("aria-current");
        });
    }

    /**
     * @param spec {kind,title,body,bodyType,actions,load}
     *   `load` is an optional promise resolving to the full body; a stale
     *   response is discarded by comparing the token captured at show() time,
     *   which is what stops a slow fetch overwriting a newer selection.
     * @param opts {push} — true when this is a drill-down that `back` should
     *   return from; omitted for ordinary peer selection.
     */
    function show(sourceId, spec, opts) {
      var doPush = pushNext || (opts && opts.push);
      pushNext = false;
      var frame = { id: sourceId, spec: spec };
      if (doPush && stack.length) stack.push(frame);
      else stack[stack.length ? stack.length - 1 : 0] = frame;
      return render(sourceId, spec);
    }

    /** Make the NEXT show() a drill-down. Cleared whether or not it fires. */
    function pushOnce() {
      pushNext = true;
    }
    function cancelPush() {
      pushNext = false;
    }

    /** Pop one drill-down. Returns false when there is nothing to pop. */
    function back() {
      if (stack.length < 2) return false;
      stack.pop();
      var top = stack[stack.length - 1];
      render(top.id, top.spec);
      return true;
    }

    function render(sourceId, spec) {
      var el = host();
      if (!el) return;
      current = sourceId;
      var mine = ++token;

      var head =
        '<div class="inspector-head">' +
        (stack.length > 1
          ? '<button type="button" class="inspector-back" title="Back (Esc)" aria-label="Back">\u2190</button>'
          : "") +
        (spec.kind ? '<span class="pill">' + esc(spec.kind) + "</span> " : "") +
        '<span class="inspector-title">' +
        esc(spec.title || "") +
        "</span>" +
        '<button type="button" class="inspector-close" title="Close (Esc)" aria-label="Close">×</button>' +
        "</div>";

      var body =
        '<pre class="payload" id="inspector-body">' +
        esc(spec.body == null ? "" : String(spec.body)) +
        "</pre>";

      var note = spec.loadingNote
        ? '<div class="dim" id="inspector-note">' + esc(spec.loadingNote) + "</div>"
        : "";

      var actions = (spec.actions || [])
        .map(function (a, i) {
          return (
            '<button type="button" class="btn-xray" data-act="' +
            i +
            '">' +
            esc(a.label) +
            "</button>"
          );
        })
        .join("");

      el.innerHTML = head + body + note + actions;
      el.classList.add("open");

      el.querySelector(".inspector-close").addEventListener("click", clear);
      var backBtn = el.querySelector(".inspector-back");
      if (backBtn) backBtn.addEventListener("click", back);
      (spec.actions || []).forEach(function (a, i) {
        var b = el.querySelector('[data-act="' + i + '"]');
        if (b) b.addEventListener("click", a.onClick);
      });

      document
        .querySelectorAll("[data-inspect].selected")
        .forEach(function (n) {
          n.classList.remove("selected");
          n.removeAttribute("aria-current");
        });
      var src = document.querySelector(
        '[data-inspect="' + cssEscape(sourceId) + '"]',
      );
      if (src) {
        src.classList.add("selected");
        src.setAttribute("aria-current", "true");
      }

      if (typeof spec.load === "function") {
        spec.load()
          .then(function (full) {
            if (mine !== token) return; // superseded by a newer selection
            var b = document.getElementById("inspector-body");
            var n = document.getElementById("inspector-note");
            if (b) b.textContent = full;
            if (n) n.remove();
          })
          .catch(function (err) {
            if (mine !== token) return;
            var n = document.getElementById("inspector-note");
            if (n) n.textContent = "full payload unavailable — " + (err.message || err);
          });
      }
    }

    return {
      show: show,
      pushOnce: pushOnce,
      cancelPush: cancelPush,
      back: back,
      clear: clear,
      depth: function () {
        return stack.length;
      },
      selected: function () {
        return current;
      },
    };
  })();

  /** Minimal attribute-selector escaping — ids here are ascii but may hold ':' and '/'. */
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }
  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok)
        return r.json().then(function (b) {
          throw new Error(b.error || r.status);
        });
      return r.json();
    });
  }
  function fmtTime(epoch) {
    if (!epoch) return "—";
    var d = new Date(epoch * 1000);
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }
  function fmtDur(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return ms + "ms";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + Math.round(s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function fmtTok(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "K";
    return String(n);
  }
  function fmtCost(c, plus) {
    if (c == null) return "—";
    var s =
      c >= 100
        ? "$" + c.toFixed(0)
        : c >= 0.01 || c === 0
          ? "$" + c.toFixed(2)
          : "$" + c.toFixed(4);
    return plus ? s + "+" : s;
  }
  function fmtPct(x) {
    return (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%";
  }
  function basename(p) {
    if (!p) return "";
    var parts = String(p).split("/");
    return parts[parts.length - 1] || p;
  }
  function agentPill(agent) {
    var a = esc(agent || "?");
    return '<span class="pill agent-' + a + '">' + a + "</span>";
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      var args = arguments,
        self = this;
      t = setTimeout(function () {
        fn.apply(self, args);
      }, ms);
    };
  }

  /** Skeleton shimmer placeholder: optional card grid + stacked rows. */
  function skeleton(opts) {
    opts = opts || {};
    var h = "";
    if (opts.cards) {
      h += '<div class="skel-cards">';
      for (var c = 0; c < opts.cards; c++)
        h += '<div class="skel skel-card"></div>';
      h += "</div>";
    }
    for (var i = 0; i < (opts.rows || 6); i++)
      h += '<div class="skel skel-row"></div>';
    return h;
  }
  function skelRows(n, cols) {
    var out = "";
    for (var i = 0; i < n; i++) {
      out +=
        '<tr><td colspan="' +
        cols +
        '"><div class="skel skel-line"></div></td></tr>';
    }
    return out;
  }

  // Status bar: db path, index counts, price source (refreshed on SSE change).
  function loadMeta() {
    fetchJSON("/api/meta")
      .then(function (m) {
        var db = document.getElementById("sb-db");
        var counts = document.getElementById("sb-counts");
        var prices = document.getElementById("sb-prices");
        if (db) {
          db.textContent = m.dbPath;
          db.title = m.dbPath;
        }
        if (counts) {
          counts.textContent =
            m.counts.sessions +
            " sessions · " +
            m.counts.requests +
            " calls · " +
            m.counts.prompts +
            " prompts · " +
            m.counts.events +
            " events";
        }
        if (prices) prices.textContent = "prices: " + m.priceSource;
        // The page you are reading is re-composed from disk on every request,
        // so it is always current — the SERVER is not. When they diverge the
        // symptom is a pane calling an endpoint that does not exist yet, which
        // reads as a data bug rather than a stale process. Say it plainly.
        var stale = document.getElementById("sb-stale");
        if (stale && m.build) {
          stale.hidden = !m.build.stale;
          if (m.build.stale) {
            stale.textContent = "⚠ restart required — newer build on disk";
            stale.title =
              "running build " +
              new Date(m.build.loadedAt).toLocaleString() +
              "\non disk       " +
              new Date(m.build.builtAt).toLocaleString() +
              "\n\nThe frontend reloads from disk, but compiled server code is " +
              "frozen at process start. Restart `tracetap serve`.";
          }
        }
      })
      .catch(function () {});
  }

  // ------------------------------------------------------------- svg charts
  /** Vertical column chart. items: [{label, value, title?, warn?}] */
  function columnChart(items, opts) {
    opts = opts || {};
    var H = opts.height || 120,
      PAD = 4,
      LABEL_H = opts.labels ? 16 : 0;
    var W = Math.max(80, items.length * (opts.colWidth || 18));
    var max = 0;
    items.forEach(function (it) {
      if (it.value > max) max = it.value;
    });
    if (max <= 0) max = 1;
    var cw = W / items.length;
    var bars = items.map(function (it, i) {
      var h = Math.max(
        it.value > 0 ? 2 : 0,
        (it.value / max) * (H - PAD - LABEL_H),
      );
      var x = i * cw + 1.5;
      var color = it.warn ? "var(--warn)" : it.color || "var(--accent)";
      var rect =
        '<rect x="' +
        x.toFixed(1) +
        '" y="' +
        (H - LABEL_H - h).toFixed(1) +
        '" width="' +
        Math.max(1, cw - 3).toFixed(1) +
        '" height="' +
        h.toFixed(1) +
        '" rx="1.5" fill="' +
        color +
        '" opacity="0.85"><title>' +
        esc(it.title || it.label + ": " + it.value) +
        "</title></rect>";
      var label = "";
      if (
        opts.labels &&
        (items.length <= 16 || i % Math.ceil(items.length / 16) === 0)
      ) {
        label =
          '<text x="' +
          (i * cw + cw / 2).toFixed(1) +
          '" y="' +
          (H - 3) +
          '" font-size="9" fill="var(--dim)" text-anchor="middle">' +
          esc(it.label) +
          "</text>";
      }
      return rect + label;
    });
    return (
      '<svg viewBox="0 0 ' +
      W +
      " " +
      H +
      '" preserveAspectRatio="none" height="' +
      H +
      '">' +
      bars.join("") +
      "</svg>"
    );
  }

  /** Stacked column chart. items: [{label, parts:[{value,color,name}], title}] */
  function stackedChart(items, opts) {
    opts = opts || {};
    var H = opts.height || 120,
      PAD = 4;
    var W = Math.max(80, items.length * (opts.colWidth || 18));
    var max = 0;
    items.forEach(function (it) {
      var sum = 0;
      it.parts.forEach(function (p) {
        sum += p.value;
      });
      if (sum > max) max = sum;
    });
    if (max <= 0) max = 1;
    var cw = W / items.length;
    var out = items.map(function (it, i) {
      var x = i * cw + 1.5,
        y = H;
      var rects = it.parts.map(function (p) {
        var h = (p.value / max) * (H - PAD);
        y -= h;
        if (h <= 0) return "";
        return (
          '<rect x="' +
          x.toFixed(1) +
          '" y="' +
          y.toFixed(1) +
          '" width="' +
          Math.max(1, cw - 3).toFixed(1) +
          '" height="' +
          h.toFixed(1) +
          '" fill="' +
          p.color +
          '" opacity="0.9"></rect>'
        );
      });
      return (
        "<g>" +
        rects.join("") +
        "<title>" +
        esc(it.title || it.label) +
        "</title></g>"
      );
    });
    return (
      '<svg viewBox="0 0 ' +
      W +
      " " +
      H +
      '" preserveAspectRatio="none" height="' +
      H +
      '">' +
      out.join("") +
      "</svg>"
    );
  }

  // ---------------------------------------------------------------- router
  var current = { name: null, arg: null };

  function route() {
    var h = location.hash.replace(/^#/, "") || "sessions";
    var m;
    // session/<id>[/<pane>][/step-N]
    //
    // The pane list is built from SESSION_PANES rather than spelled out here.
    // It used to be a literal, so adding a pane silently broke its own URL:
    // the whole route stopped matching and fell through to the session LIST,
    // which looks like the pane failed to render rather than like a routing
    // miss. One list, one place to add to.
    if (
      (m = h.match(
        new RegExp(
          "^session\\/([^/]+)(?:\\/(" +
            SESSION_PANES.join("|") +
            "))?(?:\\/step-(\\d+))?$",
        ),
      ))
    ) {
      renderSession(
        decodeURIComponent(m[1]),
        m[3] ? Number(m[3]) : null,
        m[2] || "flow",
      );
    } else if ((m = h.match(/^prompt\/(.+)$/)))
      renderPrompt(decodeURIComponent(m[1]));
    else if (h === "usage") renderUsage();
    else if (h === "analytics") renderAnalytics();
    else if (h === "prompts") renderPrompts();
    else if (h === "audit") renderAudit();
    else if (h === "tooltax") renderToolTax();
    else renderSessions();

    var tab = h.split("/")[0];
    if (tab === "session") tab = "sessions";
    if (tab === "prompt") tab = "prompts";
    document.querySelectorAll("#tabs a").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-tab") === tab);
    });
  }
  window.addEventListener("hashchange", route);

  function setView(html) {
    view.innerHTML = html;
  }
  function fail(err) {
    setView('<div class="empty">Error: ' + esc(err.message || err) + "</div>");
  }
  function card(k, v, alert) {
    return (
      '<div class="card' +
      (alert ? " alert" : "") +
      '"><div class="k">' +
      k +
      '</div><div class="v">' +
      v +
      "</div></div>"
    );
  }

  // --------------------------------------------------------- wire pane (FIG/waterfall)

  function bindSessionInteractions(reqs, compactSeqs, steps) {
    var wf = document.getElementById("wf");
    if (wf) {
      var bySeq = {};
      reqs.forEach(function (r) {
        bySeq[r.seq] = r;
      });
      TT.bind(wf, ".wf-row", function (rowEl) {
        var r = bySeq[rowEl.getAttribute("data-seq")];
        return r ? wfTooltip(r, compactSeqs[r.seq]) : null;
      });
      wf.addEventListener("click", function (e) {
        var rowEl = e.target.closest(".wf-row");
        if (!rowEl) return;
        var step = rowEl.getAttribute("data-step");
        if (step) flashStep(step);
      });
    }

    var mm = document.getElementById("minimap");
    if (mm) {
      mm.addEventListener("click", function (e) {
        var tick = e.target.closest(".mm-tick");
        if (!tick) return;
        e.preventDefault();
        flashStep(tick.getAttribute("data-step"));
      });
      // Scroll spy: light up the rail segment for the topmost visible step.
      var visible = new Set();
      var spy = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            var idx = en.target.id.replace("step-", "");
            if (en.isIntersecting) visible.add(idx);
            else visible.delete(idx);
          });
          var top = null;
          visible.forEach(function (idx) {
            var n = Number(idx);
            if (top == null || n < top) top = n;
          });
          mm.querySelectorAll(".mm-tick").forEach(function (t) {
            t.classList.toggle("on", Number(t.getAttribute("data-step")) === top);
          });
        },
        { rootMargin: "-64px 0px -40% 0px" },
      );
      document.querySelectorAll(".step[id^=step-]").forEach(function (st) {
        spy.observe(st);
      });
    }
  }

  function wfTooltip(r, compaction) {
    var stream = r.durationMs != null && r.ttftMs != null ? r.durationMs - r.ttftMs : null;
    var h = TT.title("call " + r.seq + (r.model ? " · " + r.model : ""));
    h += TT.row(
      "status",
      r.status == null
        ? '<span class="warn-text">no response</span>'
        : r.status >= 400
          ? '<span class="warn-text">' + r.status + "</span>"
          : String(r.status),
    );
    if (r.ttftMs != null) h += TT.row("ttft", fmtDur(r.ttftMs));
    if (stream != null) h += TT.row("stream", fmtDur(stream));
    h += TT.row("total", fmtDur(r.durationMs));
    h += TT.row("fresh in", fmtTok(r.promptTokens));
    h += TT.row("cache read", fmtTok(r.cacheRead));
    if (r.cacheCreation) h += TT.row("cache write", fmtTok(r.cacheCreation));
    h += TT.row("output", fmtTok(r.completionTokens));
    if (r.reasoningTokens) h += TT.row("reasoning", fmtTok(r.reasoningTokens));
    if (r.stopReason) h += TT.row("stop", TT.esc(r.stopReason));
    h += TT.row("transcript", r.transcriptItems + " items");
    if (compaction)
      h += TT.row(
        "compaction",
        '<span class="warn-text">' + compaction.from + " → " + compaction.to + " items</span>",
      );
    if (r.promptHash) h += TT.row("prompt", r.promptHash.slice(0, 8));
    if (r.agentStepIndex != null) h += TT.row("step", "#" + r.agentStepIndex + " · click to jump");
    return h;
  }

  function minimapHtml(steps) {
    if (steps.length < 8) return "";
    return (
      '<nav class="minimap" id="minimap" aria-label="transcript minimap">' +
      steps
        .map(function (st) {
          var cls = st.errored
            ? "e"
            : st.role === "user"
              ? "u"
              : st.role === "agent"
                ? "a"
                : "s";
          var label =
            "#" +
            st.stepIndex +
            " " +
            st.role +
            (st.toolName ? " · " + st.toolName.split(/\s+/)[0] : "");
          return (
            '<a class="mm-tick ' +
            cls +
            '" href="#" data-step="' +
            st.stepIndex +
            '" title="' +
            esc(label) +
            '"></a>'
          );
        })
        .join("") +
      "</nav>"
    );
  }

  function laneSection(reqs, compactSeqs) {
    if (!reqs.length) return "";
    var ctxItems = reqs.map(function (r) {
      var c = compactSeqs[r.seq];
      return {
        label: String(r.seq),
        value: r.transcriptItems,
        warn: !!c,
        title:
          "call " +
          r.seq +
          ": " +
          r.transcriptItems +
          " transcript items" +
          (c ? " — COMPACTION (was " + c.from + ")" : ""),
      };
    });
    var tokItems = reqs.map(function (r) {
      return {
        label: String(r.seq),
        title:
          "call " +
          r.seq +
          ": fresh in " +
          fmtTok(r.promptTokens) +
          " · cache read " +
          fmtTok(r.cacheRead) +
          " · cache write " +
          fmtTok(r.cacheCreation) +
          " · out " +
          fmtTok(r.completionTokens),
        parts: [
          { value: r.cacheRead, color: "var(--cache)" },
          { value: r.cacheCreation, color: "var(--purple)" },
          { value: r.promptTokens, color: "var(--accent)" },
          { value: r.completionTokens, color: "var(--ok)" },
        ],
      };
    });
    return (
      '<div class="split">' +
      '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.1</span>Context growth — transcript items per call · amber = mid-task compaction</div>' +
      columnChart(ctxItems, { height: 110, labels: false }) +
      "</div>" +
      '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.2</span>Token flow per call</div>' +
      stackedChart(tokItems, { height: 110 }) +
      '<div class="legend">' +
      '<span><span class="sw" style="background:var(--cache)"></span>cache read</span>' +
      '<span><span class="sw" style="background:var(--purple)"></span>cache write</span>' +
      '<span><span class="sw" style="background:var(--accent)"></span>fresh input</span>' +
      '<span><span class="sw" style="background:var(--ok)"></span>output</span>' +
      "</div></div></div>"
    );
  }

  function waterfall(reqs, compactSeqs) {
    if (!reqs.length)
      return '<div class="dim">No wire data (re-index with tracetap ≥ 0.3).</div>';
    var t0 = Infinity,
      t1 = -Infinity;
    reqs.forEach(function (r) {
      if (r.ts > 0) t0 = Math.min(t0, r.ts);
      var end = r.ts + (r.durationMs || 0) / 1000;
      t1 = Math.max(t1, end);
    });
    if (!isFinite(t0) || t1 <= t0) {
      t0 = 0;
      t1 = 1;
    }
    var span = t1 - t0;
    return reqs
      .map(function (r) {
        var left = r.ts > 0 ? ((r.ts - t0) / span) * 100 : 0;
        var durW =
          r.durationMs != null ? Math.max(0.4, (r.durationMs / 1000 / span) * 100) : 0.6;
        var ttftW = r.ttftMs != null ? (r.ttftMs / 1000 / span) * 100 : 0;
        var bars = "";
        if (ttftW > 0) {
          bars +=
            '<div class="wf-bar wait" style="left:' +
            left.toFixed(2) +
            "%;width:" +
            ttftW.toFixed(2) +
            '%"></div>';
          bars +=
            '<div class="wf-bar' +
            (r.errored ? " errored" : "") +
            '" style="left:' +
            (left + ttftW).toFixed(2) +
            "%;width:" +
            Math.max(0.3, durW - ttftW).toFixed(2) +
            '%"></div>';
        } else {
          bars +=
            '<div class="wf-bar' +
            (r.errored ? " errored" : "") +
            '" style="left:' +
            left.toFixed(2) +
            "%;width:" +
            durW.toFixed(2) +
            '%"></div>';
        }
        var c = compactSeqs[r.seq];
        var meta =
          (r.status == null ? "no response" : r.status) +
          " · " +
          fmtDur(r.durationMs) +
          (r.ttftMs != null ? " · ttft " + fmtDur(r.ttftMs) : "") +
          " · " +
          fmtTok(r.completionTokens) +
          " out" +
          (r.stopReason ? " · " + esc(r.stopReason) : "");
        var linked = r.agentStepIndex != null;
        return (
          '<div class="wf-row' +
          (linked ? " click" : "") +
          '" data-seq="' +
          r.seq +
          '" data-inspect="ctp:' +
          r.seq +
          '" tabindex="0"' +
          (linked ? ' data-step="' + r.agentStepIndex + '"' : "") +
          ">" +
          '<div class="wf-label">' +
          r.seq +
          (c ? ' <span class="wf-compact">⇣</span>' : "") +
          (r.isSubagent
            ? ' <span class="agent-dot" title="' +
              esc(r.agentLabel || "subagent (unnamed)") +
              '"></span>'
            : "") +
          "</div>" +
          '<div class="wf-track">' +
          bars +
          "</div>" +
          '<div class="wf-meta">' +
          meta +
          "</div>" +
          "</div>"
        );
      })
      .join("");
  }

  // ------------------------------------------------------------- sessions
  var sess = {
    sort: "started_at",
    order: "desc",
    q: "",
    agent: "",
    model: "",
    project: "",
    errored: false,
  };

  var SESSION_COLS = [
    { key: "agent", label: "Agent", sortable: true },
    { key: "model", label: "Model", sortable: true },
    { key: "project_cwd", label: "Project", sortable: true },
    { key: "started_at", label: "Started", sortable: true },
    { key: "duration_ms", label: "Duration", sortable: true, num: true },
    { key: "turns", label: "Turns", num: true },
    { key: "total_in_tokens", label: "In", sortable: true, num: true },
    { key: "total_out_tokens", label: "Out", sortable: true, num: true },
    { key: "cache", label: "Cache hit", num: true },
    { key: "errors", label: "Errs", num: true },
    { key: "cost_usd", label: "Cost", sortable: true, num: true },
  ];

  function renderSessions() {
    current = { name: "sessions" };
    var controls =
      '<div class="controls">' +
      '<input id="q" type="search" placeholder="Full-text search every session (FTS5) — try an error message, a file name, a tool name…" value="' +
      esc(sess.q) +
      '" />' +
      '<input id="f-agent" class="filter" type="text" placeholder="agent" value="' +
      esc(sess.agent) +
      '" />' +
      '<input id="f-model" class="filter" type="text" placeholder="model" value="' +
      esc(sess.model) +
      '" />' +
      '<input id="f-project" class="filter" type="text" placeholder="project" value="' +
      esc(sess.project) +
      '" />' +
      '<label class="check"><input id="f-errored" type="checkbox"' +
      (sess.errored ? " checked" : "") +
      "/> errored only</label>" +
      "</div>" +
      '<div class="meta-line" id="meta">Loading…</div>' +
      '<div class="tbl-wrap"><table><thead><tr id="head"></tr></thead><tbody id="rows">' +
      skelRows(8, SESSION_COLS.length) +
      "</tbody></table></div>" +
      '<div class="empty" id="empty" style="display:none"></div>';
    setView(controls);

    ["q", "f-agent", "f-model", "f-project"].forEach(function (id) {
      document
        .getElementById(id)
        .addEventListener("input", debounce(onSessionControls, 200));
    });
    document
      .getElementById("f-errored")
      .addEventListener("change", onSessionControls);
    loadSessionData();
  }

  function onSessionControls() {
    sess.q = document.getElementById("q").value.trim();
    sess.agent = document.getElementById("f-agent").value.trim();
    sess.model = document.getElementById("f-model").value.trim();
    sess.project = document.getElementById("f-project").value.trim();
    sess.errored = document.getElementById("f-errored").checked;
    loadSessionData();
  }

  function sessionParams() {
    var p = new URLSearchParams();
    if (sess.agent) p.set("agent", sess.agent);
    if (sess.model) p.set("model", sess.model);
    if (sess.project) p.set("project", sess.project);
    if (sess.errored) p.set("errored", "1");
    return p;
  }

  function loadSessionData() {
    if (!document.getElementById("rows")) return;
    if (sess.q) return loadSearchHits();
    renderSessionHead();
    var p = sessionParams();
    p.set("sort", sess.sort);
    p.set("order", sess.order);
    fetchJSON("/api/sessions?" + p)
      .then(function (data) {
        var meta = document.getElementById("meta");
        if (meta)
          meta.textContent =
            data.count + " session" + (data.count === 1 ? "" : "s");
        renderSessionRows(data.sessions);
      })
      .catch(fail);
  }

  function renderSessionHead() {
    var head = document.getElementById("head");
    if (!head) return;
    head.innerHTML = SESSION_COLS.map(function (c) {
      var arrow =
        c.key === sess.sort
          ? ' <span class="arrow">' +
            (sess.order === "asc" ? "▲" : "▼") +
            "</span>"
          : "";
      return (
        '<th class="' +
        (c.num ? "num " : "") +
        (c.sortable ? "sortable" : "") +
        '" data-key="' +
        c.key +
        '" data-sortable="' +
        (c.sortable ? 1 : 0) +
        '">' +
        esc(c.label) +
        arrow +
        "</th>"
      );
    }).join("");
    head.querySelectorAll("th[data-sortable='1']").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (sess.sort === key)
          sess.order = sess.order === "asc" ? "desc" : "asc";
        else {
          sess.sort = key;
          sess.order = "desc";
        }
        loadSessionData();
      });
    });
  }

  function cacheRate(s) {
    var denom =
      (s.totalInTokens || 0) + (s.cacheRead || 0) + (s.cacheCreation || 0);
    return denom > 0 ? (s.cacheRead || 0) / denom : 0;
  }

  function renderSessionRows(sessions) {
    var rows = document.getElementById("rows");
    var empty = document.getElementById("empty");
    if (!rows) return;
    if (!sessions.length) {
      rows.innerHTML = "";
      empty.style.display = "block";
      empty.innerHTML =
        "No indexed sessions. Capture with <code>tracetap claude|codex|gemini</code>, then run <code>tracetap index</code>.";
      return;
    }
    empty.style.display = "none";
    rows.innerHTML = sessions
      .map(function (s) {
        return (
          '<tr class="click" data-id="' +
          esc(s.sessionId) +
          '">' +
          "<td>" +
          agentPill(s.agent) +
          "</td>" +
          "<td>" +
          esc(s.model || "—") +
          "</td>" +
          '<td class="dim" title="' +
          esc(s.projectCwd) +
          '">' +
          esc(basename(s.projectCwd)) +
          "</td>" +
          "<td>" +
          fmtTime(s.startedAt) +
          "</td>" +
          '<td class="num">' +
          fmtDur(s.durationMs) +
          "</td>" +
          '<td class="num">' +
          (s.turns || 0) +
          "</td>" +
          '<td class="num">' +
          fmtTok(s.totalInTokens) +
          "</td>" +
          '<td class="num">' +
          fmtTok(s.totalOutTokens) +
          "</td>" +
          '<td class="num">' +
          fmtPct(cacheRate(s)) +
          "</td>" +
          '<td class="num">' +
          (s.errorCount
            ? '<span class="pill err">' + s.errorCount + "</span>"
            : "0") +
          "</td>" +
          '<td class="num">' +
          fmtCost(s.costUsd) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
    rows.querySelectorAll("tr[data-id]").forEach(function (tr) {
      tr.addEventListener("click", function () {
        location.hash =
          "#session/" + encodeURIComponent(tr.getAttribute("data-id"));
      });
    });
  }

  function loadSearchHits() {
    var p = sessionParams();
    p.set("q", sess.q);
    p.set("limit", "50");
    fetchJSON("/api/search?" + p)
      .then(function (data) {
        var meta = document.getElementById("meta");
        if (meta)
          meta.textContent =
            data.count +
            " hit" +
            (data.count === 1 ? "" : "s") +
            " for “" +
            sess.q +
            "”";
        var head = document.getElementById("head");
        head.innerHTML =
          "<th>Session</th><th>Model</th><th>Match</th><th>When</th>";
        var rows = document.getElementById("rows");
        var empty = document.getElementById("empty");
        if (!data.hits.length) {
          rows.innerHTML = "";
          empty.style.display = "block";
          empty.textContent = "No matches.";
          return;
        }
        empty.style.display = "none";
        rows.innerHTML = data.hits
          .map(function (h) {
            var snip = esc(h.snippet).replace(/\[([^\]]*)\]/g, "<b>$1</b>");
            return (
              '<tr class="click" data-id="' +
              esc(h.sessionId) +
              '" data-step="' +
              h.stepIndex +
              '">' +
              "<td>" +
              agentPill(h.agent) +
              ' <span class="pill">#' +
              h.stepIndex +
              "</span>" +
              (h.errored ? ' <span class="pill err">errored</span>' : "") +
              "</td>" +
              "<td>" +
              esc(h.model) +
              "</td>" +
              '<td><div class="snippet">' +
              snip +
              "</div>" +
              (h.toolName
                ? '<div class="hash">↳ ' + esc(h.toolName) + "</div>"
                : "") +
              "</td>" +
              '<td class="dim">' +
              fmtTime(h.startedAt) +
              "</td>" +
              "</tr>"
            );
          })
          .join("");
        rows.querySelectorAll("tr[data-id]").forEach(function (tr) {
          tr.addEventListener("click", function () {
            // Deep-link straight to the matching transcript step.
            location.hash =
              "#session/" +
              encodeURIComponent(tr.getAttribute("data-id")) +
              "/step-" +
              tr.getAttribute("data-step");
          });
        });
      })
      .catch(fail);
  }

  // -------------------------------------------------------- session detail
  function renderSession(id, stepN, pane) {
    if (
      current.name === "session" &&
      current.arg === id &&
      stepN != null &&
      !pane
    ) {
      // Same session, new step anchor (e.g. minimap click) — just scroll.
      flashStep(stepN);
      return;
    }
    // Same session, only pane change — don't reload.
    if (
      current.name === "session" &&
      current.arg === id &&
      pane &&
      document.getElementById("pane-" + pane)
    ) {
      activatePane(pane);
      if (stepN != null) {
        activatePane("wire");
        setTimeout(function () {
          flashStep(stepN);
        }, 30);
      }
      return;
    }
    current = { name: "session", arg: id, pane: pane || "flow" };
    setView(skeleton({ cards: 8, rows: 6 }));
    fetchJSON("/api/session/" + encodeURIComponent(id))
      .then(function (data) {
        if (current.name !== "session" || current.arg !== id) return;
        drawSession(data, stepN, current.pane || "flow");
      })
      .catch(fail);
  }

  function flashStep(stepIndex) {
    var elStep = document.getElementById("step-" + stepIndex);
    if (!elStep) return;
    elStep.scrollIntoView({ behavior: "smooth", block: "center" });
    elStep.classList.remove("flash");
    void elStep.offsetWidth; // restart the animation
    elStep.classList.add("flash");
  }

  /**
   * Report panes the server could not build.
   *
   * `paneSection` isolates a failing section so one bad row cannot 500 the whole
   * endpoint — but the isolated section arrives as null, which renders as an
   * ordinary empty pane. Without this the user cannot tell "nothing to show"
   * from "this broke", which is the whole point of having isolated it.
   */
  function sectionErrorBanner(errors) {
    if (!errors) return "";
    var names = Object.keys(errors);
    if (!names.length) return "";
    return (
      '<div class="section-errors">' +
      names
        .map(function (n) {
          return (
            "<div><b>" +
            esc(n) +
            "</b> pane failed to load — " +
            esc(String(errors[n])) +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function drawSession(data, stepN, initialPane) {
    var s = data.session,
      reqs = data.requests,
      steps = data.steps;
    var hooks = data.hooks || [];
    hooksForPane = hooks;
    var flow = data.flow || { nodes: [], edges: [] };
    var siblings = data.siblings || [];
    var compactSeqs = {};
    var compactionList = data.compactions || [];
    compactionList.forEach(function (c) {
      compactSeqs[c.seq] = c;
    });

    var ttfts = reqs
      .map(function (r) {
        return r.ttftMs;
      })
      .filter(function (v) {
        return v != null;
      })
      .sort(function (a, b) {
        return a - b;
      });
    var ttftP50 = ttfts.length
      ? ttfts[Math.floor((ttfts.length - 1) * 0.5)]
      : null;
    var errReqs = reqs.filter(function (r) {
      return r.errored;
    }).length;

    var cards =
      card("Cost", fmtCost(s.costUsd)) +
      card("Duration", fmtDur(s.durationMs)) +
      card("Turns", s.turns || 0) +
      card(
        "API calls",
        reqs.length +
          (errReqs
            ? ' <small class="warn-text">' + errReqs + " failed</small>"
            : ""),
      ) +
      card(
        "Tokens in/out",
        fmtTok(s.totalInTokens) +
          " <small>/</small> " +
          fmtTok(s.totalOutTokens),
      ) +
      card("Cache hit", fmtPct(cacheRate(s))) +
      card("TTFT p50", ttftP50 != null ? fmtDur(ttftP50) : "—") +
      // Headline the count that can actually tell you something. "Hooks 869"
      // when all 869 are stubs is a number that reads as signal and is not.
      card(
        "Hooks",
        signalHooks(hooks).length +
          (signalHooks(hooks).length !== hooks.length
            ? ' <small class="dim">of ' + hooks.length + "</small>"
            : ""),
      ) +
      card("Compactions", compactionList.length, compactionList.length > 0);

    var pane = initialPane || "flow";
    function subnavBtn(name, label, count) {
      return (
        '<button type="button" class="subnav-btn' +
        (pane === name ? " active" : "") +
        '" data-pane="' +
        name +
        '">' +
        label +
        (count != null ? " <small>" + count + "</small>" : "") +
        "</button>"
      );
    }

    var html =
      '<div class="crumb"><a href="#sessions">← sessions</a></div>' +
      '<div class="detail-head"><h1>' +
      agentPill(s.agent) +
      " " +
      esc(s.model) +
      "</h1>" +
      '<span class="dim">' +
      esc(s.projectCwd) +
      " · " +
      fmtTime(s.startedAt) +
      "</span>" +
      '<span class="actions">' +
      (data.reportAvailable
        ? '<a href="/report?session=' +
          encodeURIComponent(s.sessionId) +
          '" target="_blank" rel="noopener">wire report ↗</a>'
        : "") +
      // The system prompt was reachable only as 8 characters of hash inside a
      // waterfall row's hover tooltip — you could see that a prompt existed
      // but never read it without hunting the Prompts tab by eye.
      (reqs.length && reqs[0].promptHash
        ? ' <a class="head-link" href="#prompt/' +
          esc(reqs[0].promptHash) +
          '">system prompt ↗</a>'
        : "") +
      "</span></div>" +
      '<div class="cards">' +
      cards +
      "</div>" +
      sectionErrorBanner(data.sectionErrors) +
      '<nav class="session-subnav" id="session-subnav">' +
      subnavBtn("flow", "Flow") +
      subnavBtn("hooks", "Hooks", signalHooks(hooks).length) +
      subnavBtn("xray", "Context X-Ray") +
      subnavBtn("tools", "Tool Tax") +
      subnavBtn("wire", "Wire") +
      subnavBtn("related", "Related", siblings.length || null) +
      "</nav>" +
      '<div class="session-body">' +
      '<div class="session-panes">' +
      '<section class="session-pane' +
      (pane === "flow" ? " active" : "") +
      '" id="pane-flow">' +
      renderFlowPane(flow) +
      "</section>" +
      '<section class="session-pane' +
      (pane === "hooks" ? " active" : "") +
      '" id="pane-hooks">' +
      renderHooksPane(hooks) +
      "</section>" +
      '<section class="session-pane' +
      (pane === "xray" ? " active" : "") +
      '" id="pane-xray">' +
      renderXrayPane(s.sessionId, reqs) +
      "</section>" +
      '<section class="session-pane' +
      (pane === "tools" ? " active" : "") +
      '" id="pane-tools">' +
      // Filled in by loadToolTax once /tools responds — same lazy contract as
      // the context timeline.
      '<div id="tooltax-host"><div class="dim">loading tool tax…</div></div>' +
      "</section>" +
      '<section class="session-pane' +
      (pane === "wire" ? " active" : "") +
      '" id="pane-wire">' +
      laneSection(reqs, compactSeqs) +
      '<h2 class="sec">Request waterfall <small>(' +
      reqs.length +
      " API calls · hover for wire metrics · click to jump to the step)</small></h2>" +
      '<div class="chart-box waterfall" id="wf">' +
      waterfall(reqs, compactSeqs) +
      "</div>" +
      '<h2 class="sec">Transcript <small>(' +
      steps.length +
      " steps)</small></h2>" +
      '<div class="steps">' +
      steps.map(stepCard).join("") +
      "</div>" +
      minimapHtml(steps) +
      "</section>" +
      '<section class="session-pane' +
      (pane === "related" ? " active" : "") +
      '" id="pane-related">' +
      renderConversations(reqs) +
      renderRelatedPane(siblings, s) +
      "</section>" +
      "</div>" +
      // One inspector for all five panes. It lives beside `.session-panes`
      // rather than inside any one of them, which is the whole point: a panel
      // owned by the Flow pane can only ever serve the Flow pane.
      '<aside class="inspector" id="inspector">' +
      INSPECTOR_EMPTY +
      "</aside>" +
      "</div>";
    setView(html);
    bindSessionInteractions(reqs, compactSeqs, steps);
    bindSessionPanes(s.sessionId, reqs);
    if (stepN != null) {
      activatePane("wire");
      setTimeout(function () {
        flashStep(stepN);
      }, 30);
    }
  }

  /**
   * The inspector is shared, but what it can describe is NOT.
   *
   * The panes have different scopes, and this is a property of the data, not a
   * layout choice: Context X-Ray and Wire are per API call (215 distinct
   * context sizes across 224 calls), while Tool Tax is per TOOLSET — one
   * toolset covered all 224 calls of the session this was found on, and the
   * `tools` bucket had exactly one distinct value throughout. A dead-tool
   * selection therefore says nothing about the call you just switched to.
   *
   * Leaving it up made the panel look like it described the new pane. So a
   * selection that does not live in the pane you are now looking at is
   * dropped, and if you had been somewhere in THIS pane before, you land back
   * there rather than on nothing.
   */
  function syncInspectorToPane(name) {
    var id = Inspector.selected();
    if (!id) return;
    var pane = document.getElementById("pane-" + name);
    var el = pane
      ? pane.querySelector('[data-inspect="' + cssEscape(id) + '"]')
      : null;
    if (el) return; // still in scope — nothing to do
    Inspector.clear();
    var remembered = paneCursor[name];
    if (!remembered || !pane) return;
    var back = pane.querySelector('[data-inspect="' + cssEscape(remembered) + '"]');
    if (back && back.offsetParent !== null) back.click();
  }

  function activatePane(name) {
    document
      .querySelectorAll("#session-subnav [data-pane]")
      .forEach(function (a) {
        a.classList.toggle("active", a.getAttribute("data-pane") === name);
      });
    document.querySelectorAll(".session-pane").forEach(function (p) {
      p.classList.toggle("active", p.id === "pane-" + name);
    });
    if (current.name === "session" && current.arg) {
      current.pane = name;
      var next = "#session/" + encodeURIComponent(current.arg) + "/" + name;
      if (location.hash !== next) {
        // Update hash without re-routing away from the session.
        history.replaceState(null, "", next);
      }
    }
    // LAST, and the order is load-bearing twice over: after the class swap so
    // scope is tested against the pane that is now up, and after `current.pane`
    // so the restore click records its cursor under the pane it lands in. With
    // this call earlier, restoring pane B wrote B's row into A's cursor slot
    // and A could never be restored again.
    syncInspectorToPane(name);
  }

  function bindSessionPanes(sessionId, reqs) {
    var nav = document.getElementById("session-subnav");
    if (nav) {
      nav.addEventListener("click", function (e) {
        var a = e.target.closest("[data-pane]");
        if (!a) return;
        e.preventDefault();
        activatePane(a.getAttribute("data-pane"));
      });
    }
    // One delegated listener for every inspectable row in every pane. Panes
    // re-render their own innerHTML freely (the hooks filter, the x-ray reload)
    // and delegation means none of them ever need re-binding — the class of bug
    // that made click-to-expand inert for months.
    var panesEl = document.querySelector(".session-panes");
    if (panesEl) {
      function activate(el) {
        var id = el.getAttribute("data-inspect") || "";
        // Recorded here, not in the arrow-key helper, so a mouse click and a
        // keypress leave the same trace. Otherwise leaving a pane by mouse and
        // returning would land on nothing, while the keyboard remembered.
        if (current.pane) paneCursor[current.pane] = id;
        var type = id.slice(0, id.indexOf(":"));
        if (type === "flow") inspectFlowNode(el, sessionId);
        else if (type === "seg") inspectSegment(id);
        else if (type === "hook") inspectHook(id);
        else if (type === "ctp") inspectTimelinePoint(id);
        else if (type === "tool") inspectTool(id);
        else if (type === "prov") inspectProvider(id);
      }
      panesEl.addEventListener("click", function (e) {
        var el = e.target.closest("[data-inspect]");
        if (el) activate(el);
      });
      panesEl.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        var el = e.target.closest && e.target.closest("[data-inspect]");
        if (!el) return;
        e.preventDefault();
        activate(el);
      });
    }

    function inspectHook(id) {
      var parts = id.split(":"); // hook:<index>:<part>
      var h = hooksForPane[Number(parts[1])];
      if (!h) return;
      var part = parts[2];
      var sp = h.stdoutPreview || {};
      var body;
      if (part === "full") body = JSON.stringify(h.payload || {}, null, 2);
      else if (part === "return")
        body =
          sp.additional_context ||
          sp.reason ||
          sp.text ||
          (sp.returned ? JSON.stringify(sp.returned, null, 2) : "");
      else body = JSON.stringify(sp, null, 2);
      Inspector.show(id, {
        kind: h.event || "hook",
        title: (h.hookName || "") + " · " + part,
        body: body,
      });
    }

    /**
     * One timeline bar. This is where the compaction cards went: the same
     * numbers, on the point they describe, in the panel every other pane uses.
     */
    function inspectTimelinePoint(id) {
      var seq = Number(id.slice(id.indexOf(":") + 1));
      var pts = (timelineForPane && timelineForPane.points) || [];
      var p = null;
      for (var i = 0; i < pts.length; i++) {
        if (pts[i].seq === seq) {
          p = pts[i];
          break;
        }
      }
      if (!p) return;
      selectedSeq = p.seq;
      var lines = [
        "context read   " + fmtTok(p.contextTokens) + " tokens",
        "  cache read   " + fmtTok(p.cacheRead),
        "  cache write  " + fmtTok(p.cacheCreation),
        "  fresh input  " + fmtTok(p.promptTokens),
        "output         " + fmtTok(p.completionTokens),
        "transcript     " + p.transcriptItems + " items",
        "approx (chars) " + fmtTok(p.approxTokens) + " tokens",
        "model          " + (p.model || "—"),
        "at             " + new Date(p.ts * 1000).toLocaleTimeString(),
      ];
      if (p.compaction) {
        var c = p.compaction;
        lines.push(
          "",
          "COMPACTION",
          "  items        " + c.fromItems + " → " + c.toItems + " (dropped " + c.droppedItems + ")",
          "  context      " +
            fmtTok(c.preContextTokens) +
            " → " +
            fmtTok(c.postContextTokens) +
            " (freed " +
            fmtTok(c.droppedTokens) +
            ")",
          "  approx       " + fmtTok(c.preApproxTokens) + " → " + fmtTok(c.postApproxTokens),
        );
      }
      if (p.buckets) {
        lines.push("", "COMPOSITION (approx tokens)");
        Object.keys(p.buckets)
          .sort(function (a, b) {
            return p.buckets[b] - p.buckets[a];
          })
          .forEach(function (k) {
            lines.push("  " + (k + "            ").slice(0, 13) + fmtTok(p.buckets[k]));
          });
      }
      Inspector.show(id, {
        kind: p.compaction ? "compaction" : "api call",
        title: "#" + p.seq + " · " + fmtTok(p.contextTokens) + " context tokens",
        body: lines.join("\n"),
      });
    }

    /** Split "kind:<toolsetIdx>:<rest>" where rest may itself contain colons. */
    function toolTaxTarget(id) {
      var first = id.indexOf(":");
      var second = id.indexOf(":", first + 1);
      var ts = (toolTaxForPane || [])[Number(id.slice(first + 1, second))];
      return { toolset: ts, name: id.slice(second + 1) };
    }

    function inspectTool(id) {
      var t = toolTaxTarget(id);
      if (!t.toolset) return;
      var tool = null;
      for (var i = 0; i < t.toolset.tools.length; i++) {
        if (t.toolset.tools[i].name === t.name) {
          tool = t.toolset.tools[i];
          break;
        }
      }
      if (!tool) return;
      var total =
        t.toolset.tools.reduce(function (a, x) {
          return a + x.approxTokens;
        }, 0) || 1;
      var g = toolProvider(tool.name);
      var lines = [
        "provider       " + (g.kind === "builtin" ? "built-in" : g.kind + " · " + g.key),
        "declared on    " + t.toolset.requestCount + " API calls",
        "",
        "size / call    " + fmtTok(tool.approxTokens) + " tokens",
        "share of tools " + ((tool.approxTokens / total) * 100).toFixed(1) + "%",
        "cumulative     " + fmtTok(tool.cumulativeTokens) + " tokens",
        "invocations    " + tool.calls,
      ];
      if (tool.dead && t.toolset.deadTokensCumulative > 0) {
        // Apportioned by cumulative share — the toolset cost is measured, the
        // per-tool split is arithmetic on it, not a second estimate.
        var share = tool.cumulativeTokens / t.toolset.deadTokensCumulative;
        lines.push(
          "",
          "DEAD — declared on every call, never invoked",
          "est. cost      " + fmtCost(share * t.toolset.deadCostUsd),
        );
      }
      Inspector.show(id, { kind: tool.dead ? "dead tool" : "tool", title: tool.name, body: lines.join("\n") });
    }

    function inspectProvider(id) {
      var t = toolTaxTarget(id);
      if (!t.toolset) return;
      var groups = toolProviderGroups(t.toolset.tools);
      var g = null;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].key === t.name) {
          g = groups[i];
          break;
        }
      }
      if (!g) return;
      var total =
        t.toolset.tools.reduce(function (a, x) {
          return a + x.approxTokens;
        }, 0) || 1;
      var lines = [
        "tools declared " + g.tools.length,
        "size / call    " + fmtTok(g.approxTokens) + " tokens",
        "share of tools " + ((g.approxTokens / total) * 100).toFixed(1) + "%",
        "cumulative     " + fmtTok(g.cumulativeTokens) + " tokens",
        "invocations    " + g.calls,
      ];
      if (g.deferred) {
        lines.push(
          "",
          "DEFERRED — only the auth stubs are loaded. The full tool surface",
          "arrives after authenticating, and authenticating is sticky: it opts",
          "the connector into full loading on every later call.",
        );
      } else if (g.kind === "plugin" || g.kind === "mcp") {
        lines.push(
          "",
          "Plugins and local MCP servers load in full regardless of the",
          '"load tools when needed" setting, which only defers connectors.',
        );
      }
      lines.push("", "TOOLS (by size)");
      g.tools
        .slice()
        .sort(function (a, b) {
          return b.approxTokens - a.approxTokens;
        })
        .forEach(function (x) {
          lines.push(
            "  " + fmtTok(x.approxTokens).padStart(7) + "  " + (x.calls ? "     " : "dead ") + x.name,
          );
        });
      Inspector.show(id, {
        kind: g.calls ? "provider" : "dead provider",
        title: providerLabel(g),
        body: lines.join("\n"),
      });
    }

    function inspectSegment(id) {
      var i = Number(id.slice(id.indexOf(":") + 1));
      var segs = (xrayForPane && xrayForPane.segments) || [];
      var s = segs[i];
      if (!s) return;
      var total = xrayForPane.totalApproxTokens || 0;
      var pct = sharePct(s.approxTokens, total);
      Inspector.show(id, {
        kind: s.bucket,
        title:
          fmtTok(s.approxTokens) + " approx tokens · " + fmtShare(pct) + " of context",
        // `full` when the server sent it, otherwise the preview — same source
        // the popover used, just resolved on demand instead of pre-stringified.
        body: s.full || s.preview || "",
      });
    }

    function inspectFlowNode(node, sessionId) {
      var raw = node.getAttribute("data-detail");
      var preview = node.getAttribute("data-detail-preview");
      var kind = node.getAttribute("data-kind");
      var nodeId = node.getAttribute("data-node-id");
      var seq = node.getAttribute("data-seq");

      var body = "";
      var loadingNote = "";
      var load = null;
      if (raw) {
        try {
          body = JSON.stringify(JSON.parse(raw), null, 2);
        } catch (err) {
          body = raw;
        }
      } else if (preview) {
        // Show the preview immediately so the panel never looks empty, then
        // swap in the full payload when it arrives.
        body = preview + "…";
        loadingNote =
          "loading full payload (" +
          fmtTok(Number(node.getAttribute("data-detail-chars") || 0)) +
          " chars)…";
        load = function () {
          return fetchJSON(
            "/api/session/" +
              encodeURIComponent(sessionId) +
              "/flow/" +
              encodeURIComponent(nodeId),
          ).then(function (full) {
            return JSON.stringify(full.detail, null, 2);
          });
        };
      }

      var actions = [];
      if (seq != null && seq !== "") {
        actions.push({
          label: "Open Context X-Ray for API #" + seq,
          onClick: function () {
            // Follow the navigation. Leaving the panel on the flow node meant
            // the button was still there, still offering to do the thing it
            // had just done — a dead end that looked like a no-op. The
            // destination is pushed, so Escape / ← returns to this node.
            activatePane("xray");
            loadXray(sessionId, Number(seq));
            selectedSeq = Number(seq);
            Inspector.pushOnce();
            setTimeout(function () {
              var bar = document.querySelector(
                '[data-inspect="ctp:' + seq + '"]',
              );
              if (bar) selectTarget(bar);
              else Inspector.cancelPush();
            }, 0);
          },
        });
      }
      if (kind === "hook") {
        actions.push({
          label: "Open Hooks pane",
          onClick: function () {
            activatePane("hooks");
            Inspector.pushOnce();
            setTimeout(function () {
              var list = paneTargets();
              if (list.length) selectTarget(list[0]);
              else Inspector.cancelPush();
            }, 0);
          },
        });
      }

      Inspector.show("flow:" + nodeId, {
        kind: kind,
        title: node.getAttribute("data-label") || "",
        body: body,
        loadingNote: loadingNote,
        actions: actions,
        load: load,
      });
    }
    var xraySel = document.getElementById("xray-seq");
    if (xraySel) {
      xraySel.addEventListener("change", function () {
        loadXray(sessionId, Number(xraySel.value));
      });
      if (reqs && reqs.length) loadXray(sessionId, reqs[reqs.length - 1].seq);
    }
    // The timeline arrives on its own endpoint; it renders and binds itself.
    if (reqs && reqs.length) loadTimeline(sessionId);
    loadToolTax(sessionId);
  }

  function hookReturnBlock(h, hi) {
    var sp = h.stdoutPreview || {};
    var returned =
      sp.additional_context ||
      sp.reason ||
      sp.text ||
      (sp.returned ? JSON.stringify(sp.returned, null, 2) : "");
    if (sp.empty || (!returned && !sp.chars)) {
      // Three distinct reasons stdout is empty, and conflating them is the
      // difference between "your setup can't capture this" and "your hook had
      // nothing to say". Events captured before the flag existed report neither.
      var why;
      if (sp.observeOnly === true) {
        why =
          "Observe-only tap — it wraps <code>true</code>, so there is no command whose output could be captured.<br/>" +
          "To see real payloads, wrap the actual hook: <code>tracetap hooks track --mode inject</code>, then re-index.";
      } else if (sp.observeOnly === undefined) {
        why =
          "No stdout recorded. This event predates payload classification, so it may be an observe-only tap.<br/>" +
          "Re-capture with <code>tracetap hooks track --mode inject</code> to tell the two apart.";
      } else {
        why = "The hook ran and returned nothing — an empty allow.";
      }
      return (
        '<div class="hook-return empty">' +
        "<h3>returned payload</h3>" +
        '<div class="dim">' +
        why +
        "</div></div>"
      );
    }
    var preview =
      sp.additional_context_preview ||
      sp.reason_preview ||
      sp.preview ||
      String(returned).slice(0, 200) +
        (String(returned).length > 200 ? "…" : "");
    var full = String(returned);
    return (
      '<div class="hook-return">' +
      "<h3>returned payload" +
      (sp.additional_context_chars
        ? " · additionalContext " +
          fmtTok(sp.additional_context_chars) +
          " chars"
        : sp.chars
          ? " · " + fmtTok(sp.chars) + " chars"
          : "") +
      "</h3>" +
      '<pre class="payload">' +
      esc(preview) +
      "</pre>" +
      // Compared by value, not by length: a preview is `slice(0,160) + "…"`,
      // so a payload of exactly 161 chars produces two strings of equal length
      // with the last character missing — and a `>` test would hide the chip.
      (full !== preview
        ? inspectChip("hook:" + hi + ":return", "inspect full", "returned payload")
        : "") +
      "</div>"
    );
  }

  /**
   * An observe-only tap wraps `true`, so it can never carry a returned payload.
   * One `hooks install` is enough to make them the overwhelming majority of the
   * table, at which point the pane reports thousands of events that say nothing
   * and the few real returns are unfindable. Hide them by default.
   *
   * Keyed on the stored `observeOnly` flag, never on empty stdout: a wrapped
   * hook that returned nothing is a genuine result and must stay visible.
   */
  function isObserveOnly(h) {
    return (h.stdoutPreview || {}).observeOnly === true;
  }

  /**
   * A small "open this in the inspector" affordance, used beside a preview.
   *
   * `what` is the accessible name. The visible label stays short because it
   * sits under a heading that already says which payload it is, but the
   * heading is not part of the button's accessible name — without `what`,
   * a hooks pane is a list of eighty buttons all called "inspect".
   */
  function inspectChip(id, label, what) {
    return (
      '<button type="button" class="inspect-chip" data-inspect="' +
      esc(id) +
      '"' +
      (what ? ' aria-label="inspect ' + esc(what) + '"' : "") +
      ">" +
      esc(label || "inspect") +
      "</button>"
    );
  }

  function signalHooks(hooks) {
    return hooks.filter(function (h) {
      return !isObserveOnly(h);
    });
  }

  function renderHooksPane(hooks) {
    if (!hooks.length) {
      return (
        '<div class="empty-pane">No hook events for this session.<br/>' +
        '<span class="dim">Run <code>tracetap hooks install</code> then re-index (<code>tracetap index</code>).<br/>' +
        "If Flow shows hooks but this pane was blank before, it was a hash-route bug — use the buttons above.</span></div>"
      );
    }
    var shown = hooksShowObserveOnly ? hooks : signalHooks(hooks);
    var hidden = hooks.length - shown.length;
    var toggle =
      hidden || hooksShowObserveOnly
        ? '<label class="hooks-filter"><input type="checkbox" id="hooks-observe-toggle"' +
          (hooksShowObserveOnly ? " checked" : "") +
          "/> show observe-only (" +
          (hooks.length - signalHooks(hooks).length) +
          ")</label>"
        : "";
    if (!shown.length) {
      // Reporting "0 events" over a pane that holds thousands reads as a bug, so
      // say plainly that everything here is a stub and what to do about it.
      return (
        '<div class="hooks-timeline">' +
        '<div class="dim hooks-hint">0 of ' +
        hooks.length +
        " hook event(s) returned anything" +
        toggle +
        "</div>" +
        '<div class="empty-pane">All ' +
        hooks.length +
        " event(s) for this session are observe-only taps.<br/>" +
        '<span class="dim">They wrap <code>true</code>, so no payload exists to show. Wrap the real hooks with ' +
        "<code>tracetap hooks track --mode inject</code>, then re-index.<br/>" +
        "Clear the historical noise with <code>tracetap hooks prune</code>.</span></div></div>"
      );
    }
    var idxOf = new Map();
    hooks.forEach(function (h, i) {
      idxOf.set(h, i);
    });
    return (
      '<div class="hooks-timeline">' +
      '<div class="dim hooks-hint">' +
      shown.length +
      (hidden ? " of " + hooks.length : "") +
      " hook event(s) · expand a card for stdin + returned stdout payload" +
      toggle +
      "</div>" +
      shown
        .map(function (h) {
          // Index into the unfiltered list, so an inspect id stays valid when
          // the observe-only filter changes which rows are on screen.
          var hi = idxOf.get(h);
          var badge =
            h.decision === "block"
              ? "block"
              : h.outcome === "error"
                ? "error"
                : "ok";
          var sp = h.stdoutPreview || {};
          var hasReturn = !sp.empty && (sp.chars > 0 || sp.additional_context);
          return (
            '<details class="hook-card"' +
            (hasReturn ? " open" : "") +
            ">" +
            "<summary>" +
            '<span class="hook-time">' +
            fmtTime(h.ts) +
            "</span>" +
            '<span class="pill hook-' +
            badge +
            '">' +
            esc(h.event) +
            "</span>" +
            (h.hookName
              ? '<span class="dim">' + esc(h.hookName) + "</span>"
              : "") +
            (h.durationMs != null
              ? '<span class="dim">' + fmtDur(h.durationMs) + "</span>"
              : "") +
            (h.decision
              ? '<span class="pill">' + esc(h.decision) + "</span>"
              : "") +
            (hasReturn
              ? '<span class="pill hook-return-pill">returned</span>'
              : "") +
            "</summary>" +
            '<div class="hook-body">' +
            hookReturnBlock(h, hi) +
            '<div class="hook-grid">' +
            // Each payload is rendered once, as a preview, with a chip that
            // opens it in the inspector. Previously every one was stringified
            // TWICE — into a data-full-payload attribute and into the visible
            // <pre> — and both copies HTML-escaped. On a session with hundreds
            // of hook events that was the largest single source of DOM weight
            // in the app, for text most users never open.
            // No inspect chip on these two. The <pre> already holds the
            // WHOLE preview object — opening it in the panel reproduced the
            // same text verbatim, which teaches the reader that `inspect`
            // means nothing. Chips are kept only where the panel shows
            // something the row cannot: the full stdin payload, and a
            // returned payload longer than its preview.
            "<div><h3>stdin preview</h3>" +
            '<pre class="payload compact">' +
            esc(JSON.stringify(h.stdinPreview || {}, null, 2)) +
            "</pre></div>" +
            "<div><h3>stdout preview</h3>" +
            '<pre class="payload compact">' +
            esc(JSON.stringify(h.stdoutPreview || {}, null, 2)) +
            "</pre></div>" +
            "</div>" +
            (h.payload
              ? "<h3>full stdin payload " +
                inspectChip("hook:" + hi + ":full", null, "full stdin payload") +
                "</h3>" +
                '<pre class="payload compact">' +
                esc(JSON.stringify(h.payload, null, 2)) +
                "</pre>"
              : '<div class="dim">Full stdin not stored — set <code>TRACETAP_HOOK_FULL=1</code> on capture.</div>') +
            '<div class="dim">digest ' +
            esc((h.stdinDigest || "").slice(0, 12)) +
            " · outcome " +
            esc(h.outcome || "—") +
            " · exit " +
            esc(h.exitCode == null ? "—" : h.exitCode) +
            "</div>" +
            "</div></details>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  /**
   * Round a peak up to a readable axis maximum, so the top gridline is a
   * number a human would choose (150K, not 147,312).
   */
  function niceCeil(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * mag >= v) return steps[i] * mag;
    }
    return 10 * mag;
  }

  /**
   * Sessions captured in the same trace log.
   *
   * One `.claude-trace` log is one proxied CLI process, so everything in it
   * shares a terminal, a directory and a stretch of wall-clock time. A live
   * capture put 24 sessions in a single log — a main thread and the fleet it
   * spawned — which the session list rendered as 24 unrelated rows.
   *
   * Presented flat, not as a tree. Which session SPAWNED which needs per-agent
   * identity the rows do not carry yet, and a tree would assert a parentage
   * that has not been established.
   */
  /**
   * The conversations inside ONE session.
   *
   * A session that spawns a fleet is not one conversation — the live capture
   * behind this pane is 308 main-thread calls plus 430 subagent calls across
   * 11 named agents, all under one session id. Grouping by agent is the only
   * way the session view stops reading as one impossibly long thread.
   *
   * Unnamed subagents are kept as their own row rather than folded into the
   * main thread or hidden: they were never spawned through the Agent tool
   * (workflow-orchestrated agents are marked but have no parent record), so
   * the honest presentation is "subagent, unnamed", not silence.
   */
  function renderConversations(reqs) {
    var groups = {};
    var order = [];
    reqs.forEach(function (r) {
      var key = !r.isSubagent ? "\u0000main" : r.agentLabel || "\u0001unnamed";
      if (!groups[key]) {
        groups[key] = { key: key, calls: 0, tokens: 0, out: 0, first: r.ts, last: r.ts,
                        label: !r.isSubagent ? "main thread" : r.agentLabel || "subagent (unnamed)",
                        type: r.agentType, sub: !!r.isSubagent };
        order.push(key);
      }
      var g = groups[key];
      g.calls++;
      g.tokens += (r.promptTokens || 0) + (r.cacheRead || 0) + (r.cacheCreation || 0);
      g.out += r.completionTokens || 0;
      if (r.ts < g.first) g.first = r.ts;
      if (r.ts > g.last) g.last = r.ts;
    });
    var list = order
      .map(function (k) { return groups[k]; })
      .sort(function (a, b) {
        if (a.sub !== b.sub) return a.sub ? 1 : -1; // main thread first
        return b.calls - a.calls;
      });
    if (list.length <= 1) {
      return (
        '<div class="empty-pane">This session is a single conversation — no ' +
        "subagent calls were captured in it.</div>"
      );
    }
    var namedSubs = list.filter(function (g) { return g.sub && g.label.indexOf("unnamed") < 0; }).length;
    var rows = list
      .map(function (g) {
        return (
          '<tr class="' + (g.sub ? "convo-sub" : "convo-main") + '">' +
          "<td>" +
          (g.sub ? '<span class="convo-indent">\u2514</span> ' : "") +
          esc(g.label) +
          (g.type ? ' <span class="dim">' + esc(g.type) + "</span>" : "") +
          '</td><td class="num">' + g.calls +
          '</td><td class="num">' + fmtTok(g.tokens) +
          '</td><td class="num">' + fmtTok(g.out) +
          '</td><td class="num">' + fmtDur((g.last - g.first) * 1000) +
          "</td></tr>"
        );
      })
      .join("");
    return (
      '<h2 class="sec">Conversations in this session <small>(' +
      list.length +
      " · " +
      namedSubs +
      " named agent" +
      (namedSubs === 1 ? "" : "s") +
      ")</small></h2>" +
      '<div class="dim rel-note">One session id can hold a main thread and every ' +
      "agent it spawned. Names come from the spawning Agent tool call; an agent " +
      "started by a workflow rather than that tool has no parent record to join " +
      'to and is shown as "unnamed" rather than merged into the main thread.</div>' +
      '<div class="tbl-wrap"><table><thead><tr>' +
      "<th>conversation</th>" +
      '<th class="num">calls</th><th class="num">context read</th>' +
      '<th class="num">output</th><th class="num">span</th>' +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>"
    );
  }

  function renderRelatedPane(siblings, s) {
    if (!siblings.length) {
      return (
        '<div class="empty-pane">No other sessions were captured in this trace log.</div>'
      );
    }
    var totalCost = siblings.reduce(function (a, x) {
      return a + (x.costUsd || 0);
    }, 0);
    var log = (s.sourcePath || "").split("/").pop();
    var rows = siblings
      .map(function (x) {
        return (
          '<tr class="click" data-goto="' +
          esc(x.sessionId) +
          '"><td>' +
          agentPill(x.agent) +
          "</td><td>" +
          esc(x.model || "—") +
          "</td><td>" +
          fmtTime(x.startedAt) +
          "</td><td class=\"num\">" +
          fmtDur(x.durationMs) +
          "</td><td class=\"num\">" +
          (x.turns == null ? "—" : x.turns) +
          "</td><td class=\"num\">" +
          fmtCost(x.costUsd) +
          "</td></tr>"
        );
      })
      .join("");
    return (
      '<h2 class="sec">Captured alongside <small>(' +
      siblings.length +
      " other session" +
      (siblings.length === 1 ? "" : "s") +
      " in " +
      esc(log) +
      " · " +
      fmtCost(totalCost) +
      " combined)</small></h2>" +
      '<div class="dim rel-note">One trace log is one CLI process. These share a ' +
      "terminal and a time window with this session — siblings, not children: " +
      "establishing which spawned which needs per-agent identity that is not " +
      "captured yet.</div>" +
      '<div class="tbl-wrap"><table><thead><tr>' +
      "<th>agent</th><th>model</th><th>started</th>" +
      '<th class="num">duration</th><th class="num">turns</th><th class="num">cost</th>' +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table></div>"
    );
  }

  document.addEventListener("click", function (e) {
    var tr = e.target.closest && e.target.closest("tr[data-goto]");
    if (!tr) return;
    location.hash = "#session/" + encodeURIComponent(tr.getAttribute("data-goto"));
  });

  function renderContextTimeline(tl) {
    if (!tl || !tl.points || !tl.points.length) {
      return '<div class="dim">No context timeline points.</div>';
    }
    // Height is keyed to contextTokens — what the model actually read. The old
    // series was `promptTokens`, which under prompt caching is the UNCACHED
    // remainder: literally 2 on every call of a cached agentic session, so the
    // chart was 224 identical bars and the header read "peak 2 prompt tokens".
    var peak = Math.max(1, tl.peakContextTokens || tl.peakApproxTokens || 1);
    var axisMax = niceCeil(peak);
    var ticks = [1, 0.75, 0.5, 0.25, 0];

    var caveat =
      tl.outOfOrderPairs > 0
        ? ' <span class="warn-note" title="' +
          esc(
            tl.outOfOrderPairs +
              " adjacent call pairs run backwards in wall-clock time, so this " +
              "session interleaves concurrent conversations (a main thread plus " +
              "subagents). Neighbouring bars are not neighbouring turns.",
          ) +
          '">⚠ ' +
          tl.outOfOrderPairs +
          " interleaved</span>"
        : "";

    var html =
      '<h2 class="sec">Context size timeline <small>' +
      tl.points.length +
      " calls · " +
      tl.compactionCount +
      " compaction(s) · peak " +
      fmtTok(peak) +
      " context tokens</small>" +
      caveat +
      "</h2>" +
      // The axis is the point of this block: without it the bars were a shape
      // with no magnitude, and the only number on screen was a wrong one.
      '<div class="ct-frame">' +
      '<div class="ct-axis" aria-hidden="true">' +
      ticks
        .map(function (t) {
          return (
            '<span class="ct-tick" style="bottom:' +
            t * 100 +
            '%">' +
            (t === 0 ? "0" : fmtTok(Math.round(axisMax * t))) +
            "</span>"
          );
        })
        .join("") +
      "</div>" +
      '<div class="ct-plot">' +
      ticks
        .map(function (t) {
          return '<span class="ct-grid" style="bottom:' + t * 100 + '%"></span>';
        })
        .join("") +
      '<div class="context-timeline" id="context-timeline">';

    tl.points.forEach(function (p) {
      var h = Math.max(1, Math.round((p.contextTokens / axisMax) * 100));
      var cls =
        "ct-bar" +
        (p.compaction ? " compact" : "") +
        (p.errored ? " errored" : "");
      html +=
        '<button type="button" class="' +
        cls +
        '" data-seq="' +
        p.seq +
        '" data-inspect="ctp:' +
        p.seq +
        '" aria-label="call ' +
        p.seq +
        ", " +
        fmtTok(p.contextTokens) +
        ' context tokens" style="height:' +
        h +
        '%">' +
        '<span class="ct-seq">' +
        p.seq +
        "</span>" +
        (p.compaction ? '<span class="ct-compact">⇣</span>' : "") +
        "</button>";
    });
    html += "</div></div></div>";
    // The compaction cards used to stack below as a second, parallel list —
    // 85 of them on this session, each with its own `inspect` button and its
    // own idea of what detail looks like. They are the same points already on
    // the timeline, so the bar IS the row now: it carries the ⇣ marker and
    // opens the identical detail in the shared inspector.
    html +=
      '<div class="ct-legend dim">' +
      "bar height = context tokens read (uncached input + cache read + cache write) · " +
      "⇣ = compaction · click a bar to inspect" +
      "</div>";
    return html;
  }

  function renderXrayPane(sessionId, reqs) {
    if (!reqs.length) {
      return '<div class="empty-pane">No API calls to x-ray.</div>';
    }
    var opts = reqs
      .map(function (r) {
        return (
          '<option value="' +
          r.seq +
          '">#' +
          r.seq +
          " · " +
          esc(r.model || "model") +
          " · " +
          fmtTok(r.promptTokens) +
          " in</option>"
        );
      })
      .join("");
    return (
      // Filled in by loadTimeline once /timeline responds — the session payload
      // no longer carries it.
      '<div id="timeline-host"><div class="dim">loading context timeline…</div></div>' +
      '<div class="xray-controls">' +
      '<label class="chrome">API call <select id="xray-seq">' +
      opts +
      "</select></label>" +
      '<span class="dim" id="xray-status">loading…</span></div>' +
      '<div id="xray-view"></div>'
    );
  }
  function renderFlowPane(flow) {
    var nodes = (flow && flow.nodes) || [];
    if (!nodes.length) {
      return '<div class="empty-pane">No flow nodes yet — index a session with transcript steps.</div>';
    }
    var html =
      '<div class="flow-layout"><div class="flow-graph" id="flow-graph">';
    nodes.forEach(function (n, i) {
      var lane = n.lane ? " lane-" + Math.min(n.lane, 3) : "";
      var err = n.errored ? " errored" : "";
      html +=
        '<div class="flow-node kind-' +
        esc(n.kind) +
        lane +
        err +
        '" data-kind="' +
        esc(n.kind) +
        '" data-label="' +
        esc(n.label) +
        '" data-node-id="' +
        esc(n.id) +
        '" data-inspect="flow:' +
        esc(n.id) +
        '" tabindex="0" role="button"' +
        (n.requestSeq != null ? ' data-seq="' + n.requestSeq + '"' : "") +
        // Large payloads arrive as a preview only; the rest is fetched on click.
        // Inlining every node's full detail put hundreds of KB into DOM
        // attributes for text the user may never open.
        (n.detail
          ? ' data-detail="' + esc(JSON.stringify(n.detail)) + '"'
          : "") +
        (n.detailPreview
          ? ' data-detail-preview="' +
            esc(n.detailPreview) +
            '" data-detail-chars="' +
            (n.detailChars || 0) +
            '"'
          : "") +
        ' style="--i:' +
        i +
        '">' +
        '<span class="flow-kind">' +
        esc(n.kind.replace("_", " ")) +
        "</span>" +
        '<span class="flow-label">' +
        esc(n.label) +
        "</span>" +
        "</div>";
      if (i < nodes.length - 1)
        html += '<div class="flow-edge" aria-hidden="true"></div>';
    });
    // No local detail panel any more — the session-level inspector serves every
    // pane, so the flow graph is just the graph.
    html += "</div></div>";
    return html;
  }

  /**
   * Fetch the context timeline and render it into the X-Ray pane.
   *
   * The markup and its click handlers are deliberately in one function. The
   * timeline arrives after the pane is drawn, so binding it anywhere else means
   * binding before the elements exist — the failure mode that left the Wire
   * pane's handlers pointing at markup that was no longer emitted.
   */
  function loadTimeline(sessionId) {
    var host = document.getElementById("timeline-host");
    if (!host) return;
    fetchJSON("/api/session/" + encodeURIComponent(sessionId) + "/timeline")
      .then(function (tl) {
        timelineForPane = tl;
        host.innerHTML = renderContextTimeline(tl);
        // The separate compaction-card list is gone; each card's `inspect`
        // button is now the bar itself, via the delegated [data-inspect].
        var tlEl = host.querySelector("#context-timeline");
        if (tlEl) {
          tlEl.addEventListener("click", function (e) {
            var bar = e.target.closest("[data-seq]");
            if (!bar) return;
            activatePane("xray");
            loadXray(sessionId, Number(bar.getAttribute("data-seq")));
          });
        }
      })
      .catch(function (err) {
        host.innerHTML =
          '<div class="dim">context timeline unavailable — ' +
          esc(String(err.message || err)) +
          "</div>";
      });
  }

  /**
   * Monotonic token for the in-flight x-ray request.
   *
   * `bindSessionPanes` auto-loads the last request as soon as the pane renders,
   * so there is always one fetch in flight the moment the inspect buttons become
   * clickable. Responses are not ordered, so without this the auto-load can land
   * after a click and overwrite it — the button appears to do nothing.
   */
  var xrayToken = 0;
  // The rendered x-ray response, kept so the inspector can resolve a segment
  // by index instead of every row carrying its full text in a DOM attribute.
  var xrayForPane = null;
  var timelineForPane = null;
  var toolTaxForPane = null;

  function loadXray(sessionId, seq) {
    var token = ++xrayToken;
    var status = document.getElementById("xray-status");
    var viewEl = document.getElementById("xray-view");
    var sel = document.getElementById("xray-seq");
    if (sel && String(sel.value) !== String(seq)) sel.value = String(seq);
    if (status) status.textContent = "loading…";
    if (viewEl) viewEl.innerHTML = skeleton({ rows: 4 });
    fetchJSON(
      "/api/session/" + encodeURIComponent(sessionId) + "/context/" + seq,
    )
      .then(function (x) {
        if (token !== xrayToken) return; // a newer click already won
        if (status) {
          status.textContent =
            fmtTok(x.totalApproxTokens) +
            " ≈tokens · " +
            fmtTok(x.totalChars) +
            " chars" +
            (x.wirePromptTokens != null
              ? " · wire " + fmtTok(x.wirePromptTokens) + " prompt"
              : "");
        }
        xrayForPane = x;
        if (viewEl) {
          viewEl.innerHTML = drawXray(x);
          viewEl
            .querySelectorAll(".btn-xray[data-seq]")
            .forEach(function (btn) {
              btn.addEventListener("click", function () {
                loadXray(sessionId, Number(btn.getAttribute("data-seq")));
              });
            });
        }
      })
      .catch(function (err) {
        // A stale failure must not clobber a newer success either: a request
        // whose body was never captured 404s, and that error would otherwise
        // land on top of whatever the user had just clicked.
        if (token !== xrayToken) return;
        if (status) status.textContent = "error";
        if (viewEl)
          viewEl.innerHTML =
            '<div class="empty-pane">' +
            esc(String(err.message || err)) +
            "</div>";
      });
  }

  /** Percent of the whole context, to one decimal below 10% so small slices stay legible. */
  function sharePct(n, total) {
    if (!total) return 0;
    return (n / total) * 100;
  }
  function fmtShare(pct) {
    if (pct >= 10) return Math.round(pct) + "%";
    if (pct >= 1) return pct.toFixed(1) + "%";
    return pct < 0.1 ? "<0.1%" : pct.toFixed(1) + "%";
  }

  /**
   * Bucket rows double as filters for the segment list beneath them.
   *
   * The composition bar answers "what is eating the window" and the segment
   * list answers "which specific text", but the two were unconnected: seeing
   * TOOLS at 72% meant scrolling a mixed list of 244 segments hunting for the
   * tool ones. Clicking a row now narrows the list to that bucket. Multiple
   * rows can be active — an OR, since the question is usually "show me tools
   * AND skills, hide the conversation".
   */
  function applyBucketFilter(pane) {
    var on = {};
    var any = false;
    pane.querySelectorAll("[data-bucket-filter]").forEach(function (b) {
      if (b.getAttribute("aria-pressed") === "true") {
        on[b.getAttribute("data-bucket-filter")] = 1;
        any = true;
      }
    });
    var shown = 0;
    pane.querySelectorAll("[data-bucket]").forEach(function (seg) {
      var vis = !any || on[seg.getAttribute("data-bucket")] === 1;
      seg.hidden = !vis;
      if (vis) shown++;
    });
    var note = pane.querySelector("#xray-seg-count");
    if (note) {
      note.textContent = any
        ? shown + " of " + pane.querySelectorAll("[data-bucket]").length + " shown"
        : "";
    }
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-bucket-filter]");
    if (!btn) return;
    var pane = btn.closest(".session-pane") || document;
    btn.setAttribute(
      "aria-pressed",
      btn.getAttribute("aria-pressed") === "true" ? "false" : "true",
    );
    applyBucketFilter(pane);
  });

  function drawXray(x) {
    var total = 0;
    x.buckets.forEach(function (b) {
      total += b.approxTokens;
    });

    // Bars are share of the WHOLE context, not of the largest bucket. Scaling to
    // the max made the biggest bucket 100% wide whether it was 90% or 30% of the
    // context, which is exactly the question this pane exists to answer.
    var stack =
      '<div class="xray-stack">' +
      x.buckets
        .map(function (b) {
          var pct = sharePct(b.approxTokens, total);
          return (
            '<button type="button" class="xray-row bucket-' +
            esc(b.bucket) +
            '" data-bucket-filter="' +
            esc(b.bucket) +
            '" aria-pressed="false" title="' +
            esc(b.label) +
            " · " +
            fmtTok(b.approxTokens) +
            " approx tokens · " +
            b.segments +
            ' segment(s) · click to filter the segments below">' +
            '<span class="xray-row-label">' +
            esc(b.label) +
            "</span>" +
            '<span class="xray-track">' +
            // Floor the fill so a sub-percent bucket is still a visible sliver
            // rather than nothing at all.
            '<span class="xray-fill" style="width:' +
            Math.max(0.6, pct).toFixed(2) +
            '%"></span></span>' +
            '<span class="xray-row-n">' +
            fmtTok(b.approxTokens) +
            "</span>" +
            '<span class="xray-row-pct">' +
            fmtShare(pct) +
            "</span></button>"
          );
        })
        .join("") +
      "</div>";

    var delta = "";
    if (x.delta) {
      delta =
        '<div class="xray-delta">' +
        '<h2 class="sec">vs API #' +
        x.delta.prevSeq +
        " <small>new " +
        x.delta.newCount +
        " · carried " +
        x.delta.carriedCount +
        " · dropped " +
        x.delta.droppedCount +
        "</small></h2>" +
        '<div class="xray-delta-list">' +
        x.delta.items
          .filter(function (i) {
            return i.kind !== "carried";
          })
          .slice(0, 40)
          .map(function (i) {
            return (
              '<div class="xray-delta-item kind-' +
              esc(i.kind) +
              " bucket-" +
              esc(i.bucket) +
              '" title="' +
              esc(i.kind) +
              " · " +
              esc(i.bucket) +
              " · " +
              fmtTok(i.approxTokens) +
              ' approx tokens">' +
              '<span class="xray-delta-kind">' +
              esc(i.kind) +
              "</span>" +
              '<span class="xray-seg-bucket">' +
              esc(i.bucket) +
              "</span>" +
              '<span class="xray-seg-n">' +
              fmtTok(i.approxTokens) +
              "</span>" +
              '<span class="xray-seg-text">' +
              esc(i.preview) +
              "</span></div>"
            );
          })
          .join("") +
        "</div></div>";
    }

    var segs =
      '<h2 class="sec">Segments <small>(' +
      x.segments.length +
      ' <span id="xray-seg-count"></span></small></h2>' +
      '<div class="xray-segs">' +
      x.segments
        .slice(0, 80)
        .map(function (s, i) {
          var pct = sharePct(s.approxTokens, total);
          return (
            '<button type="button" class="xray-seg bucket-' +
            esc(s.bucket) +
            // No payload in the attribute and no native title=. The segment
            // carried both a data-full-payload popover and a title tooltip, so
            // two independent tooltips fired on one hover and drew over each
            // other. The inspector reads the segment from the cached response.
            '" data-inspect="seg:' +
            i +
            '" data-bucket="' +
            esc(s.bucket) +
            // The row is shaded to its own share of the context, so the segments
            // actually eating the window are visible without reading a number.
            '" style="--share:' +
            Math.min(100, pct).toFixed(2) +
            '%">' +
            '<span class="xray-seg-bucket">' +
            esc(s.bucket) +
            "</span>" +
            '<span class="xray-seg-n">' +
            fmtTok(s.approxTokens) +
            "</span>" +
            '<span class="xray-seg-pct">' +
            fmtShare(pct) +
            "</span>" +
            '<span class="xray-seg-text">' +
            esc(s.preview) +
            "</span></button>"
          );
        })
        .join("") +
      "</div>";

    return stack + delta + segs;
  }

  function stepCard(st) {
    var roleClass =
      st.role === "user" ? "user" : st.role === "agent" ? "agent" : "system";
    var head =
      '<div class="step-head"><span class="pill">#' +
      st.stepIndex +
      '</span><span class="role">' +
      esc(st.role) +
      "</span>" +
      (st.errored ? '<span class="pill err">errored</span>' : "") +
      "</div>";
    var body = "";
    if (st.reasoning) {
      body +=
        "<details><summary>reasoning (" +
        fmtTok(st.reasoning.length) +
        " chars)</summary><pre>" +
        esc(clip(st.reasoning, 20000)) +
        "</pre></details>";
    }
    if (st.message)
      body += '<div class="step-body">' + renderMarkdown(st.message) + "</div>";
    body += toolCallsHtml(st);
    if (st.observation) {
      var obs = clip(st.observation, 20000),
        obsInner;
      try {
        JSON.parse(obs);
        obsInner = hlJSON(obs);
      } catch (e) {
        obsInner = esc(obs);
      }
      body +=
        "<details><summary>observation (" +
        fmtTok(st.observation.length) +
        " chars)</summary><pre>" +
        obsInner +
        "</pre></details>";
    }
    if (!body) body = '<div class="step-body dim">(empty step)</div>';
    return (
      '<div class="step ' +
      roleClass +
      (st.errored ? " errored" : "") +
      '" id="step-' +
      st.stepIndex +
      '">' +
      head +
      body +
      "</div>"
    );
  }

  // -- transcript renderers --------------------------------------------------

  /** Markdown subset, escape-first (XSS-safe): fences, inline code, bold,
      headings, bullets, http(s) links. Everything else stays pre-wrapped. */
  function renderMarkdown(raw) {
    var s = esc(clip(raw, 12000));
    var parts = s.split("```");
    var out = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out +=
          '<pre class="md-code">' +
          parts[i].replace(/^[\w+-]*\n/, "") +
          "</pre>";
      } else {
        out += mdInline(parts[i]);
      }
    }
    return out;
  }
  function mdInline(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code class="md-ic">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|\n)#{1,4}\s+([^\n]+)/g, '$1<span class="md-h">$2</span>')
      .replace(/(^|\n)\s*[-*]\s+/g, "$1• ")
      .replace(
        /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      );
  }

  /** Pretty-print + token-color JSON. Falls back to escaped text on parse failure. */
  function hlJSON(val) {
    var s;
    try {
      s =
        typeof val === "string"
          ? JSON.stringify(JSON.parse(val), null, 2)
          : JSON.stringify(val, null, 2);
    } catch (e) {
      return esc(String(val));
    }
    if (s == null) return "";
    if (s.length > 24000) return esc(clip(s, 24000));
    var re =
      /("(?:[^"\\]|\\.)*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    var out = "",
      last = 0,
      m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      if (m[1] !== undefined) {
        out +=
          '<span class="' +
          (m[2] ? "j-key" : "j-str") +
          '">' +
          esc(m[1]) +
          "</span>" +
          (m[2] || "");
      } else if (m[0] === "true" || m[0] === "false" || m[0] === "null") {
        out += '<span class="j-lit">' + m[0] + "</span>";
      } else {
        out += '<span class="j-num">' + m[0] + "</span>";
      }
      last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }

  /** One block per tool call: name chip + target summary; Edit args render as
      a real diff, shell-style args as a command line, the rest as colored JSON. */
  function toolCallsHtml(st) {
    if (!st.toolInput) return "";
    var names = st.toolName ? st.toolName.split(/\s+/) : [];
    var lines = st.toolInput.split("\n").filter(function (l) {
      return l.trim();
    });
    if (!lines.length) return "";
    return lines
      .map(function (line, i) {
        var name = names[i] || names[names.length - 1] || "tool";
        var args = null;
        try {
          args = JSON.parse(line);
        } catch (e) {}
        var sum = tcSummary(args);
        var isDiff =
          args &&
          typeof args.old_string === "string" &&
          typeof args.new_string === "string";
        var isCmd = args && typeof args.command === "string";
        var open = isDiff || isCmd || line.length < 400;
        return (
          '<details class="tool-call"' +
          (open ? " open" : "") +
          '><summary class="tc-head">' +
          '<span class="pill">' +
          esc(name) +
          "</span>" +
          (sum ? '<span class="tc-sum">' + sum + "</span>" : "") +
          "</summary>" +
          tcBody(args, line, isDiff, isCmd) +
          "</details>"
        );
      })
      .join("");
  }
  function tcSummary(args) {
    if (!args || typeof args !== "object") return "";
    var v =
      args.file_path ||
      args.path ||
      args.notebook_path ||
      args.pattern ||
      args.url ||
      (typeof args.command === "string" ? args.command : "") ||
      (typeof args.description === "string" ? args.description : "");
    return v ? esc(clip(String(v), 96)) : "";
  }
  function tcBody(args, rawLine, isDiff, isCmd) {
    if (isDiff) {
      var extra = {};
      Object.keys(args).forEach(function (k) {
        if (k !== "old_string" && k !== "new_string") extra[k] = args[k];
      });
      var head = Object.keys(extra).length
        ? '<pre class="md-code">' + hlJSON(extra) + "</pre>"
        : "";
      return (
        head +
        '<div class="tc-diff diff">' +
        diffHtml(args.old_string, args.new_string) +
        "</div>"
      );
    }
    if (isCmd) {
      var rest = {};
      Object.keys(args).forEach(function (k) {
        if (k !== "command") rest[k] = args[k];
      });
      return (
        '<pre class="md-code tc-cmd">$ ' +
        esc(clip(args.command, 4000)) +
        "</pre>" +
        (Object.keys(rest).length
          ? '<pre class="md-code">' + hlJSON(rest) + "</pre>"
          : "")
      );
    }
    return (
      '<pre class="md-code">' +
      (args != null ? hlJSON(args) : esc(clip(rawLine, 20000))) +
      "</pre>"
    );
  }

  function clip(s, n) {
    s = String(s);
    return s.length > n
      ? s.slice(0, n) +
          "\n… (" +
          (s.length - n) +
          " more chars — see wire report)"
      : s;
  }

  // ----------------------------------------------------------------- usage
  var usage = {
    granularity: "daily",
    breakdown: false,
    since: "",
    until: "",
    agent: "",
  };

  function renderUsage() {
    current = { name: "usage" };
    var html =
      '<div class="controls">' +
      '<select id="u-gran">' +
      ["daily", "weekly", "monthly", "total"]
        .map(function (g) {
          return (
            '<option value="' +
            g +
            '"' +
            (usage.granularity === g ? " selected" : "") +
            ">" +
            g +
            "</option>"
          );
        })
        .join("") +
      "</select>" +
      '<label class="check"><input id="u-breakdown" type="checkbox"' +
      (usage.breakdown ? " checked" : "") +
      "/> per-model breakdown</label>" +
      '<input id="u-since" type="date" value="' +
      esc(usage.since) +
      '" title="since"/>' +
      '<input id="u-until" type="date" value="' +
      esc(usage.until) +
      '" title="until"/>' +
      '<input id="u-agent" class="filter" type="text" placeholder="agent" value="' +
      esc(usage.agent) +
      '"/>' +
      "</div>" +
      '<div id="u-chart"></div>' +
      '<div class="tbl-wrap"><table><thead><tr id="u-head"></tr></thead><tbody id="u-rows">' +
      skelRows(6, 8) +
      "</tbody></table></div>" +
      '<div class="note" id="u-note"></div>' +
      '<div class="empty" id="u-empty" style="display:none"></div>';
    setView(html);
    [
      ["u-gran", "change"],
      ["u-breakdown", "change"],
      ["u-since", "change"],
      ["u-until", "change"],
      ["u-agent", "input"],
    ].forEach(function (pair) {
      document
        .getElementById(pair[0])
        .addEventListener(pair[1], debounce(onUsageControls, 150));
    });
    loadUsage();
  }

  function onUsageControls() {
    usage.granularity = document.getElementById("u-gran").value;
    usage.breakdown = document.getElementById("u-breakdown").checked;
    usage.since = document.getElementById("u-since").value;
    usage.until = document.getElementById("u-until").value;
    usage.agent = document.getElementById("u-agent").value.trim();
    loadUsage();
  }

  function loadUsage() {
    if (!document.getElementById("u-rows")) return;
    var p = new URLSearchParams();
    p.set("granularity", usage.granularity);
    if (usage.breakdown) p.set("breakdown", "1");
    if (usage.since) p.set("since", usage.since);
    if (usage.until) p.set("until", usage.until);
    if (usage.agent) p.set("agent", usage.agent);
    try {
      p.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch (e) {}
    fetchJSON("/api/usage?" + p)
      .then(drawUsage)
      .catch(fail);
  }

  function drawUsage(report) {
    var chart = document.getElementById("u-chart");
    if (!chart) return;
    var empty = document.getElementById("u-empty");
    var rowsEl = document.getElementById("u-rows");
    var headEl = document.getElementById("u-head");
    if (!report.rows.length) {
      chart.innerHTML = "";
      headEl.innerHTML = "";
      rowsEl.innerHTML = "";
      empty.style.display = "block";
      empty.innerHTML =
        "No usage in range. Capture sessions, then run <code>tracetap index</code>.";
      return;
    }
    empty.style.display = "none";

    // Chart: cost per bucket (collapse breakdown rows into buckets).
    var byBucket = {};
    report.rows.forEach(function (r) {
      byBucket[r.bucket] = (byBucket[r.bucket] || 0) + r.costUsd;
    });
    var items = Object.keys(byBucket)
      .sort()
      .map(function (b) {
        return {
          label: b.slice(5) || b,
          value: byBucket[b],
          title: b + ": " + fmtCost(byBucket[b]),
        };
      });
    if (report.granularity !== "total" && items.length > 1) {
      chart.innerHTML =
        '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.1</span>Cost per ' +
        ({ daily: "day", weekly: "week", monthly: "month" }[
          report.granularity
        ] || report.granularity) +
        "</div>" +
        columnChart(items, { height: 130, labels: true, colWidth: 34 }) +
        "</div>";
    } else chart.innerHTML = "";

    var showGroup = report.rows.some(function (r) {
      return r.group;
    });
    headEl.innerHTML =
      "<th>Bucket</th>" +
      (showGroup ? "<th>Group</th>" : "") +
      '<th class="num">In</th><th class="num">Out</th><th class="num">Cache R</th><th class="num">Cache W</th><th class="num">Sessions</th><th class="num">Cost</th>';
    var rowsHtml = report.rows.map(function (r) {
      return (
        "<tr><td>" +
        esc(r.bucket) +
        "</td>" +
        (showGroup ? "<td>" + esc(r.group) + "</td>" : "") +
        '<td class="num">' +
        fmtTok(r.promptTokens) +
        "</td>" +
        '<td class="num">' +
        fmtTok(r.completionTokens) +
        "</td>" +
        '<td class="num">' +
        fmtTok(r.cacheRead) +
        "</td>" +
        '<td class="num">' +
        fmtTok(r.cacheCreation) +
        "</td>" +
        '<td class="num">' +
        r.sessions +
        "</td>" +
        '<td class="num">' +
        fmtCost(r.costUsd, r.hasUnpriced) +
        "</td></tr>"
      );
    });
    var t = report.totals;
    rowsHtml.push(
      '<tr class="total"><td>total</td>' +
        (showGroup ? "<td></td>" : "") +
        '<td class="num">' +
        fmtTok(t.promptTokens) +
        "</td>" +
        '<td class="num">' +
        fmtTok(t.completionTokens) +
        "</td>" +
        '<td class="num">' +
        fmtTok(t.cacheRead) +
        "</td>" +
        '<td class="num">' +
        fmtTok(t.cacheCreation) +
        "</td>" +
        '<td class="num">' +
        t.sessions +
        "</td>" +
        '<td class="num">' +
        fmtCost(t.costUsd, t.hasUnpriced) +
        "</td></tr>",
    );
    rowsEl.innerHTML = rowsHtml.join("");

    var note = "prices: " + esc(report.priceSource);
    if (report.unpricedModels.length) {
      note +=
        ' · <span class="warn-text">unpriced models excluded from $: ' +
        esc(report.unpricedModels.join(", ")) +
        "</span>";
    }
    document.getElementById("u-note").innerHTML = note;
  }

  // ------------------------------------------------------------- analytics
  function renderAnalytics() {
    current = { name: "analytics" };
    setView(skeleton({ cards: 7, rows: 8 }));
    fetchJSON("/api/analytics")
      .then(function (a) {
        if (current.name !== "analytics") return;
        drawAnalytics(a);
      })
      .catch(fail);
  }

  function drawAnalytics(a) {
    var t = a.totals;
    var cards =
      card("Sessions", t.sessions) +
      card("API calls", t.requests) +
      card(
        "Call error rate",
        t.requests ? fmtPct(t.erroredRequests / t.requests) : "—",
        t.requests && t.erroredRequests / t.requests > 0.05,
      ) +
      card("Total cost", fmtCost(t.costUsd, t.hasUnpriced)) +
      card("Cache hit rate", fmtPct(t.cacheHitRate)) +
      card("Output tokens", fmtTok(t.completionTokens)) +
      card(
        "Compactions",
        a.compactions.totalCompactions +
          " <small>in " +
          a.compactions.sessionsWithCompaction +
          " sessions</small>",
        a.compactions.totalCompactions > 0,
      );

    var trendHtml = "";
    if (a.trend.length) {
      trendHtml =
        '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.1</span>Cost calendar — last 26 weeks · ' +
        a.trend.length +
        " active days</div>" +
        '<div id="hm">' +
        TracetapCharts.calendarHeatmap(a.trend) +
        "</div></div>";
    }

    var tmItems = a.perProject
      .filter(function (p) {
        return p.costUsd > 0;
      })
      .map(function (p, i) {
        return {
          label: basename(p.project) || p.project,
          sub: fmtCost(p.costUsd) + " · " + p.sessions + " sessions",
          value: p.costUsd,
          idx: i,
        };
      });
    var vizSplit = "";
    var strips = TracetapCharts.ttftStrips(a.perModel);
    if (tmItems.length || strips) {
      vizSplit =
        '<div class="split">' +
        (tmItems.length
          ? '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.2</span>Spend by project</div><div id="tm">' +
            TracetapCharts.treemap(tmItems, { width: 620, height: 200 }) +
            "</div></div>"
          : "") +
        (strips
          ? '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.3</span>TTFT distribution by model · box p25–p75 · tick p50 · amber p95</div><div id="ts">' +
            strips +
            "</div></div>"
          : "") +
        "</div>";
    }

    var modelRows = a.perModel
      .map(function (m) {
        return (
          "<tr><td>" +
          esc(m.model) +
          "</td>" +
          '<td class="num">' +
          m.requests +
          "</td>" +
          '<td class="num">' +
          (m.errorRate > 0
            ? '<span class="warn-text">' + fmtPct(m.errorRate) + "</span>"
            : "0%") +
          "</td>" +
          '<td class="num">' +
          (m.ttftP50 != null ? fmtDur(m.ttftP50) : "—") +
          "</td>" +
          '<td class="num">' +
          (m.ttftP95 != null ? fmtDur(m.ttftP95) : "—") +
          "</td>" +
          '<td class="num">' +
          (m.durP50 != null ? fmtDur(m.durP50) : "—") +
          "</td>" +
          '<td class="num">' +
          fmtTok(m.completionTokens) +
          "</td></tr>"
        );
      })
      .join("");

    var agentRows = a.perAgent
      .map(function (p) {
        return (
          "<tr><td>" +
          agentPill(p.agent) +
          "</td>" +
          '<td class="num">' +
          p.sessions +
          "</td>" +
          '<td class="num">' +
          fmtTok(p.promptTokens) +
          "</td>" +
          '<td class="num">' +
          fmtTok(p.completionTokens) +
          "</td>" +
          '<td class="num">' +
          fmtCost(p.costUsd) +
          "</td></tr>"
        );
      })
      .join("");

    var maxTool = a.topTools.length ? a.topTools[0].count : 1;
    var toolRows = a.topTools
      .map(function (tl) {
        return (
          '<tr><td class="bar-cell"><div class="bar" style="width:' +
          ((tl.count / maxTool) * 100).toFixed(1) +
          '%"></div><span>' +
          esc(tl.name) +
          "</span></td>" +
          '<td class="num">' +
          tl.count +
          "</td></tr>"
        );
      })
      .join("");

    var topSessionRows = a.topSessions
      .map(function (s) {
        return (
          '<tr class="click" data-id="' +
          esc(s.sessionId) +
          '"><td>' +
          agentPill(s.agent) +
          " " +
          esc(s.model) +
          "</td>" +
          '<td class="dim" title="' +
          esc(s.projectCwd) +
          '">' +
          esc(basename(s.projectCwd)) +
          "</td>" +
          "<td>" +
          fmtTime(s.startedAt) +
          "</td>" +
          '<td class="num">' +
          fmtDur(s.durationMs) +
          "</td>" +
          '<td class="num">' +
          (s.turns || 0) +
          "</td>" +
          '<td class="num">' +
          fmtCost(s.costUsd) +
          "</td></tr>"
        );
      })
      .join("");

    setView(
      '<div class="cards">' +
        cards +
        "</div>" +
        trendHtml +
        vizSplit +
        '<div class="split">' +
        '<div><h2 class="sec">Per model <small>(wire latency &amp; reliability)</small></h2>' +
        '<div class="tbl-wrap"><table><thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Err</th><th class="num">TTFT p50</th><th class="num">TTFT p95</th><th class="num">Dur p50</th><th class="num">Out</th></tr></thead><tbody>' +
        (modelRows ||
          '<tr><td colspan="7" class="dim">no wire data</td></tr>') +
        "</tbody></table></div>" +
        '<h2 class="sec">Per agent</h2>' +
        '<div class="tbl-wrap"><table><thead><tr><th>Agent</th><th class="num">Sessions</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>' +
        (agentRows || '<tr><td colspan="5" class="dim">no data</td></tr>') +
        "</tbody></table></div></div>" +
        '<div><h2 class="sec">Top tools</h2>' +
        '<div class="tbl-wrap"><table><tbody>' +
        (toolRows || '<tr><td class="dim">no tool calls</td></tr>') +
        "</tbody></table></div>" +
        '<h2 class="sec">Top sessions by cost</h2>' +
        '<div class="tbl-wrap"><table><thead><tr><th>Session</th><th>Project</th><th>Started</th><th class="num">Dur</th><th class="num">Turns</th><th class="num">Cost</th></tr></thead><tbody>' +
        (topSessionRows ||
          '<tr><td colspan="6" class="dim">no sessions</td></tr>') +
        "</tbody></table></div></div>" +
        "</div>" +
        '<div class="note">prices: ' +
        esc(a.priceSource) +
        "</div>",
    );
    view.querySelectorAll("tr[data-id]").forEach(function (tr) {
      tr.addEventListener("click", function () {
        location.hash =
          "#session/" + encodeURIComponent(tr.getAttribute("data-id"));
      });
    });

    var hm = document.getElementById("hm");
    if (hm) {
      TT.bind(hm, ".hm-cell", function (cell) {
        var c = Number(cell.getAttribute("data-c"));
        return (
          TT.title(cell.getAttribute("data-d")) +
          TT.row("cost", fmtCost(c)) +
          TT.row("agent turns", cell.getAttribute("data-e"))
        );
      });
    }
    var tm = document.getElementById("tm");
    if (tm) {
      TT.bind(tm, ".tm-cell", function (cell) {
        var p = a.perProject[Number(cell.getAttribute("data-i"))];
        if (!p) return null;
        return (
          TT.title(p.project) +
          TT.row("cost", fmtCost(p.costUsd)) +
          TT.row("sessions", p.sessions) +
          TT.row("agent turns", p.events) +
          TT.row("output", fmtTok(p.completionTokens))
        );
      });
    }
    var ts = document.getElementById("ts");
    if (ts) {
      TT.bind(ts, ".ts-row", function (row) {
        var m = a.perModel[Number(row.getAttribute("data-i"))];
        if (!m || !m.ttftPcts) return null;
        var names = ["p10", "p25", "p50", "p75", "p90", "p95"];
        var h = TT.title(m.model + " · ttft, n=" + m.ttftN);
        m.ttftPcts.forEach(function (v, i) {
          h += TT.row(names[i], fmtDur(v));
        });
        return h;
      });
    }
  }

  // -------------------------------------------------------------- tool tax

  /**
   * Dead-tool-tax: tool definitions ride along in EVERY request, so a declared
   * tool that is never invoked is paid for on every call. Both views cross the
   * declared set (toolsets registry, sized at index time) with the invoked
   * histogram; only the grouping differs (fleet per tool vs one session).
   */
  function toolStatusPill(t) {
    if (t.dead) return '<span class="pill warn">dead</span>';
    return '<span class="pill ok">' + t.calls + "×</span>";
  }

  /**
   * Which provider shipped this tool, from the name alone.
   *
   * Claude Code namespaces every MCP tool as `mcp__<server>__<tool>`, and the
   * server segment says where it came from: `plugin_<plugin>_<server>` for a
   * plugin, `claude_ai_<Connector>` for a hosted connector, a bare name for a
   * local server. Anything without the prefix is built in.
   */
  function toolProvider(name) {
    if (name.indexOf("mcp__") !== 0) return { key: "built-in", kind: "builtin" };
    var server = name.slice(5).split("__")[0];
    if (server.indexOf("plugin_") === 0) {
      return { key: server.slice(7).split("_")[0], kind: "plugin" };
    }
    if (server.indexOf("claude_ai_") === 0) {
      return { key: server.slice(10), kind: "connector" };
    }
    return { key: server, kind: "mcp" };
  }

  // A connector that ships ONLY these is not really loaded — it is a stub the
  // model can call to trigger auth, which is what "load tools when needed"
  // leaves behind. Distinguishing stubs from full surfaces is the whole point
  // of the breakdown: they cost ~350 tokens instead of ~8,000.
  var AUTH_STUBS = { authenticate: 1, complete_authentication: 1 };

  /** Group a toolset's tools by provider, with the deferral state resolved. */
  function toolProviderGroups(tools) {
    var byKey = {};
    tools.forEach(function (t) {
      var p = toolProvider(t.name);
      var g = byKey[p.key];
      if (!g) {
        g = byKey[p.key] = {
          key: p.key,
          kind: p.kind,
          tools: [],
          approxTokens: 0,
          cumulativeTokens: 0,
          calls: 0,
        };
      }
      g.tools.push(t);
      g.approxTokens += t.approxTokens;
      g.cumulativeTokens += t.cumulativeTokens;
      g.calls += t.calls;
    });
    return Object.keys(byKey)
      .map(function (k) {
        var g = byKey[k];
        g.deferred =
          g.kind === "connector" &&
          g.tools.every(function (t) {
            return AUTH_STUBS[t.name.split("__").pop()] === 1;
          });
        return g;
      })
      .sort(function (a, b) {
        return b.approxTokens - a.approxTokens;
      });
  }

  function providerLabel(g) {
    if (g.kind === "builtin") return "built-in";
    if (g.kind === "plugin") return "plugin · " + g.key;
    if (g.kind === "connector") return "connector · " + g.key;
    return "mcp · " + g.key;
  }

  function sessionToolsetHtml(ts, idx) {
    var maxTok = ts.tools.length ? ts.tools[0].approxTokens : 1;
    ts.tools.forEach(function (t) {
      if (t.approxTokens > maxTok) maxTok = t.approxTokens;
    });
    var rows = ts.tools
      .map(function (t) {
        return (
          "<tr" +
          (t.dead ? ' class="tt-dead"' : "") +
          ' data-inspect="tool:' +
          idx +
          ":" +
          esc(t.name) +
          '" tabindex="0"><td class="bar-cell"><div class="bar' +
          (t.dead ? " warn" : "") +
          '" style="width:' +
          ((t.approxTokens / maxTok) * 100).toFixed(1) +
          '%"></div><span>' +
          esc(t.name) +
          "</span></td>" +
          '<td class="num">' +
          fmtTok(t.approxTokens) +
          "</td>" +
          '<td class="num">' +
          fmtTok(t.cumulativeTokens) +
          "</td>" +
          '<td class="num">' +
          toolStatusPill(t) +
          "</td></tr>"
        );
      })
      .join("");

    // Per-provider roll-up. 238 individually-ranked tools answer "which tool is
    // biggest" but not "which integration am I paying for", and the second is
    // the actionable one: a provider is something you can turn off, a tool is
    // not. It also makes deferral state legible — 28 connectors sitting at two
    // auth stubs look identical to 28 cheap connectors until they are grouped.
    var groups = toolProviderGroups(ts.tools);
    var totalTok = ts.tools.reduce(function (a, t) {
      return a + t.approxTokens;
    }, 0) || 1;
    var maxGroup = groups.length ? groups[0].approxTokens : 1;
    var groupRows = groups
      .map(function (g) {
        var deadTok = g.tools.reduce(function (a, t) {
          return a + (t.dead ? t.approxTokens : 0);
        }, 0);
        return (
          "<tr" +
          (g.calls === 0 ? ' class="tt-dead"' : "") +
          ' data-inspect="prov:' +
          idx +
          ":" +
          esc(g.key) +
          '" tabindex="0"><td class="bar-cell"><div class="bar' +
          (g.calls === 0 ? " warn" : "") +
          '" style="width:' +
          ((g.approxTokens / maxGroup) * 100).toFixed(1) +
          '%"></div><span>' +
          esc(providerLabel(g)) +
          (g.deferred ? ' <span class="pill dim">deferred</span>' : "") +
          "</span></td>" +
          '<td class="num">' +
          g.tools.length +
          "</td>" +
          '<td class="num">' +
          fmtTok(g.approxTokens) +
          "</td>" +
          '<td class="num">' +
          ((g.approxTokens / totalTok) * 100).toFixed(1) +
          "%</td>" +
          '<td class="num">' +
          (g.calls
            ? '<span class="pill">' + g.calls + "</span>"
            : '<span class="pill warn">0 · ' + fmtTok(deadTok) + " dead</span>") +
          "</td></tr>"
        );
      })
      .join("");
    var providerTable =
      '<h2 class="sec">By provider <small>(' +
      groups.length +
      " providers · a provider is something you can switch off; a tool is not)</small></h2>" +
      '<div class="tbl-wrap"><table><thead><tr>' +
      "<th>provider</th>" +
      '<th class="num">tools</th>' +
      '<th class="num">≈tok / call</th>' +
      '<th class="num">share</th>' +
      '<th class="num">calls</th>' +
      "</tr></thead><tbody>" +
      groupRows +
      "</tbody></table></div>";
    return (
      '<div class="cards">' +
      card("Declared", ts.declaredCount) +
      card("Called", ts.calledCount) +
      card("Dead", ts.deadCount, ts.deadCount > 0) +
      card("Dead ≈tok / call", fmtTok(ts.deadTokensPerRequest)) +
      card("Dead ≈tok total", fmtTok(ts.deadTokensCumulative), ts.deadTokensCumulative > 0) +
      card("Est. dead cost", fmtCost(ts.deadCostUsd)) +
      "</div>" +
      '<h2 class="sec">Toolset ' +
      esc(ts.toolsetHash.slice(0, 12)) +
      " <small>(declared on " +
      ts.requestCount +
      " API call" +
      (ts.requestCount === 1 ? "" : "s") +
      (idx > 0 ? " · variant" : "") +
      ", ranked by cumulative cost)</small></h2>" +
      providerTable +
      '<h2 class="sec">By tool</h2>' +
      '<div class="tbl-wrap"><table><thead><tr>' +
      "<th>tool</th>" +
      '<th class="num">≈tok / call</th>' +
      '<th class="num">≈tok total</th>' +
      '<th class="num">calls</th>' +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table></div>"
    );
  }

  function loadToolTax(sessionId) {
    var host = document.getElementById("tooltax-host");
    if (!host) return;
    fetchJSON("/api/session/" + encodeURIComponent(sessionId) + "/tools")
      .then(function (data) {
        if (!data.toolsets || !data.toolsets.length) {
          host.innerHTML =
            '<div class="empty-pane">No tool declarations captured for this session.</div>';
          return;
        }
        toolTaxForPane = data.toolsets;
        host.innerHTML = data.toolsets.map(sessionToolsetHtml).join("");
      })
      .catch(function (err) {
        host.innerHTML =
          '<div class="empty-pane">tool tax unavailable — ' +
          esc(String(err.message || err)) +
          "</div>";
      });
  }

  function renderToolTax() {
    current = { name: "tooltax" };
    setView(skeleton({ cards: 6, rows: 10 }));
    fetchJSON("/api/tooltax")
      .then(function (d) {
        if (current.name !== "tooltax") return;
        drawToolTax(d);
      })
      .catch(fail);
  }

  function drawToolTax(d) {
    var t = d.totals;
    if (!t.sessions) {
      setView(
        '<div class="empty">No toolsets indexed yet — run <code>tracetap index</code> ' +
          "(a schema bump reindexes captured logs and records declared tools).</div>",
      );
      return;
    }
    var cards =
      card("Sessions", t.sessions) +
      card("Distinct tools", t.tools) +
      card("Tool ≈tok paid", fmtTok(t.cumulativeToolTokens)) +
      card("Dead ≈tok", fmtTok(t.deadTokensCumulative), t.deadTokensCumulative > 0) +
      card("Dead share", fmtPct(t.deadShare), t.deadShare > 0.5) +
      card("Est. dead cost", fmtCost(t.deadCostUsd, t.hasUnpriced));

    var maxDead = d.tools.length
      ? Math.max(d.tools[0].deadTokensCumulative, 1)
      : 1;
    var toolRows = d.tools
      .map(function (tl) {
        var dead = tl.sessionsCalled === 0;
        return (
          "<tr" +
          (dead ? ' class="tt-dead"' : "") +
          '><td class="bar-cell"><div class="bar' +
          (dead ? " warn" : "") +
          '" style="width:' +
          ((tl.deadTokensCumulative / maxDead) * 100).toFixed(1) +
          '%"></div><span>' +
          esc(tl.name) +
          "</span></td>" +
          '<td class="num">' +
          fmtTok(tl.approxTokens) +
          "</td>" +
          '<td class="num">' +
          tl.sessionsDeclared +
          "</td>" +
          '<td class="num">' +
          tl.sessionsCalled +
          "</td>" +
          '<td class="num">' +
          tl.calls +
          "</td>" +
          '<td class="num">' +
          fmtTok(tl.deadTokensCumulative) +
          "</td>" +
          '<td class="num">' +
          fmtCost(tl.deadCostUsd, tl.hasUnpriced) +
          "</td></tr>"
        );
      })
      .join("");

    var sessionRows = d.sessions
      .map(function (s) {
        return (
          '<tr><td><a href="#session/' +
          encodeURIComponent(s.sessionId) +
          '/tools">' +
          esc(s.sessionId.slice(0, 16)) +
          "</a></td><td>" +
          agentPill(s.agent) +
          " " +
          esc(s.model) +
          "</td>" +
          '<td class="num">' +
          s.requestCount +
          "</td>" +
          '<td class="num">' +
          s.declaredCount +
          "</td>" +
          '<td class="num">' +
          s.calledCount +
          "</td>" +
          '<td class="num">' +
          s.deadCount +
          "</td>" +
          '<td class="num">' +
          fmtTok(s.deadTokensPerRequest) +
          "</td>" +
          '<td class="num">' +
          fmtTok(s.deadTokensCumulative) +
          "</td>" +
          '<td class="num">' +
          fmtCost(s.deadCostUsd) +
          "</td></tr>"
        );
      })
      .join("");

    setView(
      "<h1>Dead tool tax</h1>" +
        '<p class="dim">Tool definitions are resent on every API call. A declared tool that is ' +
        "never invoked still bills its schema each time — priced here at each model's " +
        "cache-read rate.</p>" +
        '<div class="cards">' +
        cards +
        "</div>" +
        '<h2 class="sec">Tools <small>(' +
        d.tools.length +
        " distinct, ranked by dead ≈tokens)</small></h2>" +
        '<div class="tbl-wrap"><table><thead><tr>' +
        "<th>tool</th>" +
        '<th class="num">≈tok / call</th>' +
        '<th class="num">declared in</th>' +
        '<th class="num">called in</th>' +
        '<th class="num">calls</th>' +
        '<th class="num">dead ≈tok</th>' +
        '<th class="num">est. cost</th>' +
        "</tr></thead><tbody>" +
        toolRows +
        "</tbody></table></div>" +
        '<h2 class="sec">Sessions <small>(ranked by dead ≈tokens)</small></h2>' +
        '<div class="tbl-wrap"><table><thead><tr>' +
        "<th>session</th><th>agent · model</th>" +
        '<th class="num">calls</th>' +
        '<th class="num">declared</th>' +
        '<th class="num">called</th>' +
        '<th class="num">dead</th>' +
        '<th class="num">dead ≈tok/call</th>' +
        '<th class="num">dead ≈tok</th>' +
        '<th class="num">est. cost</th>' +
        "</tr></thead><tbody>" +
        sessionRows +
        "</tbody></table></div>",
    );
  }

  // --------------------------------------------------------------- prompts
  function renderPrompts() {
    current = { name: "prompts" };
    setView(skeleton({ rows: 8 }));
    fetchJSON("/api/prompts")
      .then(function (data) {
        if (current.name !== "prompts") return;
        if (!data.prompts.length) {
          setView(
            '<div class="empty">No system prompts on record yet. Index some traced sessions first.</div>',
          );
          return;
        }
        var rows = data.prompts
          .map(function (p) {
            return (
              '<tr class="click" data-hash="' +
              esc(p.promptHash) +
              '">' +
              '<td class="hash">' +
              esc(p.promptHash.slice(0, 12)) +
              "</td>" +
              "<td>" +
              agentPill(p.agent) +
              "</td>" +
              '<td class="num">' +
              fmtTok(p.approxTokens) +
              "</td>" +
              '<td class="num">' +
              p.requestCount +
              "</td>" +
              '<td class="num">' +
              p.sessionCount +
              "</td>" +
              "<td>" +
              fmtTime(p.firstSeen) +
              "</td>" +
              "<td>" +
              fmtTime(p.lastSeen) +
              "</td></tr>"
            );
          })
          .join("");
        setView(
          '<div class="meta-line">' +
            data.count +
            " distinct system-prompt versions seen on the wire. " +
            "Every harness update that touches the prompt shows up here as a new version.</div>" +
            '<div class="tbl-wrap"><table><thead><tr><th>Hash</th><th>Agent</th><th class="num">~Tokens</th><th class="num">Requests</th><th class="num">Sessions</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>' +
            rows +
            "</tbody></table></div>",
        );
        view.querySelectorAll("tr[data-hash]").forEach(function (tr) {
          tr.addEventListener("click", function () {
            location.hash = "#prompt/" + tr.getAttribute("data-hash");
          });
        });
      })
      .catch(fail);
  }

  function renderPrompt(hash) {
    current = { name: "prompt", arg: hash };
    setView('<div class="meta-line">Loading prompt…</div>');
    Promise.all([
      fetchJSON("/api/prompt/" + encodeURIComponent(hash)),
      fetchJSON("/api/prompts"),
    ])
      .then(function (results) {
        if (current.name !== "prompt" || current.arg !== hash) return;
        drawPrompt(results[0], results[1].prompts);
      })
      .catch(fail);
  }

  function drawPrompt(p, all) {
    var others = all.filter(function (o) {
      return o.agent === p.agent && o.promptHash !== p.promptHash;
    });
    var diffSel = others.length
      ? '<select id="diff-against"><option value="">— diff against another version —</option>' +
        others
          .map(function (o) {
            return (
              '<option value="' +
              esc(o.promptHash) +
              '">' +
              esc(o.promptHash.slice(0, 12)) +
              " · last seen " +
              fmtTime(o.lastSeen) +
              "</option>"
            );
          })
          .join("") +
        "</select>"
      : '<span class="dim">no other ' +
        esc(p.agent) +
        " versions to diff against</span>";

    setView(
      '<div class="crumb"><a href="#prompts">← prompts</a></div>' +
        '<div class="detail-head"><h1>' +
        agentPill(p.agent) +
        ' <span class="hash">' +
        esc(p.promptHash.slice(0, 16)) +
        "…</span></h1>" +
        '<span class="dim">' +
        fmtTok(p.approxTokens) +
        " tokens · " +
        p.requestCount +
        " requests · " +
        p.sessionCount +
        " sessions · " +
        fmtTime(p.firstSeen) +
        " → " +
        fmtTime(p.lastSeen) +
        "</span></div>" +
        '<div class="controls">' +
        diffSel +
        "</div>" +
        '<div id="prompt-body"><div class="prompt-content">' +
        esc(p.content) +
        "</div></div>" +
        (p.sessionIds.length
          ? '<h2 class="sec">Sessions using this prompt</h2><div class="meta-line">' +
            p.sessionIds
              .slice(0, 20)
              .map(function (id) {
                return (
                  '<a href="#session/' +
                  encodeURIComponent(id) +
                  '">' +
                  esc(id) +
                  "</a>"
                );
              })
              .join(" · ") +
            "</div>"
          : ""),
    );
    var sel = document.getElementById("diff-against");
    if (sel) {
      sel.addEventListener("change", function () {
        var other = sel.value;
        var body = document.getElementById("prompt-body");
        if (!other) {
          body.innerHTML =
            '<div class="prompt-content">' + esc(p.content) + "</div>";
          return;
        }
        body.innerHTML = '<div class="meta-line">computing diff…</div>';
        fetchJSON("/api/prompt/" + encodeURIComponent(other))
          .then(function (o) {
            body.innerHTML =
              '<div class="meta-line">diff: <span class="hash">' +
              esc(o.promptHash.slice(0, 12)) +
              '</span> (old) → <span class="hash">' +
              esc(p.promptHash.slice(0, 12)) +
              "</span> (this)</div>" +
              '<div class="prompt-content diff">' +
              diffHtml(o.content, p.content) +
              "</div>";
          })
          .catch(fail);
      });
    }
  }

  /** Line-level LCS diff, rendered with folded unchanged regions. */
  function diffHtml(oldText, newText) {
    var a = String(oldText).split("\n"),
      b = String(newText).split("\n");
    if (a.length * b.length > 4_000_000) {
      return (
        '<div class="ln ctx">(too large to diff: ' +
        a.length +
        " × " +
        b.length +
        " lines)</div>"
      );
    }
    // LCS table (uint32, flat).
    var n = a.length,
      m = b.length;
    var dp = new Uint32Array((n + 1) * (m + 1));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] =
          a[i] === b[j]
            ? dp[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    var ops = []; // {t: 'ctx'|'del'|'add', s}
    var x = 0,
      y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) {
        ops.push({ t: "ctx", s: a[x] });
        x++;
        y++;
      } else if (dp[(x + 1) * (m + 1) + y] >= dp[x * (m + 1) + y + 1]) {
        ops.push({ t: "del", s: a[x] });
        x++;
      } else {
        ops.push({ t: "add", s: b[y] });
        y++;
      }
    }
    while (x < n) {
      ops.push({ t: "del", s: a[x++] });
    }
    while (y < m) {
      ops.push({ t: "add", s: b[y++] });
    }

    // Fold long unchanged runs.
    var out = [],
      run = [];
    function flushRun(isEnd) {
      if (run.length <= 7) {
        run.forEach(function (l) {
          out.push('<div class="ln ctx">' + esc(l) + "</div>");
        });
      } else {
        run.slice(0, 2).forEach(function (l) {
          out.push('<div class="ln ctx">' + esc(l) + "</div>");
        });
        out.push(
          '<div class="gap">··· ' +
            (run.length - 4) +
            " unchanged lines ···</div>",
        );
        if (!isEnd)
          run.slice(-2).forEach(function (l) {
            out.push('<div class="ln ctx">' + esc(l) + "</div>");
          });
      }
      run = [];
    }
    ops.forEach(function (op) {
      if (op.t === "ctx") {
        run.push(op.s);
        return;
      }
      flushRun(false);
      out.push(
        '<div class="ln ' +
          op.t +
          '">' +
          (op.t === "add" ? "+ " : "− ") +
          esc(op.s) +
          "</div>",
      );
    });
    flushRun(true);
    return out.join("");
  }

  // ----------------------------------------------------------------- audit
  var audit = { mode: "standard" };

  function renderAudit() {
    current = { name: "audit" };
    setView(
      '<div class="controls">' +
        '<label class="check"><input id="a-strict" type="checkbox"' +
        (audit.mode === "strict" ? " checked" : "") +
        "/> strict detectors (entropy-gated, may false-positive)</label>" +
        '<span class="spacer"></span></div>' +
        '<div id="a-body"><div class="meta-line">Scanning indexed logs…</div></div>',
    );
    document.getElementById("a-strict").addEventListener("change", function () {
      audit.mode = this.checked ? "strict" : "standard";
      loadAudit();
    });
    loadAudit();
  }

  function loadAudit() {
    var body = document.getElementById("a-body");
    if (!body) return;
    body.innerHTML = skeleton({ cards: 5, rows: 3 });
    fetchJSON("/api/audit?mode=" + audit.mode)
      .then(function (r) {
        if (current.name !== "audit") return;
        drawAudit(r);
      })
      .catch(fail);
  }

  function drawAudit(r) {
    var body = document.getElementById("a-body");
    if (!body) return;
    var cards =
      card("Files scanned", r.filesScanned) +
      card("API calls scanned", r.pairsScanned) +
      card("Distinct secrets", r.groups.length, r.groups.length > 0) +
      card("Egress occurrences", r.totalEgress, r.totalEgress > 0) +
      card("In responses", r.totalResponse, r.totalResponse > 0);

    var html = '<div class="cards">' + cards + "</div>";

    if (!r.groups.length) {
      html +=
        '<div class="empty">✓ No secrets detected on the wire (' +
        esc(r.mode) +
        " detectors).</div>";
    } else {
      html +=
        '<div class="meta-line warn-text">Transcript resending means a secret egresses on EVERY later turn — rotate the credentials below.</div>' +
        '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>Type</th><th>Fingerprint</th><th class="num">Len</th><th class="num">Egressed</th><th class="num">In responses</th><th>Where</th><th>First → last</th><th>Files</th>' +
        "</tr></thead><tbody>" +
        r.groups
          .map(function (g) {
            return (
              '<tr><td><span class="pill err">' +
              esc(g.type) +
              "</span></td>" +
              '<td class="hash">' +
              esc(g.fingerprint) +
              (g.last4 ? "…" + esc(g.last4) : "") +
              "</td>" +
              '<td class="num">' +
              g.tokenLength +
              "</td>" +
              '<td class="num">' +
              (g.egressCount
                ? '<b class="warn-text">' + g.egressCount + "×</b>"
                : "0") +
              "</td>" +
              '<td class="num">' +
              (g.responseCount || 0) +
              "</td>" +
              "<td>" +
              esc(g.locations.join(", ")) +
              "</td>" +
              '<td class="dim">' +
              fmtTime(g.firstTs) +
              " → " +
              fmtTime(g.lastTs) +
              "</td>" +
              '<td class="dim">' +
              g.files
                .map(function (f) {
                  return esc(basename(f));
                })
                .join("<br/>") +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>";
    }

    if (r.redactCheck) {
      html +=
        '<div class="note">redact-check: capture-time <code>--redact-bodies</code> would mask ' +
        r.redactCheck.standardMasked +
        ", <code>--redact-bodies=strict</code> " +
        r.redactCheck.strictMasked +
        " of " +
        r.redactCheck.total +
        " detected occurrence(s). " +
        "Capture with <code>tracetap claude --redact-bodies</code> to mask at write time.</div>";
    }
    body.innerHTML = html;
  }

  // ------------------------------------------------- keyboard + palette
  var TABS = ["sessions", "usage", "analytics", "prompts", "audit", "tooltax"];

  function isTyping(e) {
    var t = e.target;
    return (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    );
  }

  function focusedRow() {
    return view.querySelector(".kb-focus");
  }

  function moveCursor(dir) {
    var rows = Array.prototype.slice.call(
      view.querySelectorAll("tr.click, .wf-row.click"),
    );
    if (!rows.length) return;
    var cur = focusedRow();
    var idx = cur ? rows.indexOf(cur) : -1;
    var next = Math.min(rows.length - 1, Math.max(0, idx + dir));
    if (cur) cur.classList.remove("kb-focus");
    rows[next].classList.add("kb-focus");
    rows[next].scrollIntoView({ block: "nearest" });
  }

  function activateCursor() {
    var cur = focusedRow();
    if (cur) cur.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  function focusSearch() {
    var inp =
      view.querySelector('input[type="search"]') ||
      view.querySelector('input[type="text"]');
    if (inp) {
      inp.focus();
      inp.select();
      return true;
    }
    return false;
  }

  // Delegated: the hooks pane is re-rendered as innerHTML, so a listener bound
  // to the checkbox itself would not survive a toggle.
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || t.id !== "hooks-observe-toggle") return;
    hooksShowObserveOnly = !!t.checked;
    var pane = document.getElementById("pane-hooks");
    if (!pane) return;
    // Inspect chips are delegated off `.session-panes`, which contains every
    // pane and survives this innerHTML swap — so a re-render needs no
    // rebinding, which is the only reason the old popover code ran again here.
    pane.innerHTML = renderHooksPane(hooksForPane);
  });

  // -- session keyboard model ---------------------------------------------
  //
  // Two axes, which is the whole idea: UP/DOWN moves within the list you are
  // looking at, LEFT/RIGHT moves the same selection to a different view of it.
  // A turn stays selected as you cross panes, so "what did the context look
  // like on this call" and "what did the wire do on this call" are one
  // keystroke apart instead of a click, a scroll and a hunt.
  var SESSION_PANES = ["flow", "hooks", "xray", "tools", "wire", "related"];
  var selectedSeq = null;
  // Where you were in each pane. Returning a pane to its first row every time
  // makes LEFT/RIGHT feel like it discards your place, which defeats the point
  // of moving between views of the same work.
  var paneCursor = {};

  /** Inspectable rows in the active pane, in visual order, excluding hidden. */
  function paneTargets() {
    var pane = document.querySelector(".session-pane.active");
    if (!pane) return [];
    return Array.prototype.slice
      .call(pane.querySelectorAll("[data-inspect]"))
      .filter(function (el) {
        // Hook chips live inside collapsed <details>; arrowing onto something
        // the user cannot see reads as the keys being broken.
        return el.offsetParent !== null;
      });
  }

  function selectTarget(el) {
    if (!el) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Re-use the delegated [data-inspect] resolver rather than a second
    // dispatch table — one place decides what a row means.
    el.click();
  }

  /** After switching panes, land on the same turn if this pane has it. */
  function reselectInPane() {
    var list = paneTargets();
    if (!list.length) return;
    // A turn wins over a remembered cursor: if this pane can show the call you
    // were just looking at, that is what "the same thing, another view" means.
    var wanted = selectedSeq != null ? "ctp:" + selectedSeq : null;
    var remembered = paneCursor[current.pane];
    for (var pass = 0; pass < 2; pass++) {
      var want = pass === 0 ? wanted : remembered;
      if (!want) continue;
      for (var i = 0; i < list.length; i++) {
        if (list[i].getAttribute("data-inspect") === want) {
          selectTarget(list[i]);
          return;
        }
      }
    }
    selectTarget(list[0]);
  }

  function sessionArrowNav(e) {
    var k = e.key;
    var vertical = k === "ArrowDown" || k === "ArrowUp";
    var horizontal = k === "ArrowRight" || k === "ArrowLeft";
    if (!vertical && !horizontal) return false;

    if (horizontal) {
      var cur = SESSION_PANES.indexOf(current.pane || "flow");
      if (cur < 0) cur = 0;
      var step = k === "ArrowRight" ? 1 : SESSION_PANES.length - 1;
      e.preventDefault();
      activatePane(SESSION_PANES[(cur + step) % SESSION_PANES.length]);
      // Panes render lazily; give the new one a frame before selecting in it.
      setTimeout(reselectInPane, 0);
      return true;
    }

    var list = paneTargets();
    if (!list.length) return false;
    e.preventDefault();
    var curId = Inspector.selected();
    var i = -1;
    for (var n = 0; n < list.length; n++) {
      if (list[n].getAttribute("data-inspect") === curId) {
        i = n;
        break;
      }
    }
    var d = k === "ArrowDown" ? 1 : -1;
    var next =
      i < 0
        ? d > 0
          ? 0
          : list.length - 1
        : Math.min(list.length - 1, Math.max(0, i + d));
    selectTarget(list[next]);
    return true;
  }

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      togglePalette();
      return;
    }
    if (paletteOpen() || helpOpen()) return; // overlays own their keys
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e)) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (current.name === "session" && sessionArrowNav(e)) return;
    if (e.key === "/") {
      e.preventDefault();
      focusSearch();
    } else if (e.key === "j") moveCursor(1);
    else if (e.key === "k") moveCursor(-1);
    else if (e.key === "Enter" && focusedRow()) {
      e.preventDefault();
      activateCursor();
    } else if (e.key >= "1" && e.key <= "6")
      location.hash = "#" + TABS[Number(e.key) - 1];
    else if (e.key === "?") toggleHelp();
    else if (e.key === "Escape") {
      // Escape unwinds one level at a time: a drill-down first, then the
      // inspector, then the page. "Close what I just opened" has to win over
      // "go back", or there is no way to dismiss a selection without losing
      // your place — and a drill-down is something you just opened too.
      if (Inspector.back()) return;
      if (Inspector.selected()) {
        Inspector.clear();
        return;
      }
      if (current.name === "session") location.hash = "#sessions";
      else if (current.name === "prompt") location.hash = "#prompts";
    }
  });

  // -- command palette ---------------------------------------------------
  var palItems = [],
    palSel = 0;

  function paletteOpen() {
    return !!document.getElementById("pal");
  }

  function togglePalette() {
    if (paletteOpen()) {
      closeOverlays();
      return;
    }
    closeOverlays();
    var ov = document.createElement("div");
    ov.className = "pal-overlay";
    ov.id = "pal";
    ov.innerHTML =
      '<div class="pal">' +
      '<input id="pal-q" type="text" placeholder="Jump to a session, prompt, or view…" autocomplete="off" spellcheck="false" />' +
      '<div class="pal-list" id="pal-list"><div class="pal-empty">indexing…</div></div>' +
      '<div class="pal-foot">↑↓ navigate · ↵ open · esc close</div>' +
      "</div>";
    document.body.appendChild(ov);
    ov.addEventListener("mousedown", function (e) {
      if (e.target === ov) closeOverlays();
    });

    var q = document.getElementById("pal-q");
    q.focus();
    q.addEventListener("input", function () {
      palRender(q.value);
    });
    q.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeOverlays();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        palMove(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        palMove(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        var sel = document.querySelector(".pal-item.sel");
        if (sel) palGo(sel.getAttribute("data-go"));
      }
      e.stopPropagation();
    });

    palItems = TABS.map(function (t, i) {
      return {
        kind: "view",
        label: t,
        sub: "switch view · " + (i + 1),
        go: "#" + t,
        text: t,
      };
    });
    Promise.all([
      fetchJSON("/api/sessions?limit=200").catch(function () {
        return { sessions: [] };
      }),
      fetchJSON("/api/prompts").catch(function () {
        return { prompts: [] };
      }),
    ]).then(function (res) {
      res[0].sessions.forEach(function (s) {
        palItems.push({
          kind: "session",
          label:
            s.agent + " · " + (s.model || "?") + " · " + basename(s.projectCwd),
          sub:
            fmtTime(s.startedAt) +
            " · " +
            (s.turns || 0) +
            " turns · " +
            fmtCost(s.costUsd),
          go: "#session/" + encodeURIComponent(s.sessionId),
          text:
            s.sessionId + " " + s.agent + " " + s.model + " " + s.projectCwd,
        });
      });
      res[1].prompts.forEach(function (p) {
        palItems.push({
          kind: "prompt",
          label: p.promptHash.slice(0, 12) + " · " + p.agent,
          sub:
            "~" +
            fmtTok(p.approxTokens) +
            " tokens · last seen " +
            fmtTime(p.lastSeen),
          go: "#prompt/" + p.promptHash,
          text: p.promptHash + " " + p.agent + " prompt",
        });
      });
      if (paletteOpen()) palRender(q.value);
    });
    palRender("");
  }

  /** Subsequence fuzzy score: consecutive + word-start bonuses, -1 = no match. */
  function fuzzyScore(needle, hay) {
    if (!needle) return 0;
    needle = needle.toLowerCase();
    hay = hay.toLowerCase();
    var score = 0,
      hi = 0,
      streak = 0;
    for (var ni = 0; ni < needle.length; ni++) {
      var c = needle[ni];
      if (c === " ") {
        streak = 0;
        continue;
      }
      var found = hay.indexOf(c, hi);
      if (found === -1) return -1;
      streak = found === hi ? streak + 1 : 1;
      score +=
        streak * 2 +
        (found === 0 || hay[found - 1] === " " || hay[found - 1] === "/"
          ? 4
          : 0);
      hi = found + 1;
    }
    return score;
  }

  function palRender(qv) {
    var list = document.getElementById("pal-list");
    if (!list) return;
    var ranked = palItems
      .map(function (it) {
        return { it: it, s: fuzzyScore(qv, it.text) };
      })
      .filter(function (r) {
        return r.s >= 0;
      })
      .sort(function (a, b) {
        return b.s - a.s;
      })
      .slice(0, 12);
    palSel = 0;
    if (!ranked.length) {
      list.innerHTML = '<div class="pal-empty">no matches</div>';
      return;
    }
    list.innerHTML = ranked
      .map(function (r, i) {
        return (
          '<div class="pal-item' +
          (i === 0 ? " sel" : "") +
          '" data-go="' +
          esc(r.it.go) +
          '">' +
          '<span class="pal-kind ' +
          r.it.kind +
          '">' +
          r.it.kind +
          "</span>" +
          '<span class="pal-label">' +
          esc(r.it.label) +
          "</span>" +
          '<span class="pal-sub">' +
          esc(r.it.sub) +
          "</span>" +
          "</div>"
        );
      })
      .join("");
    list.querySelectorAll(".pal-item").forEach(function (el) {
      el.addEventListener("click", function () {
        palGo(el.getAttribute("data-go"));
      });
    });
  }

  function palMove(dir) {
    var items = document.querySelectorAll(".pal-item");
    if (!items.length) return;
    palSel = Math.min(items.length - 1, Math.max(0, palSel + dir));
    items.forEach(function (el, i) {
      el.classList.toggle("sel", i === palSel);
    });
    items[palSel].scrollIntoView({ block: "nearest" });
  }

  function palGo(hash) {
    closeOverlays();
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  // -- shortcuts overlay ---------------------------------------------------
  function helpOpen() {
    return !!document.getElementById("help");
  }

  function toggleHelp() {
    if (helpOpen()) {
      closeOverlays();
      return;
    }
    closeOverlays();
    var rows = [
      ["⌘K", "command palette"],
      ["/", "focus search"],
      ["j / k", "move row cursor"],
      ["↵", "open focused row"],
      ["1–6", "switch view"],
      // Two axes inside a session: down the list you are in, across the views
      // of the thing you have selected.
      ["↑ / ↓", "in a session: previous / next row"],
      ["← / →", "in a session: same turn, previous / next pane"],
      ["esc", "back / close"],
      ["?", "this overlay"],
    ];
    var ov = document.createElement("div");
    ov.className = "pal-overlay";
    ov.id = "help";
    ov.innerHTML =
      '<div class="pal help"><div class="tt-title">keyboard</div>' +
      rows
        .map(function (r) {
          return (
            '<div class="help-row"><kbd>' +
            r[0] +
            "</kbd><span>" +
            r[1] +
            "</span></div>"
          );
        })
        .join("") +
      "</div>";
    document.body.appendChild(ov);
    ov.addEventListener("mousedown", function (e) {
      if (e.target === ov) closeOverlays();
    });
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape" || e.key === "?") {
        closeOverlays();
        document.removeEventListener("keydown", onEsc);
      }
    });
  }

  function closeOverlays() {
    ["pal", "help"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  var palBtn = document.getElementById("palette-btn");
  if (palBtn) palBtn.addEventListener("click", togglePalette);

  // -------------------------------------------------------------- SSE live
  var liveEl = document.getElementById("live");
  var liveLabel = document.getElementById("live-label");
  var refresh = debounce(function () {
    if (current.name === "sessions") loadSessionData();
    else if (current.name === "usage") loadUsage();
    else route();
  }, 400);

  function connectSSE() {
    var es = new EventSource("/api/events");
    es.addEventListener("hello", function () {
      liveEl.className = "live on";
      liveLabel.textContent = "live";
    });
    es.addEventListener("change", function () {
      liveLabel.textContent = "updated " + new Date().toLocaleTimeString();
      loadMeta();
      refresh();
    });
    es.onerror = function () {
      liveEl.className = "live off";
      liveLabel.textContent = "offline";
    };
  }

  connectSSE();
  loadMeta();
  route();
})();
