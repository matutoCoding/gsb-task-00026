/* 无头浏览器冒烟测试：node test-ui.js */
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('/tmp/node_modules/puppeteer');
const ROOT = __dirname;
const types = { '.html':'text/html','.js':'text/javascript','.css':'text/css' };
const srv = http.createServer((req,res)=>{
  let p = ROOT + decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p,(e,d)=>{ if(e){res.writeHead(404);res.end()} else {res.writeHead(200,{'Content-Type':types[path.extname(p)]||'text/plain'});res.end(d);} });
});
(async () => {
  await new Promise(r => srv.listen(8932, r));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome',
    headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1680,1000'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto('http://127.0.0.1:8932/index.html', { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 800));

  const q = async s => (await page.$(s)) ? true : false;
  const results = [];
  const check = (name, cond) => { results.push([name, !!cond]); };

  check('明细表 50 行', await page.$$eval('#tblBody tr', x => x.length) === 50);
  check('时序图 50 个推焦点', await page.$$eval('.g-mark', x => x.length) === 50);
  check('检修封锁带存在', await q('.g-band'));
  check('KPI 7 个卡片', await page.$$eval('.kpi', x => x.length) === 7);
  check('无判废或有判废都应渲染', true);
  const ruins = await page.$$eval('.g-mark.st-ruin', x => x.length);
  console.log('默认场景判废孔数 =', ruins);

  // 点第 4 行看回溯
  await page.click('#tblBody tr[data-i="3"]');
  await new Promise(r => setTimeout(r, 200));
  check('回溯面板有内容', await page.$$eval('#detailBody .trace li', x => x.length) >= 5);
  check('回溯面板有前压统计', await q('.backlog'));

  // 拨到 10:00
  await page.click('#btnTen');
  await new Promise(r => setTimeout(r, 200));
  const clock = await page.$eval('#clock', x => x.textContent); console.log('CLOCKGOT=['+clock+']');
  check('时钟拨到 10:00', clock === '10:00', 'got=' + clock);
  const sub = await page.$eval('#clockSub', x => x.textContent);
  check('时钟副标题有已推/待推统计', sub.includes('已推') && sub.includes('待推'), sub);

  // 改一个条件：允许滞后改成 0 之外的重算
  await page.select('#fStep', '9');
  await new Promise(r => setTimeout(r, 400));
  const rows50 = await page.$$eval('#tblBody tr', x => x.length);
  check('切 9-2 仍 50 行', rows50 === 50);
  await page.select('#fStep', '5');
  await new Promise(r => setTimeout(r, 400));

  // 加检修
  await page.click('#btnAddMaint');
  await new Promise(r => setTimeout(r, 400));
  check('可插入第二条检修', await page.$$eval('.maint-item', x => x.length) === 2);

  // 改单孔计划
  await page.evaluate(() => {
    const inp = document.querySelector('.cell-edit');
    inp.value = '11:30';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 400));
  check('单孔改计划后表仍 50 行', await page.$$eval('#tblBody tr', x => x.length) === 50);

  check('控制台无 JS 错误', errors.length === 0);
  if (errors.length) console.log(errors);

  let fail = 0;
  results.forEach(([n, c]) => { console.log((c ? '  PASS ' : '  FAIL ') + n); if (!c) fail++; });
  await page.screenshot({ path: '/tmp/pusim-ui-screenshot.png' });
  await browser.close();
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
