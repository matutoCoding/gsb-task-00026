/* 推焦推演台 —— 分钟级前向推演引擎 + 值班工长界面 */
(function (global) {
'use strict';

/* ============ 工具 ============ */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
// 相对接班分钟 -> HH:MM（可跨日）。base 为接班的钟点分钟（如早班 480=08:00）
function relHHMM(rel, base) {
  if (base === undefined || base === null) base = 0;
  var total = base + Math.round(rel);
  var m = ((total % 1440) + 1440) % 1440;
  var day = Math.floor((total + 720000) / 1440) - 500;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60) + (day > 0 ? '(+%d)'.replace('%d', day) : '');
}
function hmToRel(hm) {
  if (!hm) return 0;
  var p = hm.split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}
function devText(d) {
  if (d < 0) return '早' + (-d) + '分';
  if (d > 0) return '晚' + d + '分';
  return '准点';
}
function vname(v) { return { pusher: '推焦车', guide: '拦焦车', quench: '熄焦车' }[v] || v; }

/* ============ 推焦串序生成（2-1 / 5-2 / 9-2） ============
   以“道”链方式展开：例如 5-2，道链 1,6,11,...；每条道间隔 m*r 分钟首推，
   保证串序炉号不重不漏，相邻序号炉号间距就是生产串序间距。 */
function buildSequence(n, m, first) {
  var chains = [];
  for (var a = 1; a <= m; a++) {
    var chain = [];
    for (var o = a; o <= n; o += m) chain.push(o);
    chains.push(chain);
  }
  var seq = [], seen = {};
  chains.forEach(function (chain) {
    chain.forEach(function (o) {
      if (!seen[o]) { seen[o] = 1; seq.push(o); }
    });
  });
  // 旋转，使接班首孔 = first
  var fi = seq.indexOf(first);
  if (fi < 0) fi = 0;
  return seq.slice(fi).concat(seq.slice(0, fi));
}

/* ============ 推演引擎（纯函数，便于核算/测试） ============ */
/*
 cfg: {
   nOvens, step(2|5|9), firstOven, firstTarget(相对接班分钟), gap(分),
   coke(结焦分钟), early(允许提前), late(允许滞后),
   vehicles:{ pusher:{speed,occupy,pos}, guide:{...}, quench:{...} },
   maints:[{start,end}]  相对接班分钟，end<start 视为次日
 }
 每孔：目标计划推焦 t0，装煤 = t0 - 结焦时间；窗口 [t0-early, t0+late]。
 三车从上孔位置走行到位 + 上孔占时释放 -> 最早可动时刻 ready；
 落入检修段则顺延到检修结束；ready 早于窗口起点则等窗口（防生焦）。
 实际时刻超出窗口终点 -> 判废（这炉废了，车不动，不再往后排）。
 一孔顺延，其下一孔三车释放时刻跟着顺延 => 整串连锁。
*/
function simulate(cfg) {
  var n = cfg.nOvens, gap = cfg.gap;
  var seq = buildSequence(n, cfg.step, clamp(cfg.firstOven, 1, n));
  var maints = cfg.maints.map(function (x) {
    return { start: x.start, end: x.end < x.start ? x.end + 1440 : x.end };
  }).filter(function (x) { return x.end > x.start; })
    .sort(function (a, b) { return a.start - b.start; });

  var vs = ['pusher', 'guide', 'quench'];
  var state = {};
  vs.forEach(function (v) {
    var c = cfg.vehicles[v];
    state[v] = { freeAt: c.unavailableUntil || 0, pos: clamp(c.pos, 1, n) };
  });

  var events = [];
  seq.forEach(function (oven, i) {
    var t0 = cfg.targets ? cfg.targets[i] : cfg.firstTarget + i * gap;
    var winStart = t0 - cfg.early, winEnd = t0 + cfg.late;

    var parts = {};
    var ready = 0;
    vs.forEach(function (v) {
      var c = cfg.vehicles[v];
      var travel = Math.ceil(Math.abs(oven - state[v].pos) * c.speed);
      var at = state[v].freeAt + travel;
      parts[v] = { travel: travel, ready: at, fromPos: state[v].pos };
      if (at > ready) ready = at;
    });
    var vehicleWait = ready;

    var maintDelay = 0, hitMaint = null;
    function slideMaint() {
      for (var k = 0; k < maints.length; k++) {
        var mb = maints[k];
        if (ready >= mb.start && ready < mb.end) {
          hitMaint = mb; maintDelay += mb.end - ready; ready = mb.end;
          return true;
        }
      }
      return false;
    }
    var waitWindow = false;
    // 交替处理“检修避让 / 等结焦窗口”，直到时刻稳定：
    // 等完窗口或让完检修后，都可能落入另一个封锁段/仍未到窗口。
    var guard = 0;
    while (guard++ < 100) {
      var moved = slideMaint();
      if (ready < winStart) { waitWindow = true; ready = winStart; moved = true; }
      if (!moved) break;
    }

    var ruined = ready > winEnd;
    // 窗口内：早于计划=等结焦窗口(防生焦)，正点=ok，晚于计划=被顺延
    var st = ruined ? 'ruin' : (ready < t0 ? 'wait' : (ready === t0 ? 'ok' : 'late'));

    var ev = {
      idx: i + 1, oven: oven,
      charge: t0 - cfg.coke, target: t0,
      winStart: winStart, winEnd: winEnd,
      vehicleReady: vehicleWait, readyFinal: ready, maintDelay: maintDelay,
      hitMaint: hitMaint ? { start: hitMaint.start, end: hitMaint.end } : null,
      planned: ruined ? null : ready,
      dev: ruined ? null : ready - t0,
      status: st,
      parts: parts
    };
    events.push(ev);

    if (!ruined) {
      vs.forEach(function (v) {
        state[v].freeAt = ready + cfg.vehicles[v].occupy;
        state[v].pos = oven;
      });
    } else {
      // 判废孔不推、车不移动，但该号位在时间序上仍占用：车要等到窗口关闭后才能
      // 继续下一序号，防止后续孔被排到本孔之前（连锁顺延的时间基准）。
      vs.forEach(function (v) {
        state[v].freeAt = Math.max(state[v].freeAt, winEnd);
      });
    }
  });

  return { events: events, seq: seq, maints: maints };
}

global.PushSim = { simulate: simulate, buildSequence: buildSequence,
  relHHMM: relHHMM, hmToRel: hmToRel, devText: devText, vname: vname, clamp: clamp, pad2: pad2 }
})(typeof window !== 'undefined' ? window : globalThis);

