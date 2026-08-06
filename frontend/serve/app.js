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
   * Re-measure every registered chart after the inspector rail appears or goes.
   *
   * The rail is a grid column, so opening it narrows its neighbour by ~400px in
   * the same frame. Charts are laid out at the width they will occupy and are
   * never scaled to reach it, which is exactly why they have to be told the
   * width changed. Deferred one frame so the measurement reads the new layout
   * rather than the one being replaced.
   */
  function reflowAfterRailToggle() {
    requestAnimationFrame(function () {
      if (typeof fitCharts === "function") fitCharts();
    });
  }

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
        var wasOpen = el.classList.contains("open");
        el.innerHTML = INSPECTOR_EMPTY;
        el.classList.remove("open");
        if (wasOpen) reflowAfterRailToggle();
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
      var wasOpen = el.classList.contains("open");
      el.classList.add("open");
      // Opening the rail takes ~400px away from the pane beside it, and a chart
      // laid out at the old width would be a chart drawn for a box that no
      // longer exists. Only on the transition — re-rendering into an already
      // open rail changes nothing about the width.
      if (!wasOpen) reflowAfterRailToggle();

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
      // ALL matches, not the first. A turn id (`ctp:<seq>`) deliberately
      // appears in more than one view — the X-Ray timeline bar and the turn
      // spine row — because they are the same turn. Marking only
      // `querySelector`'s first hit highlighted whichever happened to come
      // earlier in the DOM, which was routinely in a pane the user was not
      // looking at, and left the visible one unmarked.
      document
        .querySelectorAll('[data-inspect="' + cssEscape(sourceId) + '"]')
        .forEach(function (src) {
          src.classList.add("selected");
          src.setAttribute("aria-current", "true");
        });

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
  /**
   * Exact integer with thousands separators.
   *
   * `fmtTok` abbreviates (46698 → "46.7K"), which is right for dense tables and
   * wrong for a figure the reader is asked to weigh against another figure —
   * "46,698 rebuilt to reclaim 78" only lands when both are exact.
   */
  function fmtCount(n) {
    if (n == null || isNaN(n)) return "—";
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

  /**
   * Every agent that ran inside a session, as one plain-text roster.
   *
   * Used for `title=` attributes, where markup is not an option and the whole
   * cast has to fit one tooltip. Names are the parent's `description` for the
   * spawn; unnamed calls are counted, never invented.
   */
  function castRoster(s) {
    var cast = (s && s.agentCast) || [];
    var lines = cast.map(function (a) {
      return a.label + (a.type ? " (" + a.type + ")" : "") + " — " + a.calls + " calls";
    });
    if (s && s.unnamedAgentCalls) {
      lines.push(s.unnamedAgentCalls + " calls by unnamed agents (spawned by a workflow)");
    }
    return lines.join("\n");
  }

  /**
   * The cast, spelled out under the session header — one chip per named agent.
   *
   * Chips rather than a count, because the names ARE the information: "Critique
   * PR 366" and "Research overnight loop mechanisms" tell you what the session
   * delegated, which is the part a single number destroys. Capped at six so a
   * 20-agent fan-out cannot push the stat cards off the first screen; the rest
   * are reachable through the chip that says how many were dropped.
   */
  function castLineHtml(s) {
    var cast = (s && s.agentCast) || [];
    var unnamed = (s && s.unnamedAgentCalls) || 0;
    if (!cast.length && !unnamed) return "";
    var SHOWN = 6;
    var chips = cast.slice(0, SHOWN).map(function (a) {
      return (
        '<button type="button" class="cast-chip" data-pane="related" title="' +
        esc(a.label + (a.type ? " · " + a.type : "") + " — " + a.calls + " API calls") +
        '">' +
        esc(a.label) +
        ' <small>' + a.calls + "</small></button>"
      );
    });
    if (cast.length > SHOWN) {
      chips.push(
        '<button type="button" class="cast-chip more" data-pane="related" title="' +
          esc(castRoster(s)) +
          '">+' +
          (cast.length - SHOWN) +
          " more</button>",
      );
    }
    if (unnamed) {
      // Never merged into a named chip or into the main thread: these are real
      // subagent calls whose spawn was never captured, and saying so beats both
      // silence and a guess.
      chips.push(
        '<button type="button" class="cast-chip unnamed" data-pane="related" title="' +
          esc(
            unnamed +
              " subagent calls carry the subagent billing marker but no Agent" +
              " tool_use to take a name from — typically a workflow-orchestrated" +
              " agent, whose spawn is never on the wire.",
          ) +
          '">unnamed <small>' +
          unnamed +
          "</small></button>",
      );
    }
    return (
      '<div class="cast-line"><span class="cast-lead">agents</span>' +
      chips.join("") +
      "</div>"
    );
  }

  /**
   * The session's cast as a cell: how many agents, named on hover.
   *
   * A count rather than the names themselves, because a fan-out runs a dozen
   * and the column has to stay one line — the names are one hover away here and
   * spelled out in full in the session header.
   */
  function castCell(s) {
    var n = ((s && s.agentCast) || []).length;
    var unnamed = (s && s.unnamedAgentCalls) || 0;
    if (!n && !unnamed) return '<td class="num dim">—</td>';
    return (
      '<td class="num" title="' +
      esc(castRoster(s)) +
      '">' +
      (n ? n : "") +
      (n && unnamed ? ' <span class="dim">+?</span>' : "") +
      (!n && unnamed ? '<span class="dim">?</span>' : "") +
      "</td>"
    );
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

  /** Skeleton shimmer placeholder: a grid of stat-card blanks. */
  function skelCards(n) {
    var h = '<div class="skel-cards">';
    for (var c = 0; c < n; c++) h += '<div class="skel skel-card"></div>';
    return h + "</div>";
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
          if (m.build.stale && !restarting) {
            // Say what it DOES, not what is wrong. The old wording ("restart
            // required") named an action the reader had no way to take from
            // here, so the obvious response — refresh — could only fail.
            stale.textContent = "⚠ newer build on disk — click to upgrade";
            stale.title =
              "running build " +
              new Date(m.build.loadedAt).toLocaleString() +
              "\non disk       " +
              new Date(m.build.builtAt).toLocaleString() +
              "\n\nA page refresh cannot fix this: the frontend reloads from " +
              "disk every request, but compiled server code is frozen at " +
              "process start.\nClicking relaunches the server and reloads once " +
              "it is back.";
          }
        }
      })
      .catch(function () {});
  }

  /** Set while an upgrade is in flight, so the poller stops rewriting the badge. */
  var restarting = false;

  /**
   * Relaunch the server on the newer build, then reload once it answers.
   *
   * The server re-execs, so the socket drops mid-flight — the POST is EXPECTED
   * to fail at the transport level and a rejection here says nothing about
   * whether the restart took. Only the poll below can tell, and what it waits
   * for is a CHANGED `loadedAt`: "the server answers" is not enough, because
   * the old process answers too right up until it exits.
   */
  function upgradeServer(btn) {
    if (restarting) return;
    restarting = true;
    var before = null;
    btn.textContent = "⟳ relaunching…";
    btn.disabled = true;

    fetchJSON("/api/meta")
      .then(function (m) {
        before = m.build ? m.build.loadedAt : null;
        return fetch("/api/restart", { method: "POST" }).catch(function () {
          return null; // the connection dying IS the restart happening
        });
      })
      .then(function (res) {
        // 409 is "already running the newest build" — the goal state, reached
        // without doing anything. Reporting it as a failure was wrong and
        // alarming: it happens whenever the badge is a poll interval stale,
        // which is exactly when a user is most likely to click.
        if (res && res.status === 409) {
          location.reload();
          return null;
        }
        // A live 403 (or anything else) means the server declined and is still
        // running, so there is nothing to wait for.
        if (res && !res.ok && res.status !== 202) {
          return res.json().then(function (j) {
            throw new Error(j.error || "restart refused");
          });
        }
        var tries = 0;
        return new Promise(function (resolve, reject) {
          (function poll() {
            if (++tries > 40) return reject(new Error("server did not come back"));
            fetch("/api/meta")
              .then(function (r) {
                return r.json();
              })
              .then(function (m) {
                var now = m.build ? m.build.loadedAt : null;
                if (now && now !== before) resolve();
                else setTimeout(poll, 250);
              })
              .catch(function () {
                setTimeout(poll, 250);
              });
          })();
        });
      })
      .then(function () {
        location.reload();
      })
      .catch(function (err) {
        restarting = false;
        btn.disabled = false;
        btn.textContent = "⚠ upgrade failed — restart tracetap serve";
        btn.title = String((err && err.message) || err);
      });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("#sb-stale");
    if (btn && !btn.hidden) upgradeServer(btn);
  });

  // ------------------------------------------------------------- svg charts
  /** Vertical column chart. items: [{label, value, title?, warn?}] */
  /**
   * Charts are laid out at their host's MEASURED width, which is only knowable
   * once the host is in the document — so a view registers a render function
   * per host id and this measures, then calls it. Re-render, never rescale: an
   * SVG stretched to fit its box shears its own text (see charts.js `svgOpen`).
   *
   * `TT.bind` delegates from the host, which survives replacing its innerHTML,
   * so re-fitting never costs a tooltip binding.
   */
  var chartFits = {};

  function fitChart(hostId) {
    var host = document.getElementById(hostId);
    var render = chartFits[hostId];
    if (!host || !render) return;
    var w = Math.floor(host.clientWidth);
    // Guard both the un-laid-out case and the no-op case: a resize that does
    // not change the host width must not rebuild the DOM under the cursor.
    if (w <= 0 || host.getAttribute("data-fit-w") === String(w)) return;
    host.setAttribute("data-fit-w", String(w));
    host.innerHTML = render(w);
  }

  function registerChart(hostId, render) {
    chartFits[hostId] = render;
    fitChart(hostId);
  }

  function fitCharts() {
    Object.keys(chartFits).forEach(fitChart);
  }

  var fitTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitCharts, 120);
  });

  function columnChart(items, opts) {
    opts = opts || {};
    var H = opts.height || 120,
      PAD = 4,
      LABEL_H = opts.labels ? 16 : 0;
    // Columns grow into the space available, bounded on BOTH sides: below the
    // floor they stop being readable, above the ceiling four daily buckets turn
    // into four 500px slabs. The chart is then exactly `cw * items` wide and is
    // rendered at that size — never stretched to reach it.
    var MIN_COL = 6, MAX_COL = 96;
    var natural = opts.colWidth || 18;
    var cw = opts.width
      ? Math.max(MIN_COL, Math.min(MAX_COL, Math.floor(opts.width / items.length)))
      : natural;
    if (cw < natural && !opts.width) cw = natural;
    var W = Math.max(80, Math.round(items.length * cw));
    var max = 0;
    items.forEach(function (it) {
      if (it.value > max) max = it.value;
    });
    if (max <= 0) max = 1;
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
    // No `preserveAspectRatio="none"`: with the height pinned and the width
    // free, it stretched a 136-wide viewBox across 1942px and sheared the date
    // labels 14× horizontally. Explicit px width/height, one-to-one with the
    // viewBox, is the whole fix.
    return (
      '<svg width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + " " + H + '">' +
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
    var h = location.hash.replace(/^#/, "") || "analytics";
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
        m[2] || "journey",
      );
    } else if ((m = h.match(/^prompt\/(.+)$/)))
      renderPrompt(decodeURIComponent(m[1]));
    // #usage was folded into #analytics; keep old bookmarks working (replace,
    // so Back does not bounce straight into the redirect again).
    else if (h === "usage") {
      location.replace("#analytics");
      return;
    }
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
  /**
   * One stat card: label, headline number, optional qualifying sub-line.
   *
   * `sub` is a separate argument rather than markup smuggled into `v`, because
   * a qualifier appended inline wraps INSIDE the headline — "309 in 21" then
   * "sessions" on a third line — and a grid row is as tall as its tallest card,
   * so one wrapping card added 40px to all seven.
   */
  function card(k, v, alert, sub) {
    return (
      '<div class="card' +
      (alert ? " alert" : "") +
      '"><div class="k">' +
      k +
      '</div><div class="v">' +
      v +
      "</div>" +
      (sub ? '<div class="card-sub">' + sub + "</div>" : "") +
      "</div>"
    );
  }

  // ------------------------------------------------------- wire pane (turn spine)

  function bindSessionInteractions(reqs, compactSeqs, steps) {
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


  // ------------------------------------------------------- turn spine
  /**
   * One row per turn, expandable into everything that happened during it.
   *
   * The Wire pane showed three parallel views of the same 18 calls — two
   * summary charts and a waterfall — while the hooks that fired during those
   * calls lived in another pane and the compactions in a third. Answering
   * "what happened on turn 13, and what caused it" meant reading four places
   * and correlating by eye on a `seq` that is not even time-ordered.
   *
   * A turn is the unit of work, so it is the row. Its events hang under it.
   */
  function buildTurns(reqs, hooks, steps, compactSeqs) {
    var byStep = {};
    // The nearest USER step at or before each index — i.e. the prompt that
    // produced the call. A request is joined to the AGENT step it emitted, and
    // on many sessions that step is empty (the indexer stores the placeholder
    // "<block>no" and no tool fields), so the agent side alone leaves every row
    // blank. What was actually said is on the user side, one step earlier.
    var prevUser = {};
    var lastUser = null;
    (steps || [])
      .slice()
      .sort(function (a, b) {
        return a.stepIndex - b.stepIndex;
      })
      .forEach(function (st) {
        byStep[st.stepIndex] = st;
        if (st.role === "user") lastUser = st;
        prevUser[st.stepIndex] = lastUser;
      });
    return (reqs || []).map(function (r, i) {
      var next = reqs[i + 1];
      // Hooks are timestamped, not seq-tagged, so a turn owns the hooks that
      // fired between its start and the next turn's. Imperfect where turns
      // interleave across agents — which is why the turn carries its agent
      // label, so a mis-attributed hook is at least visible as such.
      var evs = [];
      var st = r.agentStepIndex != null ? byStep[r.agentStepIndex] : null;
      if (st && st.toolName) {
        // `toolName` is space-joined and `toolInput` newline-joined, ONE entry
        // per tool_use block on the step — so a step that called three tools
        // arrived here as the single label "WebFetch WebFetch Bash" and counted
        // as one event. Split them back apart against the same index: the count
        // on the filter chip is only honest if each call is its own event.
        var names = String(st.toolName).trim().split(/\s+/);
        var inputs = String(st.toolInput || "").split("\n");
        names.forEach(function (name, k) {
          evs.push({
            kind: "tool",
            label: name + toolArgHint(inputs[k]),
            detail: inputs[k] || "",
            // The observation is stitched across ALL of the step's calls, so it
            // can only be attributed when there was exactly one to attribute to.
            n: names.length === 1 ? String(st.observation || "").length : null,
          });
        });
      }
      // The LAST turn used to have no upper bound, so every hook that fired
      // after the session's final API call piled onto it: on one session that
      // was 155 of 211 hooks, and the "densest turn" insight was really
      // reporting "the last turn is a bucket". Bound it by its own end instead;
      // what falls outside is genuinely unattributed and is reported as such
      // rather than assigned to whoever happens to be last.
      var upper = next ? next.ts : reqSpanMs(r).to / 1000;
      (hooks || []).forEach(function (h) {
        if (h.ts < r.ts) return;
        if (h.ts >= upper) return;
        evs.push({
          kind: "hook",
          label: (h.event || "hook") + " · " + (h.hookName || ""),
          // What it SAW and what it DID, not just what it printed. A hook that
          // blocks a tool call is the most consequential thing on a turn and
          // `stdoutPreview` alone does not show the decision.
          detail: JSON.stringify(
            {
              decision: h.decision,
              outcome: h.outcome,
              exitCode: h.exitCode,
              stdin: h.stdinPreview,
              stdout: h.stdoutPreview,
              payload: h.payload,
            },
            null,
            2,
          ),
          // Carried so the journey can render decision/outcome without
          // re-deriving them out of the serialised blob.
          hook: h,
          n: h.durationMs,
        });
      });
      var c = compactSeqs[r.seq];
      if (c) {
        evs.push({
          kind: "compaction",
          label: "compaction " + c.from + " → " + c.to + " items",
          detail: "",
          n: c.from - c.to,
        });
      }
      var prompt = r.agentStepIndex != null ? prevUser[r.agentStepIndex] : null;
      return {
        seq: r.seq,
        req: r,
        agent: r.isSubagent ? r.agentLabel || "subagent (unnamed)" : "main thread",
        summary: turnSummary(st, prompt),
        // Kept whole (not just summarised) because the journey view shows the
        // turn's anatomy: what came IN, what the model did, what went OUT.
        step: st || null,
        prompt: prompt || null,
        events: evs,
      };
    });
  }

  /** The one argument that most distinguishes a tool call from its siblings. */
  var TOOL_ARG_KEYS = [
    "file_path", "path", "pattern", "command", "url", "query",
    "prompt", "description", "notebook_path", "skill", "name",
  ];

  function toolArgHint(inputJson) {
    var v = firstToolArg(inputJson);
    return v ? " " + v : "";
  }

  function firstToolArg(inputJson) {
    if (!inputJson) return "";
    var o;
    try {
      o = JSON.parse(inputJson);
    } catch (_) {
      return oneLine(inputJson, 60);
    }
    if (!o || typeof o !== "object") return "";
    for (var i = 0; i < TOOL_ARG_KEYS.length; i++) {
      var v = o[TOOL_ARG_KEYS[i]];
      if (typeof v === "string" && v) return oneLine(v, 60);
    }
    return "";
  }

  /** Collapse to a single line and clip, so a row can never grow a second line. */
  function oneLine(s, max) {
    var t = String(s || "")
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!max || t.length <= max) return t;
    return t.slice(0, max - 1) + "…";
  }

  /** The indexer's placeholder for a step whose content it could not extract. */
  var EMPTY_STEP_MESSAGE = "<block>no";

  /**
   * The readable text inside a transcript step's message.
   *
   * User-side steps are stored as a one-key JSON envelope whose key names the
   * SOURCE — `{"user": "…"}` for something a human typed, `{"Bash": "…"}` for a
   * tool result being fed back. Rendering the envelope raw put `{"user":"…` at
   * the front of every row and pushed the actual words off the end, so unwrap it
   * and keep the key as a prefix only when it is not the trivial "user" case.
   *
   * Slash-command chatter (`<command-name>`, `<local-command-stdout>`) is kept
   * but unwrapped: "/model fable" is a real thing the user did and belongs on
   * the spine, it just does not need its tags.
   */
  function stepText(st) {
    if (!st) return "";
    var raw = String(st.message || "");
    if (!raw || raw.indexOf(EMPTY_STEP_MESSAGE) === 0) return "";
    var o = null;
    try {
      o = JSON.parse(raw);
    } catch (_) {
      /* not an envelope — the raw text IS the message */
    }
    var label = "";
    if (o && typeof o === "object" && !Array.isArray(o)) {
      var keys = Object.keys(o);
      if (keys.length === 1 && typeof o[keys[0]] === "string") {
        if (keys[0] !== "user") label = keys[0] + " ";
        raw = o[keys[0]];
      }
    }
    raw = raw
      .replace(/<command-name>\s*/g, "")
      .replace(/<\/command-name>/g, "")
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
      .replace(/<command-args>\s*/g, " ")
      .replace(/<\/command-args>/g, "")
      .replace(/<\/?local-command-stdout>/g, "")
      .replace(/<\/?transcript>/g, "");
    return label + oneLine(raw, 200);
  }

  /**
   * What the turn was ABOUT, in one line.
   *
   * The agent column read "main thread" on 258 consecutive rows. A column whose
   * value never varies carries no information and still costs its width — what
   * you actually scan a spine for is the WORK: the prompt that opened the turn,
   * or the tools the assistant reached for. So the agent survives only as a
   * badge on subagent rows, i.e. only in the case where it distinguishes.
   */
  function turnSummary(st, prompt) {
    // What the assistant DID, when the indexer captured it.
    var tools = st ? String(st.toolName || "").trim() : "";
    if (tools) {
      var names = tools.split(/\s+/);
      var inputs = String(st.toolInput || "").split("\n");
      return names
        .map(function (n, k) {
          var a = firstToolArg(inputs[k]);
          return a ? n + " " + oneLine(a, 34) : n;
        })
        .join("  ·  ");
    }
    var own = stepText(st);
    if (own) return own;
    // Else what it was ASKED. Marked with "› " so a prompt is never mistaken for
    // a response — the row is showing its neighbour, and should admit it.
    var asked = stepText(prompt);
    return asked ? "› " + asked : "";
  }

  /**
   * Lane index per interval, so overlapping intervals never share a lane.
   *
   * This IS the information the waterfall carried and a sorted list cannot:
   * two bars on one lane are provably sequential, and anything stacked is
   * provably concurrent. Greedy first-fit over start order, which is optimal
   * for interval-graph colouring — the lane count it returns is exactly the
   * maximum number of calls in flight at any instant.
   *
   * @param items `[{from, to}]` in render order (NOT required to be sorted).
   * @returns lane index parallel to `items`.
   */
  function packLanes(items) {
    var order = items
      .map(function (_, i) { return i; })
      .sort(function (a, b) { return items[a].from - items[b].from; });
    var laneEnd = [];
    var lanes = new Array(items.length);
    order.forEach(function (i) {
      var it = items[i];
      var lane = -1;
      for (var l = 0; l < laneEnd.length; l++) {
        if (laneEnd[l] <= it.from) { lane = l; break; }
      }
      if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
      laneEnd[lane] = it.to;
      lanes[i] = lane;
    });
    return lanes;
  }

  /**
   * A request's [start, end) in EPOCH MILLISECONDS.
   *
   * `ts` is served in SECONDS (every other reader multiplies it by 1000) while
   * `durationMs` is milliseconds. Adding them raw stretched every bar ~1000×,
   * which made all 224 calls of one session overlap and reported "max 224 in
   * flight" — a unit bug wearing the costume of a finding.
   */
  function reqSpanMs(r) {
    var from = (r.ts || 0) * 1000;
    return { from: from, to: from + Math.max(0, r.durationMs || 0) };
  }

  /** Ribbon height budget in px; past it the lanes scroll rather than grow. */
  var RIBBON_H = 104;

  /**
   * The time ribbon: every call on a real wall-clock axis, drag to select.
   *
   * The turn spine orders by `seq`, which on a session that runs a fleet is not
   * time order at all — 87 of 223 adjacent pairs ran backwards on the capture
   * that motivated this. So the spine can show you WHAT ran but never WHEN, or
   * what ran alongside it. This is the view that answers both, and the brush
   * over it is the filter that carries the answer back into the spine.
   *
   * Height is bounded by dividing RIBBON_H among however many lanes the packer
   * needs, rather than by capping the lane count: a 30-way fan-out renders as
   * 30 thin lanes, which is honest, instead of 12 lanes that quietly imply
   * calls were sequential when they were not.
   */
  function timeRibbonHtml(turns) {
    var items = turns.map(function (t) {
      return reqSpanMs(t.req);
    });
    var t0 = Infinity;
    var t1 = -Infinity;
    items.forEach(function (it) {
      if (it.from < t0) t0 = it.from;
      if (it.to > t1) t1 = it.to;
    });
    if (!isFinite(t0)) return "";
    // A session whose calls all share one timestamp has no axis to draw on.
    // Say so rather than dividing by zero and painting 18 full-width bars.
    var span = t1 - t0;
    if (span <= 0) {
      return '<div class="ribbon-note dim">No time span recorded for these ' +
        turns.length + " calls — range selection unavailable.</div>";
    }
    var lanes = packLanes(items);
    var laneCount = Math.max.apply(null, lanes) + 1;
    var laneH = Math.max(2, Math.min(11, Math.floor(RIBBON_H / laneCount)));

    var bars = turns
      .map(function (t, i) {
        var it = items[i];
        return (
          '<span class="ribbon-bar' + (t.req.isSubagent ? " sub" : "") +
          '" data-ribbon-seq="' + t.seq + '"' +
          ' data-from="' + it.from + '" data-to="' + it.to + '"' +
          ' title="#' + t.seq + " · " + esc(t.agent) + " · " +
          esc(fmtDur(t.req.durationMs)) + '"' +
          ' style="left:' + (((it.from - t0) / span) * 100).toFixed(3) + "%;width:" +
          (((it.to - it.from) / span) * 100).toFixed(3) + "%;top:" +
          lanes[i] * laneH + "px;height:" + Math.max(2, laneH - 1) + 'px"></span>'
        );
      })
      .join("");

    return (
      // `.ribbon` caps the visible height and scrolls; `.ribbon-lanes` is the
      // full-height content, so the budget is enforced instead of merely
      // intended — a `Math.max(2, …)` floor on lane height silently blew past
      // it at 224 lanes and rendered a 448px strip.
      '<div class="ribbon" id="ribbon" data-t0="' + t0 + '" data-t1="' + t1 + '">' +
      '<div class="ribbon-lanes" style="height:' + laneCount * laneH + 'px">' +
      bars +
      // The grips are children of the band so they travel with it for free, and
      // they carry `data-grip` so the drag handler can tell "resize this edge"
      // from "draw a new window" without a hit-test against pixel coordinates.
      '<span class="ribbon-sel" hidden>' +
      '<span class="ribbon-grip" data-grip="from"></span>' +
      '<span class="ribbon-grip" data-grip="to"></span>' +
      "</span>" +
      "</div></div>" +
      // Shares the ribbon's t0/span, so it is the SAME x-axis — a context cliff
      // sits directly under the call that caused it. Registered rather than
      // inlined because it is laid out at its measured width (see `fitChart`).
      '<div class="ctx-strip" id="ctx-strip"></div>' +
      '<div class="ribbon-axis"><span>0s</span><span>' +
      esc(fmtDur(span / 2)) + "</span><span>" + esc(fmtDur(span)) + "</span></div>" +
      // "first start → last finish", spelled out because it does NOT match the
      // header's duration: the session's `ended_at` is the last call's START,
      // so a long final call puts the two legitimately minutes apart.
      '<div class="ribbon-note" id="ribbon-note">' +
      turns.length + (turns.length === 1 ? " call" : " calls") +
      " · first start → last finish " + esc(fmtDur(span)) + " · max " +
      laneCount + " in flight · drag to select a window</div>"
    );
  }

  function ctxOf(r) {
    return (r.promptTokens || 0) + (r.cacheRead || 0) + (r.cacheCreation || 0);
  }

  /**
   * What is worth LOOKING at in this session.
   *
   * A 258-row spine is a haystack with no needle marked. These are the needles:
   * each one names a specific turn, says what is unusual about it in the units
   * that matter (tokens, seconds, dollars-by-proxy), and is clickable, so
   * "something is wrong here" turns into "go look at turn 47".
   *
   * Deliberately a small fixed set of RULES rather than a model: every entry
   * has to be defensible from the numbers on the row, because an insight you
   * cannot check is worse than no insight.
   */
  function sessionInsights(turns) {
    var out = [];
    if (!turns.length) return out;

    function push(kind, label, detail, seq, sev) {
      out.push({ kind: kind, label: label, detail: detail, seq: seq, sev: sev || "info" });
    }

    // Compactions — the single most consequential thing that happens to a
    // session, and the one you cannot see from any single row. Collapsed into
    // ONE entry: a session with 13 of them emitted 13 near-identical chips and
    // pushed every other kind of insight off the first row, which is the exact
    // failure this strip exists to prevent.
    var comps = [];
    turns.forEach(function (t) {
      t.events.forEach(function (e) {
        if (e.kind === "compaction") comps.push({ t: t, e: e });
      });
    });
    if (comps.length) {
      var dropped = 0;
      comps.forEach(function (c) {
        dropped += c.e.n || 0;
      });
      push(
        "compaction",
        comps.length + (comps.length === 1 ? " compaction" : " compactions"),
        dropped + " transcript items dropped · first at turn " + comps[0].t.seq +
          (comps.length > 1 ? ", last at turn " + comps[comps.length - 1].t.seq : ""),
        comps[0].t.seq,
        "warn",
      );
    }

    // Errors, which are cheap to miss in a wall of rows.
    var errs = turns.filter(function (t) {
      return t.req.errored;
    });
    if (errs.length) {
      push(
        "error",
        errs.length + (errs.length === 1 ? " failed call" : " failed calls"),
        "first at turn " + errs[0].seq +
          (errs[0].req.status ? " · HTTP " + errs[0].req.status : " · no response"),
        errs[0].seq,
        "bad",
      );
    }

    // Cache rebuilds. Cache WRITE bills 1.25x fresh input and cache READ ~0.1x,
    // so a turn that re-writes most of its context costs roughly 12x the same
    // context served from cache. This is the most expensive recurring mistake a
    // session can make and it is invisible in a "context tokens" column.
    var rebuilds = turns.filter(function (t) {
      var c = ctxOf(t.req);
      return c > 20000 && (t.req.cacheCreation || 0) / c > 0.5;
    });
    if (rebuilds.length) {
      var wasted = 0;
      rebuilds.forEach(function (t) {
        wasted += t.req.cacheCreation || 0;
      });
      push(
        "cache",
        rebuilds.length + " cache rebuild" + (rebuilds.length === 1 ? "" : "s"),
        fmtTok(wasted) + " tokens written at 1.25x instead of read at 0.1x · first at turn " +
          rebuilds[0].seq,
        rebuilds[0].seq,
        "warn",
      );
    }

    // Slowest call, but only when it is an OUTLIER — "the slowest of 145" is
    // trivially true of some turn and is not information. 3x the median is.
    var durs = turns
      .map(function (t) {
        return t.req.durationMs || 0;
      })
      .filter(function (d) {
        return d > 0;
      })
      .sort(function (a, b) {
        return a - b;
      });
    if (durs.length > 4) {
      var med = durs[Math.floor(durs.length / 2)];
      var slowest = turns.reduce(function (a, b) {
        return (b.req.durationMs || 0) > (a.req.durationMs || 0) ? b : a;
      });
      if (med > 0 && (slowest.req.durationMs || 0) > med * 3) {
        push(
          "slow",
          "Turn " + slowest.seq + " took " + fmtDur(slowest.req.durationMs),
          Math.round((slowest.req.durationMs || 0) / med) + "x the median call (" +
            fmtDur(med) + ")",
          slowest.seq,
          "warn",
        );
      }
    }

    // Largest single jump in context. Where a session got expensive, there is
    // usually one turn where something big was pasted in.
    var jump = null;
    for (var i = 1; i < turns.length; i++) {
      var d = ctxOf(turns[i].req) - ctxOf(turns[i - 1].req);
      if (!jump || d > jump.d) jump = { d: d, t: turns[i] };
    }
    if (jump && jump.d > 20000) {
      push(
        "growth",
        "Context jumped " + fmtTok(jump.d) + " at turn " + jump.t.seq,
        "to " + fmtTok(ctxOf(jump.t.req)) + " · every later call pays for this",
        jump.t.seq,
        "warn",
      );
    }

    // Busiest turn, as a place to look rather than as a problem.
    var busiest = turns.reduce(function (a, b) {
      return b.events.length > a.events.length ? b : a;
    });
    if (busiest.events.length >= 5) {
      push(
        "busy",
        "Turn " + busiest.seq + " fired " + busiest.events.length + " events",
        "the densest turn in the session",
        busiest.seq,
        "info",
      );
    }

    // Hooks that fired outside every turn's span. Previously these were silently
    // swept onto the last turn; a hook we cannot place is a fact about the
    // capture, and hiding it inside a turn makes that turn a lie.
    var attributed = 0;
    turns.forEach(function (t) {
      t.events.forEach(function (e) {
        if (e.kind === "hook") attributed++;
      });
    });
    var totalHooks = (hooksForPane || []).length;
    if (totalHooks && totalHooks - attributed > 0) {
      var orphan = totalHooks - attributed;
      push(
        "hooks",
        orphan + " of " + totalHooks + " hooks fired outside any call",
        "before the first request or after the last — not attributable to a turn",
        turns[turns.length - 1].seq,
        "info",
      );
    }

    // Peak context, always — it is the ceiling the session ran against.
    var peak = turns.reduce(function (a, b) {
      return ctxOf(b.req) > ctxOf(a.req) ? b : a;
    });
    push(
      "peak",
      "Peak context " + fmtTok(ctxOf(peak.req)) + " at turn " + peak.seq,
      peak.req.model || "",
      peak.seq,
      "info",
    );

    return out;
  }

  var CTX_STRIP_H = 54;

  /**
   * Context over wall-clock, stacked by where the context came from.
   *
   * Two questions the spine could not answer at a glance, both about the SHAPE
   * of a session rather than any one call: how the context grew, and how much
   * of it was being paid for fresh. Stacking cache read / cache write / fresh
   * input answers them together, because the total height IS the context size
   * and the bands are its cost breakdown — a compaction reads as a cliff, and a
   * cache rebuild reads as an amber wedge immediately after it.
   *
   * It shares `t0`/`span` with the ribbon directly above, so the two are the
   * same axis and a cliff sits under the call that caused it.
   *
   * Sampled at call START. Calls overlap, so no single instant has one true
   * context size; the start is the value the request was actually sent with.
   */
  function contextStripHtml(turns, t0, span, W) {
    var H = CTX_STRIP_H;
    var pts = turns
      .map(function (t) {
        var r = t.req;
        return {
          x: ((r.ts * 1000 - t0) / span) * W,
          read: r.cacheRead || 0,
          write: r.cacheCreation || 0,
          fresh: r.promptTokens || 0,
        };
      })
      .sort(function (a, b) {
        return a.x - b.x;
      });
    if (!pts.length) return "";
    var max = 0;
    pts.forEach(function (p) {
      var tot = p.read + p.write + p.fresh;
      if (tot > max) max = tot;
    });
    if (max <= 0) return "";

    // Bands are cumulative, drawn back-to-front, so each polygon is the area
    // under a running total rather than a floating ribbon that has to be closed
    // along a second edge.
    function band(keys, cls) {
      var top = pts.map(function (p) {
        var v = 0;
        keys.forEach(function (k) {
          v += p[k];
        });
        return p.x.toFixed(1) + "," + (H - (v / max) * (H - 2)).toFixed(1);
      });
      return (
        '<polygon class="' + cls + '" points="' +
        pts[0].x.toFixed(1) + "," + H + " " + top.join(" ") + " " +
        pts[pts.length - 1].x.toFixed(1) + "," + H + '"></polygon>'
      );
    }

    return (
      '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">' +
      band(["read", "write", "fresh"], "ctx-fresh") +
      band(["read", "write"], "ctx-write") +
      band(["read"], "ctx-read") +
      "</svg>" +
      '<div class="ctx-strip-note dim">context over time · peak ' +
      fmtTok(max) + " · stacked by provenance</div>"
    );
  }

  /**
   * The Compactions card, preferring the measurement over the guess.
   *
   * Two provenances, never merged. `recorded` is Claude Code's own
   * `compact_boundary` records — exact pre/post sizes and, uniquely, WHY it
   * happened. `inferred` is our wire-side detector, which measured 75% false
   * positives against the live index and cannot recover the trigger at all.
   *
   * The recorded set is scoped to the whole Claude Code session, not to this
   * system-prompt group, so the card says so. It is suppressed on subagent-only
   * groups: a subagent's context is not what got compacted.
   */
  /**
   * One sentence about compactions, from whichever provenance is authoritative.
   *
   * The card and the X-Ray heading were computing this independently — the card
   * from Claude Code's recorded `compact_boundary` entries, the heading from
   * our wire-side detector — so a session with one recorded auto-compaction
   * displayed "1 · 1 auto" and "0 compaction(s)" on the same screen. Two
   * numbers on one screen both labelled "compaction" and disagreeing is a bug
   * whether or not either is right.
   *
   * The recorded set wins where it exists, and says out loud that it is scoped
   * to the whole Claude Code session rather than to these calls — that is WHY
   * it can disagree with a per-call count, and hiding the reason would just
   * move the confusion rather than remove it. `records: []` means UNKNOWN, not
   * zero, so it falls through to the inferred count labelled as inferred.
   */
  function compactionPhrase(inferredCount, recorded) {
    var recs = (recorded && recorded.records) || [];
    if (!recs.length || (recorded && recorded.subagentOnly)) {
      return inferredCount + " compaction(s) inferred here";
    }
    return (
      recs.length + " compaction" + (recs.length === 1 ? "" : "s") +
      " recorded session-wide (not attributable to a single call)"
    );
  }

  function compactionCard(inferred, recorded) {
    var recs = (recorded && recorded.records) || [];
    if (!recs.length || (recorded && recorded.subagentOnly)) {
      return card(
        "Compactions",
        inferred.length + ' <small class="dim">inferred</small>',
        inferred.length > 0,
      );
    }
    var byTrigger = {};
    var dropped = 0;
    recs.forEach(function (r) {
      byTrigger[r.trigger] = (byTrigger[r.trigger] || 0) + 1;
      dropped += r.droppedTokens || 0;
    });
    var mix = Object.keys(byTrigger)
      .sort()
      .map(function (k) {
        return byTrigger[k] + " " + k;
      })
      .join(" · ");
    return card(
      "Compactions",
      recs.length +
        ' <small class="dim">' + esc(mix) + "</small>" +
        '<div class="card-sub">' + fmtTok(dropped) + " dropped · session-wide</div>",
      recs.length > 0,
    );
  }

  /**
   * The context bar, split by where the context CAME FROM.
   *
   * One accent bar told you how big the context was; it could not tell you what
   * it cost, and cost is the whole question. Cache-read tokens bill at a tenth
   * of fresh input and cache-write at 1.25×, so two rows of identical width can
   * differ ~12× in price. Segmenting the same bar by provenance turns the spine
   * into the caching timeline without spending a second chart or a second row:
   * a session that is caching well reads as one long dim band, and a wall of
   * bright segments is money being re-sent.
   *
   * Widths are shares of `maxCtx` — the session's largest context — so segments
   * are comparable ACROSS rows, not just within one.
   */
  function contextBarHtml(r, maxCtx) {
    var parts = [
      { cls: "seg-read", v: r.cacheRead || 0, name: "cache read" },
      { cls: "seg-write", v: r.cacheCreation || 0, name: "cache write" },
      { cls: "seg-fresh", v: r.promptTokens || 0, name: "fresh input" },
    ];
    var tip = parts
      .map(function (p) {
        return p.name + " " + fmtTok(p.v);
      })
      .join(" · ");
    return (
      '<span class="turn-bar" title="' + esc(tip) + '">' +
      parts
        .map(function (p) {
          if (!p.v) return "";
          return (
            '<span class="' + p.cls + '" style="width:' +
            ((p.v / maxCtx) * 100).toFixed(2) + '%"></span>'
          );
        })
        .join("") +
      "</span>"
    );
  }

  /**
   * The journey: one session as a scrubbable strip, one turn as an anatomy.
   *
   * The spine answers "what happened, in order". It does not answer "what
   * SHAPE was this session" or "what actually happened inside turn 47", and
   * scrolling a 258-row table answers neither. So the journey splits those two
   * questions onto two axes:
   *
   *   ACROSS — a wide strip, one column per turn, left to right. Column height
   *   is context size and its fill is the cache-read / cache-write / fresh
   *   split, so the session's cost profile is a silhouette you read in one look
   *   rather than a column you scan.
   *
   *   DOWN — the focused turn, opened up as what an LLM turn actually IS:
   *   something came IN (a prompt, or the results of the last turn's tools),
   *   the model did something with it, and something went OUT (text, or the
   *   next tool calls, which become the next turn's input). The loop is drawn
   *   because the loop is the point — output feeds the next turn's input.
   */
  var JOURNEY_H = 132;

  function journeyHtml(turns) {
    if (!turns.length) return '<div class="dim">No wire data for this session.</div>';
    var maxCtx = 1;
    turns.forEach(function (t) {
      var c = ctxOf(t.req);
      if (c > maxCtx) maxCtx = c;
    });
    var maxDur = 1;
    turns.forEach(function (t) {
      if ((t.req.durationMs || 0) > maxDur) maxDur = t.req.durationMs || 0;
    });

    var insights = sessionInsights(turns);
    var flagged = {};
    insights.forEach(function (n) {
      if (n.sev !== "info") flagged[n.seq] = n.kind;
    });

    var cols = turns
      .map(function (t) {
        var r = t.req;
        var c = ctxOf(r);
        var h = Math.max(3, (c / maxCtx) * (JOURNEY_H - 22));
        function seg(v, cls) {
          return v ? '<i class="' + cls + '" style="height:' + ((v / c) * 100).toFixed(2) + '%"></i>' : "";
        }
        return (
          '<button type="button" class="jr-col' +
          (flagged[t.seq] ? " flag flag-" + flagged[t.seq] : "") +
          (r.errored ? " err" : "") +
          '" data-jr="' + t.seq + '" title="turn ' + t.seq + " · " +
          esc(fmtTok(c)) + " ctx · " + esc(fmtDur(r.durationMs)) + '">' +
          '<span class="jr-stack" style="height:' + h.toFixed(1) + 'px">' +
          seg(r.cacheRead || 0, "seg-read") +
          seg(r.cacheCreation || 0, "seg-write") +
          seg(r.promptTokens || 0, "seg-fresh") +
          "</span>" +
          '<span class="jr-dur" style="height:' +
          Math.max(1, ((r.durationMs || 0) / maxDur) * 12).toFixed(1) + 'px"></span>' +
          "</button>"
        );
      })
      .join("");

    var chips = insights
      .map(function (n) {
        return (
          '<button type="button" class="jr-insight sev-' + n.sev +
          '" data-jr="' + n.seq + '">' +
          '<span class="jr-i-label">' + esc(n.label) + "</span>" +
          '<span class="jr-i-detail">' + esc(n.detail) + "</span>" +
          "</button>"
        );
      })
      .join("");

    return (
      '<h2 class="sec">Worth looking at <small>(' + insights.length +
      " · click to jump)</small></h2>" +
      '<div class="jr-insights">' + chips + "</div>" +
      '<h2 class="sec">Journey <small>(' + turns.length +
      " turns · drag or ←→ to scrub · height is context, fill is cache split)</small></h2>" +
      '<div class="jr-strip" id="jr-strip" style="height:' + JOURNEY_H + 'px">' +
      cols + "</div>" +
      '<input class="jr-range" id="jr-range" type="range" min="0" max="' +
      (turns.length - 1) + '" value="0" step="1" aria-label="Scrub turns">' +
      '<div class="jr-detail" id="jr-detail"></div>'
    );
  }

  /** The focused turn, opened up: what came in, what ran, what went out. */
  function journeyDetailHtml(t, idx, total) {
    var r = t.req;
    var c = ctxOf(r);
    function col(cls, head, body) {
      return '<div class="jr-cell ' + cls + '"><div class="jr-head">' + head +
        "</div>" + body + "</div>";
    }
    function kv(k, v) {
      return '<div class="jr-kv"><span>' + esc(k) + "</span><b>" + v + "</b></div>";
    }

    // What triggered THIS call. For every turn after the first tool call that
    // is the previous turn's tool RESULTS — which is the loop the panel draws —
    // and only at the start of a run is it a user prompt. Showing the nearest
    // preceding user prompt unconditionally is why this panel looked frozen
    // while scrubbing: one prompt is shared by a whole run of turns.
    var prevTurn = idx > 0 ? turnsForPane[idx - 1] : null;
    var fedBack = prevTurn && prevTurn.step
      ? String(prevTurn.step.observation || "")
      : "";
    var inKind, inText;
    if (fedBack.trim()) {
      inKind = "tool results from turn " + prevTurn.seq;
      inText = fedBack;
    } else {
      inKind = t.prompt ? "prompt · transcript step " + t.prompt.stepIndex : "";
      inText = stepText(t.prompt);
    }
    var inBody =
      kv("transcript", r.transcriptItems + " items") +
      kv("context", fmtTok(c)) +
      (inKind ? '<div class="jr-src">' + esc(inKind) + "</div>" : "") +
      '<div class="jr-quote">' +
      (inText
        ? esc(clip(inText, 4000))
        : '<span class="dim">no input text indexed for this turn</span>') +
      "</div>";

    var hooks = t.events.filter(function (e) {
      return e.kind === "hook";
    });
    var midBody =
      kv("model", esc(r.model || "—")) +
      kv("duration", esc(fmtDur(r.durationMs))) +
      kv("first token", esc(r.ttftMs == null ? "—" : fmtDur(r.ttftMs))) +
      kv("cache read", fmtTok(r.cacheRead) + ' <em class="seg-read-t">0.1x</em>') +
      kv("cache write", fmtTok(r.cacheCreation) + ' <em class="seg-write-t">1.25x</em>') +
      kv("fresh input", fmtTok(r.promptTokens) + ' <em class="seg-fresh-t">1x</em>') +
      (hooks.length ? kv("hooks fired", hooks.length) : "");

    var tools = t.events.filter(function (e) {
      return e.kind === "tool";
    });
    var said = t.step ? stepText(t.step) : "";
    var outBody =
      kv("output", fmtTok(r.completionTokens) + " tokens") +
      kv("stop reason", esc(r.stopReason || "—")) +
      kv("tool calls", tools.length) +
      (tools.length
        ? '<div class="jr-tools">' +
          tools
            .map(function (e) {
              return '<div class="jr-tool">' + esc(e.label) + "</div>";
            })
            .join("") +
          "</div>"
        : "") +
      (said
        ? '<div class="jr-src">assistant text</div><div class="jr-quote">' +
          esc(clip(said, 2000)) + "</div>"
        : tools.length
          ? ""
          : '<div class="jr-quote"><span class="dim">no assistant text indexed — ' +
            "extended thinking is returned encrypted and never reaches the wire" +
            "</span></div>");

    return (
      '<div class="jr-nav">' +
      '<button type="button" class="jr-step" data-jr-step="-1" ' +
      (idx <= 0 ? "disabled" : "") + ">← prev</button>" +
      '<span class="jr-pos">turn <b>' + t.seq + "</b> · " + (idx + 1) + " of " + total +
      (r.isSubagent ? ' · <span class="turn-agent sub">' + esc(t.agent) + "</span>" : "") +
      "</span>" +
      '<button type="button" class="jr-step" data-jr-step="1" ' +
      (idx >= total - 1 ? "disabled" : "") + ">next →</button>" +
      "</div>" +
      '<div class="jr-triad">' +
      col("jr-in", "IN &mdash; what triggered it", inBody) +
      '<div class="jr-arrow">&rarr;</div>' +
      col("jr-mid", "MODEL &mdash; what it cost", midBody) +
      '<div class="jr-arrow">&rarr;</div>' +
      col("jr-out", "OUT &mdash; what it produced", outBody) +
      "</div>" +
      '<div class="jr-loop">' +
      (tools.length
        ? "↳ these results become the next turn's input"
        : "↳ the conversation continues with the user's next message") +
      "</div>" +
      '<div class="jr-below">' +
      journeyStepsHtml(t) +
      journeyContextHtml(t, prevTurn) +
      "</div>"
    );
  }

  /** Clip without collapsing whitespace — these panels want the line breaks. */
  function clip(s, max) {
    var t = String(s || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    return t.length <= max ? t : t.slice(0, max) + "\n… (" + fmtTok(t.length - max) + " more chars)";
  }

  /**
   * The turn's steps: every tool call with its FULL arguments, and every hook
   * that fired, with what it decided.
   *
   * The triad summarises; this is the record. A tool call whose argument is
   * elided to 34 characters cannot answer "what did it actually run", and a
   * hook shown as the number 3 cannot answer "what did they do" — which is the
   * whole reason 211 of them are captured per session.
   */
  function journeyStepsHtml(t) {
    var inputs = t.step ? String(t.step.toolInput || "").split("\n") : [];
    // Carry the ORIGINAL position with each event. `inputs` is indexed by
    // position in the UNFILTERED tool list, so filtering the array without
    // keeping the index would pair every surviving call with another call's
    // arguments — wrong, and wrong in a way that reads as correct.
    var allTools = [];
    t.events.forEach(function (e, i) {
      if (e.kind === "tool") allTools.push({ e: e, i: allTools.length });
    });
    var lane = journeyLaneFilter;
    var laneKind = lane ? LANE_STEPS[lane] : null;
    var tools = allTools.filter(function (x) {
      if (!laneKind) return true;
      if (laneKind === "skill") return /skill/i.test(x.e.label || "");
      return true;
    });
    var hooks = t.events.filter(function (e) {
      return e.kind === "hook";
    });

    var toolHtml = tools.length
      ? tools
          .map(function (x) {
            var e = x.e;
            var arg = inputs[x.i] || e.detail || "";
            var pretty = arg;
            try {
              pretty = JSON.stringify(JSON.parse(arg), null, 2);
            } catch (_) {
              /* not JSON — show it raw */
            }
            return (
              '<details class="jr-step-row"' + (tools.length === 1 ? " open" : "") + ">" +
              "<summary><span class=\"jr-badge tool\">tool</span>" +
              '<span class="jr-step-name">' + esc(e.label) + "</span></summary>" +
              '<pre class="jr-pre">' + esc(clip(pretty, 6000)) + "</pre>" +
              "</details>"
            );
          })
          .join("")
      : "";

    var obs = t.step ? String(t.step.observation || "") : "";
    var obsHtml = obs.trim()
      ? '<details class="jr-step-row"><summary><span class="jr-badge result">result</span>' +
        '<span class="jr-step-name">tool output · ' + fmtTok(obs.length) +
        " chars</span></summary>" +
        '<pre class="jr-pre">' + esc(clip(obs, 6000)) + "</pre></details>"
      : "";

    var hookHtml = hooks
      .map(function (e) {
        var h = e.hook || null;
        var meta = [];
        if (h) {
          if (h.decision) meta.push("decision " + h.decision);
          if (h.outcome) meta.push(h.outcome);
          if (h.exitCode != null) meta.push("exit " + h.exitCode);
        }
        if (e.n != null) meta.push(fmtDur(e.n));
        return (
          '<details class="jr-step-row"><summary>' +
          '<span class="jr-badge hook">hook</span>' +
          '<span class="jr-step-name">' + esc(e.label) + "</span>" +
          '<span class="jr-step-meta">' + esc(meta.join(" · ")) + "</span></summary>" +
          '<pre class="jr-pre">' + esc(clip(e.detail || "{}", 4000)) + "</pre></details>"
        );
      })
      .join("");

    var body = toolHtml + obsHtml + hookHtml;
    return (
      '<div class="jr-panel">' +
      '<div class="jr-head">STEPS &mdash; ' + tools.length + " tool call" +
      (tools.length === 1 ? "" : "s") +
      (lane && tools.length !== allTools.length ? " of " + allTools.length : "") +
      " · " + hooks.length + " hook" +
      (hooks.length === 1 ? "" : "s") + "</div>" +
      (lane
        ? '<div class="jr-filter"><span class="jr-filter-lab">filtered to</span>' +
          '<button type="button" class="jr-filter-chip" data-lane-clear="1">' +
          esc(lane) + ' <span aria-hidden="true">✕</span></button>' +
          '<span class="dim">hooks stay listed — they are what triggered these calls</span>' +
          "</div>"
        : "") +
      (body || '<div class="dim">This turn recorded no tool calls and no hooks.</div>') +
      "</div>"
    );
  }

  var BUCKET_ORDER = ["system", "tools", "skills", "user", "assistant", "tool_result"];

  // Which lanes are BACKED BY STEPS this pane can show. Only these are
  // clickable; the rest render inert rather than fake-clickable, because a
  // control that looks live and does nothing is worse than no control at all.
  var LANE_STEPS = { tools: "tool", tool_result: "tool", skills: "skill" };
  var journeyLaneFilter = null;

  /**
   * What the context is MADE OF at this turn, and what changed since the last.
   *
   * "Context: 206K" is a number you cannot act on. The composition is: 87K of
   * it is tool schemas resent on every call, 16K is the user's own words. The
   * delta column is the one that answers "what got added, and when" — scrub and
   * the rows that move are the thing that grew.
   *
   * Sourced from the timeline endpoint's char-approximation, which is why the
   * total will not equal the billed context exactly; that is stated rather than
   * silently reconciled.
   */
  function journeyContextHtml(t, prevTurn) {
    var pts = (timelineForPane && timelineForPane.points) || [];
    function bucketsFor(seq) {
      for (var i = 0; i < pts.length; i++) if (pts[i].seq === seq) return pts[i].buckets || null;
      return null;
    }
    var cur = bucketsFor(t.seq);
    if (!cur) {
      return (
        '<div class="jr-panel"><div class="jr-head">CONTEXT &mdash; composition</div>' +
        '<div class="dim">Composition is derived by the context timeline, which has ' +
        "not loaded for this session.</div></div>"
      );
    }
    var prev = prevTurn ? bucketsFor(prevTurn.seq) : null;
    // PRE / NET / POST is a TURN-LOCAL story on purpose. The timeline already
    // carries the session-since-start view, and turn-local deltas keep meaning
    // across a COMPACTION, where a since-start delta becomes nonsense: the
    // context drops by 100K and every start-relative number inverts sign at
    // once. Pre and post still read correctly through that.
    var isFirst = !prevTurn;
    var keys = BUCKET_ORDER.filter(function (k) {
      return cur[k];
    }).concat(
      Object.keys(cur).filter(function (k) {
        return BUCKET_ORDER.indexOf(k) < 0 && cur[k];
      }),
    );
    var totPost = 0;
    var totPre = 0;
    keys.forEach(function (k) {
      totPost += cur[k] || 0;
      if (prev) totPre += prev[k] || 0;
    });
    // ONE denominator for both bars. Scaling each to its own total would make a
    // lane that grew 5K look identical to one that shrank, because both would
    // redraw to the same share of their own row.
    var scale = Math.max(totPost, totPre) || 1;
    function net(d) {
      if (d == null) return '<span class="jr-bk-d">—</span>';
      var cls = d > 0 ? " up" : d < 0 ? " down" : "";
      return (
        '<span class="jr-bk-d' + cls + '">' +
        (d === 0 ? "·" : (d > 0 ? "+" : "−") + fmtTok(Math.abs(d))) +
        "</span>"
      );
    }
    function barFor(k, pre, post) {
      var prePct = (pre / scale) * 100;
      var postPct = (post / scale) * 100;
      return (
        '<span class="jr-bk-bar">' +
        '<i class="bk-pre" style="width:' + prePct.toFixed(1) + '%"></i>' +
        '<i class="bk-' + esc(k) + '" style="width:' + postPct.toFixed(1) + '%"></i>' +
        (pre ? '<u class="bk-tick" style="left:' + prePct.toFixed(1) + '%"></u>' : "") +
        "</span>"
      );
    }
    var rows = keys
      .map(function (k) {
        var post = cur[k] || 0;
        var pre = prev ? prev[k] || 0 : 0;
        var lane = LANE_STEPS[k];
        var on = journeyLaneFilter === k;
        return (
          "<button type=\"button\" class=\"jr-bk jr-bk-row" +
          (lane ? " is-lane" : "") + (on ? " on" : "") + "\"" +
          (lane ? ' data-lane="' + esc(k) + '"' : " disabled") +
          (lane ? ' aria-pressed="' + (on ? "true" : "false") + '"' : "") +
          (lane ? ' title="show only the ' + esc(k) + ' steps in this turn"' : "") +
          ">" +
          '<span class="jr-bk-name">' + esc(k) + "</span>" +
          barFor(k, pre, post) +
          '<span class="jr-bk-n pre">' + (prev ? fmtTok(pre) : "—") + "</span>" +
          net(prev ? post - pre : null) +
          '<span class="jr-bk-n">' + fmtTok(post) + "</span>" +
          "</button>"
        );
      })
      .join("");
    var totals =
      '<div class="jr-bk jr-bk-total">' +
      '<span class="jr-bk-name">total</span>' +
      barFor("total", prev ? totPre : 0, totPost) +
      '<span class="jr-bk-n pre">' + (prev ? fmtTok(totPre) : "—") + "</span>" +
      net(prev ? totPost - totPre : null) +
      '<span class="jr-bk-n">' + fmtTok(totPost) + "</span>" +
      "</div>";
    return (
      '<div class="jr-panel">' +
      '<div class="jr-head">CONTEXT &mdash; what it is made of</div>' +
      '<div class="jr-bk jr-bk-head">' +
      "<span></span><span></span>" +
      "<span>" + (isFirst ? "pre" : "pre &middot; turn " + prevTurn.seq) + "</span>" +
      "<span>net</span><span>post</span></div>" +
      rows +
      totals +
      '<div class="jr-note dim">' +
      (isFirst
        ? "This is the first turn in view, so there is no prior composition to compare against. "
        : "Pre is the composition entering this turn, post is what left it. ") +
      "Approximated from transcript characters, so the total (" +
      fmtTok(totPost) +
      ") will not match the billed context exactly." +
      "</div></div>"
    );
  }

  function turnSpineHtml(turns) {
    if (!turns.length) return '<div class="dim">No wire data for this session.</div>';
    var maxCtx = 1;
    turns.forEach(function (t) {
      var c = (t.req.promptTokens || 0) + (t.req.cacheRead || 0) + (t.req.cacheCreation || 0);
      if (c > maxCtx) maxCtx = c;
    });
    var kinds = {};
    turns.forEach(function (t) {
      t.events.forEach(function (e) {
        kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      });
    });
    var filters = Object.keys(kinds)
      .sort()
      .map(function (k) {
        return (
          '<button type="button" class="turn-filter" data-turn-filter="' +
          esc(k) +
          '" aria-pressed="false">' +
          esc(k) +
          " <small>" +
          kinds[k] +
          "</small></button>"
        );
      })
      .join("");

    // Repeat suppression. A workflow fan-out is dozens of calls that genuinely
    // share one prompt, and printing it on all of them is honest but hides the
    // rows that DIFFER inside a wall of identical sentences. Ditto marks turn
    // that wall into visible structure: a run reads as one block, and the row
    // where the work changes is the only one carrying text.
    //
    // The full text stays in `title`, because a filter can hide the row a ditto
    // refers back to and hovering must still answer "same as what?".
    var prevSummary = null;
    var distinct = {};
    turns.forEach(function (t) {
      if (t.summary) distinct[t.summary] = 1;
    });
    // A spine of nothing but ditto marks is a true statement about the index,
    // not a rendering failure — some sessions (permission-hook fan-outs) record
    // one shared instruction and an empty placeholder for every response. Say
    // that in words once, rather than letting 257 repeat marks imply a bug.
    var isUniform = turns.length > 3 && Object.keys(distinct).length <= 1;
    var uniform = isUniform
      ? '<div class="ribbon-note dim">No per-call transcript content indexed for ' +
        "this session — all " + turns.length +
        " calls share one prompt and record no response text. Rows are still " +
        "distinguished by context size, duration and events.</div>"
      : "";
    var rows = turns
      .map(function (t) {
        var repeat = t.summary !== "" && t.summary === prevSummary;
        prevSummary = t.summary;
        var ctx = (t.req.promptTokens || 0) + (t.req.cacheRead || 0) + (t.req.cacheCreation || 0);
        var evHtml = t.events
          .map(function (e, j) {
            return (
              '<div class="turn-ev ev-' + esc(e.kind) + '" data-ev-kind="' + esc(e.kind) +
              '" data-inspect="ev:' + t.seq + ":" + j + '" tabindex="0">' +
              '<span class="ev-kind">' + esc(e.kind) + "</span>" +
              '<span class="ev-label">' + esc(e.label) + "</span>" +
              '<span class="ev-n">' + (e.n == null ? "" : esc(String(e.n))) + "</span>" +
              "</div>"
            );
          })
          .join("");
        var span = reqSpanMs(t.req);
        return (
          // The window predicate reads these off the DOM rather than a parallel
          // array, so a re-render can never leave the two out of step.
          '<div class="turn" data-turn="' + t.seq + '" data-from="' + span.from +
          '" data-to="' + span.to + '">' +
          '<div class="turn-row" data-inspect="ctp:' + t.seq + '" tabindex="0">' +
          '<span class="turn-caret" data-expand="' + t.seq + '">' +
          (t.events.length ? "\u25b8" : "\u00b7") +
          "</span>" +
          '<span class="turn-seq">' + t.seq + "</span>" +
          '<span class="turn-what">' +
          (t.req.isSubagent
            ? '<span class="turn-agent sub">' + esc(t.agent) + "</span>"
            : "") +
          '<span class="turn-sum' + (repeat ? " ditto" : "") + '" title="' +
          esc(t.summary) + '">' +
          (repeat ? "〃" : esc(t.summary || "—")) + "</span>" +
          "</span>" +
          contextBarHtml(t.req, maxCtx) +
          '<span class="turn-ctx">' + fmtTok(ctx) + "</span>" +
          '<span class="turn-dur">' + fmtDur(t.req.durationMs) + "</span>" +
          '<span class="turn-evn">' +
          (t.events.length ? t.events.length + " ev" : "") + "</span>" +
          "</div>" +
          '<div class="turn-events" hidden>' + evHtml + "</div>" +
          "</div>"
        );
      })
      .join("");

    return (
      '<h2 class="sec">Turns <small>(' + turns.length +
      " · \u2191\u2193 move · \u2192 expand · \u2190 collapse · click for detail)</small></h2>" +
      timeRibbonHtml(turns) +
      uniform +
      '<div class="turn-filters">' + filters +
      '<span class="turn-legend">' +
      '<i class="seg-read"></i>cache read<i class="seg-write"></i>cache write' +
      '<i class="seg-fresh"></i>fresh input</span>' +
      "</div>" +
      // The header is a `.turn-row` so it inherits the grid verbatim — a second
      // template would drift out of alignment the first time a column changed.
      // The header lives INSIDE the scroll container and sticks. Outside it, the
      // rows were narrower by the scrollbar width while the header was not, and
      // since the shared grid is `ch`-and-fr the difference landed entirely on
      // the elastic column — 10px of drift by the right-hand numerics.
      // When every row's summary is the same one, the "what" column holds a
      // ditto mark 257 times in 938px — 62% of the spine spent saying "same as
      // above". The note above already says it once in words, so the column is
      // dropped and its width goes to the context bar, which is the thing that
      // still differs row to row and gains resolution from every pixel.
      '<div class="turn-spine' + (isUniform ? " spine-uniform" : "") + '" id="turn-spine">' +
      '<div class="turn-body">' +
      '<div class="turn-row turn-head" aria-hidden="true">' +
      "<span></span><span>#</span><span>what</span><span>context</span>" +
      "<span>tok</span><span>dur</span><span>ev</span></div>" +
      rows + "</div></div>"
    );
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
    { key: "title", label: "Session" },
    { key: "project_cwd", label: "Project", sortable: true },
    { key: "started_at", label: "Started", sortable: true },
    { key: "duration_ms", label: "Duration", sortable: true, num: true },
    { key: "turns", label: "Turns", num: true },
    { key: "agents", label: "Agents", num: true },
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
      '<input id="f-agent" class="filter" type="text" placeholder="agent name or type" value="' +
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
          '<td class="s-title"><span class="s-ask">' +
          esc(s.title || "untitled session") +
          '</span><span class="s-meta">' +
          esc(s.model || "—") +
          "</span></td>" +
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
          castCell(s) +
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
    current = { name: "session", arg: id, pane: pane || "journey" };
    setView(skeleton({ cards: 8, rows: 6 }));
    fetchJSON("/api/session/" + encodeURIComponent(id))
      .then(function (data) {
        if (current.name !== "session" || current.arg !== id) return;
        drawSession(data, stepN, current.pane || "journey");
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
    stepsForPane = steps;
    var compactSeqs = {};
    var compactionList = data.compactions || [];
    compactionList.forEach(function (c) {
      compactSeqs[c.seq] = c;
    });
    // AFTER compactSeqs is populated: a turn needs to know whether it compacted,
    // and building it a few lines earlier read an empty (hoisted) object.
    turnsForPane = buildTurns(reqs, hooks, steps, compactSeqs);
    // The brush window is absolute epoch ms, so it is meaningless against a
    // different session's ribbon. Drop it with the render that produced it.
    turnRange = null;

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
      compactionCard(compactionList, data.recordedCompactions);
    recordedForPane = data.recordedCompactions || null;

    var pane = initialPane || "journey";
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
      // The ask is the session's IDENTITY; the model and project are properties
      // of it. Titling by model gave nine consecutive headers reading
      // "claude-opus-5 · eMachina" with nothing to tell them apart.
      '<div class="detail-head"><h1>' +
      esc(s.title || "untitled session") +
      "</h1>" +
      '<span class="dim">' +
      agentPill(s.agent) + " " + esc(s.model) + " · " +
      esc(s.projectCwd) +
      " · " +
      fmtTime(s.startedAt) +
      "</span>" +
      // WHO ran, by name. The `claude` pill above is the harness family and is
      // the same on every session ever captured; the names that actually differ
      // are the ones each parent gave the agents it spawned, and they were
      // reachable only in the Related pane, two clicks down.
      //
      // This matters most on the sessions that ARE a fan-out: grouping is by
      // system prompt, so subagent traffic forms its own session, and one of
      // them held six differently-named agents under a header that said
      // "claude" and nothing else.
      castLineHtml(s) +
      '<span class="actions">' +
      (data.reportAvailable
        ? '<a href="/report?session=' +
          encodeURIComponent(s.sessionId) +
          '" target="_blank" rel="noopener">wire report ↗</a>'
        : "") +
      // The system prompt used to be reachable only as 8 characters of hash
      // inside a hover tooltip — you could see that a prompt existed but never
      // read it without hunting the Prompts tab by eye.
      (reqs.length && reqs[0].promptHash
        ? ' <a class="head-link" href="#prompt/' +
          esc(reqs[0].promptHash) +
          '">system prompt ↗</a>'
        : "") +
      // The ASK. It was in the transcript all along, buried some way down the
      // steps list behind system-reminder scaffolding, so the one thing you
      // most want when opening a session — what was this run even asked to
      // do — took the most scrolling to find.
      (initialUserStep(steps) != null
        ? ' <button type="button" class="head-link" data-inspect="ask:0">' +
          "user prompt</button>"
        : "") +
      "</span></div>" +
      // The cards, the tabs and the panes are ONE content column, so they share
      // a right edge whether or not the inspector rail is open. Leaving them
      // outside gave a 1942px card row above a 1528px ribbon — a block edge
      // 414px past the block below it, which is what reads as broken.
      //
      // The title block above stays full-width on purpose: it is the page
      // header, and narrowing it would re-wrap a 120-character title and push
      // the row you just clicked down the page.
      '<div class="session-body' + (pane === "journey" ? " no-inspector" : "") + '">' +
      '<div class="session-main">' +
      '<div class="cards">' +
      cards +
      "</div>" +
      sectionErrorBanner(data.sectionErrors) +
      '<nav class="session-subnav" id="session-subnav">' +
      subnavBtn("journey", "Journey") +
      subnavBtn("flow", "Flow") +
      subnavBtn("hooks", "Hooks", signalHooks(hooks).length) +
      subnavBtn("xray", "Context X-Ray") +
      subnavBtn("tools", "Tool Tax") +
      subnavBtn("wire", "Wire") +
      subnavBtn("related", "Related", siblings.length || null) +
      "</nav>" +
      '<div class="session-panes">' +
      '<section class="session-pane' +
      (pane === "journey" ? " active" : "") +
      '" id="pane-journey">' +
      journeyHtml(turnsForPane) +
      "</section>" +
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
      // The spine REPLACES what used to sit here rather than sitting above it:
      // FIG.1 (transcript items per call), FIG.2 (token flow per call) and the
      // request waterfall were three renderings of the same 18 calls, and
      // adding a fourth is not consolidation. Every number they carried is on
      // a spine row or one click into the inspector — context read, duration,
      // compaction, and the cache read/write/fresh/output split.
      //
      // What genuinely died with the waterfall is TIME OVERLAP: it was the only
      // view showing calls running concurrently. That returns with the range
      // selector, which needs a time axis anyway.
      turnSpineHtml(turnsForPane) +
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
      "</div>" + // .session-panes
      "</div>" + // .session-main
      // One inspector for all five panes. It lives beside `.session-panes`
      // rather than inside any one of them, which is the whole point: a panel
      // owned by the Flow pane can only ever serve the Flow pane.
      '<aside class="inspector" id="inspector">' +
      INSPECTOR_EMPTY +
      "</aside>" +
      "</div>";
    setView(html);
    // After `setView`, because the strip is laid out at its measured width and
    // reads t0/span back off the ribbon it must align with — one source for the
    // axis, so the two can never drift apart.
    var rib = document.getElementById("ribbon");
    if (rib) {
      var stripT0 = +rib.getAttribute("data-t0");
      var stripSpan = +rib.getAttribute("data-t1") - stripT0 || 1;
      registerChart("ctx-strip", function (w) {
        return contextStripHtml(turnsForPane, stripT0, stripSpan, w);
      });
    }
    // The journey opens on turn 0 rather than on an empty detail panel: the
    // pane should show a worked example of what it is before you touch it.
    setJourney(0);
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
    // Session-scoped selections (the ask, rendered in the header) belong to no
    // pane and are valid in all of them. Only evict something that lives in a
    // DIFFERENT pane, not something that lives outside panes entirely.
    var anywhere = document.querySelector('[data-inspect="' + cssEscape(id) + '"]');
    if (anywhere && !anywhere.closest(".session-pane")) return;
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
    // Land on the SAME CALL in the pane you just switched to. `reselectInPane`
    // was written for exactly this and was never called from anywhere, so the
    // selection only ever crossed panes via the LEFT/RIGHT keys — clicking a
    // tab dropped it and left you at the top of a 258-row list. It prefers the
    // shared turn over the pane's remembered cursor, which is what "the same
    // thing, another view" has to mean.
    reselectInPane(false);
    var body = document.querySelector(".session-body");
    if (body) body.classList.toggle("no-inspector", name === "journey");
    // A hidden pane measures 0 wide, so a chart registered while it was down
    // could never lay itself out. Re-fit on the way up; `fitChart` no-ops when
    // the width is unchanged, so this costs nothing on repeat visits.
    fitCharts();
  }

  function bindSessionPanes(sessionId, reqs) {
    // The subnav and the header's cast chips are two different containers that
    // both switch panes, so the listener is bound to each rather than to the
    // subnav alone — a chip outside #session-subnav would otherwise be inert.
    ["session-subnav", "detail-head"].forEach(function (sel) {
      var host =
        document.getElementById(sel) || document.querySelector("." + sel);
      if (!host) return;
      host.addEventListener("click", function (e) {
        var a = e.target.closest("[data-pane]");
        if (!a) return;
        e.preventDefault();
        activatePane(a.getAttribute("data-pane"));
      });
    });
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
        // A `ctp:` row IS an API call, and which call you are looking at is a
        // property of the SESSION, not of the pane you happen to be in. Set in
        // the one place every selection passes through — a mouse click, a
        // keypress and an arrow key all arrive here — so no caller has to
        // remember to keep the cross-pane cursor in step.
        if (type === "ctp") {
          var n = Number(id.slice(4));
          if (Number.isFinite(n)) selectedSeq = n;
        }
        if (type === "flow") inspectFlowNode(el, sessionId);
        else if (type === "seg") inspectSegment(id);
        else if (type === "hook") inspectHook(id);
        else if (type === "ctp") inspectTimelinePoint(id);
        else if (type === "tool") inspectTool(id);
        else if (type === "prov") inspectProvider(id);
        else if (type === "ask") inspectAsk();
        else if (type === "ev") inspectTurnEvent(id);
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
    /**
     * The point for a turn, from whichever source has it.
     *
     * The spine and the X-Ray draw from DIFFERENT fetches: rows come from
     * `/api/session/<id>` (every request, always loaded) while points come from
     * `/api/session/<id>/timeline`, which is only fetched when the X-Ray pane is
     * opened. Resolving a row click against the points ALONE left every row in
     * the spine inert until you happened to visit X-Ray first — the row kept its
     * pointer cursor, kept its selected style, and did nothing.
     *
     * So the point is preferred (it alone carries the composition buckets and
     * the char approximation) and the request is the fallback — never the other
     * way round, and with no third branch that silently returns.
     */
    function timelinePointFor(seq) {
      var pts = (timelineForPane && timelineForPane.points) || [];
      for (var i = 0; i < pts.length; i++) {
        if (pts[i].seq === seq) return pts[i];
      }
      for (var j = 0; j < turnsForPane.length; j++) {
        var r = turnsForPane[j].req;
        if (r.seq !== seq) continue;
        return {
          seq: r.seq,
          ts: r.ts,
          model: r.model,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          cacheRead: r.cacheRead,
          cacheCreation: r.cacheCreation,
          contextTokens:
            (r.promptTokens || 0) + (r.cacheRead || 0) + (r.cacheCreation || 0),
          transcriptItems: r.transcriptItems,
          // Both are timeline-only derivations. `null` says "not fetched", which
          // the renderer prints as "—" rather than as a confident zero.
          approxTokens: null,
          buckets: null,
        };
      }
      return null;
    }

    function inspectTimelinePoint(id) {
      var seq = Number(id.slice(id.indexOf(":") + 1));
      var p = timelinePointFor(seq);
      if (!p) return;
      selectedSeq = p.seq;
      var lines = [
        "context read   " + fmtTok(p.contextTokens) + " tokens",
        "  cache read   " + fmtTok(p.cacheRead),
        "  cache write  " + fmtTok(p.cacheCreation),
        "  fresh input  " + fmtTok(p.promptTokens),
        "output         " + fmtTok(p.completionTokens),
        "transcript     " + p.transcriptItems + " items",
        "approx (chars) " +
          (p.approxTokens == null ? "—" : fmtTok(p.approxTokens) + " tokens"),
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

    function inspectAsk() {
      var st = initialUserStep(stepsForPane);
      if (!st) return;
      Inspector.show("ask:0", {
        kind: "user prompt",
        title: "what this session was asked to do",
        body: String(st.message || ""),
      });
    }

    function inspectTurnEvent(id) {
      var parts = id.split(":"); // ev:<seq>:<index>
      var seq = Number(parts[1]);
      var t = null;
      for (var i = 0; i < turnsForPane.length; i++) {
        if (turnsForPane[i].seq === seq) {
          t = turnsForPane[i];
          break;
        }
      }
      if (!t) return;
      var e = t.events[Number(parts[2])];
      if (!e) return;
      Inspector.show(id, {
        kind: e.kind,
        title: "turn " + seq + " · " + e.label,
        body:
          "agent          " + t.agent + "\n" +
          "at             " + new Date(t.req.ts * 1000).toLocaleTimeString() + "\n" +
          (e.n != null ? "size / dur     " + e.n + "\n" : "") +
          (e.detail ? "\n" + e.detail : ""),
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
   * The first genuinely user-authored step.
   *
   * Claude Code prepends `<system-reminder>` steps carrying CLAUDE.md, the
   * skills roster and environment context, so step 0 is scaffolding on every
   * session. Taking it literally would show the harness talking to itself
   * rather than the ask.
   */
  function initialUserStep(steps) {
    for (var i = 0; i < (steps || []).length; i++) {
      var st = steps[i];
      if (st.role !== "user") continue;
      var m = String(st.message || "");
      if (m.trim().indexOf("<system-reminder>") === 0) continue;
      return st;
    }
    return null;
  }

  /**
   * The conversations inside ONE session.
   *
   * TWO ids are in play and conflating them is the whole confusion. Claude
   * Code's own session id is inherited by every agent it spawns: one live
   * `x-claude-code-session-id` covers 512 main-thread calls plus 521 subagent
   * calls across 26 named agents. A tracetap session is narrower — grouped by
   * SYSTEM PROMPT — so that one Claude session arrives here as 23 tracetap
   * sessions, and none of them mixes main-thread and subagent traffic
   * (measured across an 86-session index: 32 all-subagent, 54 all-main, 0
   * mixed).
   *
   * So what this pane separates is usually several AGENTS that shared one
   * system prompt, not an agent from its parent. Grouping by name is the only
   * thing that stops a six-critic fan-out reading as one impossibly long
   * thread.
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
      '<div class="dim rel-note">Sessions are grouped by system prompt, so a ' +
      "fan-out lands here rather than inside its parent: every agent that shared " +
      "one prompt appears as its own conversation. Names come from the spawning " +
      "Agent tool call; an agent started by a workflow rather than that tool has " +
      'no parent record to join to and is shown as "unnamed" rather than merged ' +
      "into the main thread.</div>" +
      '<div class="tbl-wrap"><table><thead><tr>' +
      "<th>conversation</th>" +
      '<th class="num">calls</th><th class="num">context read</th>' +
      '<th class="num">output</th><th class="num">span</th>' +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>"
    );
  }

  /**
   * Sessions captured in the same trace log.
   *
   * One `.claude-trace` log is one proxied CLI process, so everything in it
   * shares a terminal, a directory and a stretch of wall-clock time. A live
   * capture put 24 sessions in a single log — a main thread and the fleet it
   * spawned — which the session list rendered as 24 unrelated rows.
   *
   * Presented flat, not as a tree. Which session SPAWNED which needs a link
   * these rows do not carry: the cast names each agent, but not which of these
   * siblings hosted the parent that named it, and a tree would assert a
   * parentage that has not been established.
   */
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
          // The agent pill read "CLAUDE" on all 36 rows — a column that cannot
          // distinguish anything it lists. What separates siblings is the same
          // thing that separates sessions anywhere else: what they were asked.
          '"><td class="s-title"><span class="s-ask">' +
          esc(x.title || "untitled session") +
          "</span></td>" +
          castCell(x) +
          "<td>" +
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
      '<th>session</th><th class="num">agents</th><th>model</th><th>started</th>' +
      '<th class="num">duration</th><th class="num">turns</th><th class="num">cost</th>' +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table></div>"
    );
  }

  /** Expand or collapse one turn. */
  function setTurnExpanded(seq, open) {
    var turn = document.querySelector('.turn[data-turn="' + seq + '"]');
    if (!turn) return false;
    var box = turn.querySelector(".turn-events");
    var caret = turn.querySelector(".turn-caret");
    if (!box || !box.children.length) return false;
    box.hidden = !open;
    if (caret) caret.textContent = open ? "\u25be" : "\u25b8";
    return true;
  }

  document.addEventListener("click", function (e) {
    var c = e.target.closest && e.target.closest("[data-expand]");
    if (c) {
      e.stopPropagation();
      var seq = c.getAttribute("data-expand");
      var box = c.closest(".turn").querySelector(".turn-events");
      setTurnExpanded(seq, box.hidden);
      return;
    }
    var f = e.target.closest && e.target.closest("[data-turn-filter]");
    if (!f) return;
    f.setAttribute("aria-pressed", f.getAttribute("aria-pressed") === "true" ? "false" : "true");
    applyTurnFilters();
  });

  /** Selected time window from the ribbon brush, or null for the whole session. */
  var turnRange = null;

  /**
   * The ONE place `.turn[hidden]` is written.
   *
   * Two independent filters — the event-kind chips and the ribbon brush — both
   * want to hide turns. Letting each write `hidden` directly means whichever
   * ran last silently undoes the other; they have to be ANDed in one pass.
   */
  function applyTurnFilters() {
    var on = {};
    var anyKind = false;
    document.querySelectorAll("[data-turn-filter]").forEach(function (b) {
      if (b.getAttribute("aria-pressed") === "true") {
        on[b.getAttribute("data-turn-filter")] = 1;
        anyKind = true;
      }
    });
    var r = turnRange;
    var total = 0;
    var shownTurns = 0;
    document.querySelectorAll(".turn").forEach(function (t) {
      total++;
      var shown = 0;
      t.querySelectorAll("[data-ev-kind]").forEach(function (ev) {
        var vis = !anyKind || on[ev.getAttribute("data-ev-kind")] === 1;
        ev.hidden = !vis;
        if (vis) shown++;
      });
      // OVERLAP, not containment: a call that straddles the edge of the window
      // did run during it, and dropping it would understate what was in flight.
      var inWindow =
        !r ||
        (+t.getAttribute("data-to") >= r.from && +t.getAttribute("data-from") <= r.to);
      // Filtering EVENTS also filters TURNS: a turn with nothing left to show is
      // noise when you have asked "show me only the compactions".
      t.hidden = !inWindow || (anyKind && shown === 0);
      if (!t.hidden) {
        shownTurns++;
        if (anyKind && shown) setTurnExpanded(t.getAttribute("data-turn"), true);
      }
    });
    document.querySelectorAll(".ribbon-bar").forEach(function (b) {
      b.classList.toggle(
        "out",
        !!r && (+b.getAttribute("data-to") < r.from || +b.getAttribute("data-from") > r.to),
      );
    });
    var note = document.getElementById("ribbon-note");
    var rib = document.getElementById("ribbon");
    if (note && rib && r) {
      var t0 = +rib.getAttribute("data-t0");
      note.innerHTML =
        "window +" + esc(fmtDur(r.from - t0)) + " → +" + esc(fmtDur(r.to - t0)) +
        " (" + esc(fmtDur(r.to - r.from)) + ") · " + shownTurns + " of " + total +
        ' turns · <button type="button" class="ribbon-clear">clear</button>';
    } else if (note && rib) {
      note.textContent =
        total + (total === 1 ? " call" : " calls") + " · first start → last finish " +
        fmtDur(+rib.getAttribute("data-t1") - +rib.getAttribute("data-t0")) +
        " · drag to select a window";
    }
  }

  function setTurnRange(range) {
    turnRange = range;
    var sel = document.querySelector(".ribbon-sel");
    var rib = document.getElementById("ribbon");
    if (sel && rib) {
      if (!range) {
        sel.hidden = true;
      } else {
        var t0 = +rib.getAttribute("data-t0");
        var span = +rib.getAttribute("data-t1") - t0 || 1;
        sel.hidden = false;
        sel.style.left = (((range.from - t0) / span) * 100).toFixed(3) + "%";
        sel.style.width = (((range.to - range.from) / span) * 100).toFixed(3) + "%";
      }
    }
    applyTurnFilters();
  }

  /**
   * Brush over the ribbon.
   *
   * Bound on `document` rather than on the ribbon element: the spine is
   * re-rendered wholesale on every pane switch, so a listener attached to the
   * node would be discarded silently the first time you navigated away and back.
   */
  document.addEventListener("mousedown", function (e) {
    var rib = e.target.closest && e.target.closest(".ribbon");
    if (!rib) return;
    e.preventDefault();
    var lanes = rib.querySelector(".ribbon-lanes");
    // Measure the LANES, not the scroll container: a vertical scrollbar on
    // `.ribbon` would otherwise shift every fraction by its width.
    var box = lanes.getBoundingClientRect();
    var sel = rib.querySelector(".ribbon-sel");
    var t0 = +rib.getAttribute("data-t0");
    var span = +rib.getAttribute("data-t1") - t0 || 1;
    // Grabbing a grip anchors the drag at the OPPOSITE edge of the existing
    // window, so the same "min/max of anchor and cursor" arithmetic that draws
    // a new window also resizes one — one code path, and crossing the far edge
    // flips the window instead of inverting it.
    var grip = e.target.closest && e.target.closest(".ribbon-grip");
    var startX = e.clientX;
    var moved = false;
    if (grip && turnRange) {
      var anchorMs = grip.getAttribute("data-grip") === "from" ? turnRange.to : turnRange.from;
      startX = box.left + ((anchorMs - t0) / span) * box.width;
      moved = true; // a grip drag is a resize from the first pixel, never a click
    }

    function frac(clientX) {
      return Math.max(0, Math.min(1, (clientX - box.left) / (box.width || 1)));
    }
    function paint(clientX) {
      var a = Math.min(frac(startX), frac(clientX));
      var b = Math.max(frac(startX), frac(clientX));
      sel.hidden = false;
      sel.style.left = (a * 100).toFixed(3) + "%";
      sel.style.width = ((b - a) * 100).toFixed(3) + "%";
      return [a, b];
    }
    function onMove(ev) {
      // 3px of slop so a click that jitters is still a click, not a 0.2ms window.
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      if (moved) paint(ev.clientX);
    }
    function onUp(ev) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!moved) {
        var bar = e.target.closest && e.target.closest(".ribbon-bar");
        if (bar) {
          // A click on a bar is navigation, not selection: jump the spine to
          // that turn rather than filtering down to it.
          var seq = bar.getAttribute("data-ribbon-seq");
          var row = document.querySelector('.turn[data-turn="' + seq + '"] .turn-row');
          if (row) {
            row.scrollIntoView({ block: "center" });
            row.click();
          }
        } else {
          setTurnRange(null);
        }
        return;
      }
      var ab = paint(ev.clientX);
      setTurnRange({ from: t0 + ab[0] * span, to: t0 + ab[1] * span });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest(".ribbon-clear")) setTurnRange(null);
  });

  // Insight chips and recent-session rows are <button>s, not links, because
  // they carry structure a link cannot; this gives them link behaviour back.
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-goto]");
    if (!el) return;
    location.hash = el.getAttribute("data-goto");
  });

  // ------------------------------------------------------------- journey
  /**
   * Focus index into `turnsForPane`, NOT a seq. The strip, the range input and
   * the arrow keys are three ways to move one cursor, so they all go through
   * here — the class of bug where a slider and a keyboard disagree about where
   * you are exists only when there are two cursors.
   */
  var journeyIdx = 0;

  function setJourney(idx) {
    var turns = turnsForPane;
    if (!turns.length) return;
    journeyIdx = Math.max(0, Math.min(turns.length - 1, idx));
    var t = turns[journeyIdx];
    var detail = document.getElementById("jr-detail");
    if (detail) detail.innerHTML = journeyDetailHtml(t, journeyIdx, turns.length);
    var range = document.getElementById("jr-range");
    if (range && +range.value !== journeyIdx) range.value = String(journeyIdx);
    var strip = document.getElementById("jr-strip");
    if (!strip) return;
    strip.querySelectorAll(".jr-col.on").forEach(function (c) {
      c.classList.remove("on");
    });
    var col = strip.querySelector('.jr-col[data-jr="' + t.seq + '"]');
    if (!col) return;
    col.classList.add("on");
    // Keep the focused column in view when scrubbing by keyboard past the edge,
    // but never yank the strip while the pointer is dragging it.
    var sb = strip.getBoundingClientRect();
    var cb = col.getBoundingClientRect();
    if (cb.left < sb.left + 8 || cb.right > sb.right - 8) {
      strip.scrollLeft += cb.left - sb.left - sb.width / 2;
    }
  }

  /**
   * Scrub by pointer: mousedown anywhere on the strip, then drag across it.
   *
   * Hit-tests on X ALONE, and that is the fix. The first version probed
   * `elementFromPoint(clientX, strip.top + 8)` — a fixed y, 8px below the
   * strip's top edge. But `.jr-strip` carries `padding: 10px 8px 0` with
   * `align-items: flex-end`, so no column is ever painted above y=10: the probe
   * always landed in the top padding, `elementFromPoint` returned the strip
   * itself, and `.closest(".jr-col")` was null on EVERY press. 4b69dc6 added the
   * padding and the probe in one commit, so the pointer path never worked once
   * — the range input did, which is why it went unreported.
   *
   * A scrub surface has one axis. Every x maps to a turn, including an x above a
   * short column (most of them are short) and an x in the gutter, which snaps to
   * the nearest column instead of doing nothing.
   */
  function journeyFromPoint(clientX) {
    var strip = document.getElementById("jr-strip");
    if (!strip) return;
    var cols = strip.querySelectorAll(".jr-col");
    if (!cols.length) return;
    var hit = null;
    var bestGap = Infinity;
    for (var c = 0; c < cols.length; c++) {
      var r = cols[c].getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) {
        hit = cols[c];
        break;
      }
      var gap = clientX < r.left ? r.left - clientX : clientX - r.right;
      if (gap < bestGap) {
        bestGap = gap;
        hit = cols[c];
      }
    }
    if (!hit) return;
    var seq = +hit.getAttribute("data-jr");
    for (var i = 0; i < turnsForPane.length; i++) {
      if (turnsForPane[i].seq === seq) {
        setJourney(i);
        return;
      }
    }
  }

  document.addEventListener("mousedown", function (e) {
    var strip = e.target.closest && e.target.closest("#jr-strip");
    if (!strip) return;
    e.preventDefault();
    journeyFromPoint(e.clientX);
    function onMove(ev) {
      journeyFromPoint(ev.clientX);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "jr-range") setJourney(+e.target.value);
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest) return;
    // Lane -> steps filter. Toggling re-renders the detail through the same
    // path a scrub takes, so there is one render and no second code path to
    // drift.
    var laneBtn = e.target.closest("[data-lane]");
    if (laneBtn) {
      var k = laneBtn.getAttribute("data-lane");
      journeyLaneFilter = journeyLaneFilter === k ? null : k;
      setJourney(journeyIdx);
      return;
    }
    if (e.target.closest("[data-lane-clear]")) {
      journeyLaneFilter = null;
      setJourney(journeyIdx);
      return;
    }
    var step = e.target.closest("[data-jr-step]");
    if (step) {
      setJourney(journeyIdx + +step.getAttribute("data-jr-step"));
      return;
    }
    // An insight chip is a jump, so it also has to SWITCH panes when clicked
    // from anywhere else — the whole point is that it takes you to the turn.
    var chip = e.target.closest(".jr-insight");
    if (!chip) return;
    var seq = +chip.getAttribute("data-jr");
    for (var i = 0; i < turnsForPane.length; i++) {
      if (turnsForPane[i].seq === seq) {
        setJourney(i);
        break;
      }
    }
  });

  // Escape clearing the window is a rung on the existing unwind ladder, not a
  // listener of its own — see the `Escape` branch in the keyboard handler.

  // Session-header inspect targets. The pane listener is mounted on
  // `.session-panes`, so anything rendered in the header — the ask, and
  // whatever joins it later — would otherwise be inert.
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest('[data-inspect^="ask:"]');
    if (!el) return;
    var st = initialUserStep(stepsForPane);
    if (!st) return;
    Inspector.show("ask:0", {
      kind: "user prompt",
      title: "what this session was asked to do",
      body: String(st.message || ""),
    });
  });

  document.addEventListener("click", function (e) {
    var tr = e.target.closest && e.target.closest("tr[data-goto]");
    if (!tr) return;
    location.hash = "#session/" + encodeURIComponent(tr.getAttribute("data-goto"));
  });

  /**
   * Compaction stats keyed by request seq, captured when the timeline lands.
   * Lets the x-ray detail head describe a compaction without a second fetch.
   */
  var xrayCompactions = {};

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
      compactionPhrase(tl.compactionCount, recordedForPane) +
      " · peak " +
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

    // Label thinning, same rule columnChart uses for its date axis: a bar is
    // 12-28px wide and a 3-digit sequence is ~17px, so past ~20 bars the labels
    // collide. 44 of 145 overlapped before this. The seq is on every bar's
    // `aria-label` regardless, so nothing becomes unreachable.
    var seqEvery = Math.max(1, Math.ceil(tl.points.length / 20));
    tl.points.forEach(function (p, i) {
      var h = Math.max(1, Math.round((p.contextTokens / axisMax) * 100));
      var cls =
        "ct-col" +
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
        ' context tokens">' +
        // The BUTTON is a full-height transparent column; the bar inside it
        // encodes the value. Sizing the button itself gave a small-context
        // call a ~3px-tall click target, and .ct-seq/.ct-compact are
        // absolutely positioned against the column, so they need it whole.
        '<span class="ct-bar" style="height:' +
        h +
        '%"></span>' +
        (i % seqEvery === 0 ? '<span class="ct-seq">' + p.seq + "</span>" : "") +
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

  /** Compaction seqs in call order — the stepper walks this. */
  var xrayCompactionSeqs = [];

  /**
   * The compaction stepper: a count plus prev/next, sitting in the controls row.
   *
   * It replaces the left-hand compaction list. The list was a whole column spent
   * on 15 rows, and it was the only place compactions were easy to find — so
   * deleting it outright would have made them strictly harder to reach. This
   * keeps the two things the list actually provided (how many there are, and a
   * way to walk them) in one line of chrome, and the timeline's amber ticks keep
   * the "where are they" job the list never really did well anyway.
   */
  function renderCompactionNav(tl) {
    xrayCompactions = {};
    xrayCompactionSeqs = [];
    ((tl && tl.points) || []).forEach(function (p) {
      if (!p.compaction) return;
      xrayCompactions[p.seq] = p.compaction;
      xrayCompactionSeqs.push(p.seq);
    });
    var n = xrayCompactionSeqs.length;
    if (!n) {
      return '<span class="xray-comp-nav"><span class="xray-comp-label">compactions</span><span class="dim">none</span></span>';
    }
    return (
      '<span class="xray-comp-nav">' +
      '<span class="xray-comp-label">compactions</span>' +
      '<button type="button" class="comp-step" data-comp-step="-1" title="Previous compaction" aria-label="Previous compaction">‹</button>' +
      '<button type="button" class="comp-step comp-pos" data-comp-step="0" id="xray-comp-pos" title="Jump to a compaction">—/' +
      n +
      "</button>" +
      '<button type="button" class="comp-step" data-comp-step="1" title="Next compaction" aria-label="Next compaction">›</button>' +
      "</span>"
    );
  }

  /** Repaint the stepper's position readout for whatever the detail is showing. */
  function updateCompNav() {
    var pos = document.getElementById("xray-comp-pos");
    if (!pos) return;
    var n = xrayCompactionSeqs.length;
    var i = xrayCompactionSeqs.indexOf(currentXraySeq);
    pos.textContent = (i < 0 ? "—" : i + 1) + "/" + n;
    pos.classList.toggle("on", i >= 0);
    pos.title =
      i < 0
        ? "Not on a compaction — click to jump to the next one"
        : "Compaction " + (i + 1) + " of " + n + " · API #" + currentXraySeq;
  }

  /**
   * Which compaction a step lands on. `dir` is -1 / +1 / 0 (nearest forward).
   * Deliberately does NOT wrap: walking off the end silently teleporting to the
   * other end of a 145-call session is disorienting, so the ends just hold.
   */
  function stepCompaction(dir) {
    var seqs = xrayCompactionSeqs;
    if (!seqs.length) return null;
    var cur = currentXraySeq;
    var i = seqs.indexOf(cur);
    // Already on one: step off it, or — for the readout in the middle, which is
    // a jump target and not a third arrow — stay put.
    if (i >= 0) {
      if (dir === 0) return seqs[i];
      var next = i + dir;
      return next < 0 || next >= seqs.length ? seqs[i] : seqs[next];
    }
    // Not sitting on a compaction: step to the nearest one in the direction of
    // travel, so `next` from call #50 means "the next compaction after #50".
    var k;
    if (dir < 0) {
      for (k = seqs.length - 1; k >= 0; k--) if (seqs[k] < cur) return seqs[k];
      return seqs[0];
    }
    for (k = 0; k < seqs.length; k++) if (cur == null || seqs[k] > cur) return seqs[k];
    return seqs[seqs.length - 1];
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
      // Filled in by loadTimeline: the count + prev/next that replaced the
      // left-hand compaction list.
      '<span id="xray-comp-host"></span>' +
      '<span class="dim" id="xray-status">loading…</span></div>' +
      // One column, not two. The compaction list that used to sit on the left is
      // gone — the timeline above reaches every compaction — and the detail
      // carries four-column segment rows plus full payload text, which is what
      // the reclaimed width is for.
      '<div class="xray-layout">' +
      '<aside class="flow-detail xray-detail-full" id="xray-view">' +
      '<div class="dim">Click a column in the timeline above to inspect that call’s context</div>' +
      "</aside></div>"
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
    var compEl = document.getElementById("xray-comp-host");
    // Delegated on the containers, which outlive their contents — binding each
    // control would have to be redone every time they are re-rendered.
    if (compEl && !compEl.getAttribute("data-bound")) {
      compEl.setAttribute("data-bound", "1");
      compEl.addEventListener("click", function (e) {
        var b = e.target.closest(".comp-step[data-comp-step]");
        if (!b) return;
        var seq = stepCompaction(Number(b.getAttribute("data-comp-step")));
        if (seq == null) return;
        activatePane("xray");
        loadXray(sessionId, seq);
      });
    }
    if (!host.getAttribute("data-bound")) {
      host.setAttribute("data-bound", "1");
      host.addEventListener("click", function (e) {
        var col = e.target.closest(".ct-col[data-seq]");
        if (!col) return;
        activatePane("xray");
        loadXray(sessionId, Number(col.getAttribute("data-seq")));
      });
    }
    fetchJSON("/api/session/" + encodeURIComponent(sessionId) + "/timeline")
      .then(function (tl) {
        timelineForPane = tl;
        host.innerHTML = renderContextTimeline(tl);
        if (compEl) compEl.innerHTML = renderCompactionNav(tl);
        // The auto-loaded x-ray resolved before this markup existed, so there
        // was nothing to mark selected at the time. Re-apply it now.
        markXraySelection(currentXraySeq);
        // The head is already on screen by now and was drawn without the
        // compaction facts (they only arrive here), so redraw it in place.
        refreshXrayHead();
        // The timeline is the only thing in this pane carrying per-call rows,
        // and it arrives on its own fetch AFTER the pane can be switched to. A
        // restore that ran while it was still empty found nothing and was lost
        // silently — the selection did not fail to cross, it crossed into a
        // pane that had no rows yet. Re-run it once the rows exist.
        if (document.querySelector("#pane-xray.active")) reselectInPane(false);
      })
      .catch(function (err) {
        host.innerHTML =
          '<div class="dim">context timeline unavailable — ' +
          esc(String(err.message || err)) +
          "</div>";
        if (compEl) compEl.innerHTML = "";
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
  /**
   * Claude Code's own `compact_boundary` records for this session.
   *
   * Held at module scope for the same reason `timelineForPane` is: the header
   * card and the X-Ray timeline render from different call sites and were
   * quoting different provenances, so one screen could read "1 · 1 auto" in the
   * card and "0 compaction(s)" in the timeline heading at the same time.
   */
  var recordedForPane = null;
  var toolTaxForPane = null;
  var stepsForPane = [];
  var turnsForPane = [];

  /**
   * The seq the detail pane is showing. Kept outside `loadXray` because the
   * timeline arrives later and has to re-apply the selection to markup that did
   * not exist when the auto-load resolved.
   */
  var currentXraySeq = null;

  /** The `note` the head last rendered, so the head can be redrawn in place. */
  var currentXrayNote = "";

  /** Paint the active timeline column, and clear the rest. */
  function markXraySelection(seq) {
    currentXraySeq = seq;
    var hit = null;
    document
      .querySelectorAll("#pane-xray .ct-col")
      .forEach(function (el) {
        var on = seq != null && el.getAttribute("data-seq") === String(seq);
        el.classList.toggle("selected", on);
        if (on) {
          el.setAttribute("aria-current", "true");
          hit = el;
        } else {
          el.removeAttribute("aria-current");
        }
      });
    // 145 columns overflow the chart, so the selected one is often scrolled out
    // of sight. `nearest` on both axes means a visible column never moves.
    if (hit && hit.offsetParent && hit.scrollIntoView) {
      hit.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    updateCompNav();
  }

  /**
   * "Was this compaction worth it?" — rendered only when the timeline says so.
   *
   * `compaction.efficacy` is a NEW field. Sessions indexed before it existed
   * carry no such key, and an empty bordered box on every one of them is worse
   * than no box at all — so every read here is guarded and the whole block
   * collapses to "" when the data is absent or malformed. Nothing else in the
   * detail depends on it, so it lights up on its own the moment it appears.
   */
  function compactionEfficacy(seq, c) {
    var e = c && c.efficacy;
    if (!e || typeof e !== "object") return "";
    var verdict = String(e.verdict || "").toLowerCase();
    var label =
      verdict === "negative"
        ? "net negative"
        : verdict === "positive"
          ? "net positive"
          : verdict === "marginal"
            ? "marginal"
            : verdict;
    var rows = "";
    function row(k, v, tip) {
      rows +=
        '<div class="ceff-row"' +
        (tip ? ' title="' + esc(tip) + '"' : "") +
        '><span class="ceff-k">' +
        esc(k) +
        '</span><span class="ceff-v">' +
        v +
        "</span></div>";
    }
    if (e.reclaimedTokens != null) {
      row(
        "reclaimed",
        "<b>" +
          fmtCount(e.reclaimedTokens) +
          "</b> tokens" +
          (typeof e.reclaimedPct === "number"
            ? ' <span class="dim">(' + e.reclaimedPct.toFixed(1) + "%)</span>"
            : ""),
      );
    }
    if (e.cacheRebuildTokens != null) {
      // The two cache-read figures are the evidence for the rebuild number, but
      // they are one level of detail below the verdict — a tooltip, not a row.
      row(
        "cache rebuild",
        "<b>" + fmtCount(e.cacheRebuildTokens) + "</b>",
        e.cacheReadBefore != null || e.cacheReadAfter != null
          ? "cache read " +
              fmtCount(e.cacheReadBefore) +
              " → " +
              fmtCount(e.cacheReadAfter) +
              " across the compaction"
          : "",
      );
    }
    if (typeof e.callsToRegrow !== "undefined") {
      row(
        "regrew in",
        e.callsToRegrow == null
          ? '<span class="dim">never regrew</span>'
          : "<b>" +
              fmtCount(e.callsToRegrow) +
              "</b> call" +
              (e.callsToRegrow === 1 ? "" : "s"),
      );
    }
    // `trigger` is a separate, also-optional field on the compaction — a
    // compaction can have efficacy and no known trigger, so guard it apart.
    var t = c.trigger;
    if (t && t.kind) {
      row(
        "trigger",
        "<b>" +
          esc(t.kind) +
          "</b>" +
          (t.source ? ' <span class="dim">(' + esc(t.source) + ")</span>" : ""),
        t.hookTs ? "hook fired " + fmtTime(t.hookTs) : "",
      );
    }
    if (!rows && !label) return "";
    return (
      '<div class="ceff' +
      (verdict ? " ceff-" + esc(verdict) : "") +
      '"><div class="ceff-head">' +
      '<span class="ceff-title">compaction #' +
      esc(seq) +
      "</span>" +
      (label ? '<span class="ceff-verdict">' + esc(label) + "</span>" : "") +
      "</div>" +
      '<div class="ceff-rows">' +
      rows +
      "</div>" +
      (e.verdictReason
        ? '<div class="ceff-why dim">' + esc(e.verdictReason) + "</div>"
        : "") +
      "</div>"
    );
  }

  /** Flow-pane style detail header: what you are looking at, and how big it is. */
  function xrayHead(seq, note) {
    var c = xrayCompactions[seq];
    return (
      // Wrapped so the head can be redrawn on its own: the timeline (and with it
      // the compaction facts) can land AFTER the context body, and re-rendering
      // the whole detail to pick them up would throw away an open segment.
      '<div id="xray-head-block">' +
      '<div class="flow-detail-head">' +
      '<span class="pill">context</span> API #' +
      esc(seq) +
      (c ? ' <span class="pill compaction-pill">compaction</span>' : "") +
      '<span class="dim xray-head-note">' +
      esc(note) +
      "</span></div>" +
      (c
        ? '<div class="dim xray-head-sub">compacted at this call — items ' +
          c.fromItems +
          " → " +
          c.toItems +
          " (dropped " +
          c.droppedItems +
          ") · prompt tokens " +
          fmtTok(c.prePromptTokens) +
          " → " +
          fmtTok(c.postPromptTokens) +
          "</div>"
        : "") +
      compactionEfficacy(seq, c) +
      "</div>"
    );
  }

  /** Redraw just the head in place, leaving the body (and any open segment) alone. */
  function refreshXrayHead() {
    var el = document.getElementById("xray-head-block");
    if (!el || currentXraySeq == null) return;
    el.outerHTML = xrayHead(currentXraySeq, currentXrayNote);
  }

  function loadXray(sessionId, seq) {
    var token = ++xrayToken;
    var status = document.getElementById("xray-status");
    var viewEl = document.getElementById("xray-view");
    var sel = document.getElementById("xray-seq");
    if (sel && String(sel.value) !== String(seq)) sel.value = String(seq);
    markXraySelection(seq);
    if (status) status.textContent = "loading #" + seq + "…";
    if (viewEl) {
      // Same guard as the flow detail: the pane records what it is showing, so
      // the header is right even while the body is still a skeleton.
      viewEl.setAttribute("data-showing", String(seq));
      currentXrayNote = "loading…";
      // Building one x-ray re-parses the request bodies of BOTH this call and
      // its predecessor — ~2.5s on a 150K-token call. Replacing the table with
      // a skeleton for that long reads as "the click did nothing, then the page
      // reloaded". The previous numbers stay on screen, dimmed and inert, so the
      // click has an immediate effect and the comparison you were reading is
      // still there while its replacement is fetched. First load has nothing to
      // keep, so that one still gets the skeleton.
      if (!viewEl.querySelector(".xray-stack")) {
        viewEl.innerHTML = xrayHead(seq, "loading…") + skeleton({ rows: 4 });
      } else {
        viewEl.classList.add("is-stale");
      }
    }
    // Which call the TABLE is showing — a separate state from the inspector's
    // `.selected`, and marked here rather than on arrival so the feedback
    // lands at the point of the click.
    var tlEl = document.getElementById("context-timeline");
    if (tlEl) {
      tlEl.querySelectorAll(".ct-col.current").forEach(function (c) {
        c.classList.remove("current");
      });
      var hit = tlEl.querySelector('.ct-col[data-seq="' + seq + '"]');
      if (hit) hit.classList.add("current");
    }
    fetchJSON(
      "/api/session/" + encodeURIComponent(sessionId) + "/context/" + seq,
    )
      .then(function (x) {
        if (token !== xrayToken) return; // a newer click already won
        var summary =
          fmtTok(x.totalApproxTokens) +
          " ≈tokens · " +
          fmtTok(x.totalChars) +
          " chars" +
          (x.wirePromptTokens != null
            ? " · wire " + fmtTok(x.wirePromptTokens) + " prompt"
            : "");
        if (status) status.textContent = summary;
        currentXrayNote = summary;
        xrayForPane = x;
        if (viewEl) {
          viewEl.classList.remove("is-stale");
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
        currentXrayNote = "unavailable";
        if (viewEl)
          viewEl.innerHTML =
            xrayHead(seq, "unavailable") +
            '<div class="section-errors"><b>context unavailable</b><br/>' +
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

  /**
   * One row per bucket, in a stable order, carrying BOTH sides of the turn.
   *
   * Merged on the bucket id rather than zipped by position: a bucket can exist
   * on one side only — a compaction that empties TOOL RESULT to zero is a
   * result, and a row that vanishes cannot show the −96K that produced it.
   */
  function mergeXrayBuckets(buckets, prevBuckets) {
    var byId = {};
    var order = [];
    function slot(b) {
      if (!byId[b.bucket]) {
        byId[b.bucket] = { bucket: b.bucket, label: b.label, pre: 0, post: 0, segments: 0 };
        order.push(b.bucket);
      }
      return byId[b.bucket];
    }
    (prevBuckets || []).forEach(function (b) {
      slot(b).pre = b.approxTokens;
    });
    (buckets || []).forEach(function (b) {
      var r = slot(b);
      r.post = b.approxTokens;
      r.segments = b.segments;
    });
    return order.map(function (k) {
      return byId[k];
    });
  }

  function drawXray(x) {
    var total = 0;
    x.buckets.forEach(function (b) {
      total += b.approxTokens;
    });
    var prevBuckets = x.delta ? x.delta.prevBuckets || [] : [];
    var preTotal = prevBuckets.reduce(function (a, b) {
      return a + b.approxTokens;
    }, 0);
    var rows = mergeXrayBuckets(x.buckets, prevBuckets);
    var hasPre = prevBuckets.length > 0;
    // Both sides share ONE scale — the larger total — or a 74.9K "pre" bar and a
    // 185K "post" bar would be drawn the same length and the 2.5x jump this
    // pane exists to show would be invisible.
    var scale = Math.max(total, preTotal) || 1;

    // Bars are share of the WHOLE context, not of the largest bucket. Scaling to
    // the max made the biggest bucket 100% wide whether it was 90% or 30% of the
    // context, which is exactly the question this pane exists to answer.
    function deltaCell(pre, post) {
      var d = post - pre;
      if (!hasPre) return '<span class="xray-row-d dim">—</span>';
      if (d === 0) return '<span class="xray-row-d dim">·</span>';
      return (
        '<span class="xray-row-d ' + (d > 0 ? "up" : "down") + '">' +
        (d > 0 ? "+" : "−") + fmtTok(Math.abs(d)) + "</span>"
      );
    }
    function bucketRow(r, isTotal) {
      var prePct = Math.max(r.pre > 0 ? 0.6 : 0, sharePct(r.pre, scale));
      var postPct = Math.max(r.post > 0 ? 0.6 : 0, sharePct(r.post, scale));
      var tag = isTotal ? "div" : "button";
      return (
        "<" + tag + (isTotal ? ' class="xray-row xray-total"' :
          ' type="button" class="xray-row bucket-' + esc(r.bucket) +
          '" data-bucket-filter="' + esc(r.bucket) + '" aria-pressed="false"') +
        ' title="' + esc(r.label) + " · " + fmtTok(r.pre) + " → " + fmtTok(r.post) +
        (isTotal ? "" : " approx tokens · " + r.segments +
          " segment(s) · click to filter the segments below") + '">' +
        '<span class="xray-row-label">' + esc(r.label) + "</span>" +
        '<span class="xray-row-pre">' + (hasPre ? fmtTok(r.pre) : "—") + "</span>" +
        deltaCell(r.pre, r.post) +
        // Post drawn over pre in the SAME track, so the two are read as one
        // length and its change rather than two rows to subtract by eye.
        '<span class="xray-track">' +
        (hasPre
          ? '<span class="xray-fill pre" style="width:' + prePct.toFixed(2) + '%"></span>'
          : "") +
        '<span class="xray-fill" style="width:' + postPct.toFixed(2) + '%"></span>' +
        "</span>" +
        '<span class="xray-row-n">' + fmtTok(r.post) + "</span>" +
        '<span class="xray-row-pct">' + fmtShare(sharePct(r.post, total)) + "</span>" +
        "</" + tag + ">"
      );
    }

    var stack =
      '<div class="xray-stack' + (hasPre ? " has-pre" : "") + '">' +
      // The bar column's header is BLANK on purpose: right-aligned "net" sat
      // flush against a left-aligned "pre → post" and the two read as one
      // phrase, "NET PRE → POST". What the bars mean is said once below the
      // table instead, where it does not have to survive being adjacent.
      '<div class="xray-row xray-head" aria-hidden="true">' +
      "<span></span><span>pre</span><span>net</span>" +
      "<span></span><span>post</span><span>share</span>" +
      "</div>" +
      rows.map(function (r) { return bucketRow(r, false); }).join("") +
      // Totals last, because the question they answer — "did this turn grow the
      // window or shrink it" — is the sum of the rows above, not a preface.
      bucketRow({ label: "total", pre: preTotal, post: total, segments: 0 }, true) +
      "</div>" +
      (hasPre
        ? '<div class="dim xray-bar-legend">outline = entering this call · fill = leaving it' +
          " · both on one scale, so a bar that grows past its outline grew the window" +
          " · click a row to filter the segments below</div>"
        : '<div class="dim xray-bar-legend">First call in view — nothing to compare against,' +
          " so there is no pre side. Click a row to filter the segments below.</div>");

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
          var meta =
            fmtCount(s.approxTokens) +
            " approx tokens · " +
            fmtCount(s.chars) +
            " chars · " +
            fmtShare(pct) +
            " of context";
          return (
            // The payload used to live in a hover popover, which meant it
            // vanished the moment you reached for it and could not be scrolled,
            // selected or compared. It now opens in the shared inspector, like
            // every other inspectable in the app — see `inspectSegment`, which
            // resolves it from the cached response rather than from an
            // attribute, so 80 full payloads never enter the DOM.
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

  // ------------------------------------------------- analytics (merged pane)
  /**
   * ONE pane, ONE scope. `since` / `until` / `agent` are PANE-LEVEL filters:
   * they go to /api/analytics and /api/usage alike, so every card, chart and
   * table below answers for exactly the same slice -- there is no "this half
   * is filtered, that half is all-time" ambiguity to explain away.
   *
   * `granularity` / `breakdown` are NOT filters -- they only reshape the
   * time-series section, so they live next to it rather than in the scope bar,
   * and changing them re-queries that section alone.
   */
  var an = { since: "", until: "", agent: "", granularity: "daily", breakdown: false };
  var anAgents = [];

  function anFiltered() { return !!(an.since || an.until || an.agent); }

  /** The scope every request from this pane carries. */
  function anScopeParams() {
    var p = new URLSearchParams();
    if (an.since) p.set("since", an.since);
    if (an.until) p.set("until", an.until);
    if (an.agent) p.set("agent", an.agent);
    return p;
  }

  function anAgentOptions() {
    return '<option value="">all agents</option>' +
      anAgents.map(function (a) {
        return '<option value="' + esc(a) + '"' + (an.agent === a ? " selected" : "") + ">" + esc(a) + "</option>";
      }).join("");
  }

  function renderAnalytics() {
    current = { name: "analytics" };
    setView(
      '<div class="controls scope' + (anFiltered() ? " on" : "") + '" id="an-scope">' +
      '<span class="ctl-lbl">scope</span>' +
      '<input id="an-since" type="date" value="' + esc(an.since) + '" title="since (inclusive)"/>' +
      '<span class="ctl-sep">&rarr;</span>' +
      '<input id="an-until" type="date" value="' + esc(an.until) + '" title="until (inclusive)"/>' +
      '<select id="an-agent" title="agent">' + anAgentOptions() + "</select>" +
      '<button type="button" class="btn" id="an-reset"' + (anFiltered() ? "" : " disabled") + ">reset</button>" +
      '<span class="spacer"></span>' +
      '<span class="ctl-hint">applies to every figure on this page</span>' +
      "</div>" +
      '<div class="scope-line" id="an-scope-line">Loading&hellip;</div>' +
      // A single column of full-width blocks made a 3168px page out of content
      // that mostly wanted half the width: short wide rows with dead space on
      // both sides. The grid pairs blocks whose natural widths differ — a list
      // that wants to be long beside a chart that wants to be square.
      '<div class="an-grid">' +
      '<div class="an-full" id="an-cards">' + skelCards(7) + "</div>" +
      '<div class="an-full" id="an-insights"></div>' +
      '<div class="an-wide" id="an-recent"></div>' +
      '<div class="an-side" id="an-calendar"></div>' +
      '<div class="an-full">' +
      '<h2 class="sec">Spend over time <small>(the same slice, bucketed &mdash; granularity and breakdown reshape this section only)</small></h2>' +
      '<div class="controls sub">' +
      '<select id="an-gran" title="bucket size">' +
      ["daily", "weekly", "monthly", "total"].map(function (g) {
        return '<option value="' + g + '"' + (an.granularity === g ? " selected" : "") + ">" + g + "</option>";
      }).join("") +
      "</select>" +
      '<label class="check"><input id="an-breakdown" type="checkbox"' + (an.breakdown ? " checked" : "") + "/> per-model breakdown</label>" +
      "</div></div>" +
      '<div class="an-full" id="an-series"><div class="tbl-wrap"><table><tbody>' + skelRows(6, 8) + "</tbody></table></div></div>" +
      '<div class="an-full" id="an-viz"></div>' +
      '<div class="an-full" id="an-tables"></div>' +
      '<div class="an-full note" id="an-note"></div>' +
      "</div>"
    );

    ["an-since", "an-until", "an-agent"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", onScopeControls);
    });
    document.getElementById("an-reset").addEventListener("click", function () {
      an.since = "";
      an.until = "";
      an.agent = "";
      renderAnalytics();
    });
    ["an-gran", "an-breakdown"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", onSeriesControls);
    });

    loadAnalytics();
  }

  /** Scope changed - everything on the page has to be re-asked. */
  function onScopeControls() {
    an.since = document.getElementById("an-since").value;
    an.until = document.getElementById("an-until").value;
    an.agent = document.getElementById("an-agent").value;
    var bar = document.getElementById("an-scope");
    if (bar) bar.classList.toggle("on", anFiltered());
    var reset = document.getElementById("an-reset");
    if (reset) reset.disabled = !anFiltered();
    loadAnalytics();
  }

  /** Series shape changed - only the time-series section is affected. */
  function onSeriesControls() {
    an.granularity = document.getElementById("an-gran").value;
    an.breakdown = document.getElementById("an-breakdown").checked;
    loadAnalyticsSeries();
  }

  function loadAnalytics() {
    loadAnalyticsOverview();
    loadAnalyticsSeries();
  }

  /**
   * Number the figures by final DOM order. The pane's regions render
   * independently and some charts drop out for a given slice (a single bucket,
   * no wire data), so hard-coded FIG.n would leave holes; both draw passes call
   * this and the last one to land settles the numbering.
   */
  function renumberFigs() {
    view.querySelectorAll(".chart-title .fig").forEach(function (el, i) {
      el.textContent = "FIG." + (i + 1);
    });
  }

  /** Replace one pane region with an error instead of nuking the whole view. */
  function regionFail(id, err) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="empty">Error: ' + esc(err.message || err) + "</div>";
  }

  function loadAnalyticsOverview() {
    if (!document.getElementById("an-cards")) return;
    fetchJSON("/api/analytics?" + anScopeParams()).then(function (a) {
      if (current.name !== "analytics") return;
      drawAnalytics(a);
    }).catch(function (err) { regionFail("an-cards", err); });
  }

  function loadAnalyticsSeries() {
    if (!document.getElementById("an-series")) return;
    var p = anScopeParams();
    p.set("granularity", an.granularity);
    if (an.breakdown) p.set("breakdown", "1");
    try { p.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) {}
    fetchJSON("/api/usage?" + p).then(function (report) {
      if (current.name !== "analytics") return;
      drawSeries(report);
    }).catch(function (err) { regionFail("an-series", err); });
  }

  /** Human-readable proof of what the numbers on this page actually cover. */
  function scopeLine(a) {
    var t = a.totals;
    var range = an.since || an.until
      ? esc(an.since || "the beginning") + " &rarr; " + esc(an.until || "now")
      : "all time";
    return "<b>" + range + "</b> &middot; <b>" + (an.agent ? esc(an.agent) : "all agents") + "</b> &mdash; " +
      t.sessions + " session" + (t.sessions === 1 ? "" : "s") + " &middot; " +
      t.requests + " API call" + (t.requests === 1 ? "" : "s") + " &middot; " +
      t.events + " agent turn" + (t.events === 1 ? "" : "s");
  }

  function drawAnalytics(a) {
    var t = a.totals;

    // The agent picker offers every agent in the index, not just the ones that
    // survived the current filter - otherwise picking one erases the others.
    if (a.agentOptions && a.agentOptions.join(" ") !== anAgents.join(" ")) {
      anAgents = a.agentOptions;
      var sel = document.getElementById("an-agent");
      if (sel) sel.innerHTML = anAgentOptions();
    }
    document.getElementById("an-scope-line").innerHTML = scopeLine(a);
    anForInsights = a;

    document.getElementById("an-cards").innerHTML = '<div class="cards">' +
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
        a.compactions.totalCompactions,
        a.compactions.totalCompactions > 0,
        "in " + a.compactions.sessionsWithCompaction + " sessions",
      ) +
      "</div>";

    document.getElementById("an-insights").innerHTML = fleetInsightsHtml(a);
    loadRecentSessions();

    document.getElementById("an-calendar").innerHTML = a.trend.length
      ? '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.1</span>Cost calendar &mdash; last 26 weeks &middot; ' +
        a.trend.length + " active days in scope</div>" +
        '<div id="hm"></div></div>'
      : '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.1</span>Cost calendar</div>' +
        '<div class="dim">No priced activity in scope.</div></div>';

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
    var strips = TracetapCharts.ttftStrips(a.perModel);
    document.getElementById("an-viz").innerHTML = (tmItems.length || strips)
      ? '<div class="split">' +
        (tmItems.length
          ? '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.3</span>Spend by project</div><div id="tm"></div></div>'
          : "") +
        (strips
          ? '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.4</span>TTFT distribution by model &middot; box p25&ndash;p75 &middot; tick p50 &middot; amber p95</div><div id="ts"></div></div>'
          : "") +
        "</div>"
      : "";

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

    // Per NAMED agent, not per harness family. The old table keyed on
    // `sessions.agent` and so had exactly one row — "CLAUDE, 82 sessions,
    // $398" — which is the total-cost card restated, and told you nothing
    // about where the money went.
    var allAgents = a.perNamedAgent || [];
    // Capped so this column stays comparable in height to the two beside it —
    // 44 rows would have made it twice the page. What is cut is SAID, with its
    // combined cost, because a silent top-N reads as "that is all of them".
    var AGENT_ROWS = 12;
    var namedAgents = allAgents.slice(0, AGENT_ROWS);
    var restAgents = allAgents.slice(AGENT_ROWS);
    var restCost = restAgents.reduce(function (s, p) {
      return s + (p.costUsd || 0);
    }, 0);
    var agentMaxCost = namedAgents.reduce(function (m, p) {
      return Math.max(m, p.costUsd || 0);
    }, 0);
    // The agent TYPE is "general-purpose" on nearly every row, so printing it
    // on each one lengthens every label to say nothing. Name the common type
    // once in the heading and show the type inline only where it DIFFERS —
    // the same rule that took the model out of the session titles.
    var typeCounts = {};
    allAgents.forEach(function (p) {
      if (p.type) typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
    });
    var commonType = Object.keys(typeCounts).sort(function (x, y) {
      return typeCounts[y] - typeCounts[x];
    })[0];
    var agentRows = namedAgents
      .map(function (p) {
        return (
          '<tr class="' +
          (p.label === "main thread" ? "an-agent-main" : p.named ? "" : "an-agent-unnamed") +
          '"><td class="bar-cell an-agent-name" title="' +
          esc(p.label + (p.type ? " · " + p.type : "")) +
          '"><div class="bar" style="width:' +
          (agentMaxCost ? ((p.costUsd || 0) / agentMaxCost) * 100 : 0).toFixed(1) +
          '%"></div><span>' +
          esc(p.label) +
          (p.type && p.type !== commonType
            ? ' <small class="dim">' + esc(p.type) + "</small>"
            : "") +
          "</span></td>" +
          '<td class="num">' +
          p.calls +
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
    if (restAgents.length) {
      agentRows +=
        '<tr class="an-agent-rest"><td class="dim">+ ' +
        restAgents.length +
        " more agent" +
        (restAgents.length === 1 ? "" : "s") +
        '</td><td class="num dim">' +
        restAgents.reduce(function (s, p) {
          return s + p.calls;
        }, 0) +
        '</td><td class="num"></td><td class="num"></td><td class="num dim">' +
        fmtCost(restCost) +
        "</td></tr>";
    }

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
          '"><td class="s-title"><span class="s-ask">' +
          esc(s.title || "untitled session") +
          '</span><span class="s-meta">' +
          esc(s.model || "—") +
          "</span></td>" +
          '<td class="dim" title="' +
          esc(s.projectCwd) +
          '">' +
          esc(basename(s.projectCwd)) +
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

    var tables = document.getElementById("an-tables");
    tables.innerHTML =
      // Four narrow tables, laid out by `auto-fit` on their own minimum rather
      // than by a hardcoded column count: at 2100px they sit three across, at
      // 1200px two, and none of them ever gets stretched to a full 2152px.
      '<div class="an-tables-grid">' +
      '<div><h2 class="sec">Per model <small>(wire latency &amp; reliability)</small></h2>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Err</th><th class="num">TTFT p50</th><th class="num">TTFT p95</th><th class="num">Dur p50</th><th class="num">Out</th></tr></thead><tbody>' +
      (modelRows || '<tr><td colspan="7" class="dim">no wire data</td></tr>') + "</tbody></table></div>" +
      '<h2 class="sec">Where the spend went <small>(by agent, dearest first' +
      (commonType ? " &middot; " + esc(commonType) + " unless noted" : "") +
      ")</small></h2>" +
      '<div class="tbl-wrap"><table><thead><tr><th>Agent</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>' +
      (agentRows || '<tr><td colspan="5" class="dim">no data</td></tr>') + "</tbody></table></div></div>" +
      '<div><h2 class="sec">Top tools' +
      (a.toolsTotal && a.toolsTotal > a.topTools.length
        ? " <small>(" + a.topTools.length + " of " + a.toolsTotal + ")</small>"
        : "") +
      "</h2>" +
      '<div class="tbl-wrap"><table><tbody>' + (toolRows || '<tr><td class="dim">no tool calls</td></tr>') + "</tbody></table></div></div>" +
      '<div><h2 class="sec">Top sessions by cost</h2>' +
      // No "started" column: this table ranks by COST, the recency list at the
      // top of the page already answers "when", and six columns in a 637px
      // grid cell left the one that identifies the row — its ask — clipped to
      // 130px.
      '<div class="tbl-wrap"><table><thead><tr><th>Session</th><th>Project</th><th class="num">Dur</th><th class="num">Turns</th><th class="num">Cost</th></tr></thead><tbody>' +
      (topSessionRows || '<tr><td colspan="5" class="dim">no sessions</td></tr>') + "</tbody></table></div></div>" +
      "</div>";
    document.getElementById("an-note").innerHTML = "prices: " + esc(a.priceSource);

    tables.querySelectorAll("tr[data-id]").forEach(function (tr) {
      tr.addEventListener("click", function () {
        location.hash =
          "#session/" + encodeURIComponent(tr.getAttribute("data-id"));
      });
    });

    // Registered AFTER the hosts are in the document, because the whole point
    // is to measure them. Each closure keeps the data; only the width varies.
    registerChart("hm", function (w) {
      return TracetapCharts.calendarHeatmap(a.trend, { width: w });
    });
    registerChart("tm", function (w) {
      return TracetapCharts.treemap(tmItems, { width: w, height: 260 });
    });
    registerChart("ts", function (w) {
      return TracetapCharts.ttftStrips(a.perModel, { width: w });
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
    renumberFigs();
  }

  var anForInsights = null;

  /**
   * Fleet-scale "worth looking at" — the analytics analogue of the journey's
   * per-turn insights, and held to the same standard: every entry is a rule you
   * can check against a number on this page, not a judgement.
   *
   * The landing page's job is to answer "what should I look at" before you have
   * formed a query. A wall of totals does not do that; totals tell you what
   * happened, not which of it is unusual.
   */
  function fleetInsightsHtml(a) {
    var t = a.totals;
    var out = [];
    function push(label, detail, sev, href) {
      out.push(
        '<button type="button" class="jr-insight sev-' + sev + '"' +
        (href ? ' data-goto="' + esc(href) + '"' : "") + ">" +
        '<span class="jr-i-label">' + label + "</span>" +
        '<span class="jr-i-detail">' + detail + "</span></button>",
      );
    }

    // Unpriced models first: it invalidates every dollar figure above it, so
    // burying it under "insights" would be the wrong order.
    if (t.hasUnpriced) {
      push(
        "Cost is understated",
        "some calls used models with no price in the catalogue",
        "warn",
      );
    }

    // Cache economics. Reads bill ~0.1x and writes ~1.25x, so the ratio between
    // them is the single biggest lever on spend that is not "send less".
    var cw = t.cacheCreation || 0;
    var cr = t.cacheRead || 0;
    if (cw + cr > 0) {
      var writeShare = cw / (cw + cr);
      push(
        fmtPct(writeShare) + " of cached tokens were WRITES",
        fmtTok(cw) + " written at 1.25x vs " + fmtTok(cr) +
          " read at 0.1x — a write costs 12.5x a read",
        writeShare > 0.25 ? "warn" : "info",
      );
    }

    // Error-rate outlier by model, not the fleet average: one bad model hides
    // inside a healthy aggregate.
    var worst = null;
    (a.perModel || []).forEach(function (m) {
      if (m.requests >= 20 && (!worst || m.errorRate > worst.errorRate)) worst = m;
    });
    if (worst && worst.errorRate > 0.01) {
      push(
        esc(worst.model) + " failed " + fmtPct(worst.errorRate) + " of calls",
        worst.errored + " of " + worst.requests + " requests",
        "bad",
      );
    }

    // Latency spread, which the p50 on the cards cannot show.
    var slow = null;
    (a.perModel || []).forEach(function (m) {
      if (m.ttftN >= 20 && (!slow || m.ttftP95 > slow.ttftP95)) slow = m;
    });
    if (slow && slow.ttftP50 && slow.ttftP95 > slow.ttftP50 * 2.5) {
      push(
        esc(slow.model) + " p95 is " + esc(fmtDur(slow.ttftP95)),
        Math.round(slow.ttftP95 / slow.ttftP50) + "x its own median (" +
          esc(fmtDur(slow.ttftP50)) + ") — a long tail, not a slow model",
        "info",
      );
    }

    // Concentration: where the money actually went.
    var top = (a.perProject || [])[0];
    if (top && t.costUsd > 0) {
      push(
        esc(basename(top.project) || top.project) + " is " +
          fmtPct(top.costUsd / t.costUsd) + " of spend",
        fmtCost(top.costUsd) + " across " + top.sessions + " sessions",
        "info",
      );
    }

    if (a.compactions.totalCompactions > 0) {
      push(
        a.compactions.totalCompactions + " compactions",
        "across " + a.compactions.sessionsWithCompaction + " of " + t.sessions +
          " sessions — each one drops transcript the model can no longer see",
        "warn",
      );
    }

    var busiest = (a.topTools || [])[0];
    if (busiest) {
      push(
        esc(busiest.name) + " ran " + busiest.count + " times",
        "the most-invoked tool in scope",
        "info",
        "#tooltax",
      );
    }

    if (!out.length) return "";
    return (
      '<h2 class="sec">Worth looking at <small>(' + out.length + ")</small></h2>" +
      '<div class="jr-insights">' + out.join("") + "</div>"
    );
  }

  /**
   * "Jump back in" — the newest sessions, so making analytics the landing page
   * does not cost the one thing the session list was good for.
   *
   * Deliberately short. The full list is one click away and is a LOOKUP tool;
   * this is the recency shortcut, which is the only part of it you need before
   * you have a query in mind.
   */
  function loadRecentSessions() {
    var host = document.getElementById("an-recent");
    if (!host) return;
    fetchJSON("/api/sessions?limit=6")
      .then(function (d) {
        var rows = (d.sessions || [])
          .map(function (s) {
            return (
              '<button type="button" class="an-recent-row" data-goto="#session/' +
              esc(encodeURIComponent(s.sessionId)) + '">' +
              '<span class="rc-when">' + esc(fmtWhen(s.startedAt)) + "</span>" +
              '<span class="rc-title">' + esc(s.title || "untitled session") + "</span>" +
              '<span class="rc-model">' + esc(basename(s.projectCwd) || "—") +
              " · " + esc(s.model || "") + "</span>" +
              '<span class="rc-n">' + (s.turns || 0) + " turns</span>" +
              '<span class="rc-n">' + esc(fmtDur(s.durationMs)) + "</span>" +
              '<span class="rc-n' + (s.errorCount ? " bad" : "") + '">' +
              (s.errorCount ? s.errorCount + " err" : "") + "</span>" +
              '<span class="rc-cost">' + esc(fmtCost(s.costUsd)) + "</span>" +
              "</button>"
            );
          })
          .join("");
        host.innerHTML = rows
          ? '<h2 class="sec">Jump back in <small>(newest first · ' +
            '<a href="#sessions">all sessions</a>)</small></h2>' +
            '<div class="an-recent">' + rows + "</div>"
          : "";
      })
      .catch(function () {
        host.innerHTML = "";
      });
  }

  /** Relative-then-absolute, because "3h ago" is what you scan a recent list for. */
  function fmtWhen(epochSeconds) {
    if (!epochSeconds) return "—";
    var d = new Date(epochSeconds * 1000);
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    if (mins < 60 * 24) return Math.round(mins / 60) + "h ago";
    if (mins < 60 * 24 * 7) return Math.round(mins / (60 * 24)) + "d ago";
    return d.toLocaleDateString();
  }

  /** The bucketed drill-down: cost per bucket + the full token/spend table. */
  function drawSeries(report) {
    var host = document.getElementById("an-series");
    if (!host) return;
    if (!report.rows.length) {
      host.innerHTML = '<div class="empty">No usage in scope. Capture sessions, then run <code>tracetap index</code>.</div>';
      return;
    }

    // Chart: cost per bucket (collapse breakdown rows back into buckets).
    var byBucket = {};
    report.rows.forEach(function (r) {
      byBucket[r.bucket] = (byBucket[r.bucket] || 0) + r.costUsd;
    });
    var items = Object.keys(byBucket).sort().map(function (b) {
      return { label: b.slice(5) || b, value: byBucket[b], title: b + ": " + fmtCost(byBucket[b]) };
    });
    var chart = report.granularity !== "total" && items.length > 1
      ? '<div class="chart-box"><div class="chart-title"><span class="fig">FIG.2</span>Cost per ' +
        ({ daily: "day", weekly: "week", monthly: "month" }[report.granularity] || report.granularity) + "</div>" +
        '<div id="an-fig2"></div></div>'
      : "";

    // The grouping column holds models when broken down and otherwise the
    // agents that produced the bucket — say which, rather than "Group".
    var showGroup = report.rows.some(function (r) { return r.group; });
    var head = "<th>Bucket</th>" + (showGroup ? "<th>" + (an.breakdown ? "Model" : "Agents") + "</th>" : "") +
      '<th class="num">In</th><th class="num">Out</th><th class="num">Cache R</th><th class="num">Cache W</th>' +
      '<th class="num" title="Sessions with billable turns in this bucket">Sessions</th><th class="num">Cost</th>';
    var rowsHtml = report.rows.map(function (r) {
      return "<tr><td>" + esc(r.bucket) + "</td>" +
        (showGroup ? "<td>" + esc(r.group) + "</td>" : "") +
        '<td class="num">' + fmtTok(r.promptTokens) + "</td>" +
        '<td class="num">' + fmtTok(r.completionTokens) + "</td>" +
        '<td class="num">' + fmtTok(r.cacheRead) + "</td>" +
        '<td class="num">' + fmtTok(r.cacheCreation) + "</td>" +
        '<td class="num">' + r.sessions + "</td>" +
        '<td class="num">' + fmtCost(r.costUsd, r.hasUnpriced) + "</td></tr>";
    });
    var t = report.totals;
    rowsHtml.push('<tr class="total"><td>total</td>' + (showGroup ? "<td></td>" : "") +
      '<td class="num">' + fmtTok(t.promptTokens) + "</td>" +
      '<td class="num">' + fmtTok(t.completionTokens) + "</td>" +
      '<td class="num">' + fmtTok(t.cacheRead) + "</td>" +
      '<td class="num">' + fmtTok(t.cacheCreation) + "</td>" +
      '<td class="num">' + t.sessions + "</td>" +
      '<td class="num">' + fmtCost(t.costUsd, t.hasUnpriced) + "</td></tr>");

    // Sessions here counts sessions that BILLED in the bucket, while the
    // Sessions card counts every indexed session in scope — call out the gap
    // rather than let two different numbers sit unexplained on one page.
    var note = "Sessions counts sessions with billable turns in the bucket; the " +
      "<b>Sessions</b> card above counts every indexed session in scope.";
    if (report.unpricedModels.length) {
      note += ' <span class="warn-text">Unpriced models excluded from $: ' +
        esc(report.unpricedModels.join(", ")) + ".</span>";
    }
    note = '<div class="note">' + note + "</div>";

    // The chart and the table are the SAME numbers, so they sit side by side
    // rather than stacked: at full width five daily buckets became five bars
    // stranded in the middle of a 1960px box, and the table below it spread
    // eight columns across the same width for no reason.
    host.innerHTML =
      '<div class="an-series-grid">' +
      (chart ? '<div class="an-series-chart">' + chart + "</div>" : "") +
      '<div class="an-series-table"><div class="tbl-wrap"><table><thead><tr>' +
      head + "</tr></thead><tbody>" + rowsHtml.join("") +
      "</tbody></table></div>" + note + "</div></div>";
    if (chart) {
      registerChart("an-fig2", function (w) {
        return columnChart(items, { height: 130, labels: true, colWidth: 34, width: w });
      });
    }
    renumberFigs();
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
  var TABS = ["sessions", "analytics", "prompts", "audit", "tooltax"];

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

  /**
   * `.kb-focus` cursor for the LIST pages (sessions, usage, prompts, …).
   *
   * Session pages have their own cursor — the inspector selection driven by
   * `sessionArrowNav` — so j/k are routed there instead of here. Two cursors
   * on one page means two highlights disagreeing about where you are.
   */
  function moveCursor(dir) {
    // `.wf-row.click` used to be here for the request waterfall. The waterfall
    // is gone; the selector went with it.
    var rows = Array.prototype.slice.call(view.querySelectorAll("tr.click"));
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
  var SESSION_PANES = ["journey", "flow", "hooks", "xray", "tools", "wire", "related"];
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

  /**
   * Re-entrancy guard. `selectTarget` clicks a real row, and some rows switch
   * panes when clicked — the x-ray timeline bar calls `activatePane("xray")`.
   * Without this, restoring into the x-ray would click the bar, whose handler
   * re-enters `activatePane`, which restores again: an infinite loop that hangs
   * the tab rather than failing visibly.
   */
  var reselecting = false;

  /**
   * After switching panes, land on the same turn if this pane has it.
   *
   * @param allowFallback select the pane's first row when there is nothing to
   *   restore. TRUE for keyboard traversal, where landing somewhere is the
   *   point; FALSE for a tab click, because inventing a selection would pop the
   *   inspector rail open every time you looked at a different pane.
   */
  function reselectInPane(allowFallback) {
    if (reselecting) return;
    var list = paneTargets();
    if (!list.length) return;
    // A turn wins over a remembered cursor: if this pane can show the call you
    // were just looking at, that is what "the same thing, another view" means.
    var wanted = selectedSeq != null ? "ctp:" + selectedSeq : null;
    var remembered = paneCursor[current.pane];
    reselecting = true;
    try {
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
      if (allowFallback) selectTarget(list[0]);
    } finally {
      reselecting = false;
    }
  }

  function sessionArrowNav(e) {
    var k = e.key;
    // j/k are the vim spelling of ↓/↑ and must mean the same thing here. Left
    // to fall through they reached `moveCursor`, a second cursor that paints
    // `.kb-focus` on transcript rows while ↑/↓ moved the inspector selection
    // — two highlights, on different elements, both claiming to be "where you
    // are".
    var vertical = k === "ArrowDown" || k === "ArrowUp" || k === "j" || k === "k";
    var horizontal = k === "ArrowRight" || k === "ArrowLeft";
    if (!vertical && !horizontal) return false;

    if (horizontal) {
      // On the journey, LEFT/RIGHT scrubs. It is the pane's ONLY axis, so
      // taking the arrows here costs nothing and reading a session by holding
      // → is the interaction the view exists for. The pane switch keeps its
      // other spelling (the subnav) and every other pane is unaffected.
      if (current.pane === "journey" && turnsForPane.length) {
        e.preventDefault();
        setJourney(journeyIdx + (k === "ArrowRight" ? 1 : -1));
        return true;
      }
      // On a turn row, LEFT/RIGHT means expand/collapse rather than change
      // pane — drilling into the thing you have selected is the nearer
      // meaning, and the pane switch is still there once it is collapsed.
      var sel = Inspector.selected() || "";
      if (sel.indexOf("ctp:") === 0) {
        var seq = sel.slice(4);
        if (setTurnExpanded(seq, k === "ArrowRight")) {
          e.preventDefault();
          return true;
        }
      }
      var cur = SESSION_PANES.indexOf(current.pane || "journey");
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
    var d = k === "ArrowDown" || k === "j" ? 1 : -1;
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
    } else if (e.key >= "1" && e.key <= "9" && Number(e.key) <= TABS.length)
      // Bound comes from TABS, not a literal. Folding #usage into analytics
      // left this reading `<= "6"` against five tabs, so 6 navigated to
      // "#undefined" and dropped you on a dead route.
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
      // A brushed time window is a narrowing you applied, so it unwinds before
      // the page does — otherwise Escape to drop the window also throws you out
      // of the session, which is what a competing listener here used to do.
      if (turnRange) {
        setTurnRange(null);
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
      ["1-" + TABS.length, "switch view"],
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
    else if (current.name === "analytics") loadAnalytics();
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
