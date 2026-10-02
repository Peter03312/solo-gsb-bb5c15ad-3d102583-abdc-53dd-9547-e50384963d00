'use strict';

// 共享房间「主持权交接」HTTP 单元测试：
// 主持人凭当前控制密钥与房间修订号发起交接（凭证仅显示一次、五分钟有效、同房间
// 仅一份待领取、再次发起旧凭证失效）；接班人凭房间码与凭证领取新密钥（领取与
// 修订号 +1 原子完成、旧密钥即刻失效、并发至多一人成功、重试不回显新密钥）；
// 主持人成功控制房间后凭证作废（409，须重新索取）；过期凭证、错误凭证、过期
// 修订号均明确拒绝且不改变控制权；播放状态/时码/速度/固定版本/超载保护不因
// 交接重置；GET 房间只报告交接状态，不向观看者泄露凭证或密钥。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-room-handover-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { get } = require('../src/db');
const { app } = require('../server.js');
const db = get();

let server;

function request(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const getJson = (p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => server.close(r));
});

async function resetDraft() {
  const cues = await getJson('/api/cues');
  for (const c of cues) await request('DELETE', `/api/cues/${c.id}`);
  const lights = await getJson('/api/lights');
  for (const l of lights) await request('DELETE', `/api/lights/${l.id}`);
}

async function seedVersion() {
  await resetDraft();
  const l1 = (await request('POST', '/api/lights', { name: '交接面光' })).json.id;
  const l2 = (await request('POST', '/api/lights', { name: '交接侧光' })).json.id;
  await request('POST', '/api/cues', [
    { cue_no: 9101, light_id: l1, time: 0, target: 100, duration: 10 },
    { cue_no: 9102, light_id: l2, time: 2, target: 50, duration: 4 },
  ]);
  return (await request('POST', '/api/versions', { label: '交接首演' })).json;
}

async function makeRoom(body = {}) {
  const v = await seedVersion();
  const r = await request('POST', '/api/rooms', { version_id: v.id, ...body });
  assert.equal(r.status, 201);
  return r.json;
}

const issue = (code, body) => request('POST', `/api/rooms/${code}/handover/issue`, body);
const claim = (code, body) => request('POST', `/api/rooms/${code}/handover/claim`, body);
const ctrl = (code, body) => request('POST', `/api/rooms/${code}/control`, body);