/* ============ 以下为浏览器界面（Node 下不执行） ============ */
if (typeof document !== 'undefined') (function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
var S = PushSim;
function pad2(n) { return (n < 10 ? '0' : '') + n; }
var shiftBaseRel = 480; // 接班钟点（分钟），recalc 时按 fShift 更新
function H(rel) { return S.relHHMM(rel, shiftBaseRel); }

var DEFAULT = {
  date: '', shift: '08:00', nOvens: 50, step: 5, firstOven: 5,
  firstTarget: '08:10', cokeH: 20, cokeM: 0,
  early: 5, late: 10, gap: 10,
  vehicles: {
    pusher: { speed: 0.2, occupy: 6, pos: 5, downUntil: '' },
    guide:  { speed: 0.2, occupy: 5, pos: 5, downUntil: '' },
    quench: { speed: 0.2, occupy: 8, pos: 5, downUntil: '' }
  },
  maints: [{ start: '10:00', end: '10:25' }]
};

var cfg = loadCfg();
var result = null;
var overrides = loadOverrides();           // oven(字符串) -> HH:MM
var scrubRel = 0;
var selIdx = 0;
var playTimer = null;

/* ---------- 存取 ---------- */
function loadCfg() {
  try {
    var raw = localStorage.getItem('pusim-cfg-v1');
    if (raw) return Object.assign(JSON.parse(JSON.stringify(DEFAULT)), JSON.parse(raw));
  } catch (e) {}
  var d = JSON.parse(JSON.stringify(DEFAULT));
  d.date = new Date().toISOString().slice(0, 10);
  return d;
}
function saveCfg() { try { localStorage.setItem('pusim-cfg-v1', JSON.stringify(cfg)); } catch (e) {} }
function loadOverrides() {
  try { return JSON.parse(localStorage.getItem('pusim-over-v1') || '{}'); } catch (e) { return {}; }
}
function saveOverrides() { try { localStorage.setItem('pusim-over-v1', JSON.stringify(overrides)); } catch (e) {} }

/* ---------- 表单 -> cfg ---------- */
function readForm() {
  cfg.nOvens = S.clamp(parseInt($('fOvens').value, 10) || 50, 10, 120);
  cfg.step = parseInt($('fStep').value, 10);
  cfg.firstOven = S.clamp(parseInt($('fFirst').value, 10) || 1, 1, cfg.nOvens);
  cfg.firstTarget = $('fFirstTarget').value || '08:00';
  cfg.shift = $('fShift').value || '08:00';
  cfg.date = $('fDate').value;
  cfg.cokeH = parseInt($('fCokeH').value, 10) || 0;
  cfg.cokeM = parseInt($('fCokeM').value, 10) || 0;
  cfg.early = parseInt($('fEarly').value, 10) || 0;
  cfg.late = parseInt($('fLate').value, 10) || 0;
  cfg.gap = parseInt($('fGap').value, 10) || 12;
  ['pusher', 'guide', 'quench'].forEach(function (v) {
    var box = document.querySelector('.vehicle[data-v="' + v + '"]');
    cfg.vehicles[v].speed = parseFloat(box.querySelector('.v-speed').value) || 0;
    cfg.vehicles[v].occupy = parseInt(box.querySelector('.v-occupy').value, 10) || 1;
    cfg.vehicles[v].pos = parseInt(box.querySelector('.v-pos').value, 10) || 1;
    cfg.vehicles[v].downUntil = box.querySelector('.v-down').value || '';
  });
  cfg.maints = [];
  document.querySelectorAll('.maint-item').forEach(function (row) {
    var a = row.querySelector('.m-start').value, b = row.querySelector('.m-end').value;
    if (a && b) cfg.maints.push({ start: a, end: b });
  });
}
function writeForm() {
  $('fDate').value = cfg.date || '';
  $('fShift').value = cfg.shift;
  $('fOvens').value = cfg.nOvens;
  $('fStep').value = cfg.step;
  $('fFirst').value = cfg.firstOven;
  $('fFirstTarget').value = cfg.firstTarget;
  $('fCokeH').value = cfg.cokeH;
  $('fCokeM').value = cfg.cokeM;
  $('fEarly').value = cfg.early;
  $('fLate').value = cfg.late;
  $('fGap').value = cfg.gap;
  ['pusher', 'guide', 'quench'].forEach(function (v) {
    var box = document.querySelector('.vehicle[data-v="' + v + '"]');
    box.querySelector('.v-speed').value = cfg.vehicles[v].speed;
    box.querySelector('.v-occupy').value = cfg.vehicles[v].occupy;
    box.querySelector('.v-pos').value = cfg.vehicles[v].pos;
    box.querySelector('.v-down').value = cfg.vehicles[v].downUntil || '';
  });
  renderMaint();
}
function renderMaint() {
  var list = $('maintList');
  list.innerHTML = '';
  cfg.maints.forEach(function (m, mi) {
    var row = document.createElement('div');
    row.className = 'maint-item';
    row.innerHTML =
      '<input type="time" step="60" class="m-start" value="' + m.start + '">' +
      '<span>—</span>' +
      '<input type="time" step="60" class="m-end" value="' + m.end + '">' +
      '<button title="删除">✕</button>';
    list.appendChild(row);
    row.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('change', scheduleRecalc);
    });
    row.querySelector('button').addEventListener('click', function () {
      cfg.maints.splice(mi, 1); renderMaint(); scheduleRecalc();
    });
  });
}

