// 认证限流策略：加载、回退、以及 blockMs（固定封禁）语义。
//
// 这一组测试守的不是"数字对不对"，而是三件容易静默出错的事：
//   1. auth-policy.json 与代码内置 DEFAULTS 必须一致——否则文件一丢，
//      两端就静默切换成另一套策略，而没人会发现；
//   2. 坏文件必须回退而不是抛错——限流退化好过登录接口 500；
//   3. 封禁期内到达的请求不能延长封禁——否则等于滑动封禁，永远解不开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const authPolicy = require('../src/lib/authPolicy.js');
const { rateLimit } = require('../src/lib/rateLimit.js');

const POLICY_FILE = path.resolve(import.meta.dirname, '../../auth-policy.json');
const SECTIONS = ['loginAccount', 'loginIpCoarse', 'register'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 只保留策略字段（JSON 里还有 _purpose 这类说明字段）
function pickSections(obj) {
  const out = {};
  for (const k of SECTIONS) {
    const { windowSec, maxFails, blockSec = 0 } = obj[k] || {};
    out[k] = { windowSec, maxFails, blockSec };
  }
  return out;
}

test('auth-policy.json 存在且三节策略字段完整合法', () => {
  assert.ok(fs.existsSync(POLICY_FILE), `找不到策略文件：${POLICY_FILE}`);
  const raw = readJson(POLICY_FILE);
  for (const k of SECTIONS) {
    assert.ok(raw[k], `策略文件缺少 ${k}`);
    assert.ok(Number.isInteger(raw[k].windowSec) && raw[k].windowSec > 0, `${k}.windowSec 必须是正整数`);
    assert.ok(Number.isInteger(raw[k].maxFails) && raw[k].maxFails >= 1, `${k}.maxFails 必须是正整数`);
    const block = raw[k].blockSec === undefined ? 0 : raw[k].blockSec;
    assert.ok(Number.isInteger(block) && block >= 0, `${k}.blockSec 必须是非负整数`);
  }
});

test('内置 DEFAULTS 必须与 auth-policy.json 完全一致（否则文件丢失会静默换策略）', () => {
  const raw = readJson(POLICY_FILE);
  assert.deepEqual(pickSections(authPolicy.DEFAULTS), pickSections(raw));
});

test('正常读取：source=file，取值与文件一致', () => {
  const raw = readJson(POLICY_FILE);
  const r = authPolicy.loadPolicy(POLICY_FILE);
  assert.equal(r.source, 'file');
  assert.equal(r.error, null);
  assert.deepEqual(pickSections(r.policy), pickSections(raw));
});

test('文件缺失：回退默认值，且不当作错误上报（error 标记为 ENOENT）', () => {
  const r = authPolicy.loadPolicy(path.join(os.tmpdir(), 'no-such-auth-policy.json'));
  assert.equal(r.source, 'default');
  assert.equal(r.error, 'ENOENT');
  assert.deepEqual(r.policy, authPolicy.DEFAULTS);
});

test('JSON 写坏：回退默认值，不抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-policy-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ "loginAccount": { "windowSec": 600,,, }');
  const r = authPolicy.loadPolicy(bad);
  assert.equal(r.source, 'default');
  assert.notEqual(r.error, 'ENOENT');
  assert.deepEqual(r.policy, authPolicy.DEFAULTS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('单节字段非法：只有那一节回退，不是整份丢掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-policy-'));
  const file = path.join(dir, 'part.json');
  fs.writeFileSync(file, JSON.stringify({
    loginAccount: { windowSec: 0, maxFails: 6, blockSec: 300 },   // 窗口非法
    loginIpCoarse: { windowSec: 300, maxFails: 200, blockSec: 0 }, // 合法
    register: { windowSec: 3600, maxFails: 5 },                    // 省略 blockSec → 当 0
  }));
  const r = authPolicy.loadPolicy(file);
  assert.equal(r.source, 'file');
  // 非法那节回退
  assert.deepEqual(r.policy.loginAccount, authPolicy.DEFAULTS.loginAccount);
  // 合法那节按文件生效（此处与默认恰好相同，另改一个数验证确实读了文件）
  assert.equal(r.policy.loginIpCoarse.maxFails, 200);
  assert.equal(r.policy.register.blockSec, 0, '省略 blockSec 时按 0 处理');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// blockMs：超限后固定封禁，且封禁期内不延长
// ---------------------------------------------------------------------------
function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    finished: false,
    listeners: {},
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; },
  };
  return res;
}

test('blockMs：超限后封禁固定时长，封禁期内后续请求不延长封禁', () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const mw = rateLimit({ windowMs: 60_000, max: 2, blockMs: 10_000, keyFn: () => 'k' });
    const hit = () => {
      const req = {};
      const res = fakeRes();
      let passed = false;
      mw(req, res, () => { passed = true; });
      return { res, passed };
    };

    // 前两次未超限 → 放行
    assert.equal(hit().passed, true);
    assert.equal(hit().passed, true);

    // 第 3 次越过阈值 → 429，Retry-After 应指向"现在 + blockMs"
    const third = hit();
    assert.equal(third.passed, false);
    assert.equal(third.res.statusCode, 429);
    assert.equal(third.res.headers['retry-after'], '10');

    // 封禁进行到第 3 秒：仍是 429，且剩余时间应随之减少（7s），
    // 若被延长会重新变回 10s——这正是滑动封禁的特征
    clock += 3000;
    const fourth = hit();
    assert.equal(fourth.res.statusCode, 429);
    assert.equal(fourth.res.headers['retry-after'], '7', '封禁期内请求不得延长封禁');

    // 封禁结束后（累计 11s）应重新放行，且是全新计数
    clock += 8000;
    assert.equal(hit().passed, true);
  } finally {
    Date.now = realNow;
  }
});

test('未声明 blockMs：沿用固定窗口，不额外封禁', () => {
  const realNow = Date.now;
  let clock = 2_000_000;
  Date.now = () => clock;
  try {
    const mw = rateLimit({ windowMs: 60_000, max: 1, keyFn: () => 'k2' });
    const hit = () => {
      const res = fakeRes();
      let passed = false;
      mw({}, res, () => { passed = true; });
      return { res, passed };
    };
    assert.equal(hit().passed, true);
    const second = hit();
    assert.equal(second.res.statusCode, 429);
    // 剩余时间指向窗口结束（约 60s），而不是某个封禁时长
    assert.ok(Number(second.res.headers['retry-after']) > 50);
  } finally {
    Date.now = realNow;
  }
});
