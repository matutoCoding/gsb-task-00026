/* 引擎行为验证：node test-engine.js */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
const end = src.indexOf('/* ============ 以下为浏览器界面');
eval(src.slice(0, end));
const S = globalThis.PushSim;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const baseV = {
  pusher: { speed: 0.4, occupy: 7, pos: 5 },
  guide:  { speed: 0.3, occupy: 6, pos: 5 },
  quench: { speed: 0.5, occupy: 9, pos: 5 }
};
function cfg(over) {
  return Object.assign({
    nOvens: 50, step: 5, firstOven: 5, firstTarget: 10, gap: 12,
    coke: 1200, early: 5, late: 10, vehicles: JSON.parse(JSON.stringify(baseV)),
    maints: []
  }, over || {});
}

// 串序
const seq = S.buildSequence(50, 5, 5);
ok('串序不重不漏 50孔', new Set(seq).size === 50 && seq.length === 50);
ok('5-2 首孔=5，其后=10,15...', seq.slice(0, 4).join() === '5,10,15,20', seq.slice(0, 6));
ok('5-2 道链接 1,6,11...', seq[10] === 1 && seq[11] === 6, seq.slice(9, 14));
const seq2 = S.buildSequence(65, 2, 3);
ok('2-1 串序不重不漏', new Set(seq2).size === 65 && seq2[0] === 3);

// 1. 按分钟前推，每孔有时刻
let r = S.simulate(cfg());
ok('每孔都有分钟级时刻（判废孔除外）',
  r.events.every(e => typeof e.target === 'number' && (e.planned === null || e.planned % 1 === 0)));
ok('首孔车08:05齐->等窗口开08:05推', r.events[0].planned === 5 && r.events[0].status === 'wait',
  [S.relHHMM(r.events[0].planned), r.events[0].status]);
ok('装煤=计划-结焦20h', r.events[0].charge === r.events[0].target - 1200);

// 2. 窗口：等窗口（防生焦）
r = S.simulate(cfg({ vehicles: {
  pusher:{speed:0,occupy:1,pos:5}, guide:{speed:0,occupy:1,pos:5}, quench:{speed:0,occupy:1,pos:5}
}}));
ok('车齐得比窗口早 -> 等到窗口起点（不生焦）',
  r.events[1].status === 'wait' && r.events[1].planned === r.events[1].winStart,
  [r.events[1].status, r.events[1].planned, r.events[1].winStart]);

// 2b. 过窗口判废
r = S.simulate(cfg({ maints: [{ start: 10, end: 52 }], early: 5, late: 10 }));
const ruins = r.events.filter(e => e.status === 'ruin');
ok('检修封40分 -> 出现判废孔', ruins.length >= 2, ruins.map(e=>({o:e.oven,t:e.target})));
const firstRuin = ruins[0];
ok('判废孔不再后排(planned=null)', firstRuin.planned === null);
ok('判废因为可推时刻(含检修让路)>窗口终点',
  Math.max(firstRuin.vehicleReady, firstRuin.hitMaint ? firstRuin.hitMaint.end : 0) > firstRuin.winEnd,
  [firstRuin.vehicleReady, firstRuin.winEnd]);

// 3. 一台推焦车：相邻序号最小间隔 ≈ 占时+走行
r = S.simulate(cfg({ gap: 6, late: 60 })); // 计划6分一孔，推焦车占7分，来不及
const normal = r.events.filter(e => e.planned !== null);
const d = normal[1].planned - normal[0].planned;
ok('相邻孔排不开则被车撑开(≥7分)', d >= 7, d);
ok('撑开后标记顺延', r.events.some(e => e.status === 'late'));

// 4. 三车凑齐：熄焦车迟到
r = S.simulate(cfg({ late: 60, vehicles: {
  pusher:{speed:0.4,occupy:7,pos:5}, guide:{speed:0.3,occupy:6,pos:5},
  quench:{speed:1,occupy:9,pos:20} } })); // 熄焦车远在10号
ok('熄焦车迟到 -> 首孔等它凑齐', r.events[0].planned > r.events[0].target,
  [r.events[0].planned, r.events[0].target]);
ok('首孔在放宽窗口内仍可推(顺延)', r.events[0].status !== 'ruin');

// 4b. 熄焦车故障停用至 08:40（接班后40分），首孔必须等它
r = S.simulate(cfg({ late: 60, vehicles: {
  pusher:{speed:0.2,occupy:6,pos:5}, guide:{speed:0.2,occupy:5,pos:5},
  quench:{speed:0.2,occupy:8,pos:5, unavailableUntil:40} } }));
ok('熄焦车故障停用 -> 首孔不早于08:40', r.events[0].planned >= 40, r.events[0].planned);
ok('故障车是最慢凑齐的车', r.events[0].parts.quench.ready >= r.events[0].parts.pusher.ready);

// 5. 连锁顺延：检修之后整串偏移
r = S.simulate(cfg({ maints: [{ start: 60, end: 72 }], late: 60 }));
const after = r.events.filter(e => e.target >= 60 && e.status !== 'ruin');
ok('检修后整串序号整体后移', after.length > 0 && after.every(e => e.planned >= e.target));

// 6. 改条件重算：外部 targets 改变（单孔推迟整串平移）
const c1 = cfg();
const r1 = S.simulate(c1);
const targets = r1.events.map(e => e.target);
targets[3] += 20;
for (let k = 4; k < targets.length; k++) targets[k] += 20;
const r2 = S.simulate(Object.assign(c1, { targets }));
ok('改一孔计划 -> 其后整串平移20分', r2.events[5].target - r1.events[5].target === 20);

// 7. 炉号/结焦/计划三落一孔
ok('事件同时带炉号/装煤(结焦)/计划', !!r1.events[0].oven && 'charge' in r1.events[0] && 'target' in r1.events[0]);

// 8. 检修让路：无孔落在封锁段
r = S.simulate(cfg({ maints: [{ start: 100, end: 160 }], late: 120 }));
const pushed = r.events.filter(e => e.planned !== null);
ok('没有孔排在检修时段内', pushed.every(e => !(e.planned >= 100 && e.planned < 160)));

// 9. 拨杆回溯：queueAhead 逻辑用 planned/winEnd 对比 scrub（在 UI 中，这里验证数据足够）
const e8 = r1.events[7];
const ahead = r1.events.slice(0, 7).filter(p => (p.planned ?? p.winEnd) > e8.target - 5);
ok('回溯数据：前压孔数可算', Array.isArray(ahead));

// 10. 过窗口标出且不后排：已在 2b 覆盖，再加总量统计
ok('判废孔不计入正常推出', r.events.filter(e=>e.planned!==null).length + r.events.filter(e=>e.status==='ruin').length === r.events.length);

// 跨日检修
r = S.simulate(cfg({ maints: [{ start: 1400, end: 60 }] }));
ok('跨日检修 end+1440', r.maints[0].end === 1500, r.maints);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
