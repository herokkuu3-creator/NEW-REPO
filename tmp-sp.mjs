import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { firefox } from 'playwright';
function pids() {
  const out = execSync('ps -eo pid,args --no-headers').toString().trim().split('\n');
  return out.map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => /firefox|isForBrowser/.test(m[2]) && !/tmp-sp/.test(m[2])).map((m) => Number(m[1]));
}
function mem() {
  let pss = 0, rss = 0, n = 0;
  for (const pid of pids()) {
    try {
      rss += Number(/VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
      pss += Number(/^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0);
      n++;
    } catch {}
  }
  return { procs: n, rssMb: Math.round(rss / 1024), pssMb: Math.round(pss / 1024) };
}
const prefs = { 'permissions.default.image': 2, 'browser.cache.memory.capacity': 0, 'browser.cache.disk.enable': false };
for (const [name, env] of [['e10s-on', {}], ['e10s-off', { MOZ_FORCE_DISABLE_E10S: '1' }]]) {
  try {
    const b = await firefox.launch({ headless: true, firefoxUserPrefs: prefs, env: { ...process.env, ...env } });
    const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
    const p = await ctx.newPage();
    let status = 'x', areas = -1, title = '';
    try {
      const r = await p.goto('https://codeforces.com/contest/1/submit', { waitUntil: 'domcontentloaded', timeout: 90000 });
      status = String(r?.status());
      await p.waitForTimeout(4000);
      areas = await p.locator('textarea[name="source"]').count().catch(() => -1);
      title = (await p.title().catch(() => '')).slice(0, 30);
    } catch (e) { status = 'err ' + String(e).slice(0, 60); }
    const on = mem();
    await b.close();
    console.log(JSON.stringify({ name, status, title, sourceTextareas: areas, onPage: on }));
  } catch (e) { console.log(JSON.stringify({ name, error: String(e).slice(0, 160) })); }
}