/* ---------- 组装引擎入参（含单孔计划改写） ---------- */
function buildEngineCfg() {
  var shiftRel = S.hmToRel(cfg.shift);
  var firstRel = S.hmToRel(cfg.firstTarget);
  if (firstRel < shiftRel) firstRel += 1440;

  var maints = cfg.maints.map(function (m) {
    var s = S.hmToRel(m.start), e = S.hmToRel(m.end);
    if (s < shiftRel) s += 1440;
    if (e <= s) e += 1440;
    return { start: s - shiftRel, end: e - shiftRel };
  });

  var coke = cfg.cokeH * 60 + cfg.cokeM;
  var vehicles = {};
  ['pusher', 'guide', 'quench'].forEach(function (v) {
    var down = 0;
    if (cfg.vehicles[v].downUntil) {
      var d = S.hmToRel(cfg.vehicles[v].downUntil);
      if (d < shiftRel) d += 1440;
      down = d - shiftRel;
    }
    vehicles[v] = {
      speed: cfg.vehicles[v].speed,
      occupy: cfg.vehicles[v].occupy,
      pos: cfg.vehicles[v].pos,
      unavailableUntil: down
    };
  });
  return {
    nOvens: cfg.nOvens, step: cfg.step, firstOven: cfg.firstOven,
    firstTarget: firstRel - shiftRel, gap: cfg.gap,
    coke: coke, early: cfg.early, late: cfg.late,
    vehicles: vehicles,
    maints: maints
  };
}