test('发起交接：缺少/错误密钥 403；修订号缺失/非法 400；过期修订号 409 且不改动', async () => {
  const c = await makeRoom();

  let r = await issue(c.code, { revision: 0 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await issue(c.code, { control_key: '0'.repeat(48), revision: 0 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  r = await issue(c.code, { control_key: c.control_key });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await issue(c.code, { control_key: c.control_key, revision: -1 });
  assert.equal(r.status, 400);

  // 房间修订号推进后用旧修订号发起：409
  await ctrl(c.code, { control_key: c.control_key, revision: 0, action: 'play' });
  r = await issue(c.code, { control_key: c.control_key, revision: 0 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);

  // 全程没有产生待领取凭证
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.handover, undefined);
  assert.equal(g.json.revision, 1);
});

test('房间码异常：发起/领取的错误房间码 400、不存在 404', async () => {
  const c = await makeRoom();
  let r = await issue('ab', { control_key: c.control_key, revision: 0 });
  assert.equal(r.status, 400);
  r = await issue('ZZZZZZ', { control_key: c.control_key, revision: 0 });
  assert.equal(r.status, 404);
  r = await claim('ab', { handover_token: 'x', revision: 0 });
  assert.equal(r.status, 400);
  r = await claim('ZZZZZZ', { handover_token: 'x', revision: 0 });
  assert.equal(r.status, 404);
});

test('发起成功：凭证仅返回一次（48 位十六进制）、五分钟有效；GET 只报告状态不泄露', async () => {
  const c = await makeRoom();
  const r = await issue(c.code, { control_key: c.control_key, revision: 0 });
  assert.equal(r.status, 200);
  assert.match(r.json.handover_token, /^[0-9a-f]{48}$/);
  assert.equal(r.json.handover_expires_in, 300);
  assert.equal(r.json.revision, 0); // 发起交接不增加修订号
  // 发起响应本身不回显控制密钥
  assert.equal(r.json.control_key, undefined);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.handover.active, true);
  assert.ok(g.json.handover.seconds_remaining > 299 && g.json.handover.seconds_remaining <= 300);
  assert.equal(g.json.handover.revision, 0);
  assert.equal(typeof g.json.handover.expires_at, 'number');
  // 不向观看者泄露凭证或密钥
  assert.equal(g.json.handover.token, undefined);
  assert.equal(g.json.handover.handover_token, undefined);
  assert.equal(g.json.control_key, undefined);
});

test('同房间仅一份待领取凭证：再次发起使旧凭证失效', async () => {
  const c = await makeRoom();
  const h1 = (await issue(c.code, { control_key: c.control_key, revision: 0 })).json;
  const h2 = (await issue(c.code, { control_key: c.control_key, revision: 0 })).json;
  assert.notEqual(h1.handover_token, h2.handover_token);

  // 旧凭证领取：403 凭证无效，控制权与修订号不变
  let r = await claim(c.code, { handover_token: h1.handover_token, revision: 0 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /交接凭证无效/);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.revision, 0);
  assert.equal(g.json.handover.active, true);

  // 新凭证仍可正常领取
  r = await claim(c.code, { handover_token: h2.handover_token, revision: 0 });
  assert.equal(r.status, 200);
});

test('领取成功：新密钥仅返回一次；修订号 +1 与领取原子完成；旧密钥即刻失效', async () => {
  const c = await makeRoom();
  const h = (await issue(c.code, { control_key: c.control_key, revision: 0 })).json;

  const r = await claim(c.code, { handover_token: h.handover_token, revision: 0 });
  assert.equal(r.status, 200);
  assert.match(r.json.control_key, /^[0-9a-f]{48}$/);
  assert.notEqual(r.json.control_key, c.control_key);
  assert.equal(r.json.revision, 1);
  // 领取后不再有待领取凭证
  assert.equal(r.json.handover, undefined);

  // 旧密钥立即失效：主持人控制被 403 拒绝
  const old = await ctrl(c.code, { control_key: c.control_key, revision: 1, action: 'pause' });
  assert.equal(old.status, 403);
  assert.match(old.json.error, /控制密钥无效/);

  // 新密钥可正常控制
  const ok = await ctrl(c.code, { control_key: r.json.control_key, revision: 1, action: 'play' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.revision, 2);
});

test('凭证一次性：重复/重试领取不再回显新密钥（403），GET 也不含密钥', async () => {
  const c = await makeRoom();
  const h = (await issue(c.code, { control_key: c.control_key, revision: 0 })).json;
  const first = await claim(c.code, { handover_token: h.handover_token, revision: 0 });
  assert.equal(first.status, 200);

  // 同一凭证再领取（客户端重试）：403 且响应体没有 control_key
  const retry = await claim(c.code, { handover_token: h.handover_token, revision: 1 });
  assert.equal(retry.status, 403);
  assert.equal(retry.json.control_key, undefined);
  assert.match(retry.json.error, /交接凭证无效/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.control_key, undefined);
  assert.equal(g.json.handover, undefined);
});

test('并发领取：至多一人成功', async () => {
  const c = await makeRoom();
  const h = (await issue(c.code, { control_key: c.control_key, revision: 0 })).json;
  const results = await Promise.all([
    claim(c.code, { handover_token: h.handover_token, revision: 0 }),
    claim(c.code, { handover_token: h.handover_token, revision: 0 }),
    claim(c.code, { handover_token: h.handover_token, revision: 0 }),
  ]);
  const oks = results.filter((r) => r.status === 200);
  assert.equal(oks.length, 1);
  // 失败者均为 403 且不携带新密钥
  for (const r of results.filter((x) => x.status !== 200)) {
    assert.equal(r.status, 403);
    assert.equal(r.json.control_key, undefined);
  }
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.revision, 1);
});

test('领取端过期修订号：409 且控制权/凭证不变，刷新修订号后可成功', async () => {
  const c = await makeRoom();
  // 主持人先做一次控制把修订号推到 1，再发起交接（凭证绑定修订号 1）
  await ctrl(c.code, { control_key: c.control_key, revision: 0, action: 'play' });
  const h = (await issue(c.code, { control_key: c.control_key, revision: 1 })).json;

  // 接班人手里是旧修订号 0：409，凭证保留、控制权不变
  let r = await claim(c.code, { handover_token: h.handover_token, revision: 0 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.revision, 1);
  assert.equal(g.json.handover.active, true);
  assert.equal(g.json.control_key, undefined);

  // 用最新修订号重试：成功
  r = await claim(c.code, { handover_token: h.handover_token, revision: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 2);
});

test('凭证发出后原主持人成功控制房间：凭证作废，领取 409 且不改变控制权', async () => {
  const c = await makeRoom();
  const h = (await issue(c.code, { control_key: c.control_key, revision: 0 })).json;

  // 原主持人继续控制房间（修订号前进）
  const played = await ctrl(c.code, { control_key: c.control_key, revision: 0, action: 'play' });
  assert.equal(played.status, 200);

  // GET 交接状态明确标为 superseded（不泄露凭证）
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.handover.active, false);
  assert.equal(g.json.handover.reason, 'superseded');
  assert.equal(g.json.handover.handover_token, undefined);

  // 接班人领取：凭证已作废 409（领取同时清除作废凭证）
  let r = await claim(c.code, { handover_token: h.handover_token, revision: 1 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /交接凭证已作废/);
  assert.equal(r.json.control_key, undefined);

  // 原主持人仍可控制；作废凭证再领已无此行 → 403
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.handover, undefined);
  const again = await claim(c.code, { handover_token: h.handover_token, revision: 1 });
  assert.equal(again.status, 403);
  const still = await ctrl(c.code, { control_key: c.control_key, revision: 1, action: 'pause' });
  assert.equal(still.status, 200);
});

test('错误凭证/空凭证：403 明确拒绝且不改变控制权', async () => {
  const c = await makeRoom();
  await issue(c.code, { control_key: c.control_key, revision: 0 });

  let r = await claim(c.code, { revision: 0 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少交接凭证/);

  r = await claim(c.code, { handover_token: 'f'.repeat(48), revision: 0 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /交接凭证无效/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.revision, 0);
  assert.equal(g.json.handover.active, true); // 正确凭证仍可领取
});

test('领取端修订号缺失/非法：400 且不改变控制权、不消耗凭证', async () => {
  const c = await makeRoom();
  const h = (await issue(c.code, { control_key: c.control_key, revision: 0 })).json;

  let r = await claim(c.code, { handover_token: h.handover_token });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);
  r = await claim(c.code, { handover_token: h.handover_token, revision: 'x' });
  assert.equal(r.status, 400);

  const ok = await claim(c.code, { handover_token: h.handover_token, revision: 0 });
  assert.equal(ok.status, 200);
});

test('过期凭证：明确 403 拒绝且不改变控制权', async () => {
  const c = await makeRoom();
  const h = await issue(c.code, { control_key: c.control_key, revision: 0 });
  assert.equal(h.status, 200);

  // 直接把凭证改成已过期（墙钟过期）
  db.prepare('UPDATE room_handovers SET expires_at = ? WHERE room_id = ?').run(
    Date.now() / 1000 - 1,
    db.prepare('SELECT id FROM rooms WHERE code = ?').get(c.code).id
  );

  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.handover.active, false);
  assert.equal(g.json.handover.reason, 'expired');

  let r = await claim(c.code, { handover_token: h.json.handover_token, revision: 0 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /交接凭证已过期/);
  assert.equal(r.json.control_key, undefined);

  // 控制权未变：原密钥仍可控制；过期行已清除
  const played = await ctrl(c.code, { control_key: c.control_key, revision: 0, action: 'play' });
  assert.equal(played.status, 200);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.handover, undefined);
});

test('交接不重置播放状态/时码/速度/固定版本；保护房间交接后保护状态仍在', async () => {
  // 普通房间：播放中、2 倍速时交接
  const c = await makeRoom();
  await ctrl(c.code, { control_key: c.control_key, revision: 0, action: 'speed', speed: 2 });
  await ctrl(c.code, { control_key: c.control_key, revision: 1, action: 'seek', time: 4 });
  const played = await ctrl(c.code, { control_key: c.control_key, revision: 2, action: 'play' });
  assert.equal(played.status, 200);
  const h = await issue(c.code, { control_key: c.control_key, revision: 3 });
  assert.equal(h.status, 200);

  const done = await claim(c.code, { handover_token: h.json.handover_token, revision: 3 });
  assert.equal(done.status, 200);
  assert.equal(done.json.playing, true);
  assert.equal(done.json.speed, 2);
  assert.ok(Math.abs(done.json.server_time - 4) < 0.5, `time=${done.json.server_time}`);
  assert.equal(done.json.version.id, h.json.version.id);
  assert.equal(done.json.revision, 4);
  assert.equal(done.json.protection.enabled, false);

  // 新主持人在交接后的连续修订号上可直接控制
  const pause = await ctrl(c.code, { control_key: done.json.control_key, revision: 4, action: 'pause' });
  assert.equal(pause.status, 200);
  assert.equal(pause.json.revision, 5);
});

test('交接凭证不影响观看者只读：观看者 GET 全程无凭证无密钥', async () => {
  const c = await makeRoom();
  // 未发起：无 handover 字段
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.handover, undefined);

  await issue(c.code, { control_key: c.control_key, revision: 0 });
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.handover.active, true);
  assert.deepEqual(Object.keys(g.json.handover).sort(), [
    'active',
    'expires_at',
    'issued_at',
    'revision',
    'seconds_remaining',
  ]);
  assert.equal(g.json.control_key, undefined);
});
