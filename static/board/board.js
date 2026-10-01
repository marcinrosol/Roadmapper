(function () {
  "use strict";

  /**
   * board.js — the entire client-side Gantt/roadmap board UI.
   *
   * This is a single vanilla-JS IIFE with no external dependencies and no
   * build step (no bundler, no transpiler, no npm packages — it is loaded
   * directly as a <script> tag by projects/board.html). It talks to the
   * Django REST backend purely over `fetch`, and owns all DOM rendering by
   * hand (no templating library, no virtual DOM): every render pass tears
   * down and rebuilds the relevant DOM subtree from the in-memory `tasks`/
   * `projects`/`links`/`transitions`/`markers` arrays.
   *
   * At a glance, it renders:
   *  - a "portfolio" view (all projects) and a per-project drill-in view,
   *  - a left-hand task tree with recursive parent/child hierarchy, where
   *    summary rows roll up their children's dates/progress/budget/status,
   *  - a right-hand timeline with dependency arrows (solid) and cross-task
   *    "transition" arrows (dashed), plus milestone/key-event/decision-point
   *    markers drawn on top of task bars,
   *  - an optional critical-path highlight for the open project,
   *  - fiscal-year/quarter/month bands across the top of the timeline,
   *  - and docked drawers (sidebars) for creating/editing tasks and projects
   *    that write back to the API and patch the in-memory state in place.
   *
   * The file is organized into sections marked with banner comments like
   * `/* ============ section name ============ *\/` (constants, API layer,
   * data, accessors, hierarchy, state, range, filtering, critical path,
   * derived rows, rendering, toast, scroll sync, drawer, snapshot, init).
   * Read top to bottom, later sections generally depend on earlier ones.
   */

  /* ============ constants ============ */
  var ROW_H = 40;
  // Zoom bounds in px/day (keep in sync with #board-zoom-slider min/max), and
  // the margin fitToProject leaves on each side of a project's span.
  var ZOOM_MIN = 2, ZOOM_MAX = 40;
  var FIT_MARGIN_DAYS = 4;
  var DAY_MS = 86400000;
  var TODAY = (function () {
    var d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  })();

  var PROJECT_COLORS = ['#3C6E9E', '#2E6E5E', '#C98A2C', '#6E4C8A', '#8A5A44', '#4C7A4C'];

  // Marker types attached to a task and anchored at a specific date, rendered as a
  // large indicator on top of that task's bar. Each type has a fixed semantic color,
  // the same regardless of which project the task belongs to.
  var MARKER_TYPES = {
    milestone: { symbol: '◆', color: '#D4AF00', label: 'Milestone' },
    key_event: { symbol: '▲', color: '#D97706', label: 'Key event' },
    decision_point: { symbol: '✛', color: '#7C3AED', label: 'Decision point' },
  };

  function fmtBudgetM(dollars) { return '$' + (parseFloat(dollars || 0) / 1e6).toFixed(1) + 'M'; } // e.g. "$1.2M"
  function fmtBudget(dollars) { return '$' + Math.round(parseFloat(dollars || 0)).toLocaleString('en-US'); } // e.g. "$1,234"
  function parseDate(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); } // "YYYY-MM-DD" -> UTC midnight Date, so day math never shifts across local timezones/DST
  function fmtDate(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); } // Date -> "YYYY-MM-DD" (inverse of parseDate)
  // Date -> short human label, e.g. "Mar 4".
  function fmtShort(d) {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }
  function addDays(d, n) { return new Date(d.getTime() + n * DAY_MS); }
  function dayDiff(a, b) { return Math.round((b.getTime() - a.getTime()) / DAY_MS); }

  // --- Federal fiscal year helpers ---
  // The US federal fiscal year starts Oct 1 of the *previous* calendar year and
  // is named after the calendar year it ends in: FY26 = Oct 1 2025 -> Sep 30 2026.
  // All of these treat dates as UTC-midnight (see parseDate) so month/day
  // comparisons are pure calendar math with no timezone surprises.

  // Which fiscal year a date falls in: Oct(9)-Dec roll forward into next calendar year's FY.
  function fiscalYearOf(d) { var y = d.getUTCFullYear(), m = d.getUTCMonth(); return (m >= 9) ? y + 1 : y; }
  function fyStart(fy) { return new Date(Date.UTC(fy - 1, 9, 1)); } // Oct 1 of (fy - 1)
  function fyEnd(fy) { return new Date(Date.UTC(fy, 9, 1)); } // exclusive end = Oct 1 of fy (i.e. start of next FY)
  // Federal fiscal quarter (Q1 = Oct-Dec, Q2 = Jan-Mar, Q3 = Apr-Jun, Q4 = Jul-Sep).
  function fiscalQuarterOf(d) {
    var m = d.getUTCMonth();
    if (m >= 9) return 1;
    if (m <= 2) return 2;
    if (m <= 5) return 3;
    return 4;
  }
  // Start date of fiscal quarter q within fiscal year fy.
  function quarterStart(fy, q) {
    var map = { 1: [fy - 1, 9], 2: [fy, 0], 3: [fy, 3], 4: [fy, 6] };
    return new Date(Date.UTC(map[q][0], map[q][1], 1));
  }
  function quarterEnd(fy, q) { return q === 4 ? fyEnd(fy) : quarterStart(fy, q + 1); } // exclusive end; Q4 ends the FY

  // Splits [rangeStart, rangeEnd) into one segment per fiscal year, clipped to
  // the range, for drawing the "FY26" bands across the top of the timeline.
  function getFYSegments(rangeStart, rangeEnd) {
    var segs = [];
    var fy = fiscalYearOf(rangeStart);
    var cursor = fyStart(fy) < rangeStart ? rangeStart : fyStart(fy);
    while (cursor < rangeEnd) {
      var end = fyEnd(fy);
      segs.push({ fy: fy, start: cursor, end: end > rangeEnd ? rangeEnd : end });
      cursor = end; fy++;
    }
    return segs;
  }
  // Same idea as getFYSegments but one segment per fiscal quarter, for the "Q1"/"Q2"/... band row.
  function getQuarterSegments(rangeStart, rangeEnd) {
    var segs = [];
    var fy = fiscalYearOf(rangeStart), q = fiscalQuarterOf(rangeStart);
    var cursor = rangeStart;
    while (cursor < rangeEnd) {
      var end = quarterEnd(fy, q);
      segs.push({ fy: fy, q: q, start: cursor, end: end > rangeEnd ? rangeEnd : end });
      cursor = end;
      q++; if (q > 4) { q = 1; fy++; }
    }
    return segs;
  }

  /* ============ API layer ============ */
  // Reads the Django CSRF token out of the `csrftoken` cookie (set by Django
  // on any page render) so it can be echoed back as the X-CSRFToken header —
  // Django's CSRF protection requires this for any unsafe (POST/PATCH/DELETE)
  // request, including same-origin fetch() calls like this board's.
  function getCookie(name) {
    var match = document.cookie.match("(^|;\\s*)" + name + "=([^;]*)");
    return match ? decodeURIComponent(match[2]) : null;
  }

  // Thin JSON fetch wrapper shared by every Api.* call below: attaches the
  // CSRF header, JSON-encodes the body, and normalizes failures into a
  // rejected promise with a human-readable .message (falling back to raw
  // response text if the error body isn't JSON) so callers can show it
  // directly in a drawer's error box.
  function apiRequest(method, url, body) {
    return fetch(url, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCookie("csrftoken"),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          var message = text;
          try {
            var parsed = JSON.parse(text);
            message = Array.isArray(parsed) ? parsed.join(" ") : (parsed.detail || JSON.stringify(parsed));
          } catch (e) { /* keep raw text */ }
          var err = new Error(message || ("Request failed (" + response.status + ")"));
          err.status = response.status;
          throw err;
        });
      }
      if (response.status === 204) return {};
      return response.json();
    });
  }

  // Thin REST client for the board's five resource types. Every method is a
  // one-line wrapper around apiRequest + the resource's DRF URL; callers are
  // responsible for patching the in-memory arrays (tasks/links/etc.) and
  // calling rebuildIndexes()/render() afterwards — this layer does no caching.
  var Api = {
    createTask: function (data) { return apiRequest("POST", window.BOARD_API_TASKS_URL, data); },
    updateTask: function (id, data) { return apiRequest("PATCH", window.BOARD_API_TASKS_URL + id + "/", data); },
    deleteTask: function (id) { return apiRequest("DELETE", window.BOARD_API_TASKS_URL + id + "/"); },
    createLink: function (data) { return apiRequest("POST", window.BOARD_API_LINKS_URL, data); },
    deleteLink: function (id) { return apiRequest("DELETE", window.BOARD_API_LINKS_URL + id + "/"); },
    createProject: function (data) { return apiRequest("POST", window.BOARD_API_PROJECTS_URL, data); },
    updateProject: function (id, data) { return apiRequest("PATCH", window.BOARD_API_PROJECTS_URL + id + "/", data); },
    deleteProject: function (id) { return apiRequest("DELETE", window.BOARD_API_PROJECTS_URL + id + "/"); },
    createTransition: function (data) { return apiRequest("POST", window.BOARD_API_TRANSITIONS_URL, data); },
    updateTransition: function (id, data) { return apiRequest("PATCH", window.BOARD_API_TRANSITIONS_URL + id + "/", data); },
    deleteTransition: function (id) { return apiRequest("DELETE", window.BOARD_API_TRANSITIONS_URL + id + "/"); },
    createMarker: function (data) { return apiRequest("POST", window.BOARD_API_MARKERS_URL, data); },
    updateMarker: function (id, data) { return apiRequest("PATCH", window.BOARD_API_MARKERS_URL + id + "/", data); },
    deleteMarker: function (id) { return apiRequest("DELETE", window.BOARD_API_MARKERS_URL + id + "/"); },
  };

  /* ============ data ============ */
  // The board's entire client-side state lives in these module-level arrays,
  // fetched once from BOARD_DATA_URL at startup (see the "init" section at
  // the bottom) and mutated in place by drawer save/delete handlers. There is
  // no framework-managed reactivity: every mutation is followed by an
  // explicit rebuildIndexes() + render() call.
  var projects = [];
  var tasks = [];
  var links = [];
  var transitions = [];
  var markers = [];
  var canEdit = {};
  var currentUserId = null;
  var dependsOnIndex = {}; // successor id -> [predecessor task ids]
  var transitionsFromIndex = {}; // from_task id -> [transition objects]
  var markersByTask = {}; // task id -> [marker objects]
  var projectById = {};
  var taskById = {};
  var focusedMarkerId = null;
  var focusedTaskId = null;
  var lastRows = [];

  // Rebuilds every id -> object/list lookup table from the flat arrays above.
  // Must be called after any mutation to projects/tasks/links/transitions/
  // markers (create, update, delete) so the derived indexes stay in sync —
  // nothing here is incrementally maintained.
  function rebuildIndexes() {
    projectById = {};
    projects.forEach(function (p) { projectById[p.id] = p; });
    taskById = {};
    tasks.forEach(function (t) { taskById[t.id] = t; });
    dependsOnIndex = {};
    links.forEach(function (l) {
      dependsOnIndex[l.successor] = dependsOnIndex[l.successor] || [];
      dependsOnIndex[l.successor].push(l.predecessor);
    });
    transitionsFromIndex = {};
    transitions.forEach(function (tr) {
      transitionsFromIndex[tr.from_task] = transitionsFromIndex[tr.from_task] || [];
      transitionsFromIndex[tr.from_task].push(tr);
    });
    markersByTask = {};
    markers.forEach(function (m) {
      markersByTask[m.task] = markersByTask[m.task] || [];
      markersByTask[m.task].push(m);
    });
  }

  // Project's display color: an explicit p.color if set, else a deterministic
  // fallback picked from the fixed palette by project id.
  function projectColor(p) {
    return p.color || PROJECT_COLORS[p.id % PROJECT_COLORS.length];
  }

  /* ============ accessors ============ */
  function taskStartDate(t) { return parseDate(t.start_date); }
  function taskEndDate(t) { return parseDate(t.end_date); }
  function taskProgressPct(t) { return Math.round((t.progress || 0) * 100); } // API stores progress as 0..1
  function taskParentId(t) { return t.parent; }
  function taskProjectId(t) { return t.project; }

  /* ============ hierarchy ============ */
  function childrenOf(taskId) { return tasks.filter(function (t) { return (t.parent || null) === taskId; }); }
  function isLeaf(taskId) { return childrenOf(taskId).length === 0; }
  // All descendant task ids of taskId (children, grandchildren, ...), depth-first.
  // `seen` guards against revisiting the same id twice if the tree data is
  // malformed (e.g. a task that ends up its own descendant).
  function descendantIds(taskId, seen) {
    seen = seen || {};
    var ids = [];
    childrenOf(taskId).forEach(function (c) {
      if (seen[c.id]) return;
      seen[c.id] = true;
      ids.push(c.id);
      ids = ids.concat(descendantIds(c.id, seen));
    });
    return ids;
  }
  // Height of the subtree rooted at taskId (0 for a leaf). depthGuard caps
  // recursion at 20 levels so a corrupt/cyclic parent chain (e.g. bad data
  // from a bulk import) can't blow the call stack — it just silently treats
  // anything past that depth as a leaf.
  function taskSubtreeDepth(taskId, depthGuard) {
    depthGuard = depthGuard || 0;
    var kids = childrenOf(taskId);
    if (kids.length === 0 || depthGuard > 20) return 0;
    return 1 + kids.reduce(function (mx, k) { return Math.max(mx, taskSubtreeDepth(k.id, depthGuard + 1)); }, 0);
  }
  // Top-level (parentless) tasks visible in the current view: all projects'
  // top-level tasks in portfolio view, or just the open project's in drill-in view.
  function topLevelTasksInScope() {
    if (state.view === 'portfolio') {
      return tasks.filter(function (t) { return !t.parent; });
    }
    var project = projectById[state.view];
    return project ? tasks.filter(function (t) { return t.project === project.id && !t.parent; }) : [];
  }
  // Highest useful value for the "Collapse to level" dropdown: 1 (just
  // projects expanded) plus however many levels of task nesting actually
  // exist in the current view, so "Expand all" always reaches the deepest task.
  function computeMaxCollapseLevel() {
    var topTasks = topLevelTasksInScope();
    var taskDepth = topTasks.reduce(function (mx, t) { return Math.max(mx, taskSubtreeDepth(t.id)); }, 0);
    return 1 + taskDepth;
  }
  // Expands (sets state.expanded[id] = true) every task whose depth from a
  // top-level task is <= maxDepth, walking each top-level task's subtree.
  function expandTasksToDepth(maxDepth) {
    if (maxDepth < 0) return;
    function walk(taskId, depth) {
      var kids = childrenOf(taskId);
      if (kids.length === 0) return;
      if (depth <= maxDepth) {
        state.expanded[taskId] = true;
        kids.forEach(function (k) { walk(k.id, depth + 1); });
      }
    }
    topLevelTasksInScope().forEach(function (t) { walk(t.id, 0); });
  }

  // Expands every ancestor row (and the owning project's row) of a task, so a
  // task nested under collapsed parents can be scrolled into view.
  function expandAncestorsOf(taskId) {
    var t = taskById[taskId];
    var guard = 0;
    while (t && t.parent && guard < 30) {
      state.expanded[t.parent] = true;
      t = taskById[t.parent];
      guard++;
    }
    var top = taskById[taskId];
    var topGuard = 0;
    while (top && top.parent && topGuard < 30) { top = taskById[top.parent]; topGuard++; }
    if (top) state.expanded['p' + top.project] = true;
  }

  // Focuses a marker: expands whatever's collapsed so its row exists, marks it
  // as the focused marker (drives the highlight styling on both the timeline
  // badge and the legend card), re-renders, then scrolls both into view.
  function focusMarker(markerId) {
    var m = markers.filter(function (x) { return x.id === markerId; })[0];
    if (!m) return;
    expandAncestorsOf(m.task);
    focusedMarkerId = markerId;
    render();
    requestAnimationFrame(function () {
      var el = document.querySelector('.board-task-marker[data-marker-id="' + markerId + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      var card = document.querySelector('.board-marker-card[data-marker-id="' + markerId + '"]');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // Highlights a task in both panes — its row in the left-hand tree and its
  // bar on the gantt — whichever one was clicked, mirroring how clicking a
  // marker badge highlights its legend card (and vice versa).
  function focusTask(taskId) {
    focusedTaskId = taskId;
    renderLabels(lastRows || []);
    var el = document.querySelector('.board-row-label[data-task-id="' + taskId + '"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.querySelectorAll('.board-bar.focused').forEach(function (b) { b.classList.remove('focused'); });
    var bar = document.querySelector('.board-bar[data-task-id="' + taskId + '"]');
    if (bar) {
      bar.classList.add('focused');
      bar.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }
  // Resets all expand/collapse state and re-expands rows up to `level` (0 =
  // everything collapsed, 1 = just projects open, 2+ = that many task levels
  // open too), driven by the "Collapse to level" dropdown.
  function applyCollapseLevel(level) {
    level = parseInt(level, 10);
    state.expanded = {};
    if (state.view === 'portfolio') {
      if (level >= 1) projects.forEach(function (p) { state.expanded['p' + p.id] = true; });
    } else {
      var project = projectById[state.view];
      if (project && level >= 1) state.expanded['p' + project.id] = true;
    }
    expandTasksToDepth(level - 2);
    state.collapseLevel = level;
    fitToView();
  }
  function renderCollapseLevelControl() {
    var select = document.getElementById('board-collapse-level');
    var maxLevel = computeMaxCollapseLevel();
    var options = [];
    // When rows were expanded/collapsed by hand (via row chevrons) rather than
    // through this control, state.collapseLevel is null — show a placeholder
    // so the control's displayed value doesn't silently claim to already match
    // "Collapse all"/etc., which would stop a re-selection from firing change.
    if (state.collapseLevel === null) {
      options.push('<option value="" selected disabled>—</option>');
    }
    for (var i = 0; i <= maxLevel; i++) {
      var label = i === 0 ? 'Collapse all' : (i === maxLevel ? 'Expand all (' + i + ')' : String(i));
      options.push('<option value="' + i + '">' + label + '</option>');
    }
    select.innerHTML = options.join('');
    if (state.collapseLevel !== null) select.value = String(Math.min(state.collapseLevel, maxLevel));
    select.onchange = function () {
      if (select.value === '') return;
      applyCollapseLevel(select.value);
    };
  }

  // ---- Recursive rollup functions ----
  // A "summary" task (one with children) has no start/end/progress/budget/
  // status of its own in any meaningful sense — the four functions below
  // (taskRange, taskProgress, taskBudgetRollup, taskStatusRollup) derive
  // those values on the fly by recursing down to its leaf descendants and
  // aggregating. They're called every render (rendering is cheap enough
  // that caching hasn't been needed) and share the same shape: a leaf task
  // (childrenOf(taskId).length === 0) returns its own field, a summary task
  // combines its children's rolled-up values. `depthGuard` (capped at 20)
  // exists purely so a malformed/cyclic parent chain can't recurse forever —
  // past that depth a node is just treated as if it were a leaf.

  // Rolled-up {start, end} span of a task: the earliest start and latest end
  // across all of its descendant leaves (a summary task's bar always spans
  // exactly its children's combined date range).
  function taskRange(taskId, depthGuard) {
    depthGuard = depthGuard || 0;
    var t = taskById[taskId];
    if (!t) return { start: TODAY, end: TODAY };
    var kids = childrenOf(taskId);
    if (kids.length === 0 || depthGuard > 20) return { start: taskStartDate(t), end: taskEndDate(t) };
    var mn = null, mx = null;
    kids.forEach(function (k) {
      var r = taskRange(k.id, depthGuard + 1);
      if (mn === null || r.start < mn) mn = r.start;
      if (mx === null || r.end > mx) mx = r.end;
    });
    return { start: mn, end: mx };
  }
  // Rolled-up progress percentage: a summary task's progress is the plain
  // (unweighted) average of its children's rolled-up progress — a task with
  // ten small subtasks and one big one still averages them equally.
  function taskProgress(taskId, depthGuard) {
    depthGuard = depthGuard || 0;
    var t = taskById[taskId];
    if (!t) return 0;
    var kids = childrenOf(taskId);
    if (kids.length === 0 || depthGuard > 20) return taskProgressPct(t);
    var sum = 0;
    kids.forEach(function (k) { sum += taskProgress(k.id, depthGuard + 1); });
    return Math.round(sum / kids.length);
  }
  // Rolled-up budget: sum of all descendant leaves' budgets (unlike progress,
  // budget rolls up additively, not as an average).
  function taskBudgetRollup(taskId, depthGuard) {
    depthGuard = depthGuard || 0;
    var t = taskById[taskId];
    if (!t) return 0;
    var kids = childrenOf(taskId);
    if (kids.length === 0 || depthGuard > 20) return parseFloat(t.budget || 0);
    var sum = 0;
    kids.forEach(function (k) { sum += taskBudgetRollup(k.id, depthGuard + 1); });
    return sum;
  }
  // Rolled-up status: worst-case aggregation, not an average — a summary
  // task is 'at_risk' if *any* descendant is at_risk (risk is contagious
  // upward), 'complete' only if *every* descendant is complete, and
  // 'on_track' otherwise (the default/optimistic middle state).
  function taskStatusRollup(taskId, depthGuard) {
    depthGuard = depthGuard || 0;
    var t = taskById[taskId];
    if (!t) return 'on_track';
    var kids = childrenOf(taskId);
    if (kids.length === 0 || depthGuard > 20) return t.status;
    var statuses = kids.map(function (k) { return taskStatusRollup(k.id, depthGuard + 1); });
    if (statuses.indexOf('at_risk') > -1) return 'at_risk';
    if (statuses.every(function (s) { return s === 'complete'; })) return 'complete';
    return 'on_track';
  }

  var STATUS_LABEL = { on_track: 'On track', at_risk: 'At risk', complete: 'Complete' };

  /* ============ state ============ */
  // All UI state that isn't derived from the server data lives here: which
  // view is open, which rows are expanded, active search/filter, zoom, etc.
  // Every mutation to this object is followed by a render() call — there's
  // no separate "state changed" event system.
  var state = {
    view: 'portfolio',
    expanded: {},
    range: null,
    search: '',
    statusFilter: 'all',
    showCritical: false,
    pxPerDay: 22,
    markerSort: 'date',
    collapseLevel: 0,
  };

  // Drill into a project's own view, defaulting its row to expanded the first time
  // (so tasks show immediately) while respecting a prior manual collapse/expand.
  function enterProject(projectId) {
    state.view = projectId;
    if (!(('p' + projectId) in state.expanded)) state.expanded['p' + projectId] = true;
    fitToProject(projectId);
  }

  // Zooms so the project's full date span (plus a few days' margin) fills the
  // visible timeline width, then scrolls its start into view. Renders.
  function fitToProject(projectId) {
    var s = projectStats(projectId);
    fitToSpan(s.start, s.end);
  }

  // Same as fitToProject, but for whatever the current view shows: one
  // project, or every project with tasks in the portfolio view.
  function fitToView() {
    if (state.view !== 'portfolio') return fitToProject(state.view);
    var mn = null, mx = null;
    projects.forEach(function (p) {
      if (!tasks.some(function (t) { return t.project === p.id; })) return;
      var s = projectStats(p.id);
      if (mn === null || s.start < mn) mn = s.start;
      if (mx === null || s.end > mx) mx = s.end;
    });
    if (mn === null) { mn = TODAY; mx = TODAY; }
    fitToSpan(mn, mx);
  }

  function fitToSpan(spanStart, spanEnd) {
    var ts = document.getElementById('board-timeline-scroll');
    var start = addDays(spanStart, -FIT_MARGIN_DAYS), end = addDays(spanEnd, FIT_MARGIN_DAYS);
    var days = Math.max(dayDiff(start, end), 1);
    state.pxPerDay = clampZoom(ts.clientWidth / days);
    computeRange();
    render();
    ts.scrollLeft = Math.max(0, xFor(start));
  }

  /* ============ range ============ */
  // Computes the full date span (state.range) the timeline should draw,
  // based on every leaf task's start/end across ALL projects (not just the
  // current view, so switching projects doesn't jitter the horizontal
  // scale). Pads 14 days before the earliest start and 21 days after the
  // latest end for breathing room, and falls back to a window around today
  // when there are no tasks at all. Must be re-run whenever pxPerDay (zoom)
  // or the task set changes, since totalWidth depends on both.
  function computeRange() {
    var mn = null, mx = null;
    tasks.filter(function (t) { return isLeaf(t.id); }).forEach(function (t) {
      var s = taskStartDate(t), e = taskEndDate(t);
      if (mn === null || s < mn) mn = s;
      if (mx === null || e > mx) mx = e;
    });
    if (mn === null) { mn = addDays(TODAY, -14); mx = addDays(TODAY, 14); }
    mn = addDays(mn, -14);
    mx = addDays(mx, 21);
    var totalDays = dayDiff(mn, mx);
    state.range = { start: mn, end: mx, totalDays: totalDays, totalWidth: totalDays * state.pxPerDay };
  }
  // Pixel x-offset of date d within the timeline, relative to state.range.start.
  function xFor(d) { return dayDiff(state.range.start, d) * state.pxPerDay; }

  /* ============ filtering ============ */
  // Whether a search/status filter is currently narrowing the row set (as
  // opposed to just showing everything).
  function activeFilter() {
    return state.search.trim() !== '' || state.statusFilter !== 'all';
  }
  // Whether a single task matches the active search text (name or assignee,
  // case-insensitive substring) AND the active status chip (compared against
  // its *rolled-up* status, so a summary task matches a status filter based
  // on its worst-case descendant, not a status field it doesn't really have).
  function taskMatches(t) {
    var q = state.search.trim().toLowerCase();
    var assigneeName = t.assignee_name || '';
    var textOk = !q || t.name.toLowerCase().indexOf(q) > -1 || assigneeName.toLowerCase().indexOf(q) > -1;
    var statusOk = state.statusFilter === 'all' || taskStatusRollup(t.id) === state.statusFilter;
    return textOk && statusOk;
  }
  // Whether a project's own name/owner matches the active search text
  // (status chip filtering doesn't apply to the project row itself, only tasks).
  function projectMatches(p) {
    var q = state.search.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().indexOf(q) > -1 || (p.owner_name || '').toLowerCase().indexOf(q) > -1;
  }

  /* ============ critical path ============ */
  // Computes the critical path for project pid: the chain of tasks that
  // directly determines the project's overall finish date. This is a
  // simplified backward walk, not a full CPM (critical-path-method) slack
  // calculation:
  //   1. Find the project's overall finish date (the latest rolled-up end
  //      date among its tasks).
  //   2. Pick whichever task(s) actually finish on that date as the start of
  //      the walk — preferring the one with the most predecessors (a proxy
  //      for "most likely to be the true driver" when several tasks tie on
  //      end date).
  //   3. Repeatedly step backward to each current task's predecessor (via
  //      dependsOnIndex) that itself finishes latest — i.e. the predecessor
  //      most likely to be *why* the current task couldn't start sooner —
  //      recording each hop as a critical edge, until a task has no
  //      predecessors or the 200-step guard trips (cycle/bad-data safety net).
  // Returns { taskIds: {id: true}, edges: {"predId>succId": true} } used by
  // renderTimeline to bold the critical bars/arrows.
  function computeCriticalPath(pid) {
    var pt = tasks.filter(function (t) { return t.project === pid; });
    var result = { taskIds: {}, edges: {} };
    if (pt.length === 0) return result;
    var finish = pt.reduce(function (mx, t) { var e = taskRange(t.id).end; return e > mx ? e : mx; }, taskRange(pt[0].id).end);
    var candidates = pt.filter(function (t) { return taskRange(t.id).end.getTime() === finish.getTime(); });
    candidates.sort(function (a, b) { return (dependsOnIndex[b.id] || []).length - (dependsOnIndex[a.id] || []).length; });
    var current = candidates[0];
    if (!current) return result;
    result.taskIds[current.id] = true;
    var guard = 0;
    while (current && (dependsOnIndex[current.id] || []).length && guard < 200) { // 200-step cap guards against a dependency cycle
      guard++;
      var preds = (dependsOnIndex[current.id] || []).map(function (id) { return taskById[id]; }).filter(Boolean);
      if (preds.length === 0) break;
      preds.sort(function (a, b) { return taskRange(b.id).end - taskRange(a.id).end; });
      var next = preds[0];
      result.edges[next.id + '>' + current.id] = true;
      result.taskIds[next.id] = true;
      current = next;
    }
    return result;
  }

  /* ============ derived rows ============ */
  // Aggregate stats for a project's row: date span and average progress
  // across its top-level tasks' rolled-up values, plus a leaf-level at-risk
  // count/total (used for the "X / Y at risk" stat and the project's own
  // summary bar).
  function projectStats(pid) {
    var topTasks = tasks.filter(function (t) { return t.project === pid && !t.parent; });
    if (topTasks.length === 0) return { start: TODAY, end: TODAY, progress: 0, atrisk: 0, total: 0 };
    var mn = null, mx = null, sum = 0;
    topTasks.forEach(function (t) {
      var r = taskRange(t.id);
      if (mn === null || r.start < mn) mn = r.start;
      if (mx === null || r.end > mx) mx = r.end;
      sum += taskProgress(t.id);
    });
    var leaves = tasks.filter(function (t) { return t.project === pid && isLeaf(t.id); });
    var atrisk = leaves.filter(function (t) { return t.status === 'at_risk'; }).length;
    return { start: mn, end: mx, progress: Math.round(sum / topTasks.length), atrisk: atrisk, total: leaves.length };
  }
  // Project's total budget: sum of its top-level tasks' rolled-up budgets
  // (each top-level task's rollup already sums its own subtree, so this
  // isn't double-counting descendants).
  function projectBudget(pid) {
    var topTasks = tasks.filter(function (t) { return t.project === pid && !t.parent; });
    return topTasks.reduce(function (sum, t) { return sum + taskBudgetRollup(t.id); }, 0);
  }

  // Whether any descendant (at any depth) of taskId matches the active
  // filter — used so that filtering keeps a parent row visible (and
  // auto-expanded) whenever a nested child matches, even if the parent
  // itself doesn't.
  function hasMatchingDescendant(taskId) {
    return childrenOf(taskId).some(function (c) {
      return taskMatches(c) || hasMatchingDescendant(c.id);
    });
  }

  // Recursively appends visible task rows (in tree order) under parentTaskId
  // within `project` to `rows`. Row visibility/expansion depends on whether a
  // filter is active:
  //  - No filter: a task is shown if its parent is shown, and its children
  //    are shown only if the task is manually expanded (state.expanded).
  //  - Filtering: a task is shown if it matches OR any descendant matches
  //    (so matches stay reachable through non-matching ancestors), and in
  //    that case its subtree is force-expanded regardless of manual
  //    collapse state, so every match is immediately visible without the
  //    user having to hand-expand each ancestor.
  function pushTaskRows(rows, parentTaskId, project, depth, filtering) {
    childrenOf(parentTaskId).filter(function (t) { return t.project === project.id; }).forEach(function (t) {
      var selfMatches = !filtering || taskMatches(t);
      var subtreeMatches = filtering && hasMatchingDescendant(t.id);
      if (filtering && !selfMatches && !subtreeMatches) return;
      var hasKids = !isLeaf(t.id);
      rows.push({ type: 'task', task: t, project: project, depth: depth, hasChildren: hasKids });
      var shouldExpand = state.expanded[t.id] || (filtering && subtreeMatches);
      if (hasKids && shouldExpand) {
        pushTaskRows(rows, t.id, project, depth + 1, filtering);
      }
    });
  }

  // Builds the flat list of rows to render this pass (one entry per visible
  // project/task row, in display order) — the single source of truth every
  // other render* function consumes. Applies the same "show if self or a
  // descendant matches, force-expand when filtering" logic as pushTaskRows,
  // but one level up for project rows: a project row is hidden entirely when
  // filtering if none of its tasks match AND its own name/owner doesn't
  // match the search text (status-chip filters never match a project row
  // directly, hence the `state.statusFilter === 'all'` check on selfMatch).
  function buildRows() {
    var rows = [];
    var filtering = activeFilter();
    if (state.view === 'portfolio') {
      projects.forEach(function (p) {
        var topTasks = tasks.filter(function (t) { return t.project === p.id && !t.parent; });
        var matchingTop = filtering ? topTasks.filter(function (t) { return taskMatches(t) || hasMatchingDescendant(t.id); }) : topTasks;
        if (filtering) {
          var selfMatch = state.statusFilter === 'all' && projectMatches(p);
          if (matchingTop.length === 0 && !selfMatch) return;
        }
        rows.push({ type: 'project', project: p });
        var shouldExpand = state.expanded['p' + p.id] || (filtering && matchingTop.length > 0);
        if (shouldExpand) {
          pushTaskRows(rows, null, p, 0, filtering);
        }
      });
    } else {
      var project = projectById[state.view];
      if (project) {
        var topTasks = tasks.filter(function (t) { return t.project === project.id && !t.parent; });
        var matchingTop = filtering ? topTasks.filter(function (t) { return taskMatches(t) || hasMatchingDescendant(t.id); }) : topTasks;
        rows.push({ type: 'project', project: project });
        var shouldExpand = state.expanded['p' + project.id] || (filtering && matchingTop.length > 0);
        if (shouldExpand) {
          pushTaskRows(rows, null, project, 0, filtering);
        }
      }
    }
    return rows;
  }

  /* ============ rendering ============ */
  // Full re-render entry point: rebuilds the row list from current state,
  // then redraws every panel from it. There's no incremental/diffed DOM
  // update — each of these render* calls clears and rebuilds its target
  // element's innerHTML from scratch, which is simple and fast enough at
  // this app's scale. Call this (not the individual render* functions)
  // after any state or data mutation.
  function render() {
    renderCrumbsAndAdd();
    renderFilterBar();
    renderStats();
    renderHeader();
    renderCollapseLevelControl();
    var rows = buildRows();
    lastRows = rows;
    var markerNumbers = computeMarkerNumbers();
    renderLabels(rows);
    renderTimeline(rows, markerNumbers);
    renderMarkersPanel(markerNumbers);
    syncHeaderScroll();
  }

  // Numbers each milestone/key-event/decision-point independently within its own
  // type, in date order, scoped to the current view — shared by the timeline
  // overlay markers and the right-side panel so the same marker shows the same
  // number in both places.
  function computeMarkerNumbers() {
    var scopeTaskIds = null;
    if (state.view !== 'portfolio') {
      scopeTaskIds = {};
      tasks.forEach(function (t) { if (t.project === state.view) scopeTaskIds[t.id] = true; });
    }
    var byType = {};
    markers.filter(function (m) {
      return (!scopeTaskIds || scopeTaskIds[m.task]) && taskById[m.task];
    }).forEach(function (m) {
      byType[m.marker_type] = byType[m.marker_type] || [];
      byType[m.marker_type].push(m);
    });
    var numbers = {};
    Object.keys(byType).forEach(function (type) {
      byType[type].sort(function (a, b) {
        if (a.on_date !== b.on_date) return a.on_date < b.on_date ? -1 : 1;
        return a.id - b.id;
      });
      byType[type].forEach(function (m, i) { numbers[m.id] = i + 1; });
    });
    return numbers;
  }

  // Renders the breadcrumb trail and the top-right "+ Add" / "Edit project"
  // buttons for the current view, and reflects the view in the URL. Uses
  // history.replaceState (not pushState / a real route change) because this
  // is a single-page board with no server-rendered routes to navigate to —
  // switching views is a pure client-side state change, so we only want the
  // URL bar/reload/share-link to reflect the current view without adding a
  // browser-history entry for every project the user clicks into.
  function renderCrumbsAndAdd() {
    var crumbs = document.getElementById('board-crumbs');
    var addBtn = document.getElementById('board-add-btn');
    var editBtn = document.getElementById('board-edit-project-btn');
    // Second "All Projects" link in the board's corner header, so there's a
    // way back without scrolling up to the toolbar crumbs.
    var cornerBack = document.getElementById('board-corner-back');
    cornerBack.style.display = state.view === 'portfolio' ? 'none' : '';
    cornerBack.onclick = function () { state.view = 'portfolio'; render(); };
    if (state.view === 'portfolio') {
      crumbs.innerHTML = '<span class="current">All Projects</span>';
      addBtn.textContent = '+ Add Project';
      addBtn.style.display = '';
      addBtn.onclick = function () { openProjectDrawer(null); };
      editBtn.style.display = 'none';
      history.replaceState(null, '', location.pathname);
    } else {
      var p = projectById[state.view];
      if (!p) { state.view = 'portfolio'; return renderCrumbsAndAdd(); }
      crumbs.innerHTML = '';
      var back = document.createElement('button');
      back.textContent = 'All Projects';
      back.onclick = function () { state.view = 'portfolio'; render(); };
      crumbs.appendChild(back);
      var sep = document.createElement('span'); sep.textContent = '/'; crumbs.appendChild(sep);
      var cur = document.createElement('span'); cur.className = 'current'; cur.textContent = p.name;
      crumbs.appendChild(cur);
      addBtn.textContent = '+ Add Task';
      addBtn.style.display = canEdit[p.id] ? '' : 'none';
      addBtn.onclick = function () { openTaskDrawer(null, p.id); };
      editBtn.style.display = canEdit[p.id] ? '' : 'none';
      editBtn.onclick = function () { openProjectDrawer(p.id); };
      history.replaceState(null, '', location.pathname + '?project=' + p.id);
    }
  }

  // Wires up (and syncs the displayed value of) the search box, status
  // chips, critical-path toggle, export/import links, zoom controls, and
  // snapshot button. Re-runs every render() so the DOM always reflects
  // current state and every control's src/href/onclick is freshly bound to
  // this render's closures.
  function renderFilterBar() {
    var si = document.getElementById('board-search');
    if (si.value !== state.search) si.value = state.search;
    si.oninput = function () { state.search = si.value; render(); };

    var chipsEl = document.getElementById('board-status-chips');
    var opts = [['all', 'All'], ['on_track', 'On track'], ['at_risk', 'At risk'], ['complete', 'Complete']];
    chipsEl.innerHTML = '';
    opts.forEach(function (o) {
      var c = document.createElement('div');
      c.className = 'board-chip' + (state.statusFilter === o[0] ? ' active ' + o[0] : '');
      c.textContent = o[1];
      c.onclick = function () { state.statusFilter = o[0]; render(); };
      chipsEl.appendChild(c);
    });

    var critBtn = document.getElementById('board-critical-btn');
    critBtn.classList.toggle('active', state.showCritical && state.view !== 'portfolio');
    critBtn.disabled = (state.view === 'portfolio');
    critBtn.style.opacity = critBtn.disabled ? '0.4' : '1';
    critBtn.title = state.view === 'portfolio' ? 'Open a project to see its critical path' : 'Highlight the chain of tasks driving this project\'s finish date';
    critBtn.onclick = function () { state.showCritical = !state.showCritical; render(); };

    var exportLink = document.getElementById('board-export-csv');
    var exportJsonLink = document.getElementById('board-export-json');
    if (state.view === 'portfolio') {
      exportLink.href = window.BOARD_EXPORT_PORTFOLIO_CSV_URL;
      exportJsonLink.href = window.BOARD_EXPORT_PORTFOLIO_JSON_URL;
    } else {
      exportLink.href = window.BOARD_EXPORT_PROJECT_CSV_TEMPLATE.replace('/0/', '/' + state.view + '/');
      exportJsonLink.href = window.BOARD_EXPORT_PROJECT_JSON_TEMPLATE.replace('/0/', '/' + state.view + '/');
    }

    var zoomSlider = document.getElementById('board-zoom-slider');
    zoomSlider.value = state.pxPerDay;
    zoomSlider.oninput = function () { zoomTo(parseInt(zoomSlider.value, 10)); };
    document.getElementById('board-zoom-in').onclick = function () { zoomTo(state.pxPerDay + 4); };
    document.getElementById('board-zoom-out').onclick = function () { zoomTo(state.pxPerDay - 4); };

    document.getElementById('board-snapshot-btn').onclick = takeSnapshot;
  }

  function clampZoom(px) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, px)); }

  // Changes the horizontal zoom (pixels per day), clamped to [ZOOM_MIN, ZOOM_MAX], while
  // keeping the day currently centered in the viewport centered after the
  // resize — computed by converting the current scroll center to a "day"
  // under the old scale, then converting back under the new scale.
  function zoomTo(px) {
    px = clampZoom(px);
    var ts = document.getElementById('board-timeline-scroll');
    var centerDay = state.range ? (ts.scrollLeft + ts.clientWidth / 2) / state.pxPerDay : 0;
    state.pxPerDay = px;
    computeRange();
    render();
    ts.scrollLeft = Math.max(0, centerDay * state.pxPerDay - ts.clientWidth / 2);
  }

  // Renders the stat strip (budget/progress/at-risk counts etc.) and legend
  // for the current view — portfolio-wide totals or a single project's stats.
  function renderStats() {
    var el = document.getElementById('board-stat-strip');
    var filtering = activeFilter();
    if (state.view === 'portfolio') {
      var totalBudget = projects.reduce(function (s, p) { return s + projectBudget(p.id); }, 0);
      var leafAll = tasks.filter(function (t) { return isLeaf(t.id); });
      var atRisk = leafAll.filter(function (t) { return t.status === 'at_risk'; }).length;
      var doneish = leafAll.filter(function (t) { return t.status === 'complete'; }).length;
      el.innerHTML =
        stat(projects.length, 'Projects') +
        stat(fmtBudgetM(totalBudget), 'Combined budget') +
        stat(atRisk, 'Tasks at risk') +
        stat(doneish + ' / ' + leafAll.length, 'Tasks complete') +
        (filtering ? stat(tasks.filter(taskMatches).length + ' / ' + tasks.length, 'Matching filter') : '') +
        legendHTML();
    } else {
      var p = projectById[state.view];
      if (!p) { el.innerHTML = ''; return; }
      var pt = tasks.filter(function (t) { return t.project === p.id; });
      var s = projectStats(p.id);
      el.innerHTML =
        stat(fmtBudgetM(projectBudget(p.id)), 'Budget') +
        stat(p.owner_name || '—', 'Owner') +
        stat(s.progress + '%', 'Avg. progress') +
        stat(s.atrisk + ' / ' + s.total, 'At risk') +
        (filtering ? stat(pt.filter(taskMatches).length + ' / ' + pt.length, 'Matching filter') : '') +
        legendHTML();
    }
  }
  function stat(n, l) { return '<div class="board-stat"><div class="n mono">' + n + '</div><div class="l">' + l + '</div></div>'; } // one number+label tile in the stat strip
  // Legend HTML for the stat strip: status color key + marker symbol key,
  // plus a critical-path entry only when that highlight is actually active.
  function legendHTML() {
    var crit = (state.showCritical && state.view !== 'portfolio') ?
      '<span class="item"><span class="board-dot" style="background:var(--critical)"></span>Critical path</span>' : '';
    return '<div class="board-legend">' +
      '<span class="item"><span class="board-dot" style="background:var(--ontrack)"></span>On track</span>' +
      '<span class="item"><span class="board-dot" style="background:var(--risk)"></span>At risk</span>' +
      '<span class="item"><span class="board-dot" style="background:var(--complete)"></span>Complete</span>' +
      '<span class="item">' + MARKER_TYPES.milestone.symbol + ' Milestone</span>' +
      '<span class="item"><span style="color:' + MARKER_TYPES.key_event.color + '">' + MARKER_TYPES.key_event.symbol + '</span> Key event</span>' +
      '<span class="item"><span style="color:' + MARKER_TYPES.decision_point.color + '">' + MARKER_TYPES.decision_point.symbol + '</span> Decision point</span>' +
      crit +
      '</div>';
  }

  function markerDateCompare(a, b) { return a.on_date < b.on_date ? -1 : (a.on_date > b.on_date ? 1 : 0); } // ISO "YYYY-MM-DD" strings sort correctly lexically

  // Renders the right-hand markers panel: every milestone/key-event/
  // decision-point marker in scope (current project, or everything in
  // portfolio view), either as one flat date-sorted list or grouped by type,
  // per state.markerSort. Shares markerNumbers with renderTimeline so a
  // marker's badge number matches between the timeline and its panel card.
  function renderMarkersPanel(markerNumbers) {
    var list = document.getElementById('board-markers-list');
    if (!list) return;
    var sortSelect = document.getElementById('board-markers-sort');
    if (sortSelect) {
      if (sortSelect.value !== state.markerSort) sortSelect.value = state.markerSort;
      sortSelect.onchange = function () { state.markerSort = sortSelect.value; renderMarkersPanel(markerNumbers); };
    }
    var scopeTaskIds = null;
    if (state.view !== 'portfolio') {
      scopeTaskIds = {};
      tasks.forEach(function (t) { if (t.project === state.view) scopeTaskIds[t.id] = true; });
    }
    var items = markers.filter(function (m) {
      return (!scopeTaskIds || scopeTaskIds[m.task]) && taskById[m.task];
    });

    list.innerHTML = '';
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'board-markers-empty';
      empty.textContent = 'No milestones, key events, or decision points yet.';
      list.appendChild(empty);
      return;
    }

    function buildCard(m) {
      var t = taskById[m.task];
      var markerDef = MARKER_TYPES[m.marker_type];
      var card = document.createElement('div');
      card.className = 'board-marker-card' + (m.id === focusedMarkerId ? ' focused' : '');
      card.dataset.markerId = m.id;
      var sym = document.createElement('div'); sym.className = 'symbol';
      sym.style.color = markerDef.color || projectColor(projectById[t.project]);
      sym.textContent = markerDef.symbol;
      card.appendChild(sym);
      var meta = document.createElement('div'); meta.className = 'meta';
      var title = document.createElement('div'); title.className = 'title';
      title.textContent = markerDef.label + ' ' + markerNumbers[m.id] + ' — ' + t.name;
      meta.appendChild(title);
      var sub = document.createElement('div'); sub.className = 'sub';
      sub.textContent = fmtShort(parseDate(m.on_date));
      meta.appendChild(sub);
      if (m.description) {
        var desc = document.createElement('div'); desc.className = 'desc';
        desc.textContent = m.description;
        meta.appendChild(desc);
      }
      card.appendChild(meta);
      card.onclick = function () { openTaskDrawer(t.id, t.project); focusMarker(m.id); };
      return card;
    }

    if (state.markerSort === 'type') {
      ['milestone', 'key_event', 'decision_point'].forEach(function (type) {
        var group = items.filter(function (m) { return m.marker_type === type; }).sort(markerDateCompare);
        if (!group.length) return;
        var groupHead = document.createElement('div'); groupHead.className = 'board-markers-group-head';
        groupHead.textContent = MARKER_TYPES[type].label + 's';
        list.appendChild(groupHead);
        group.forEach(function (m) { list.appendChild(buildCard(m)); });
      });
    } else {
      items.slice().sort(markerDateCompare).forEach(function (m) { list.appendChild(buildCard(m)); });
    }
  }

  // Renders the timeline header: fiscal-year bands, fiscal-quarter bands,
  // and (when zoomed in enough — pxPerDay >= 10, else month labels would be
  // too cramped to read) month bands, each clipped to state.range.
  function renderHeader() {
    var inner = document.getElementById('board-tl-head-inner');
    inner.style.width = state.range.totalWidth + 'px';
    inner.innerHTML = '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    getFYSegments(state.range.start, state.range.end).forEach(function (seg) {
      var band = document.createElement('div');
      band.className = 'board-fy-band';
      band.style.left = xFor(seg.start) + 'px';
      band.style.width = (xFor(seg.end) - xFor(seg.start)) + 'px';
      band.textContent = 'FY' + String(seg.fy).slice(-2);
      inner.appendChild(band);
    });

    getQuarterSegments(state.range.start, state.range.end).forEach(function (seg) {
      var band = document.createElement('div');
      band.className = 'board-q-band';
      band.style.left = xFor(seg.start) + 'px';
      band.style.width = (xFor(seg.end) - xFor(seg.start)) + 'px';
      band.textContent = 'Q' + seg.q;
      inner.appendChild(band);
    });

    if (state.pxPerDay >= 10) {
      var d = new Date(Date.UTC(state.range.start.getUTCFullYear(), state.range.start.getUTCMonth(), 1));
      while (d < state.range.end) {
        var next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
        var segStart = d < state.range.start ? state.range.start : d;
        var segEnd = next > state.range.end ? state.range.end : next;
        var band = document.createElement('div');
        band.className = 'board-month-band';
        band.style.left = xFor(segStart) + 'px';
        band.style.width = (xFor(segEnd) - xFor(segStart)) + 'px';
        band.textContent = months[d.getUTCMonth()] + " '" + String(d.getUTCFullYear()).slice(2);
        inner.appendChild(band);
        d = next;
      }
    }
  }

  // Renders the left-hand label column (project/task names, chevrons,
  // swatches, budget badges) from `rows`, absolutely positioning each row by
  // index * ROW_H so it lines up with the corresponding timeline row drawn
  // by renderTimeline from the same `rows` array.
  function renderLabels(rows) {
    var inner = document.getElementById('board-label-inner');
    inner.style.height = (rows.length * ROW_H) + 'px';
    inner.innerHTML = '';
    rows.forEach(function (r, i) {
      var row = document.createElement('div');
      row.className = 'board-row-label ' + r.type + (r.type === 'task' && r.task.id === focusedTaskId ? ' focused' : '');
      row.style.top = (i * ROW_H) + 'px'; row.style.height = ROW_H + 'px';
      if (r.type === 'task') row.dataset.taskId = r.task.id;
      if (r.type === 'project') {
        var chev = document.createElement('span');
        chev.className = 'chev' + (state.expanded['p' + r.project.id] ? ' expanded' : '');
        chev.textContent = '▸';
        chev.onclick = function (e) { e.stopPropagation(); state.expanded['p' + r.project.id] = !state.expanded['p' + r.project.id]; state.collapseLevel = null; render(); }; // null = manual override, no longer tracks a dropdown level
        row.appendChild(chev);
        var sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = projectColor(r.project);
        row.appendChild(sw);
        var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = r.project.name;
        row.appendChild(nm);
        var bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = fmtBudgetM(projectBudget(r.project.id));
        row.appendChild(bd);
        row.onclick = function () { enterProject(r.project.id); };
      } else {
        var depth = r.depth || 0;
        var depthSpacer = document.createElement('span');
        depthSpacer.style.width = (depth * 16) + 'px'; depthSpacer.style.flexShrink = '0';
        row.appendChild(depthSpacer);
        if (r.hasChildren) {
          var tchev = document.createElement('span');
          tchev.className = 'chev' + (state.expanded[r.task.id] ? ' expanded' : '');
          tchev.textContent = '▸';
          tchev.onclick = function (e) { e.stopPropagation(); state.expanded[r.task.id] = !state.expanded[r.task.id]; state.collapseLevel = null; render(); }; // same manual-override reset as the project chevron above
          row.appendChild(tchev);
        } else {
          var noChev = document.createElement('span'); noChev.style.width = '32px'; noChev.style.flexShrink = '0';
          row.appendChild(noChev);
        }
        var sw2 = document.createElement('span'); sw2.className = 'swatch'; sw2.style.background = projectColor(r.project);
        row.appendChild(sw2);
        var nm2 = document.createElement('span'); nm2.className = 'name task'; nm2.textContent = r.task.name;
        row.appendChild(nm2);
        if (canEdit[r.project.id]) {
          var addSub = document.createElement('span');
          addSub.className = 'add-sub';
          addSub.textContent = '+';
          addSub.title = 'Add subtask under “' + r.task.name + '”';
          addSub.onclick = function (e) { e.stopPropagation(); state.expanded[r.task.id] = true; openTaskDrawer(null, r.project.id, r.task.id); };
          row.appendChild(addSub);
        }
        row.onclick = function () { openTaskDrawer(r.task.id, r.project.id); focusTask(r.task.id); };
      }
      inner.appendChild(row);
    });
  }

  // Renders everything in the main timeline pane for `rows`: per-row
  // click/zebra backgrounds, an SVG layer of dependency + transition arrows,
  // task/project bars (bold-outlined + critical-highlighted where
  // applicable), marker badges, and the "today" line. This is the single
  // largest render* function since the timeline is where most of the
  // board's visual complexity lives.
  function renderTimeline(rows, markerNumbers) {
    var inner = document.getElementById('board-timeline-inner');
    var totalH = rows.length * ROW_H;
    inner.style.width = state.range.totalWidth + 'px';
    inner.style.height = totalH + 'px';
    inner.innerHTML = '';

    var crit = (state.showCritical && state.view !== 'portfolio') ? computeCriticalPath(state.view) : { taskIds: {}, edges: {} };

    rows.forEach(function (r, i) {
      var bg = document.createElement('div');
      bg.className = 'board-row-bg clickable' + (i % 2 ? ' alt' : '');
      bg.style.top = (i * ROW_H) + 'px'; bg.style.height = ROW_H + 'px';
      bg.style.width = state.range.totalWidth + 'px';
      bg.style.backgroundImage = 'linear-gradient(to right, var(--line) 1px, transparent 1px)';
      bg.style.backgroundSize = (state.pxPerDay * 7) + 'px 100%';
      bg.style.backgroundRepeat = 'repeat-x';
      if (r.type === 'project') {
        bg.onclick = function () { enterProject(r.project.id); };
      } else {
        bg.onclick = function () { openTaskDrawer(r.task.id, r.project.id); };
      }
      inner.appendChild(bg);
    });

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'board-deps');
    svg.setAttribute('width', state.range.totalWidth);
    svg.setAttribute('height', totalH);
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="board-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">' +
      '<path d="M0,0 L6,3 L0,6 Z" fill="#9AA4AD"/></marker>' +
      '<marker id="board-arrow-crit" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">' +
      '<path d="M0,0 L6,3 L0,6 Z" fill="' + getComputedColor('--critical') + '"/></marker>' +
      '<marker id="board-arrow-transition" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">' +
      '<path d="M0,0 L6,3 L0,6 Z" fill="#3C6E9E"/></marker>';
    svg.appendChild(defs);
    var idxOf = {};
    var projectRowIdx = {};
    rows.forEach(function (r, i) {
      if (r.type === 'task') idxOf[r.task.id] = i;
      else projectRowIdx[r.project.id] = i;
    });
    // Row index where a task is currently drawn: its own row if visible,
    // else its nearest visible ancestor's, else its project row (undefined
    // if the project itself is filtered out / not in this view).
    function visibleRowFor(taskId) {
      var t = taskById[taskId];
      if (!t) return undefined;
      var projectId = t.project;
      while (t) {
        if (t.id in idxOf) return idxOf[t.id];
        t = t.parent ? taskById[t.parent] : null;
      }
      return projectRowIdx[projectId];
    }
    // Date span of the bar drawn on row i (project rollup or task/summary bar).
    function rowBarRange(i) {
      var r = rows[i];
      return r.type === 'project' ? projectStats(r.project.id) : taskRange(r.task.id);
    }
    rows.forEach(function (r) {
      if (r.type !== 'task') return;
      (dependsOnIndex[r.task.id] || []).forEach(function (depId) {
        if (!(depId in idxOf)) return;
        var predTask = taskById[depId];
        var predY = idxOf[depId] * ROW_H + ROW_H / 2;
        var succY = idxOf[r.task.id] * ROW_H + ROW_H / 2;
        var predX = xFor(taskRange(predTask.id).end);
        var succX = xFor(taskRange(r.task.id).start);
        var midX = Math.max(predX + 14, succX - 14);
        var isCrit = !!crit.edges[depId + '>' + r.task.id];
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        // Elbow connector: horizontal out of the predecessor, vertical across
        // to the successor's row, horizontal into the successor (with the
        // final leg short of succX to leave room for the arrowhead marker).
        var d = 'M ' + predX + ' ' + predY + ' H ' + midX + ' V ' + succY + ' H ' + (succX - 6);
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', isCrit ? getComputedColor('--critical') : '#B7C0C9');
        path.setAttribute('stroke-width', isCrit ? '2.5' : '1.5');
        path.setAttribute('marker-end', isCrit ? 'url(#board-arrow-crit)' : 'url(#board-arrow)');
        path.dataset.linkKey = depId + '>' + r.task.id;
        // Critical-path edges are appended last (drawn on top); ordinary
        // edges are inserted right after <defs> (drawn first/underneath),
        // so a highlighted critical arrow is never visually covered by a
        // non-critical one crossing over it.
        if (isCrit) svg.appendChild(path); else svg.insertBefore(path, svg.firstChild.nextSibling);
      });
    });
    transitions.forEach(function (tr) {
      var fromTask = taskById[tr.from_task], toTask = taskById[tr.to_task];
      if (!fromTask || !toTask) return;
      var fromIdx, toIdx;
      if (fromTask.project !== toTask.project) {
        // Cross-project transitions stay visible at any collapse level by
        // anchoring each end to whichever row currently stands in for it.
        fromIdx = visibleRowFor(tr.from_task);
        toIdx = visibleRowFor(tr.to_task);
        if (fromIdx === undefined || toIdx === undefined || fromIdx === toIdx) return;
      } else {
        if (!(tr.from_task in idxOf) || !(tr.to_task in idxOf)) return;
        fromIdx = idxOf[tr.from_task];
        toIdx = idxOf[tr.to_task];
      }
      var fromY = fromIdx * ROW_H + ROW_H / 2;
      var toY = toIdx * ROW_H + ROW_H / 2;
      var x = xFor(parseDate(tr.on_date));
      // Horizontal leg out of the source row's bar to the transition date, the
      // vertical drop, then a horizontal leg into the target row's bar. When an
      // end is collapsed, its row's bar is the ancestor's summary bar or the
      // project bar. A leg is skipped when the date falls within that bar.
      var fromR = rowBarRange(fromIdx), toR = rowBarRange(toIdx);
      var fx0 = xFor(fromR.start), fx1 = xFor(fromR.end);
      var tx0 = xFor(toR.start), tx1 = xFor(toR.end);
      var sx = x < fx0 ? fx0 : (x > fx1 ? fx1 : x);
      var d = 'M ' + sx + ' ' + fromY + (sx !== x ? ' H ' + x : '') + ' V ' + toY;
      // Stop the final leg a few px short of the bar so the arrowhead shows.
      if (x < tx0) d += ' H ' + (tx0 - 4);
      else if (x > tx1) d += ' H ' + (tx1 + 4);
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#3C6E9E');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-dasharray', '5,3');
      path.setAttribute('marker-end', 'url(#board-arrow-transition)');
      svg.appendChild(path);
    });
    inner.appendChild(svg);

    rows.forEach(function (r, i) {
      var top = i * ROW_H;
      if (r.type === 'project') {
        var s = projectStats(r.project.id);
        var bar = makeBar(projectColor(r.project), xFor(s.start), xFor(s.end) - xFor(s.start), top, s.progress, r.project.name, false, false);
        bar.classList.add('rollup');
        bar.onclick = function () { enterProject(r.project.id); };
        inner.appendChild(bar);
      } else {
        var t = r.task;
        var isCritTask = !!crit.taskIds[t.id];
        if (r.hasChildren) {
          var range = taskRange(t.id);
          var prog = taskProgress(t.id);
          var x0s = xFor(range.start), x1s = xFor(range.end);
          var sumBar = makeBar(projectColor(r.project), x0s, Math.max(x1s - x0s, state.pxPerDay * 0.6), top, prog, t.name, false, false);
          sumBar.classList.add('rollup');
          sumBar.dataset.taskId = t.id;
          if (isCritTask) sumBar.classList.add('critical');
          if (t.id === focusedTaskId) sumBar.classList.add('focused');
          sumBar.onclick = function () { openTaskDrawer(t.id, r.project.id); focusTask(t.id); };
          inner.appendChild(sumBar);
        } else {
          var x0 = xFor(taskStartDate(t)), x1 = xFor(taskEndDate(t));
          var bar2 = makeBar(projectColor(r.project), x0, Math.max(x1 - x0, state.pxPerDay * 0.6), top, taskProgressPct(t), t.name, true, t.status);
          bar2.dataset.taskId = t.id;
          if (isCritTask) bar2.classList.add('critical');
          if (t.id === focusedTaskId) bar2.classList.add('focused');
          bar2.onclick = function () { openTaskDrawer(t.id, r.project.id); focusTask(t.id); };
          inner.appendChild(bar2);
        }
        (markersByTask[t.id] || []).forEach(function (m) {
          var markerDef = MARKER_TYPES[m.marker_type];
          var mx = xFor(parseDate(m.on_date));
          var marker = document.createElement('div');
          marker.className = 'board-task-marker board-task-marker-' + m.marker_type + (isCritTask ? ' critical' : '') + (m.id === focusedMarkerId ? ' focused' : '');
          marker.dataset.markerId = m.id;
          marker.style.left = mx + 'px'; marker.style.top = (top + ROW_H / 2) + 'px';
          marker.style.color = markerDef.color || projectColor(r.project);
          marker.title = markerDef.label + ' ' + markerNumbers[m.id] + (m.description ? ': ' + m.description : '') + ' · ' + fmtShort(parseDate(m.on_date));
          marker.onclick = function (e) { e.stopPropagation(); openTaskDrawer(t.id, r.project.id); focusMarker(m.id); };
          var symEl = document.createElement('span'); symEl.className = 'symbol'; symEl.textContent = markerDef.symbol;
          marker.appendChild(symEl);
          var numEl = document.createElement('span'); numEl.className = 'num'; numEl.textContent = markerNumbers[m.id];
          marker.appendChild(numEl);
          inner.appendChild(marker);
        });
      }
    });

    if (TODAY >= state.range.start && TODAY <= state.range.end) {
      var tl = document.createElement('div');
      tl.className = 'board-today-line';
      tl.style.left = xFor(TODAY) + 'px';
      tl.style.height = totalH + 'px';
      inner.appendChild(tl);
      var flag = document.createElement('div');
      flag.className = 'board-today-flag';
      flag.style.left = xFor(TODAY) + 'px';
      flag.textContent = 'TODAY';
      inner.appendChild(flag);
    }
  }

  // Reads a CSS custom property (e.g. '--critical') off #board-app so SVG
  // attributes (which can't reference `var(--x)` directly the way element
  // style/fill CSS can) get the same themed color as the rest of the UI.
  function getComputedColor(varName) {
    return getComputedStyle(document.getElementById('board-app')).getPropertyValue(varName).trim() || '#A6231F';
  }

  // Builds one Gantt bar element (used for both leaf task bars and
  // project/summary rollup bars): a colored track with a lighter "fill"
  // overlay covering the *incomplete* portion (100-progress%), an optional
  // status-color strip along the top for leaf tasks, and a text tag.
  function makeBar(color, left, width, top, progress, label, showStatus, status) {
    var bar = document.createElement('div');
    bar.className = 'board-bar' + (status === 'complete' ? ' complete' : '');
    bar.style.left = left + 'px'; bar.style.width = width + 'px'; bar.style.top = (top + 9) + 'px';
    bar.style.background = color;
    var fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = (100 - progress) + '%'; fill.style.left = progress + '%';
    bar.appendChild(fill);
    if (showStatus && status) {
      var strip = document.createElement('div');
      strip.className = 'status-strip';
      strip.style.background = status === 'at_risk' ? 'var(--risk)' : (status === 'complete' ? 'var(--complete)' : 'var(--ontrack)');
      bar.appendChild(strip);
    }
    var tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = label + '  · ' + progress + '%';
    bar.appendChild(tag);
    return bar;
  }

  /* ============ toast ============ */
  var toastTimer = null;
  // Shows a transient bottom-of-screen toast message for 4s, replacing any
  // currently-showing toast (resets the timer rather than stacking messages).
  function showToast(message) {
    var el = document.getElementById('board-toast');
    el.textContent = message;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 4000);
  }

  /* ============ scroll sync ============ */
  // Keeps the three independently-scrollable panes (timeline body, label
  // column, timeline header) in lockstep: the label column mirrors the
  // timeline's vertical scroll, the header mirrors its horizontal scroll,
  // and vice versa for the label column's own vertical scroll. The
  // `syncing` flag prevents infinite ping-pong between the two onscroll
  // handlers (setting scrollTop/scrollLeft programmatically fires another
  // scroll event, which would otherwise re-trigger the other handler).
  function syncHeaderScroll() {
    var ts = document.getElementById('board-timeline-scroll');
    var ls = document.getElementById('board-label-scroll');
    var hs = document.getElementById('board-tl-head-scroll');
    var syncing = false;
    ts.onscroll = function () {
      if (syncing) return;
      syncing = true;
      ls.scrollTop = ts.scrollTop;
      hs.scrollLeft = ts.scrollLeft;
      syncing = false;
    };
    ls.onscroll = function () {
      if (syncing) return;
      syncing = true;
      ts.scrollTop = ls.scrollTop;
      syncing = false;
    };
  }

  /* ============ drawer (docked sidebar) ============ */
  // The drawer is a single docked sidebar element reused for both the task
  // form (openTaskDrawer) and the project form (openProjectDrawer) — each
  // open*Drawer call wipes and rebuilds #board-drawer-body/-foot rather than
  // there being separate drawer instances.
  var drawer = document.getElementById('board-drawer');
  document.getElementById('board-drawer-close').onclick = closeDrawer;
  function openDrawer() { drawer.classList.add('open'); }
  function closeDrawer() { drawer.classList.remove('open'); }

  // ---- Small form-field builders used by both openTaskDrawer and openProjectDrawer ----
  // Each returns a <div class="board-field"> wrapping a labeled input/select,
  // built via innerHTML for brevity; user-supplied text values are run
  // through escapeHtml to keep them from being interpreted as markup.
  function fieldText(label, id, val) {
    var f = document.createElement('div'); f.className = 'board-field';
    f.innerHTML = '<label for="' + id + '">' + label + '</label><input type="text" id="' + id + '" value="' + escapeHtml(val || '') + '">';
    return f;
  }
  function fieldDate(label, id, val) {
    var f = document.createElement('div'); f.className = 'board-field';
    f.innerHTML = '<label for="' + id + '">' + label + '</label><input type="date" id="' + id + '" value="' + val + '">';
    return f;
  }
  function fieldNumber(label, id, val) {
    var f = document.createElement('div'); f.className = 'board-field';
    f.innerHTML = '<label for="' + id + '">' + label + '</label><input type="number" id="' + id + '" value="' + val + '">';
    return f;
  }
  function fieldSelect(label, id, val, opts) {
    var f = document.createElement('div'); f.className = 'board-field';
    var html = '<label for="' + id + '">' + label + '</label><select id="' + id + '">';
    opts.forEach(function (o) { html += '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>'; });
    html += '</select>';
    f.innerHTML = html;
    return f;
  }
  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // Opens the drawer as a create-or-edit form for a task (taskId null =
  // create; presetParentId pre-selects a parent when adding a subtask via
  // the "+" affordance on a row). Builds the whole form imperatively:
  // name/assignee/parent fields, either editable schedule/budget/progress
  // fields (leaf task) or read-only calculated rollup summaries (summary
  // task, since those values are derived — see taskRange/taskProgress/
  // taskBudgetRollup/taskStatusRollup — not stored), a collapsible
  // "Relationships" section (dependencies, transitions, markers) for
  // existing tasks, and Save/Delete/Cancel buttons. Save writes the task
  // itself first, then reconciles the three relationship lists against the
  // server in parallel (see saveDependencyChanges/saveTransitionChanges/
  // saveMarkerChanges below) and only closes the drawer if all three succeeded.
  function openTaskDrawer(taskId, projectId, presetParentId) {
    var isNew = !taskId;
    var t = isNew
      ? { id: null, project: projectId, parent: presetParentId || null, name: '', assignee: null, start_date: fmtDate(TODAY), end_date: fmtDate(addDays(TODAY, 14)), duration: 14, progress: 0, status: 'on_track' }
      : taskById[taskId];
    var editable = canEdit[projectId];
    var hasKids = !isNew && !isLeaf(t.id);
    document.getElementById('board-drawer-title').textContent = isNew ? (presetParentId ? 'New subtask' : 'New task') : 'Edit task';
    var body = document.getElementById('board-drawer-body');
    var otherTasks = tasks.filter(function (x) { return x.project === projectId && x.id !== t.id; });
    var transitionTargets = tasks.filter(function (x) { return x.id !== t.id && canEdit[x.project]; });
    var excluded = isNew ? [] : descendantIds(t.id); // a task's own descendants are excluded from its parent options to prevent creating a cycle
    var parentCandidates = tasks.filter(function (x) {
      return x.project === projectId && x.id !== t.id && excluded.indexOf(x.id) === -1;
    });

    body.innerHTML = '';
    body.appendChild(fieldText('Name', 'bf-name', t.name));

    var assigneeOpts = [['', '— Unassigned —']];
    var seenAssignee = {};
    tasks.filter(function (x) { return x.project === projectId && x.assignee; }).forEach(function (x) {
      if (!seenAssignee[x.assignee]) { seenAssignee[x.assignee] = true; assigneeOpts.push([x.assignee, x.assignee_name]); }
    });
    if (t.assignee && !seenAssignee[t.assignee]) assigneeOpts.push([t.assignee, t.assignee_name]);
    body.appendChild(fieldSelect('Assignee', 'bf-assignee', t.assignee || '', assigneeOpts));

    var parentOpts = [['', '— Top-level task —']].concat(parentCandidates.map(function (x) { return [x.id, x.name]; }));
    body.appendChild(fieldSelect('Parent task', 'bf-parent', t.parent || '', parentOpts));

    if (hasKids) {
      var range = taskRange(t.id), prog = taskProgress(t.id), st = taskStatusRollup(t.id);
      var info = document.createElement('div'); info.className = 'board-field';
      info.innerHTML = '<label>Schedule (calculated)</label>' +
        '<div style="font-size:12.5px;color:var(--ink);padding:9px 10px;background:var(--paper);border:1px solid var(--line);border-radius:3px;line-height:1.5;">' +
        fmtShort(range.start) + ' → ' + fmtShort(range.end) + ' &middot; ' + prog + '% complete &middot; ' + (STATUS_LABEL[st] || st) +
        '<br><span style="font-size:11px;color:var(--ink-faint)">Calculated from its subtasks. Edit them individually to change these dates.</span></div>';
      body.appendChild(info);

      var budgetInfo = document.createElement('div'); budgetInfo.className = 'board-field';
      budgetInfo.innerHTML = '<label>Budget (calculated)</label>' +
        '<div style="font-size:12.5px;color:var(--ink);padding:9px 10px;background:var(--paper);border:1px solid var(--line);border-radius:3px;line-height:1.5;">' +
        fmtBudget(taskBudgetRollup(t.id)) +
        '<br><span style="font-size:11px;color:var(--ink-faint)">Sum of its subtasks\' budgets.</span></div>';
      body.appendChild(budgetInfo);

      body.appendChild(fieldNumber('Estimated ($)', 'bf-estimated-budget', parseFloat(t.estimated_budget || 0)));
    } else {
      var row2 = document.createElement('div'); row2.className = 'board-row2';
      row2.appendChild(fieldDate('Start', 'bf-start', t.start_date));
      row2.appendChild(fieldDate('End', 'bf-end', t.end_date));
      body.appendChild(row2);

      var row3 = document.createElement('div'); row3.className = 'board-row2';
      row3.appendChild(fieldSelect('Status', 'bf-status', t.status, [['on_track', 'On track'], ['at_risk', 'At risk'], ['complete', 'Complete']]));
      row3.appendChild(fieldNumber('Progress %', 'bf-progress', taskProgressPct(t)));
      body.appendChild(row3);

      var row4 = document.createElement('div'); row4.className = 'board-row2';
      row4.appendChild(fieldNumber('Budget ($)', 'bf-budget', parseFloat(t.budget || 0)));
      row4.appendChild(fieldNumber('Estimated ($)', 'bf-estimated-budget', parseFloat(t.estimated_budget || 0)));
      body.appendChild(row4);
    }

    // "Relationships" is a collapsible section (dependencies/transitions/
    // markers) rather than always-open fields, since most tasks have none;
    // it starts expanded only if the task already has at least one relationship.
    var relBody = body;
    if (!isNew) {
      var relCount = (dependsOnIndex[t.id] || []).length + (transitionsFromIndex[t.id] || []).length + (markersByTask[t.id] || []).length;
      var relExpanded = relCount > 0;
      var relSection = document.createElement('div'); relSection.className = 'board-rel-section';
      var relHeader = document.createElement('div'); relHeader.className = 'board-rel-header';
      var relChev = document.createElement('span'); relChev.className = 'board-rel-chev' + (relExpanded ? ' expanded' : ''); relChev.textContent = '▸';
      relHeader.appendChild(relChev);
      var relTitle = document.createElement('span');
      relTitle.textContent = 'Relationships' + (relCount ? ' (' + relCount + ')' : '');
      relHeader.appendChild(relTitle);
      relSection.appendChild(relHeader);
      relBody = document.createElement('div'); relBody.className = 'board-rel-body';
      relBody.style.display = relExpanded ? '' : 'none';
      relSection.appendChild(relBody);
      relHeader.onclick = function () {
        relExpanded = !relExpanded;
        relChev.classList.toggle('expanded', relExpanded);
        relBody.style.display = relExpanded ? '' : 'none';
      };
      body.appendChild(relSection);
    }

    var depErrorBox = document.createElement('div'); depErrorBox.id = 'bf-dep-error'; depErrorBox.className = 'board-error-text';
    var otherTasksById = {};
    otherTasks.forEach(function (ot) { otherTasksById[ot.id] = ot; });
    var pendingDeps = isNew ? [] : (dependsOnIndex[t.id] || []).slice();

    function renderDepUI() {
      var select = document.getElementById('bf-dep-select');
      var list = document.getElementById('bf-dep-list');
      if (!select || !list) return;
      select.innerHTML = '<option value="">— Select a task —</option>';
      otherTasks.forEach(function (ot) {
        if (pendingDeps.indexOf(ot.id) > -1) return;
        var opt = document.createElement('option');
        opt.value = ot.id;
        opt.textContent = ot.name;
        select.appendChild(opt);
      });
      list.innerHTML = '';
      pendingDeps.forEach(function (id) {
        var ot = otherTasksById[id];
        var row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:6px;';
        var name = document.createElement('span');
        name.textContent = ot ? ot.name : ('Task #' + id);
        row.appendChild(name);
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'icon-btn remove';
        removeBtn.title = 'Remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = function () {
          pendingDeps = pendingDeps.filter(function (x) { return x !== id; });
          renderDepUI();
        };
        row.appendChild(removeBtn);
        list.appendChild(row);
      });
    }

    if (!isNew && otherTasks.length) {
      var depField = document.createElement('div'); depField.className = 'board-field';
      var depLabel = document.createElement('label'); depLabel.textContent = 'Depends on';
      depField.appendChild(depLabel);

      var depPicker = document.createElement('div');
      depPicker.style.cssText = 'display:flex; gap:6px; margin-bottom:8px;';
      var depSelect = document.createElement('select');
      depSelect.id = 'bf-dep-select';
      depPicker.appendChild(depSelect);
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'icon-btn add';
      addBtn.title = 'Add';
      addBtn.textContent = '+';
      addBtn.onclick = function () {
        var val = depSelect.value;
        if (!val) return;
        var id = parseInt(val, 10);
        if (pendingDeps.indexOf(id) === -1) pendingDeps.push(id);
        renderDepUI();
      };
      depPicker.appendChild(addBtn);
      depField.appendChild(depPicker);

      var depList = document.createElement('div'); depList.className = 'board-deplist'; depList.id = 'bf-dep-list';
      depField.appendChild(depList);
      depField.appendChild(depErrorBox);
      relBody.appendChild(depField);
      renderDepUI();
    } else {
      relBody.appendChild(depErrorBox);
    }

    var transErrorBox = document.createElement('div'); transErrorBox.id = 'bf-trans-error'; transErrorBox.className = 'board-error-text';
    var pendingTransitions = isNew ? [] : (transitionsFromIndex[t.id] || []).map(function (tr) {
      return { id: tr.id, toTask: tr.to_task, onDate: tr.on_date };
    });
    var editingTransition = null;

    function resetTransForm() {
      editingTransition = null;
      transAddBtn.textContent = '+';
      transAddBtn.title = 'Add';
      transCancelEditBtn.style.display = 'none';
      toSelect.value = '';
      transOnDate.value = t.start_date;
    }

    function renderTransUI() {
      var list = document.getElementById('bf-trans-list');
      if (!list) return;
      list.innerHTML = '';
      pendingTransitions.forEach(function (pt) {
        var ot = taskById[pt.toTask];
        var otProject = ot ? projectById[ot.project] : null;
        var crossProject = otProject && otProject.id !== projectId;
        var row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:6px;' +
          (pt === editingTransition ? ' outline:2px solid var(--line-strong); border-radius:3px; padding:2px 4px;' : '');
        var name = document.createElement('span');
        name.textContent = '→ ' + (ot ? ot.name + (crossProject ? ' [' + otProject.name + ']' : '') : ('Task #' + pt.toTask)) + ' (' + pt.onDate + ')';
        row.appendChild(name);
        var btnGroup = document.createElement('div'); btnGroup.style.cssText = 'display:flex; gap:4px; flex-shrink:0;';
        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'icon-btn edit';
        editBtn.title = 'Edit';
        editBtn.textContent = '✎';
        editBtn.onclick = function () {
          editingTransition = pt;
          toSelect.value = pt.toTask;
          transOnDate.value = pt.onDate;
          transAddBtn.textContent = '✓';
          transAddBtn.title = 'Update';
          transCancelEditBtn.style.display = '';
          renderTransUI();
        };
        btnGroup.appendChild(editBtn);
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'icon-btn remove';
        removeBtn.title = 'Remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = function () {
          pendingTransitions = pendingTransitions.filter(function (x) { return x !== pt; });
          if (editingTransition === pt) resetTransForm();
          renderTransUI();
        };
        btnGroup.appendChild(removeBtn);
        row.appendChild(btnGroup);
        list.appendChild(row);
      });
    }

    if (!isNew && transitionTargets.length) {
      var transField = document.createElement('div'); transField.className = 'board-field';
      var transLabel = document.createElement('label'); transLabel.textContent = 'Transitions';
      transField.appendChild(transLabel);

      var transPicker = document.createElement('div');
      transPicker.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-bottom:8px;';

      var toRow = document.createElement('div'); toRow.style.cssText = 'display:flex; gap:6px;';
      var toSelect = document.createElement('select'); toSelect.id = 'bf-trans-to-task'; toSelect.style.flex = '1';
      var placeholderOpt = document.createElement('option'); placeholderOpt.value = ''; placeholderOpt.textContent = '— Select target task —';
      toSelect.appendChild(placeholderOpt);
      var targetsByProject = {};
      transitionTargets.forEach(function (ot) {
        targetsByProject[ot.project] = targetsByProject[ot.project] || [];
        targetsByProject[ot.project].push(ot);
      });
      // Current project's tasks first, then other editable projects, each in its own group.
      Object.keys(targetsByProject).sort(function (a, b) {
        if (+a === projectId) return -1;
        if (+b === projectId) return 1;
        return 0;
      }).forEach(function (pid) {
        var proj = projectById[pid];
        var group = document.createElement('optgroup');
        group.label = proj ? proj.name : ('Project #' + pid);
        targetsByProject[pid].forEach(function (ot) {
          var opt = document.createElement('option'); opt.value = ot.id; opt.textContent = ot.name;
          group.appendChild(opt);
        });
        toSelect.appendChild(group);
      });
      toRow.appendChild(toSelect);
      var transAddBtn = document.createElement('button');
      transAddBtn.type = 'button'; transAddBtn.className = 'icon-btn add'; transAddBtn.title = 'Add';
      transAddBtn.textContent = '+';
      transAddBtn.onclick = function () {
        if (!toSelect.value || !transOnDate.value) return;
        if (editingTransition) {
          editingTransition.toTask = parseInt(toSelect.value, 10);
          editingTransition.onDate = transOnDate.value;
        } else {
          pendingTransitions.push({ id: null, toTask: parseInt(toSelect.value, 10), onDate: transOnDate.value });
        }
        resetTransForm();
        renderTransUI();
      };
      toRow.appendChild(transAddBtn);
      var transCancelEditBtn = document.createElement('button');
      transCancelEditBtn.type = 'button'; transCancelEditBtn.className = 'icon-btn cancel'; transCancelEditBtn.title = 'Cancel'; transCancelEditBtn.style.display = 'none';
      transCancelEditBtn.textContent = '×';
      transCancelEditBtn.onclick = function () {
        resetTransForm();
        renderTransUI();
      };
      toRow.appendChild(transCancelEditBtn);
      transPicker.appendChild(toRow);

      var onDateRow = document.createElement('div'); onDateRow.style.cssText = 'display:flex; gap:6px; align-items:center;';
      var onDateLabel = document.createElement('span'); onDateLabel.style.cssText = 'font-size:11px; color:var(--ink-soft); width:32px; flex-shrink:0;'; onDateLabel.textContent = 'On';
      var transOnDate = document.createElement('input'); transOnDate.type = 'date'; transOnDate.value = t.start_date; transOnDate.style.flex = '1';
      onDateRow.appendChild(onDateLabel); onDateRow.appendChild(transOnDate);
      transPicker.appendChild(onDateRow);
      transField.appendChild(transPicker);

      var transList = document.createElement('div'); transList.className = 'board-deplist'; transList.id = 'bf-trans-list';
      transField.appendChild(transList);
      transField.appendChild(transErrorBox);
      relBody.appendChild(transField);
      renderTransUI();
    } else {
      relBody.appendChild(transErrorBox);
    }

    var markerErrorBox = document.createElement('div'); markerErrorBox.id = 'bf-marker-error'; markerErrorBox.className = 'board-error-text';
    var pendingMarkers = isNew ? [] : (markersByTask[t.id] || []).map(function (m) {
      return { id: m.id, markerType: m.marker_type, onDate: m.on_date, description: m.description };
    });
    var editingMarker = null;

    function resetMarkerForm() {
      editingMarker = null;
      mAddBtn.textContent = '+';
      mAddBtn.title = 'Add';
      mCancelEditBtn.style.display = 'none';
      mTypeSelect.value = 'milestone';
      mDate.value = t.start_date;
      mDesc.value = '';
    }

    function renderMarkerUI() {
      var list = document.getElementById('bf-marker-list');
      if (!list) return;
      list.innerHTML = '';
      pendingMarkers.forEach(function (pm) {
        var markerDef = MARKER_TYPES[pm.markerType];
        var row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:6px;' +
          (pm === editingMarker ? ' outline:2px solid var(--line-strong); border-radius:3px; padding:2px 4px;' : '');
        var name = document.createElement('span');
        name.textContent = markerDef.symbol + ' ' + markerDef.label + ' — ' + pm.onDate + (pm.description ? ' (' + pm.description + ')' : '');
        row.appendChild(name);
        var btnGroup = document.createElement('div'); btnGroup.style.cssText = 'display:flex; gap:4px; flex-shrink:0;';
        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'icon-btn edit';
        editBtn.title = 'Edit';
        editBtn.textContent = '✎';
        editBtn.onclick = function () {
          editingMarker = pm;
          mTypeSelect.value = pm.markerType;
          mDate.value = pm.onDate;
          mDesc.value = pm.description || '';
          mAddBtn.textContent = '✓';
          mAddBtn.title = 'Update';
          mCancelEditBtn.style.display = '';
          renderMarkerUI();
        };
        btnGroup.appendChild(editBtn);
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'icon-btn remove';
        removeBtn.title = 'Remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = function () {
          pendingMarkers = pendingMarkers.filter(function (x) { return x !== pm; });
          if (editingMarker === pm) resetMarkerForm();
          renderMarkerUI();
        };
        btnGroup.appendChild(removeBtn);
        row.appendChild(btnGroup);
        list.appendChild(row);
      });
    }

    if (!isNew) {
      var markerField = document.createElement('div'); markerField.className = 'board-field';
      var markerLabel = document.createElement('label'); markerLabel.textContent = 'Milestones / key events / decision points';
      markerField.appendChild(markerLabel);

      var markerPicker = document.createElement('div');
      markerPicker.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-bottom:8px;';

      var mTypeRow = document.createElement('div'); mTypeRow.style.cssText = 'display:flex; gap:6px;';
      var mTypeSelect = document.createElement('select'); mTypeSelect.style.flex = '1';
      Object.keys(MARKER_TYPES).forEach(function (key) {
        var opt = document.createElement('option'); opt.value = key; opt.textContent = MARKER_TYPES[key].symbol + ' ' + MARKER_TYPES[key].label;
        mTypeSelect.appendChild(opt);
      });
      mTypeRow.appendChild(mTypeSelect);
      var mAddBtn = document.createElement('button');
      mAddBtn.type = 'button'; mAddBtn.className = 'icon-btn add'; mAddBtn.title = 'Add';
      mAddBtn.textContent = '+';
      mAddBtn.onclick = function () {
        if (!mDate.value) return;
        if (editingMarker) {
          editingMarker.markerType = mTypeSelect.value;
          editingMarker.onDate = mDate.value;
          editingMarker.description = mDesc.value.trim();
        } else {
          pendingMarkers.push({ id: null, markerType: mTypeSelect.value, onDate: mDate.value, description: mDesc.value.trim() });
        }
        resetMarkerForm();
        renderMarkerUI();
      };
      mTypeRow.appendChild(mAddBtn);
      var mCancelEditBtn = document.createElement('button');
      mCancelEditBtn.type = 'button'; mCancelEditBtn.className = 'icon-btn cancel'; mCancelEditBtn.title = 'Cancel'; mCancelEditBtn.style.display = 'none';
      mCancelEditBtn.textContent = '×';
      mCancelEditBtn.onclick = function () {
        resetMarkerForm();
        renderMarkerUI();
      };
      mTypeRow.appendChild(mCancelEditBtn);
      markerPicker.appendChild(mTypeRow);

      var mDateRow = document.createElement('div'); mDateRow.style.cssText = 'display:flex; gap:6px; align-items:center;';
      var mDateLabel = document.createElement('span'); mDateLabel.style.cssText = 'font-size:11px; color:var(--ink-soft); width:32px; flex-shrink:0;'; mDateLabel.textContent = 'On';
      var mDate = document.createElement('input'); mDate.type = 'date'; mDate.value = t.start_date; mDate.style.flex = '1';
      mDateRow.appendChild(mDateLabel); mDateRow.appendChild(mDate);
      markerPicker.appendChild(mDateRow);

      var mDesc = document.createElement('input'); mDesc.type = 'text'; mDesc.placeholder = 'Description';
      mDesc.style.cssText = 'width:100%; padding:6px 8px; border:1px solid var(--line-strong); border-radius:3px; font:inherit; font-size:12.5px; box-sizing:border-box;';
      markerPicker.appendChild(mDesc);
      markerField.appendChild(markerPicker);

      var markerList = document.createElement('div'); markerList.className = 'board-deplist'; markerList.id = 'bf-marker-list';
      markerField.appendChild(markerList);
      markerField.appendChild(markerErrorBox);
      relBody.appendChild(markerField);
      renderMarkerUI();
    } else {
      relBody.appendChild(markerErrorBox);
    }

    var errorBox = document.createElement('div'); errorBox.id = 'bf-error'; errorBox.className = 'board-error-text';
    body.appendChild(errorBox);

    var foot = document.getElementById('board-drawer-foot');
    foot.innerHTML = '';

    if (!editable) {
      Array.prototype.forEach.call(body.querySelectorAll('input, select'), function (el) { el.disabled = true; });
      var cancelOnly = document.createElement('button'); cancelOnly.className = 'btn secondary'; cancelOnly.textContent = 'Close';
      cancelOnly.onclick = closeDrawer;
      foot.appendChild(cancelOnly);
      openDrawer();
      return;
    }

    var saveBtn = document.createElement('button'); saveBtn.className = 'btn'; saveBtn.textContent = 'Save';
    saveBtn.onclick = function () {
      errorBox.textContent = '';
      var parentVal = document.getElementById('bf-parent').value;
      var assigneeVal = document.getElementById('bf-assignee').value;
      var payload = {
        project: projectId,
        name: document.getElementById('bf-name').value || 'Untitled task',
        parent: parentVal ? parseInt(parentVal, 10) : null,
        assignee: assigneeVal ? parseInt(assigneeVal, 10) : null,
      };
      if (!hasKids) {
        var startEl = document.getElementById('bf-start');
        var endEl = document.getElementById('bf-end');
        var startDate = parseDate(startEl.value);
        var endDate = parseDate(endEl.value);
        payload.start_date = startEl.value;
        payload.duration = Math.max(dayDiff(startDate, endDate), 0);
        payload.status = document.getElementById('bf-status').value;
        payload.progress = Math.max(0, Math.min(100, parseInt(document.getElementById('bf-progress').value || '0', 10))) / 100;
        payload.budget = Math.max(0, parseFloat(document.getElementById('bf-budget').value || '0'));
      }
      payload.estimated_budget = Math.max(0, parseFloat(document.getElementById('bf-estimated-budget').value || '0'));

      var savePromise = isNew ? Api.createTask(payload) : Api.updateTask(t.id, payload);
      savePromise.then(function (saved) {
        if (isNew) { tasks.push(saved); } else { Object.assign(t, saved); }
        rebuildIndexes();
        return Promise.all([saveDependencyChanges(saved.id), saveTransitionChanges(saved.id), saveMarkerChanges(saved.id)]);
      }).then(function (results) {
        computeRange();
        render();
        if (results[0] && results[1] && results[2]) { closeDrawer(); }
        // else: leave the drawer open as-is — the failing save already unchecked/reverted
        // the rejected item and wrote an inline error under its own list.
      }).catch(function (err) {
        errorBox.textContent = err.message;
      });
    };
    foot.appendChild(saveBtn);

    // Reconciles the drawer's pending "Depends on" list (pendingDeps, an
    // array of predecessor task ids) against the server: diffs it against
    // the task's current dependsOnIndex entry to find added/removed
    // predecessors, then fires create/delete calls for just the diff (not a
    // full replace). On a per-item failure, that item is rolled back out of
    // pendingDeps and the UI re-rendered so the drawer reflects only what
    // actually saved; returns false (via allOk) if anything failed, which
    // the caller uses to decide whether to keep the drawer open.
    function saveDependencyChanges(taskId) {
      if (isNew || !otherTasks.length) return Promise.resolve(true);
      var current = (dependsOnIndex[taskId] || []).slice();
      var toAdd = pendingDeps.filter(function (id) { return current.indexOf(id) === -1; });
      var toRemove = current.filter(function (id) { return pendingDeps.indexOf(id) === -1; });
      var linkByPair = {};
      links.forEach(function (l) { linkByPair[l.predecessor + '>' + l.successor] = l; });

      var allOk = true;
      var ops = [];
      toAdd.forEach(function (predId) {
        ops.push(
          Api.createLink({ project: projectId, predecessor: predId, successor: taskId, link_type: 'finish_to_start', lag: 0 })
            .then(function (link) { links.push(link); })
            .catch(function (err) {
              allOk = false;
              pendingDeps = pendingDeps.filter(function (x) { return x !== predId; });
              renderDepUI();
              depErrorBox.textContent = 'Could not link: ' + err.message;
            })
        );
      });
      toRemove.forEach(function (predId) {
        var link = linkByPair[predId + '>' + taskId];
        if (!link) return;
        ops.push(
          Api.deleteLink(link.id).then(function () {
            links = links.filter(function (l) { return l.id !== link.id; });
          }).catch(function (err) {
            allOk = false;
            depErrorBox.textContent = 'Could not remove link: ' + err.message;
          })
        );
      });
      return Promise.all(ops).then(function () { rebuildIndexes(); return allOk; });
    }

    // Same create/update/delete diff-and-reconcile pattern as
    // saveDependencyChanges, but for pendingTransitions — and unlike
    // dependencies, transitions can be *edited* in place (a pending item
    // with an id whose toTask/onDate changed vs. the original is sent as an
    // update rather than a delete+create).
    function saveTransitionChanges(taskId) {
      if (isNew || !transitionTargets.length) return Promise.resolve(true);
      var originalById = {};
      (transitionsFromIndex[taskId] || []).forEach(function (tr) { originalById[tr.id] = tr; });
      var keptIds = pendingTransitions.filter(function (pt) { return pt.id; }).map(function (pt) { return pt.id; });
      var toDeleteIds = Object.keys(originalById).map(Number).filter(function (id) { return keptIds.indexOf(id) === -1; });
      var toCreate = pendingTransitions.filter(function (pt) { return !pt.id; });
      var toUpdate = pendingTransitions.filter(function (pt) {
        var orig = pt.id ? originalById[pt.id] : null;
        return orig && (orig.to_task !== pt.toTask || orig.on_date !== pt.onDate);
      });

      var allOk = true;
      var ops = [];
      toCreate.forEach(function (pt) {
        ops.push(
          Api.createTransition({ project: projectId, from_task: taskId, to_task: pt.toTask, on_date: pt.onDate })
            .then(function (tr) { transitions.push(tr); })
            .catch(function (err) {
              allOk = false;
              pendingTransitions = pendingTransitions.filter(function (x) { return x !== pt; });
              renderTransUI();
              transErrorBox.textContent = 'Could not add transition: ' + err.message;
            })
        );
      });
      toUpdate.forEach(function (pt) {
        ops.push(
          Api.updateTransition(pt.id, { to_task: pt.toTask, on_date: pt.onDate })
            .then(function (tr) {
              transitions = transitions.filter(function (x) { return x.id !== pt.id; });
              transitions.push(tr);
            })
            .catch(function (err) {
              allOk = false;
              transErrorBox.textContent = 'Could not update transition: ' + err.message;
            })
        );
      });
      toDeleteIds.forEach(function (id) {
        ops.push(
          Api.deleteTransition(id).then(function () {
            transitions = transitions.filter(function (tr) { return tr.id !== id; });
          }).catch(function (err) {
            allOk = false;
            transErrorBox.textContent = 'Could not remove transition: ' + err.message;
          })
        );
      });
      return Promise.all(ops).then(function () { rebuildIndexes(); return allOk; });
    }

    // Same create/update/delete diff-and-reconcile pattern as
    // saveTransitionChanges, but for pendingMarkers (milestones/key events/
    // decision points) — an edited marker (type, date, or description
    // changed) is sent as an update, not a delete+create.
    function saveMarkerChanges(taskId) {
      if (isNew) return Promise.resolve(true);
      var originalById = {};
      (markersByTask[taskId] || []).forEach(function (m) { originalById[m.id] = m; });
      var keptIds = pendingMarkers.filter(function (pm) { return pm.id; }).map(function (pm) { return pm.id; });
      var toDeleteIds = Object.keys(originalById).map(Number).filter(function (id) { return keptIds.indexOf(id) === -1; });
      var toCreate = pendingMarkers.filter(function (pm) { return !pm.id; });
      var toUpdate = pendingMarkers.filter(function (pm) {
        var orig = pm.id ? originalById[pm.id] : null;
        return orig && (orig.marker_type !== pm.markerType || orig.on_date !== pm.onDate || (orig.description || '') !== pm.description);
      });

      var allOk = true;
      var ops = [];
      toCreate.forEach(function (pm) {
        ops.push(
          Api.createMarker({ project: projectId, task: taskId, marker_type: pm.markerType, on_date: pm.onDate, description: pm.description })
            .then(function (m) { markers.push(m); })
            .catch(function (err) {
              allOk = false;
              pendingMarkers = pendingMarkers.filter(function (x) { return x !== pm; });
              renderMarkerUI();
              markerErrorBox.textContent = 'Could not add marker: ' + err.message;
            })
        );
      });
      toUpdate.forEach(function (pm) {
        ops.push(
          Api.updateMarker(pm.id, { marker_type: pm.markerType, on_date: pm.onDate, description: pm.description })
            .then(function (m) {
              markers = markers.filter(function (x) { return x.id !== pm.id; });
              markers.push(m);
            })
            .catch(function (err) {
              allOk = false;
              markerErrorBox.textContent = 'Could not update marker: ' + err.message;
            })
        );
      });
      toDeleteIds.forEach(function (id) {
        ops.push(
          Api.deleteMarker(id).then(function () {
            markers = markers.filter(function (m) { return m.id !== id; });
          }).catch(function (err) {
            allOk = false;
            markerErrorBox.textContent = 'Could not remove marker: ' + err.message;
          })
        );
      });
      return Promise.all(ops).then(function () { rebuildIndexes(); return allOk; });
    }

    if (!isNew) {
      var delBtn = document.createElement('button'); delBtn.className = 'btn danger';
      var descCount = descendantIds(t.id).length;
      delBtn.textContent = descCount ? 'Delete (+' + descCount + ' subtask' + (descCount === 1 ? '' : 's') + ')' : 'Delete';
      delBtn.onclick = function () {
        Api.deleteTask(t.id).then(function () {
          var toDelete = [t.id].concat(descendantIds(t.id));
          tasks = tasks.filter(function (x) { return toDelete.indexOf(x.id) === -1; });
          links = links.filter(function (l) { return toDelete.indexOf(l.predecessor) === -1 && toDelete.indexOf(l.successor) === -1; });
          transitions = transitions.filter(function (tr) { return toDelete.indexOf(tr.from_task) === -1 && toDelete.indexOf(tr.to_task) === -1; });
          markers = markers.filter(function (m) { return toDelete.indexOf(m.task) === -1; });
          rebuildIndexes();
          computeRange();
          closeDrawer();
          render();
        }).catch(function (err) { errorBox.textContent = err.message; });
      };
      foot.appendChild(delBtn);
    }
    var cancelBtn = document.createElement('button'); cancelBtn.className = 'btn secondary'; cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeDrawer;
    foot.appendChild(cancelBtn);

    openDrawer();
  }

  // Opens the drawer as a create-or-edit form for a project (projectId null
  // = create). On create, also auto-creates a starter "Kickoff" task (30-day
  // duration from today) so a brand-new project isn't an empty, unusable
  // board — the project alone has nothing to render on the timeline.
  function openProjectDrawer(projectId) {
    var isNew = !projectId;
    var p = isNew ? { id: null, name: '', color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length], status: 'active' } : projectById[projectId];
    document.getElementById('board-drawer-title').textContent = isNew ? 'New project' : 'Edit project';
    var body = document.getElementById('board-drawer-body');
    body.innerHTML = '';
    body.appendChild(fieldText('Name', 'bf-pname', p.name));
    if (!isNew) {
      var budgetInfo = document.createElement('div'); budgetInfo.className = 'board-field';
      budgetInfo.innerHTML = '<label>Budget (calculated)</label>' +
        '<div style="font-size:12.5px;color:var(--ink);padding:9px 10px;background:var(--paper);border:1px solid var(--line);border-radius:3px;line-height:1.5;">' +
        fmtBudgetM(projectBudget(p.id)) +
        '<br><span style="font-size:11px;color:var(--ink-faint)">Sum of this project\'s task budgets. Edit them individually to change this.</span></div>';
      body.appendChild(budgetInfo);
    }
    body.appendChild(fieldSelect('Status', 'bf-pstatus', p.status, [['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['archived', 'Archived']]));

    var swatchField = document.createElement('div'); swatchField.className = 'board-field';
    var swLabel = document.createElement('label'); swLabel.textContent = 'Color';
    swatchField.appendChild(swLabel);
    var swWrap = document.createElement('div'); swWrap.className = 'board-swatches';
    var chosen = p.color;
    PROJECT_COLORS.forEach(function (c) {
      var sw = document.createElement('div'); sw.className = 'sw' + (c === chosen ? ' sel' : '');
      sw.style.background = c;
      sw.onclick = function () { chosen = c; Array.prototype.forEach.call(swWrap.children, function (el) { el.classList.remove('sel'); }); sw.classList.add('sel'); };
      swWrap.appendChild(sw);
    });
    swatchField.appendChild(swWrap);
    body.appendChild(swatchField);

    if (!isNew) {
      var ownerInfo = document.createElement('div'); ownerInfo.className = 'board-field';
      ownerInfo.innerHTML = '<label>Owner</label><div style="font-size:12.5px;padding:7px 0;">' + escapeHtml(p.owner_name) +
        ' &middot; <a href="' + window.BOARD_PROJECT_SETTINGS_URL_TEMPLATE.replace('/0/', '/' + p.id + '/') + '">Manage members / settings →</a></div>';
      body.appendChild(ownerInfo);
    }

    var errorBox = document.createElement('div'); errorBox.id = 'bf-perror'; errorBox.className = 'board-error-text';
    body.appendChild(errorBox);

    var foot = document.getElementById('board-drawer-foot');
    foot.innerHTML = '';
    var saveBtn = document.createElement('button'); saveBtn.className = 'btn'; saveBtn.textContent = 'Save';
    saveBtn.onclick = function () {
      var payload = {
        name: document.getElementById('bf-pname').value || 'Untitled project',
        status: document.getElementById('bf-pstatus').value,
        color: chosen,
      };
      var savePromise = isNew ? Api.createProject(payload) : Api.updateProject(p.id, payload);
      savePromise.then(function (saved) {
        if (isNew) {
          projects.push(saved);
          rebuildIndexes();
          return Api.createTask({ project: saved.id, name: 'Kickoff', start_date: fmtDate(TODAY), duration: 30, progress: 0 })
            .then(function (task) { tasks.push(task); rebuildIndexes(); });
        }
        Object.assign(p, saved);
        rebuildIndexes();
      }).then(function () {
        computeRange();
        closeDrawer();
        render();
      }).catch(function (err) { errorBox.textContent = err.message; });
    };
    foot.appendChild(saveBtn);

    if (!isNew) {
      var delBtn = document.createElement('button'); delBtn.className = 'btn danger'; delBtn.textContent = 'Delete project';
      delBtn.onclick = function () {
        Api.deleteProject(p.id).then(function () {
          projects = projects.filter(function (x) { return x.id !== p.id; });
          tasks = tasks.filter(function (x) { return x.project !== p.id; });
          links = links.filter(function (l) { return l.project !== p.id; });
          transitions = transitions.filter(function (tr) { return tr.project !== p.id; });
          markers = markers.filter(function (m) { return m.project !== p.id; });
          rebuildIndexes();
          state.view = 'portfolio';
          computeRange();
          closeDrawer();
          render();
        }).catch(function (err) { errorBox.textContent = err.message; });
      };
      foot.appendChild(delBtn);
    }
    var cancelBtn = document.createElement('button'); cancelBtn.className = 'btn secondary'; cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeDrawer;
    foot.appendChild(cancelBtn);

    openDrawer();
  }

  /* ============ snapshot ============ */
  // Lazily loads the html2canvas library from a CDN (this is the one
  // external dependency the board pulls in, and only on demand when the
  // user actually clicks "Snapshot PNG" — it's not needed for normal use,
  // so it isn't loaded up front). No-ops if already loaded.
  function ensureHtml2Canvas(cb) {
    if (window.html2canvas) { cb(); return; }
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = cb;
    s.onerror = function () { showToast('Could not load the snapshot library — check your network connection.'); };
    document.head.appendChild(s);
  }
  // Reads a user-selected JSON file, POSTs it to the import endpoint, shows
  // a toast summarizing what was created/updated/warned about, then
  // refetches the full board dataset from scratch (rather than trying to
  // merge the import response) since an import can touch many
  // projects/tasks/links/markers at once.
  function handleImportFile(file) {
    var btn = document.getElementById('board-import-btn');
    var origText = btn.textContent;
    btn.textContent = 'Importing…';
    var reader = new FileReader();
    reader.onload = function () {
      var payload;
      try {
        payload = JSON.parse(reader.result);
      } catch (e) {
        showToast('That file is not valid JSON.');
        btn.textContent = origText;
        return;
      }
      apiRequest('POST', window.BOARD_IMPORT_URL, payload).then(function (summary) {
        var parts = [];
        if (summary.created.length) parts.push('Created: ' + summary.created.join(', '));
        if (summary.updated.length) parts.push('Updated: ' + summary.updated.join(', '));
        if (summary.warnings.length) parts.push(summary.warnings.length + ' warning(s): ' + summary.warnings.join(' '));
        showToast(parts.length ? parts.join(' — ') : 'Import complete.');
        btn.textContent = origText;
        return fetch(window.BOARD_DATA_URL).then(function (r) { return r.json(); });
      }).then(function (data) {
        if (!data) return;
        projects = data.projects;
        tasks = data.tasks;
        links = data.links;
        transitions = data.transitions || [];
        markers = data.markers || [];
        canEdit = data.can_edit;
        rebuildIndexes();
        computeRange();
        render();
      }).catch(function (err) {
        showToast('Import failed: ' + err.message);
        btn.textContent = origText;
      });
    };
    reader.onerror = function () {
      showToast('Could not read that file.');
      btn.textContent = origText;
    };
    reader.readAsText(file);
  }

  document.getElementById('board-import-btn').onclick = function () {
    document.getElementById('board-import-file').click();
  };
  document.getElementById('board-import-file').onchange = function (e) {
    var file = e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = '';
  };

  // Rasterizes the whole #board-app element to a PNG and triggers a browser
  // download, named after the current view (portfolio or project name).
  function takeSnapshot() {
    var snapBtn = document.getElementById('board-snapshot-btn');
    var origText = snapBtn.textContent;
    snapBtn.textContent = 'Rendering…';
    ensureHtml2Canvas(function () {
      var target = document.getElementById('board-app');
      setTimeout(function () { // brief delay so the "Rendering…" label paints before the (synchronous, blocking) capture starts
        html2canvas(target, { backgroundColor: '#F6F7F5', scale: 2, useCORS: true }).then(function (canvas) {
          canvas.toBlob(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            var scopeName = state.view === 'portfolio' ? 'portfolio' : (projectById[state.view] || {}).name || 'project';
            a.href = url;
            a.download = 'board-' + String(scopeName).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-snapshot.png';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            snapBtn.textContent = origText;
          });
        }).catch(function () {
          showToast('Snapshot failed. Try again, or use Export CSV for the underlying data.');
          snapBtn.textContent = origText;
        });
      }, 50);
    });
  }

  /* ============ init ============ */
  // Entry point: fetches the full board dataset once on page load, seeds
  // every module-level array, optionally jumps straight into a specific
  // project (BOARD_INITIAL_PROJECT_ID, set by board.html from the ?project=
  // query param so a deep link / browser refresh lands back where it was —
  // see history.replaceState in renderCrumbsAndAdd), then does the first render.
  fetch(window.BOARD_DATA_URL).then(function (r) { return r.json(); }).then(function (data) {
    projects = data.projects;
    tasks = data.tasks;
    links = data.links;
    transitions = data.transitions || [];
    markers = data.markers || [];
    canEdit = data.can_edit;
    currentUserId = data.current_user_id;
    rebuildIndexes();
    if (window.BOARD_INITIAL_PROJECT_ID && projectById[window.BOARD_INITIAL_PROJECT_ID]) {
      state.view = window.BOARD_INITIAL_PROJECT_ID;
      state.expanded['p' + state.view] = true;
    }
    if (state.view !== 'portfolio') {
      fitToProject(state.view);
    } else {
      computeRange();
      render();
    }
  }).catch(function (err) {
    document.getElementById('board-label-inner').textContent = 'Failed to load board data: ' + err.message;
  });

})();