/* ---------- 重算 ---------- */
var recalcTimer = null;
function scheduleRecalc() {
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(recalc, 120);
}
function recalc() {
  readForm();
  saveCfg();
  shiftBaseRel = S.hmToRel(cfg.shift);
  var ec = buildEngineCfg();
  // 单孔改计划：从该孔起平移其后整串序号的目标时刻
  var base = ec.firstTarget;
  var tgts = [];
  for (var i = 0; i < ec.nOvens; i++) tgts.push(base + i * ec.gap);
  var seq0 = S.buildSequence(ec.nOvens, ec.step, ec.firstOven);
  Object.keys(overrides).forEach(function (ovenStr) {
    var oven = parseInt(ovenStr, 10);
    var pos = seq0.indexOf(oven);
    if (pos < 0) return;
    var want = S.hmToRel(overrides[ovenStr]);
    if (want < S.hmToRel(cfg.shift)) want += 1440;
    var wantRel = want - S.hmToRel(cfg.shift);
    var delta = wantRel - tgts[pos];
    for (var k = pos; k < tgts.length; k++) tgts[k] += delta;
  });
  ec.targets = tgts;
  result = S.simulate(ec);
  if (selIdx >= result.events.length) selIdx = 0;
  var maxT = 0;
  result.events.forEach(function (e) { maxT = Math.max(maxT, e.target, e.planned || 0, e.winEnd); });
  renderKpis(maxT);
  renderChart(maxT);
  renderTable();
  renderDetail();
  updateScrubUI();
}

/* ---------- KPI ---------- */
function renderKpis(maxT) {
  var evs = result.events;
  var done = evs.filter(function (e) { return e.planned !== null; }).length;
  var ruined = evs.filter(function (e) { return e.status === 'ruin'; }).length;
  var lateN = evs.filter(function (e) { return e.dev !== null && e.dev > 0; }).length;
  var maxDev = evs.reduce(function (m, e) { return Math.max(m, e.dev || -9999); }, -9999);
  var ontime = done ? evs.filter(function (e) { return e.dev !== null && Math.abs(e.dev) <= 5; }).length / evs.length * 100 : 0;
  var span = maxT;
  var k = [
    { v: evs.length + ' 孔', l: '接班后应推', c: '' },
    { v: done + ' 孔', l: '可正常推出', c: 'good' },
    { v: ruined + ' 孔', l: '过窗口判废', c: ruined ? 'bad' : '' },
    { v: lateN + ' 孔', l: '被压顺延', c: lateN ? 'warn' : '' },
    { v: maxDev > -9999 ? '+' + maxDev + ' 分' : '—', l: '最大顺延', c: maxDev > cfg.late ? 'bad' : '' },
    { v: ontime.toFixed(0) + '%', l: '准点率(±5分)', c: ontime >= 95 ? 'good' : 'warn' },
    { v: Math.round(span / 60 * 10) / 10 + ' 时', l: '推演总时长', c: '' }
  ];
  $('kpis').innerHTML = k.map(function (x) {
    return '<div class="kpi ' + x.c + '"><div class="v">' + x.v + '</div><div class="l">' + x.l + '</div></div>';
  }).join('');
}

