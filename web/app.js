const $ = (id) => document.getElementById(id);
const capInput = $("capital");
let capFocused = false;

capInput.addEventListener("focus", () => (capFocused = true));
capInput.addEventListener("blur", () => (capFocused = false));

const n = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "–");
const signed = (x, d = 0) => (Number(x) > 0 ? "+" : "") + n(x, d);
const cls = (x) => (Number(x) > 0 ? "g" : Number(x) < 0 ? "r" : "");
const pct = (x) => (x == null || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(0)}%`);
const hold = (s) => (!s ? "" : s < 60 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)}m`);
const ist = (ts, sec = false) =>
  ts
    ? new Date(ts).toLocaleTimeString("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        ...(sec ? { second: "2-digit" } : {}),
        hourCycle: "h23",
      })
    : "";

const SPEEDS = [
  [1, "1×"],
  [10, "10×"],
  [60, "60×"],
  [300, "300×"],
  [0, "MAX"],
];
let replayTotal = 0;

function renderReplay(r) {
  const el = $("replay");
  if (!r) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  replayTotal = r.total;
  $("rpDate").textContent = r.date;
  $("rpClock").textContent = ist(r.virtualNow, true) + (r.done ? " · DONE" : "");
  $("rpPlay").textContent = r.done ? "DONE" : r.paused ? "PLAY" : "PAUSE";
  if (!$("rpSpeeds").dataset.ready) {
    $("rpSpeeds").innerHTML = SPEEDS.map(([v, l]) => `<button data-speed="${v}">${l}</button>`).join("");
    $("rpSpeeds").dataset.ready = "1";
  }
  for (const b of $("rpSpeeds").querySelectorAll("button[data-speed]")) {
    b.classList.toggle("on", Number(b.dataset.speed) === r.speed);
  }
  $("rpProg").querySelector("i").style.width = `${r.total ? (100 * r.idx) / r.total : 0}%`;
  const budget = r.speed > 0 ? 60000 / r.speed : 0;
  const limited = !r.done && !r.paused && r.speed > 0 && (r.lastStepMs || 0) > budget + 40;
  const note = r.seeking ? " · seeking…" : r.paused ? " · paused" : r.done ? " · click bar to run again" : limited ? " · jev-limited" : "";
  $("rpPct").textContent = `${r.idx}/${r.total}${note}`;
}

