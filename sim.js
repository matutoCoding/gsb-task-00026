/* 推焦推演引擎：时间一律用“距零点分钟数”表示，按分钟推进 */
(function (root) {
  'use strict';

  function parseHM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }

  function fmtHM(t) {
    if (t == null) return '—';
    var day = '';
    var tt = t;
    if (tt >= 1440) { day = '次日'; tt -= 1440; }
    var h = Math.floor(tt / 60), mi = tt % 60;
    return day + (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }

  /* 解析窗口文本行："08:30-09:10 备注" */
  function parseWindows(text) {
    var out = [];
    String(text || '').split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(.*)$/.exec(line);
      if (!m) return;
      var a = parseHM(m[1]), b = parseHM(m[2]);
      if (a == null || b == null || b <= a) return;
      out.push({ start: a, end: b, label: m[3] || '' });
    });
    out.sort(function (x, y) { return x.start - y.start; });
    return out;
  }

  /* 生成炉孔：第 i 孔到点时刻 = 接班 + 首孔偏移 + i*计划间隔（可加确定性扰动） */
  function buildOvens(p) {
    var ovens = [];
    for (var i = 0; i < p.ovenCount; i++) {
      var jitter = 0;
      if (p.jitter > 0) {
        var x = Math.sin((i + 1) * 127.1) * 43758.5453;
        jitter = Math.round((x - Math.floor(x) - 0.5) * 2 * p.jitter);
      }
      var ready = p.shiftStart + p.firstReadyOffset + i * p.idealInterval + jitter;
      ovens.push({
        id: i + 1,
        ready: ready,                       // 结焦时间到点
        charge: ready - p.cokingMinutes,    // 装煤时刻
        windowEnd: ready + p.lateTolerance  // 窗口死线：过了就废
      });
    }
    return ovens;
  }

  /* 从 t 起跳过不可用窗口，要求 [t, t+duration) 与所有窗口不重叠；返回 {t, hits} */
  function skipWindows(t, duration, windows) {
    var hits = [];
    var moved = true, guard = 0;
    while (moved && guard++ < 1000) {
      moved = false;
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (t < w.end && t + duration0(duration) > w.start) {
          hits.push(w);
          t = w.end;
          moved = true;
        }
      }
    }
    return { t: t, hits: hits };
  }
  function duration0(d) { return d; }

  /*
   * 主推演：
   * p = { shiftStart, ovenCount, cokingMinutes, firstReadyOffset, idealInterval,
   *       cycleTime, lateTolerance, jitter }
   * equip = { pusher:[], guide:[], quench:[] }  三车各自的不可用窗口
   * maint = []  检修窗口
   */
  function simulate(p, equip, maint) {
    var ovens = buildOvens(p);
    var windows = [];
    [['推焦车', equip.pusher], ['拦焦车', equip.guide], ['熄焦车', equip.quench]]
      .forEach(function (pair) {
        pair[1].forEach(function (w) {
          windows.push({ start: w.start, end: w.end, label: pair[0] + (w.label ? '：' + w.label : '不可用'), kind: 'equip' });
        });
      });
    maint.forEach(function (w) {
      windows.push({ start: w.start, end: w.end, label: '检修' + (w.label ? '：' + w.label : ''), kind: 'maint' });
    });
    windows.sort(function (a, b) { return a.start - b.start; });

    var machineFree = p.shiftStart;
    var seq = 0;
    var results = ovens.map(function (ov) {
      var reasons = [];
      var t = Math.max(ov.ready, machineFree);
      if (machineFree > ov.ready) reasons.push('前车未腾开（推焦车占用至 ' + fmtHM(machineFree) + '）');

      var skipped = skipWindows(t, p.cycleTime, windows);
      if (skipped.t > t) {
        skipped.hits.forEach(function (w) {
          reasons.push((w.kind === 'maint' ? '检修让路' : '设备不齐') + '（' + w.label + '，至 ' + fmtHM(w.end) + '）');
        });
        t = skipped.t;
      }

      var r = {
        id: ov.id, charge: ov.charge, ready: ov.ready, windowEnd: ov.windowEnd,
        cokingHours: p.cokingMinutes / 60,
        push: null, seq: null, status: '', reasons: reasons
      };

      if (t > ov.windowEnd) {
        r.status = '过窗口';
        reasons.push('最早可排 ' + fmtHM(t) + '，已晚于死线 ' + fmtHM(ov.windowEnd) + '，此孔作废不再后排');
      } else {
        r.push = t;
        r.seq = ++seq;
        machineFree = t + p.cycleTime;
        r.status = (t >= ov.windowEnd - 5) ? '临界' : '正常';
        if (t === ov.ready && reasons.length === 0) reasons.push('到点即推');
      }
      return r;
    });

    return { params: p, results: results, windows: windows };
  }

  /* 时刻快照：把钟拨回 T，看每孔当时的状态 */
  function snapshot(sim, T) {
    return sim.results.map(function (r) {
      var state;
      if (r.status === '过窗口') {
        state = T >= r.windowEnd ? '已过窗口（作废）' : '待推（已注定过窗口）';
      } else if (T >= r.push + sim.params.cycleTime) state = '已推完';
      else if (T >= r.push) state = '正在推';
      else state = '待推';
      var ahead = 0;
      sim.results.forEach(function (o) {
        if (o.push != null && o.push < (r.push == null ? Infinity : r.push) && o.push + sim.params.cycleTime > T) ahead++;
      });
      return { id: r.id, seq: r.seq, push: r.push, state: state, aheadAtT: r.push != null && r.push >= T ? ahead : 0 };
    });
  }

  var api = { parseHM: parseHM, fmtHM: fmtHM, parseWindows: parseWindows, buildOvens: buildOvens, simulate: simulate, snapshot: snapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CokeSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