/* ---------- 时序图 ---------- */
var ROWH = 22, LABELW = 70;
function chartScale() { return parseInt($('fZoom').value, 10); }
function horizonEnd() {
  var maxT = 600;
  result.events.forEach(function (e) { maxT = Math.max(maxT, e.target + 30, e.winEnd + 30, e.planned || 0); });
  return Math.ceil((maxT + 60) / 60) * 60;
}
function renderChart() {
  var px = chartScale();
  var end = horizonEnd();
  var inner = $('chartInner');
  var w = LABELW + end * px;
  var h = 26 + result.events.length * ROWH + 8;
  inner.style.width = w + 'px';
  inner.style.height = h + 'px';

  var html = '';
  // 轴
  html += '<div class="g-axis"><div style="width:' + LABELW + 'px;position:absolute;top:0;bottom:0;background:var(--panel);border-right:1px solid var(--line)"></div>';
  var tickStep = px <= 1 ? 60 : px <= 2 ? 60 : 30;
  for (var t = 0; t <= end; t += tickStep) {
    html += '<div class="g-tick" style="left:' + (LABELW + t * px) + 'px"><span class="ticklab">' + H(t) + '</span></div>';
  }
  html += '</div>';

  html += '<div class="g-grid">';
  // 检修段
  result.maints.forEach(function (mb) {
    html += '<div class="g-band" style="left:' + (LABELW + mb.start * px) + 'px;width:' +
      Math.max(0, (mb.end - mb.start) * px) + 'px"><span class="bandlab">检修封锁 ' +
      H(mb.start) + '–' + H(mb.end) + '</span></div>';
  });
  // 行
  result.events.forEach(function (e, i) {
    var top = i * ROWH;
    html += '<div class="g-row" style="top:' + top + 'px;height:' + ROWH + 'px">';
    html += '<div class="g-ovlab">#' + (i + 1) + ' · ' + e.oven + '号</div>';
    // 窗口
    var stCls = 'st-ok';
    html += '<div class="g-win" style="left:' + (LABELW + e.winStart * px) + 'px;width:' +
      Math.max(2, (e.winEnd - e.winStart) * px) + 'px;background:#3f5468"></div>';
    // 目标刻线
    html += '<div class="g-target" style="left:' + (LABELW + e.target * px) + 'px" title="计划 ' + H(e.target) + '"></div>';
    // 推焦点
    if (e.status === 'ruin') {
      html += '<div class="g-mark st-ruin" data-i="' + i + '" style="left:' + (LABELW + e.target * px) +
        'px;top:' + (top + 5) + 'px" title="' + e.oven + '号 · 已过窗口判废"></div>';
    } else {
      var future = e.planned > scrubRel ? ' future' : '';
      var sel = i === selIdx ? ' sel' : '';
      html += '<div class="g-mark st-' + e.status + sel + future + '" data-i="' + i +
        '" style="left:' + (LABELW + e.planned * px) + 'px;top:' + (top + 5) +
        'px" title="' + e.oven + '号炉 · ' + H(e.planned) + ' · ' + devTitle(e) + '"></div>';
    }
    html += '</div>';
  });
  // 未来压暗
  if (scrubRel < end) {
    html += '<div class="g-futureveil" style="left:' + (LABELW + scrubRel * px) + 'px;right:0"></div>';
  }
  // 拨杆线
  html += '<div class="g-x" id="scrubLine" style="left:' + (LABELW + scrubRel * px) + 'px"></div>';
  html += '</div>';

  inner.innerHTML = html;
  inner.querySelectorAll('.g-mark').forEach(function (mk) {
    mk.addEventListener('click', function () {
      selIdx = parseInt(mk.getAttribute('data-i'), 10);
      renderChart(); renderTable(); renderDetail();
    });
  });
}
function devTitle(e) {
  if (e.status === 'wait') return '等结焦窗口（防生焦）';
  if (e.dev > 0) return '顺延晚' + e.dev + '分';
  if (e.dev < 0) return '早' + (-e.dev) + '分';
  return '准点';
}