// Bar index -> IST clock. Bars start at 09:15.
const barTime = (i) => {
  const m = 9 * 60 + 15 + i;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

function replayCmd(body) {
  fetch("/api/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
$("rpPlay").onclick = () => replayCmd({ paused: $("rpPlay").textContent === "PAUSE" });
$("rpSpeeds").onclick = (e) => {
  const b = e.target.closest("button[data-speed]");
  if (b) replayCmd({ speed: Number(b.dataset.speed) });
};
const barAt = (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return Math.floor(frac * replayTotal);
};
$("rpProg").onclick = (e) => replayCmd({ seek: barAt(e) });
$("rpProg").onmousemove = (e) => (e.currentTarget.title = `seek to ${barTime(barAt(e))} · back rebuilds the day`);

function render(s) {
  renderReplay(s.replay);
  const observe = s.mode === "observe";
  const replay = s.mode === "replay";
  $("mode").textContent = replay ? "REPLAY · sim fills" : observe ? "OBSERVE · no orders" : `LIVE${s.wild ? " · WILD" : ""} · opt ${s.optionsMode}`;
  $("mode").className = `pill ${replay || observe ? "a" : "r"}`;
  $("wild").classList.toggle("on", !!s.wild);
  $("wild").textContent = s.wild ? "WILD ON" : "WILD";
  $("jev").classList.toggle("on", !!s.jevPaused);
  $("jev").textContent = s.jevPaused ? "JEV PAUSED" : "PAUSE JEV";
  $("model").textContent = s.model;
  $("model").className = `pill ${s.model === "jev" ? "g" : "a"}`;
  $("session").textContent = replay ? "sim broker" : s.session ? `${s.broker} ok` : "no session";
  $("session").className = `pill ${s.session ? "g" : "r"}`;
  $("warm").textContent = s.warmedUp ? `hist ok · ${s.universeSize} names · ${s.quotesLive} quotes` : "no history";
  $("warm").className = `pill ${s.warmedUp ? "" : "a"}`;
  $("lat").textContent = `jev p50 ${s.latencyP50 || 0}ms · p90 ${s.latencyP90 || 0}ms`;
  $("skip").textContent = `${s.sessionId ? `session #${s.sessionId} · ` : ""}skipped ${s.skippedToday || 0}`;
  $("clock").textContent = ist(s.serverTime, true);

  if (!capFocused && s.capital != null) capInput.value = String(Math.round(s.capital));

  const next = s.lastDecision ? Math.max(0, Math.round((s.lastDecision + s.decisionIntervalS * 1000 - s.serverTime) / 1000)) : "–";
  $("regime").innerHTML =
    `regime <b>${s.regime}</b> · risk_off <b class="${s.riskOff >= 0.7 ? "r" : ""}">${n(s.riskOff, 2)}</b>` +
    ` · nifty_long <b>${n(s.niftyLong, 2)}</b> · nifty_short <b>${n(s.niftyShort, 2)}</b>` +
    ` · next decision <b>${next}s</b>` +
    (s.lastSkipReason ? ` · <span class="a">${esc(s.lastSkipReason)}</span>` : "");

  const st = s.stats || {};
  const usedPct = s.capital ? Math.min(100, (100 * (s.usedNotional || 0)) / s.capital) : 0;
  const mark = (st.netPnl || 0) + (s.openUnrealized || 0);
  // Replay is its own simulated book: label it so it is never read as real money.
  const sim = replay ? "SIM " : "";
  $("nums").innerHTML = [
    card(replay ? "SIM DAY PNL" : "TODAY PNL", signed(s.todayPnl), cls(s.todayPnl)),
    card(`${sim}OPEN uPNL`, signed(s.openUnrealized), cls(s.openUnrealized)),
    card(replay ? "SIM TOTAL" : "ALL-TIME", signed(st.netPnl), cls(st.netPnl)),
    card(`${sim}MARK`, signed(mark), cls(mark)),
    card("CAPITAL", n(s.capital)),
    card("IN USE", `${n(s.usedNotional)}<small>${n(usedPct)}%</small>`),
    card("FREE", n(s.freeCapital)),
    card("RISK / TRADE", n(s.riskPerTrade)),
    card("TRADES", `${st.todayTrades || 0}<small>/ ${st.trades || 0} all</small>`),
    card("HIT", `${pct(st.todayHit)}<small>${pct(st.hit)} all</small>`),
    card("EXPECTANCY", signed(st.expectancy, 1), cls(st.expectancy)),
    card("PROFIT FACTOR", n(st.profitFactor, 2), st.profitFactor >= 1.2 ? "g" : st.trades ? "r" : ""),
    card("MAX DD", n(st.maxDd), st.maxDd < 0 ? "r" : ""),
    card("AVG WIN / LOSS", `${n(st.avgWin)}<small>/ ${n(st.avgLoss)}</small>`),
    card("AVG HOLD", hold(st.avgHoldS)),
    card("FRICTION PAID", n(st.friction)),
    card("LOSS HALT", `-${n(s.dailyLossCap)}`, s.halted ? "r" : ""),
    card("JEV TOKENS", n(s.tokensToday)),
  ].join("");

  const g = s.governor || {};
  $("today").innerHTML =
    `<div>entries ${s.todayEntries} · allow ${g.allowance < 0 || g.allowance == null ? "uncapped" : g.allowance} <span class="dim">(${g.reason ?? ""})</span>` +
    ` · positions ${(s.positions || []).length}/${s.maxPositions}` +
    `${s.halted ? ' <span class="r">HALTED</span>' : ""}${s.killed ? ' <span class="r">KILLED</span>' : ""}</div>` +
    `<div class="use"><i style="width:${usedPct}%"></i></div>`;

  $("pos").querySelector("tbody").innerHTML =
    (s.positions || [])
      .map(
        (p) =>
          `<tr><td class="bright">${p.symbol}</td><td class="${p.side === "long" ? "g" : "r"}">${p.side}</td><td>${p.qty - (p.closedQty || 0)}</td>` +
          `<td>${n(p.entryPrice, 2)}</td><td>${n(p.ltp, 2)}</td><td>${n(p.stop, 2)}</td><td class="${p.hasStop ? "g" : "r"}">${p.hasStop ? "EXCH" : "ENGINE"}</td>` +
          `<td>${n(p.notional)}</td><td class="${cls(p.unrealized)}">${signed(p.unrealized)}</td><td title="${esc(p.lastVerdict || "")}">${n(p.thesis, 2)}${p.lastVerdict ? ` <span class="dim">${esc(p.lastVerdict.split(" · ")[0])}</span>` : ""}</td><td>${n(p.mfeBps)}bp</td><td>${n(p.holdMin, 1)}</td></tr>`,
      )
      .join("") || `<tr><td colspan="12" class="dim">no positions</td></tr>`;

  $("orders").innerHTML = (s.openOrders || []).length
    ? "orders: " +
      s.openOrders
        .map((o) => `${o.kind} ${o.side} ${o.filled}/${o.qty} ${o.symbol} @${n(o.price, 2)}${o.trigger ? ` trg ${n(o.trigger, 2)}` : ""} ${o.ageS}s${o.requotes ? ` rq${o.requotes}` : ""}`)
        .join(" · ")
    : "";

  const longs = (s.rankings || []).find((r) => r.side === "long")?.payload || [];
  const shorts = (s.rankings || []).find((r) => r.side === "short")?.payload || [];
  const cands = s.candidates || [];
  $("rank").innerHTML =
    `<div class="dim" style="font-size:10.5px;letter-spacing:.1em;margin-bottom:4px">STAGE 1 · TOP 3 PER SIDE</div>` +
    (Array.isArray(longs) ? longs.map((x) => rankRow("LONG", x.symbol, x.p, "")).join("") : "") +
    (Array.isArray(shorts) ? shorts.map((x) => rankRow("SHORT", x.symbol, x.p, "s")).join("") : "") +
    (!longs.length && !shorts.length ? `<div class="dim">no candidates yet</div>` : "") +
    `<div class="dim" style="font-size:10.5px;letter-spacing:.1em;margin:8px 0 4px">STAGE 2 · COMPOSITE</div>` +
    (cands.length
      ? cands
          .map((c) => {
            const taken = s.taken && s.taken.symbol === c.symbol;
            return rankRow(c.tier, `${c.symbol} ${c.side}`, c.entryScore, "c", taken ? " ← SENT" : "") +
              `<div class="dim" style="margin:-2px 0 4px 64px;font-size:11px">setup ${n(c.setupProb, 2)} conf ${n(c.setupConf, 2)} · trend ${n(c.scores.trend_quality, 2)} flow ${n(c.scores.flow_alignment, 2)} idx ${n(c.scores.index_alignment, 2)} liq ${n(c.scores.liquidity, 2)} · one_sided ${n(c.oneSided, 2)}</div>`;
          })
          .join("")
      : `<div class="dim">none passed</div>`);

  $("trades").querySelector("tbody").innerHTML = (s.trades || [])
    .map(
      (t) =>
        `<tr><td class="dim">${ist(t.closed_at)}</td><td>${t.leg}</td><td class="bright">${t.symbol}</td><td class="${t.side === "long" ? "g" : "r"}">${t.side}</td><td>${t.qty}</td>` +
        `<td>${n(t.entry, 2)}</td><td>${n(t.exit, 2)}</td>` +
        `<td class="${cls(t.pnl)}">${signed(t.pnl)}</td><td>${hold(t.hold_s)}</td><td>${t.exit_reason}</td><td class="dim">${t.attribution || ""}</td></tr>`,
    )
    .join("");

  $("log").innerHTML = (s.events || [])
    .map((e) => `<div><span class="t">${ist(e.ts, true)}</span><span class="k ${e.kind}">${e.kind}</span>${esc(e.message)}</div>`)
    .join("");

  $("decs").querySelector("tbody").innerHTML = (s.decisions || [])
    .slice(0, 120)
    .map(
      (d) =>
        `<tr><td class="dim">${ist(d.ts, true)}</td><td>${d.stage}</td><td class="bright">${d.symbol || ""}</td><td>${d.question}</td><td>${esc(String(d.answer))}</td>` +
        `<td>${d.probability != null ? n(d.probability, 2) : ""}</td><td class="dim">${d.confidence != null ? n(d.confidence, 2) : ""}</td><td class="dim">${d.latency_ms}</td></tr>`,
    )
    .join("");

  drawCurve(s.curve || st.curve || []);
}

function card(label, value, color = "") {
  return `<div class="num"><span>${label}</span><b class="${color}">${value}</b></div>`;
}

function rankRow(lbl, name, v, barCls, suffix = "") {
  const w = Math.max(0, Math.min(100, (Number(v) || 0) * 100));
  return `<div class="rank-row"><span class="lbl">${lbl}</span><span style="width:150px" class="bright">${esc(name)}</span><span class="bar ${barCls}"><i style="width:${w}%"></i></span><span style="width:40px;text-align:right">${n(v, 2)}</span><span class="taken">${suffix}</span></div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function drawCurve(pts) {
  const svg = $("eq");
  if (pts.length < 2) {
    svg.innerHTML = `<text x="400" y="115" text-anchor="middle" fill="#5f8f6a" font-family="DM Mono, monospace" font-size="12">awaiting first closed trade</text>`;
    $("chartMeta").textContent = "";
    return;
  }
  const w = 800;
  const h = 220;
  const pad = 16;
  const ys = pts.map((p) => p.eq);
  let min = Math.min(0, ...ys);
  let max = Math.max(0, ...ys);
  if (min === max) {
    max = min + 1;
    min = min - 1;
  }
  const x0 = pts[0].t;
  const x1 = pts[pts.length - 1].t || x0 + 1;
  const xs = (t) => pad + ((t - x0) / Math.max(1, x1 - x0)) * (w - 2 * pad);
  const yy = (v) => h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xs(p.t).toFixed(1)},${yy(p.eq).toFixed(1)}`).join(" ");
  const zero = yy(0);
  const last = pts[pts.length - 1];
  const color = last.eq >= 0 ? "#39ff7a" : "#ff5c5c";
  const area = `${line} L${xs(last.t).toFixed(1)},${zero.toFixed(1)} L${xs(pts[0].t).toFixed(1)},${zero.toFixed(1)} Z`;
  svg.innerHTML =
    `<defs><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>` +
    `<line x1="${pad}" x2="${w - pad}" y1="${zero}" y2="${zero}" stroke="#143a1f" stroke-dasharray="3 4" />` +
    `<path d="${area}" fill="url(#gl)" />` +
    `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" style="filter:drop-shadow(0 0 4px ${color})" />`;
  $("chartMeta").textContent = `${pts.length} pts · last ${signed(last.eq)} · peak ${signed(Math.max(...ys))} · trough ${signed(Math.min(...ys))}`;
}

$("kill").onclick = () => {
  if (prompt("type CONFIRM to cancel all entries and flatten") !== "CONFIRM") return;
  fetch("/api/kill", { method: "POST" });
};
$("jev").onclick = () => {
  const paused = !$("jev").classList.contains("on");
  fetch("/api/jev", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) });
};
$("wild").onclick = () => {
  const on = !$("wild").classList.contains("on");
  if (on && prompt("WILD: enter on stage-1 conviction alone, up to the position cap per cycle, no re-entry cooldown. Type WILD to enable.") !== "WILD") return;
  fetch("/api/wild", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
};
$("unkill").onclick = () => {
  if (prompt("type RESUME to clear the kill switch") !== "RESUME") return;
  fetch("/api/unkill", { method: "POST" });
};

$("capForm").onsubmit = (e) => {
  e.preventDefault();
  const capital = Number(capInput.value);
  if (!capital || capital < 1000) {
    $("capMsg").textContent = "min 1000";
    return;
  }
  fetch("/api/capital", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capital }) })
    .then((r) => r.json())
    .then((j) => {
      $("capMsg").textContent = j.ok ? `set ${j.capital}` : "failed";
      capInput.blur();
    })
    .catch(() => ($("capMsg").textContent = "failed"));
};

