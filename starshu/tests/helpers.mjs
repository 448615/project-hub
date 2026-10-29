// 测试辅助：以「临时 SQLite 库 + 随机端口」启动真实服务进程。
// 目的：① 用例不触碰开发库 data/cms.db；② 多个测试文件并行运行时互不干扰；
//      ③ 需要验证「重启后行为」的用例可复用同一库文件二次启动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 端口冲突重试次数。`node --test` 默认按 CPU 核数并行跑测试文件，每个文件都会起
// 一个真实服务进程；两个文件恰好随机到同一个端口时，后起的那个会 EADDRINUSE 直接
// 退出，表现为「偶发一条测试失败、重跑又全绿」——这种抖动最消耗信任，所以显式
// 换端口重试，而不是把随机范围调大了事。
const MAX_ATTEMPTS = 3;

export async function startServer(opts = {}) {
  const { dbFile, env: extraEnv } = opts;
  const dir = dbFile ? path.dirname(dbFile) : fs.mkdtempSync(path.join(os.tmpdir(), 'cms-test-'));
  const file = dbFile || path.join(dir, 'test.db');

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await startOnce(file, extraEnv);
    } catch (e) {
      lastErr = e;
      // 只有「端口被占」才重试。启动即崩、超时这类真问题必须立刻暴露，
      // 不能靠重试把真 bug 粉饰成偶发。
      if (!e.retryable) break;
    }
  }
  if (!dbFile) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  throw lastErr;
}

function startOnce(file, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const port = 4100 + Math.floor(Math.random() * 1400);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: APP_ROOT,
      // extraEnv 放在 PORT/DB_FILE 之前，允许用例覆盖 NODE_ENV、TRUST_PROXY 等部署变量
      env: { ...process.env, ...extraEnv, PORT: String(port), DB_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* 忽略 */ }
      finish(reject, new Error('服务启动超时（20s）'));
    }, 20000);
    child.stdout.on('data', (d) => {
      out += d;
      if (!settled && out.includes('running on port')) finish(resolve, makeApi(port, child, file));
    });
    child.stderr.on('data', (d) => {
      errOut += d;
      process.stderr.write('[srv] ' + d);
    });
    child.on('exit', (code) => {
      const e = new Error('服务进程提前退出 code=' + code);
      e.retryable = /EADDRINUSE/.test(errOut) || /EADDRINUSE/.test(out); // 端口被并行测试占了
      finish(reject, e);
    });
  });
}

function makeApi(port, child, dbFile) {
  const base = `http://127.0.0.1:${port}`;
  async function call(method, p, { token, body, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h['X-Auth-Token'] = token;
    let payload;
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
    // 把响应头也带出来：限流用例需要断言 Retry-After（与枢纽一致的可观测语义）
    return { status: res.status, json, text, headers: res.headers, retryAfter: res.headers.get('retry-after') };
  }
  return {
    base, port, child, dbFile,
    call,
    async login(email, password) {
      const r = await call('POST', '/api/auth/login', { body: { email, password } });
      if (r.status !== 200) throw new Error(`登录失败 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json.token;
    },
    async stop(cleanup = true) {
      try { child.kill(); } catch (e) { /* 忽略 */ }
      await new Promise((r) => setTimeout(r, 400));
      if (cleanup) {
        try { fs.rmSync(path.dirname(dbFile), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      }
    },
  };
}