/* ---------- 明细表 ---------- */
var STNAME = { ok: '准点', wait: '等窗口', late: '顺延', ruin: '判废' };
function reasonShort(e) {
  if (e.status === 'ruin') {
    return '窗口 ' + H(e.winEnd) + ' 关闭，三车最早 ' + H(e.readyFinal) +
      ' 才齐 → 生焦/废炉，停止后排';
  }
  var bits = [];
  if (e.hitMaint) bits.push('检修 ' + H(e.hitMaint.start) + '–' + H(e.hitMaint.end) + ' 让路');
  var bottle = null, bv = -1;
  ['pusher', 'guide', 'quench'].forEach(function (v) {
    if (e.parts[v].ready > bv) { bv = e.parts[v].ready; bottle = v; }
  });
  if (bv > e.target || (e.hitMaint)) {
    bits.push(S.vname(bottle) + '最后到位（走行' + e.parts[bottle].travel + '分）');
  }
  if (e.status === 'wait') bits.unshift('接班时未到结焦点，等窗口开 ' + H(e.winStart));
  if (e.dev > 0) bits.push('连锁顺延晚' + e.dev + '分');
  if (!bits.length) bits.push('三车正点凑齐，窗口内直接推');
  return bits.join('；');
}
function renderTable() {
  var tb = $('tblBody');
  var html = '';
  result.events.forEach(function (e, i) {
    var sel = i === selIdx ? ' class="sel"' : '';
    var ov = String(e.oven);
    var planCell = e.status === 'ruin'
      ? '<td class="c-time dv-ruin">—</td>'
      : '<td class="c-time"><input class="cell-edit" data-oven="' + ov + '" value="' +
        fmtEdit(e.target) + '" title="改计划推焦，整串重排"></td>';
    html += '<tr' + sel + ' data-i="' + i + '">' +
      '<td class="c-idx">' + (i + 1) + '</td>' +
      '<td class="c-oven">' + e.oven + '</td>' +
      '<td class="c-time">' + H(e.charge) + '</td>' +
      '<td class="c-time">' + cfg.cokeH + ':' + pad2(cfg.cokeM) + '</td>' +
      planCell +
      '<td class="c-win dim">' + H(e.winStart) + '–' + H(e.winEnd) + '</td>' +
      (e.status === 'ruin'
        ? '<td class="c-time dv-ruin">不排</td><td class="c-dev dv-ruin">窗口已过</td>'
        : '<td class="c-time dv-' + e.status + '">' + H(e.planned) + '</td>' +
          '<td class="c-dev dv-' + (e.dev === 0 ? 'ok' : e.status) + '">' + S.devText(e.dev) + '</td>') +
      '<td class="c-st"><span class="badge st-' + e.status + '">' + STNAME[e.status] + '</span></td>' +
      '<td class="td-reason">' + reasonShort(e) + '</td></tr>';
  });
  tb.innerHTML = html;
  tb.querySelectorAll('tr').forEach(function (tr) {
    tr.addEventListener('click', function () {
      selIdx = parseInt(tr.getAttribute('data-i'), 10);
      renderChart(); renderTable(); renderDetail();
    });
  });
  tb.querySelectorAll('.cell-edit').forEach(function (inp) {
    inp.addEventListener('click', function (ev2) { ev2.stopPropagation(); });
    inp.addEventListener('change', function () {
      var v = inp.value.trim();
      if (!/^\d{1,2}:\d{2}$/.test(v)) { recalc(); return; }
      overrides[inp.getAttribute('data-oven')] = v;
      saveOverrides();
      recalc();
    });
  });
}
function fmtEdit(rel) {
  var m = (((shiftBaseRel + Math.round(rel)) % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

/* ---------- 单孔回溯 ---------- */
function queueAhead(e) {
  // 拨杆时刻：这孔前面“压了几孔”——
  // 只数窗口已经开了却还没推出去的孔（车压着/检修让路），以及窗口已关的判废孔；
  // 窗口还没开（结焦未到点）的孔属于正常待结焦，不算“压车”。
  var i = e.idx - 1;
  var list = [];
  for (var k = 0; k < i; k++) {
    var p = result.events[k];
    if (p.status === 'ruin') {
      if (p.winEnd <= scrubRel) list.push(p);
    } else if (p.planned > scrubRel && p.winStart <= scrubRel) {
      list.push(p);
    }
  }
  return list;
}
function renderDetail() {
  var e = result.events[selIdx];
  if (!e) return;
  var box = $('detailBody');
  var q = queueAhead(e);
  var atScrub = function () {
    if (e.status === 'ruin') return '该孔窗口已于 ' + H(e.winEnd) + ' 关闭，判废停排';
    if (e.planned <= scrubRel) return '已在 ' + H(e.planned) + ' 推焦完成';
    if (scrubRel >= e.winStart) return '窗口已开，正在等三车凑齐';
    return '结焦未到点（早推出生焦），排队等待中';
  };

  var h = '';
  h += '<div class="dh"><span class="big">' + e.oven + '号</span><span class="seq">推焦序号 #' + e.idx + ' / ' + result.events.length + '</span></div>';
  h += '<div class="backlog">拨到 <b>' + H(scrubRel) + '</b>：前面还压着 <b>' + q.length + '</b> 孔没出完。<div class="queuechips">' +
    q.slice(0, 12).map(function (p) {
      return '<span>#' + p.idx + ' ' + p.oven + '号' + (p.status === 'ruin' ? '(废)' : '') + '</span>';
    }).join('') + (q.length > 12 ? '<span>…</span>' : '') + '</div></div>';

  h += '<div class="dgrid">' +
    dcell('装煤时刻', H(e.charge)) +
    dcell('结焦时间', cfg.cokeH + '时' + pad2(cfg.cokeM) + '分') +
    dcell('计划推焦', H(e.target)) +
    dcell('推演推焦', e.planned !== null ? H(e.planned) : '<span class="dv-ruin">不排</span>') +
    dcell('结焦窗口', H(e.winStart) + '–' + H(e.winEnd)) +
    dcell('偏差', e.dev === null ? '—' : '<span class="dv-' + (e.dev === 0 ? 'ok' : e.status) + '">' + S.devText(e.dev) + '</span>') +
    '</div>';

  h += '<div class="dsec"><h4>此刻状态</h4><div>' + atScrub() + '</div></div>';
  h += '<div class="dsec"><h4>排在这个位置的原因（逐级推演）</h4><ul class="trace">' + buildTrace(e) + '</ul></div>';
  box.innerHTML = h;
}
function dcell(l, v) {
  return '<div class="dcell"><div class="l">' + l + '</div><div class="v">' + v + '</div></div>';
}
function buildTrace(e) {
  var L = [];
  L.push(li('', e.oven + '号炉 ' + H(e.charge) + ' 装煤，结焦 ' + cfg.cokeH + '时' + pad2(cfg.cokeM) +
    '分，理论 ' + H(e.target) + ' 到结焦点（炉号/结焦/计划三落一孔）'));
  L.push(li('', '结焦窗口 ' + H(e.winStart) + '–' + H(e.winEnd) +
    '：早于 ' + H(e.winStart) + ' 是生焦，晚于 ' + H(e.winEnd) + ' 这炉作废'));

  ['pusher', 'guide', 'quench'].forEach(function (v) {
    var p = e.parts[v];
    var c = cfg.vehicles[v];
    L.push(li(p.ready > e.winStart ? 'warn' : '',
      S.vname(v) + '：自 ' + p.fromPos + '号轨位走行 |' + e.oven + '-' + p.fromPos + '|×' + c.speed +
      '=' + p.travel + '分，最早 ' + H(p.ready) + ' 能凑上' +
      (p.ready <= e.winStart ? '（窗口开启前已就位）' : (p.ready <= e.winEnd ? '（窗口开启后才到，仍在窗口内）' : '（到不了窗口内）'))));
  });
  var bottle = null, bv = -1;
  ['pusher', 'guide', 'quench'].forEach(function (v) {
    if (e.parts[v].ready > bv) { bv = e.parts[v].ready; bottle = v; }
  });
  L.push(li(bv > e.winStart ? 'warn' : 'good',
    '三车取最慢：' + S.vname(bottle) + ' ' + H(bv) + ' 才齐 —— 三样缺一样都不能推'));

  if (e.hitMaint) {
    L.push(li('warn', '检修封锁 ' + H(e.hitMaint.start) + '–' + H(e.hitMaint.end) +
      ' 插入，该时段全孔让路，顺延至 ' + H(e.hitMaint.end)));
  }
  if (e.vehicleReady < e.winStart) {
    L.push(li('warn', '车齐了但还没到窗口，等到 ' + H(e.winStart) + ' 再推（防生焦）'));
  }
  // 连锁来源
  if (e.idx > 1) {
    var prev = result.events[e.idx - 2];
    L.push(li('', '上一序号 #' + prev.idx + ' ' + prev.oven + '号' +
      (prev.planned !== null ? ' ' + H(prev.planned) + ' 推完才放车' : ' 判废') +
      '；它一旦晚点，三车释放点后移，本孔整串跟着挪'));
  }
  if (e.status === 'ruin') {
    L.push(li('bad', '实际可推 ' + H(e.readyFinal) + ' 已晚于窗口终点 ' +
      H(e.winEnd) + ' → 判定生焦/废炉，该孔不再往后排，后续序号依次顶替'));
  } else {
    L.push(li(e.dev > 0 ? 'warn' : 'good',
      '最终 ' + H(e.planned) + ' 推焦，' + (e.dev === 0 ? '准点' : S.devText(e.dev)) +
      (e.dev > cfg.late ? '（注意：已超允许滞后）' : '')));
  }
  return L.join('');
}
function li(cls, txt) { return '<li class="' + cls + '">' + txt + '</li>'; }

/* ---------- 拨杆 / 播放 ---------- */
function setScrub(rel) {
  scrubRel = S.clamp(Math.round(rel), 0, horizonEnd());
  renderChart(); renderDetail();
  // 表格行状态联动
  result.events.forEach(function (e, i) {
    var tr = $('tblBody').querySelector('tr[data-i="' + i + '"]');
    if (tr) tr.style.opacity = (e.planned !== null && e.planned <= scrubRel) ||
      (e.status === 'ruin' && e.winEnd <= scrubRel) ? '0.45' : '1';
  });
  updateScrubUI();
}
function updateScrubUI() {
  $('clock').textContent = H(scrubRel);
  var done = result.events.filter(function (e) {
    return e.planned !== null && e.planned <= scrubRel;
  }).length;
  var ruinNow = result.events.filter(function (e) {
    return e.status === 'ruin' && e.winEnd <= scrubRel;
  }).length;
  var queue = result.events.filter(function (e) {
    return e.planned !== null && e.planned > scrubRel && e.winStart <= scrubRel;
  }).length;
  $('clockSub').textContent = '已推 ' + done + ' 孔 · 窗口已开待推 ' + queue + ' 孔 · 已判废 ' + ruinNow + ' 孔';
}
function togglePlay() {
  var btn = $('btnPlay');
  if (playTimer) { clearInterval(playTimer); playTimer = null; btn.textContent = '▶'; return; }
  btn.textContent = '⏸';
  var speed = parseInt($('fPlaySpeed').value, 10);
  playTimer = setInterval(function () {
    if (scrubRel >= horizonEnd()) { togglePlay(); return; }
    setScrub(scrubRel + speed / 10); // 10帧/秒
  }, 100);
}

/* ---------- 事件绑定 / 初始化 ---------- */
function init() {
  writeForm();
  document.querySelectorAll('#sideLeft input, #sideLeft select').forEach(function (el) {
    el.addEventListener('change', scheduleRecalc);
  });
  $('btnAddMaint').addEventListener('click', function () {
    cfg.maints.push({ start: '13:00', end: '13:30' });
    renderMaint(); scheduleRecalc();
  });
  $('btnRecalc').addEventListener('click', recalc);
  $('btnReset').addEventListener('click', function () {
    if (!confirm('恢复全部默认条件？（含单孔改写）')) return;
    localStorage.removeItem('pusim-cfg-v1');
    localStorage.removeItem('pusim-over-v1');
    location.reload();
  });
  $('fZoom').addEventListener('change', function () { renderChart(); });

  // 时序图上点击/拖拨杆
  var chartScroll = $('chartScroll');
  function scrubFromEvent(ev2) {
    var rect = $('chartInner').getBoundingClientRect();
    var x = ev2.clientX - rect.left - LABELW;
    setScrub(x / chartScale());
  }
  var dragging = false;
  chartScroll.addEventListener('mousedown', function (ev2) {
    if (ev2.target.classList.contains('g-mark')) return;
    dragging = true; scrubFromEvent(ev2);
  });
  window.addEventListener('mousemove', function (ev2) { if (dragging) scrubFromEvent(ev2); });
  window.addEventListener('mouseup', function () { dragging = false; });

  $('btnToStart').addEventListener('click', function () { setScrub(0); });
  $('btnStep').addEventListener('click', function () { setScrub(scrubRel + 10); });
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnTen').addEventListener('click', function () {
    var shift = S.hmToRel(cfg.shift);
    var ten = 10 * 60 - shift;
    if (ten < 0) ten += 1440;
    setScrub(ten);
  });

  recalc();
  setScrub(0);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
