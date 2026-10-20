#!/usr/bin/env node
// DSH 升级后的自检：只读、零依赖，不联网。
// 目的：在"插件装不上/启动不了"之前，先把清单、配置、客户端 bundle、DSH 版本兼容性四条都验一遍。
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const results = [];
const pass = (name, detail = '') => results.push({ level: 'PASS', name, detail });
const warn = (name, detail = '') => results.push({ level: 'WARN', name, detail });
const fail = (name, detail = '') => results.push({ level: 'FAIL', name, detail });

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// ① 插件清单
const pkg = readJson(join(ROOT, 'package.json'));
if (!pkg) fail('清单', 'package.json 读不出来或不是合法 JSON');
else {
  const problems = [];
  if (pkg.name !== 'dsh-im-bridge') problems.push('name 不是 dsh-im-bridge');
  if (pkg.type !== 'module') problems.push('type 必须是 module');
  if (pkg.main !== 'lib/host.js') problems.push('main 必须是 lib/host.js');
  if (!pkg.exports?.['.']) problems.push('缺少 exports["."]');
  if (!pkg.exports?.['./client']) problems.push('缺少 exports["./client"]（DSH 不会加载设置页）');
  if (pkg.dsh?.client?.platform !== 'web') problems.push('dsh.client.platform 必须是 web');
  if (!pkg.dsh?.bundle?.patch) problems.push('缺少 dsh.bundle.patch（装完不会进 profile bundles）');
  if (problems.length === 0) pass('清单', 'name/type/main/exports/dsh 段齐全');
  else fail('清单', problems.join('；'));

  const patchFile = pkg.dsh?.bundle?.patch ? join(ROOT, pkg.dsh.bundle.patch) : null;
  if (patchFile && existsSync(patchFile)) {
    const yml = readFileSync(patchFile, 'utf8');
    if (/id:\s*dsh-bot\b/.test(yml)) pass('插件行', 'cordis.patch.yml 含 id: dsh-bot');
    else fail('插件行', 'cordis.patch.yml 里没有 id: dsh-bot（设置命名空间会错）');
  } else fail('插件行', 'cordis.patch.yml 不存在');

  for (const entry of [pkg.main, pkg.exports?.['./client']].filter(Boolean)) {
    if (!existsSync(join(ROOT, entry))) fail('入口文件', entry + ' 不存在');
  }
}

// ② 客户端 bundle 形状（DSH 运行期不打包，形状错就是白屏）
try {
  const src = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
  let captured = null;
  const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useCallback: (f) => f, Fragment: 'f' };
  const fakeWindow = { __ModuleLoader__: { load: (m) => { captured = m; } } };
  new Function('window', 'require', src)(fakeWindow, (n) => { if (n === 'react') return fakeReact; throw new Error('unexpected require: ' + n); });
  if (!captured) fail('客户端 bundle', '没有调用 window.__ModuleLoader__.load');
  else {
    const mod = captured.factory((n) => (n === 'react' ? fakeReact : {}));
    const regs = [];
    mod.apply({ slots: { inject: (_s, fn) => fn(), register: (o) => { regs.push(o); return () => {}; } } });
    const hit = regs.find((o) => o.id === 'dsh-bot');
    if (hit && hit.name === 'settings.section') pass('客户端 bundle', '注册 settings.section / id=dsh-bot（order=' + hit.order + '）');
    else fail('客户端 bundle', '没有注册 settings.section / id=dsh-bot');
  }
} catch (error) {
  fail('客户端 bundle', '执行失败：' + String(error?.message ?? error).slice(0, 160));
}

// ③ 配置文件
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const cfgPath = process.env.DSH_BOT_CONFIG || join(dshHome, 'dsh-bot', 'config.json');
try {
  if (!existsSync(cfgPath)) warn('配置', '还没有配置文件（先在设置页保存一次）：' + cfgPath);
  else {
    const store = await import(pathToFileURL(join(ROOT, 'src/plugin/config-store.mjs')).href);
    const view = store.normalizeConfig(JSON.parse(readFileSync(cfgPath, 'utf8')));
    for (const p of view.problems) fail('配置', p);
    for (const w of view.warnings) warn('配置', w);
    if (view.problems.length === 0) {
      const c = view.config;
      pass('配置', '校验通过：platform=' + c.platform + '，runner=' + c.dsh.runner + '，白名单 ' + c.security.userWhitelist.length + ' 个');
      if (c.security.userWhitelist.length === 0 && c.security.groupWhitelist.length === 0) fail('配置', '白名单为空：启动会被拒');
    }
  }
} catch (error) {
  fail('配置', '读取/校验失败：' + String(error?.message ?? error).slice(0, 160));
}

// ④ DSH 版本是否在兼容表里
const known = Object.keys(pkg?.dsh?.compatibility?.dshReleases ?? {});
const binPath = (() => {
  try { const raw = JSON.parse(readFileSync(cfgPath, 'utf8')); return raw?.dsh?.binPath || ''; } catch { return ''; }
})();
function dshVersionFrom(bin) {
  if (!bin) return null;
  let dir = dirname(bin);
  for (let i = 0; i < 6; i += 1) {
    const candidate = readJson(join(dir, 'package.json'));
    if (candidate?.name === '@deepseek-ai/dsh') return candidate.version ?? null;
    dir = dirname(dir);
  }
  return null;
}
const version = dshVersionFrom(binPath);
if (!binPath) warn('DSH 版本', '配置里没有 dsh.binPath，跳过版本比对');
else if (!version) warn('DSH 版本', '从 dsh.binPath 找不到 @deepseek-ai/dsh 的 package.json');
else if (known.includes(version)) pass('DSH 版本', version + '（在兼容表里）');
else warn('DSH 版本', version + ' 不在兼容表（已验证：' + (known.join(', ') || '无') + '）—— 跑完 node --test 后记得加进 package.json');

// ⑤ 结果
const counts = results.reduce((acc, r) => { acc[r.level] = (acc[r.level] ?? 0) + 1; return acc; }, {});
for (const r of results) console.log('[' + r.level + '] ' + r.name + (r.detail ? ' — ' + r.detail : ''));
console.log('');
console.log('结论：' + (counts.PASS ?? 0) + ' PASS / ' + (counts.WARN ?? 0) + ' WARN / ' + (counts.FAIL ?? 0) + ' FAIL');
process.exit(counts.FAIL ? 1 : 0);