// ---- Sessions tab ----
let tab = "live";
$("tabs").onclick = (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  for (const x of $("tabs").querySelectorAll("button")) x.classList.toggle("on", x === b);
  const live = tab === "live";
  $("liveView").hidden = !live;
  $("nums").hidden = !live;
  $("regime").hidden = !live;
  $("sessions").hidden = live;
  if (!live) loadSessions();
};

const pendingOpen = new Set();

function loadSessions() {
  fetch("/api/sessions")
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(renderSessions)
    .catch(() => {
      $("sessTable").querySelector("tbody").innerHTML = `<tr><td colspan="7" class="dim">sessions are only available from the live dashboard</td></tr>`;
    });
}

function renderSessions(d) {
  const live = d.live || [];
  $("liveSess").querySelector("tbody").innerHTML =
    live
      .map((s) => {
        const end = s.ended_at || Date.now();
        const dur = Math.round((end - s.started_at) / 60000);
        const date = new Date(s.started_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        return (
          `<tr><td class="dim">${s.id}</td><td>${date}</td><td>${ist(s.started_at)}</td><td>${s.ended_at ? ist(s.ended_at) : '<span class="g">live</span>'}</td>` +
          `<td>${dur}m</td><td>${s.decisions}</td><td>${s.trades}</td><td class="${cls(s.pnl)}">${s.trades ? signed(s.pnl) : "–"}</td>` +
          `<td>${s.end_reason || ""}</td><td class="dim">${esc(s.note || "")}</td>` +
          `<td>${s.ended_at ? `<button data-replay="${date}" title="replay this day">REPLAY DAY</button>` : ""}</td></tr>`
        );
      })
      .join("") || `<tr><td colspan="11" class="dim">no live sessions yet — RESUME starts one</td></tr>`;
  const running = d.running || [];
  for (const r of running) {
    // Open the replay tab once, only when its server is actually up.
    if (r.ready && !r.exited && pendingOpen.has(r.date)) {
      pendingOpen.delete(r.date);
      window.open(`http://${location.hostname}:${r.port}/`, "_blank");
    }
  }
  $("runningReplays").innerHTML = running.length
    ? `<div class="running">` +
      running
        .map(
          (r) =>
            `<div><span class="a">REPLAY</span> ${r.date} · ${r.speed === 0 ? "MAX" : r.speed + "×"}${r.wild ? " · WILD" : ""} · ` +
            (r.exited
              ? `<span class="dim">exited (${r.exitCode ?? "?"}) — ${esc(r.lastLog || "")}</span>`
              : r.ready
                ? `<a href="http://${location.hostname}:${r.port}/" target="_blank">open :${r.port}</a>`
                : `<span class="dim">starting… ${esc(r.lastLog || "")}</span>`) +
            ` <button data-stop="${r.date}">${r.exited ? "CLEAR" : "STOP"}</button></div>`,
        )
        .join("") +
      `</div>`
    : "";
  const active = new Set(running.filter((r) => !r.exited).map((r) => r.date));
  $("sessTable").querySelector("tbody").innerHTML =
    (d.sessions || [])
      .map(
        (s) =>
          `<tr><td class="bright">${s.date}</td><td>${s.bars}</td><td>${s.symbols}</td><td>${s.trades}</td>` +
          `<td class="${cls(s.pnl)}">${s.trades ? signed(s.pnl) : "–"}</td>` +
          `<td><select data-speed-for="${s.date}">${SPEEDS.map(([v, l]) => `<option value="${v}" ${v === 60 ? "selected" : ""}>${l}</option>`).join("")}</select></td>` +
          `<td>${active.has(s.date) ? `<span class="a">running</span>` : `<button data-replay="${s.date}">REPLAY</button>`}</td></tr>`,
      )
      .join("") || `<tr><td colspan="7" class="dim">no bars yet — run the live engine once (warm-up loads 25 days) or pnpm calibrate</td></tr>`;
}

$("sessions").onclick = (e) => {
  const play = e.target.closest("button[data-replay]");
  if (play) {
    const date = play.dataset.replay;
    const sel = $("sessions").querySelector(`select[data-speed-for="${date}"]`);
    const speed = sel ? Number(sel.value) : 60;
    const wild = $("wild").classList.contains("on");
    play.disabled = true;
    pendingOpen.add(date);
    fetch("/api/sessions/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, speed, wild }) })
      .then((r) => r.json())
      .then(() => {
        loadSessions();
        const poll = setInterval(() => {
          if (!pendingOpen.has(date)) return clearInterval(poll);
          loadSessions();
        }, 1000);
        setTimeout(() => clearInterval(poll), 60000);
      });
    return;
  }
  const stop = e.target.closest("button[data-stop]");
  if (stop) {
    fetch("/api/sessions/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: stop.dataset.stop }) }).then(loadSessions);
  }
};
setInterval(() => {
  if (tab === "sessions") loadSessions();
}, 3000);

const es = new EventSource("/events");
es.onmessage = (e) => render(JSON.parse(e.data));
fetch("/api/state").then((r) => r.json()).then(render).catch(() => {});
