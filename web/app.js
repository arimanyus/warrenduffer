const $ = (id) => document.getElementById(id);

function render(s) {
  $("mode").textContent = `${s.mode} / opt ${s.optionsMode}`;
  $("mode").className = "pill " + (s.mode === "live" ? "r" : "g");
  $("model").textContent = s.model;
  $("session").textContent = s.session ? "kotak ok" : "no session";
  $("lat").textContent = `jev p50 ${s.latencyP50 || 0}ms`;
  $("skip").textContent = `skipped ${s.skippedToday || s.skipped || 0}`;
  $("regime").innerHTML = `regime <b>${s.regime}</b> · risk_off ${(s.riskOff || 0).toFixed(2)} · nifty_long ${(s.niftyLong || 0).toFixed(2)} · nifty_short ${(s.niftyShort || 0).toFixed(2)}`;
  const g = s.governor || {};
  $("today").innerHTML = `
    <div>PnL <b class="${s.todayPnl >= 0 ? "g" : "r"}">${(s.todayPnl || 0).toFixed(0)}</b> / cap ${s.dailyLossCap}</div>
    <div>friction ${(s.todayFriction || 0).toFixed(0)} / ${s.frictionBudget} · entries ${s.todayEntries} · allow ${g.allowance ?? "–"} (${g.reason ?? ""})</div>
    <div>${s.halted ? '<span class="r">HALTED</span>' : ""} ${s.killed ? '<span class="r">KILLED</span>' : ""}</div>`;
  $("positions").innerHTML = (s.positions || [])
    .map((p) => `<div>${p.symbol} ${p.side} ${p.qty} @ ${p.entryPrice} stop ${p.stop} u=${p.unrealized?.toFixed?.(0) ?? "–"} thesis=${p.thesis ?? "–"}</div>`)
    .join("") || "<div class='mut'>no positions</div>";
  const longs = (s.rankings || []).find((r) => r.side === "long")?.payload || [];
  const shorts = (s.rankings || []).find((r) => r.side === "short")?.payload || [];
  const cands = s.candidates || [];
  $("rank").innerHTML = `
    <div>long ${fmtRank(longs)}</div>
    <div>short ${fmtRank(shorts)}</div>
    <div>stage2 ${cands.map((c) => `${c.symbol} ${c.side} ${c.entryScore.toFixed(2)} ${c.tier}${s.taken && s.taken.symbol === c.symbol ? " ← taken" : ""}`).join(" · ") || "–"}</div>`;
  const tb = $("trades").querySelector("tbody");
  tb.innerHTML = (s.trades || [])
    .map((t) => `<tr><td>${ago(t.closed_at)}</td><td>${t.leg}</td><td>${t.symbol}</td><td>${t.side}</td><td class="${t.pnl >= 0 ? "g" : "r"}">${Number(t.pnl).toFixed(0)}</td><td>${t.exit_reason}</td><td>${t.attribution || ""}</td></tr>`)
    .join("");
  const db = $("decs").querySelector("tbody");
  db.innerHTML = (s.decisions || [])
    .slice(0, 80)
    .map((d) => `<tr><td>${d.stage}</td><td>${d.symbol || ""}</td><td>${d.question}</td><td>${d.answer}</td><td>${d.probability ?? ""}</td><td>${d.latency_ms}</td></tr>`)
    .join("");
}

function fmtRank(xs) {
  if (!Array.isArray(xs)) return "–";
  return xs.map((x) => `${x.symbol} ${(x.p || 0).toFixed(2)}`).join(" · ") || "–";
}

function ago(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
}

$("kill").onclick = () => {
  if (prompt("type CONFIRM to kill") !== "CONFIRM") return;
  fetch("/api/kill", { method: "POST" });
};

const es = new EventSource("/events");
es.onmessage = (e) => render(JSON.parse(e.data));
fetch("/api/state").then((r) => r.json()).then(render).catch(() => {});
