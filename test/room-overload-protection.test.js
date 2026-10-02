'use strict';

// 共享房间「回路超载保护」HTTP 单元测试：
// 创建开关、固定版本快照、播放抵达超载区间左边界自动暂停（不越界、不加修订号）、
// 当前超载拒绝播放、播放中跳入超载段拒绝且房间不变、暂停允许跳转避险、
// 倍速实时推算、未启用/旧版无配置沿用原行为、重启恢复保护状态。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-room-protect-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const circuits = await getJson('/api/circuits');
  for (const c of circuits) await request('DELETE', `/api/circuits/${c.id}`);
}

/**
 * 种一个带回路配置的短版本：
 *  - 灯 L1 接到回路「超载回路」，容量 100W，额定 200W。
 *    Cue：t=0 瞬变到 50（负载 100W，恰好等于容量，不超载），
 *          t=0.3 瞬变到 100（负载 200W，严格超载），时长 0，区间左边界 t=0.3 闭端点。
 *  - 灯 L2 接到另一安全回路，容量 1000W，额定 200W，全程满亮（40%，负载 80W）。
 */
async function seedProtectedVersion() {
  await resetDraft();
  const c1 = (await request('POST', '/api/circuits', { name: '超载回路P', capacity: 100 })).json.id;
  const c2 = (await request('POST', '/api/circuits', { name: '安全回路P', capacity: 1000 })).json.id;
  const l1 = (await request('POST', '/api/lights', { name: '大灯P' })).json.id;
  const l2 = (await request('POST', '/api/lights', { name: '小灯P' })).json.id;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c1, watts: 200 });
  await request('PUT', `/api/lights/${l2}/wiring`, { circuit_id: c2, watts: 200 });
  await request('POST', '/api/cues', [
    { cue_no: 8101, light_id: l1, time: 0, target: 50, duration: 0 },
    { cue_no: 8102, light_id: l1, time: 0.3, target: 100, duration: 0 },
    { cue_no: 8103, light_id: l2, time: 0, target: 40, duration: 0 },
    // t=1 瞬变熄灭：超载区间为 [0.3, 1)，同时把版本末尾延长到 1 秒
    { cue_no: 8104, light_id: l1, time: 1, target: 0, duration: 0 },
  ]);
  return { version: (await request('POST', '/api/versions', { label: '保护版P' })).json, l1, l2, c1, c2 };
}

// 渐变超载版本：灯 t=0 从 0 渐变到 100、duration 1；容量 100W、额定 200W，
// 亮度=100t、负载=200t，负载严格大于 100W 的交点在 t=0.5（开端点）。
async function seedRampVersion() {
  await resetDraft();
  const c1 = (await request('POST', '/api/circuits', { name: '渐变回路R', capacity: 100 })).json.id;
  const l1 = (await request('POST', '/api/lights', { name: '渐变大灯R' })).json.id;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c1, watts: 200 });
  await request('POST', '/api/cues', [{ cue_no: 8201, light_id: l1, time: 0, target: 100, duration: 1 }]);
  return { version: (await request('POST', '/api/versions', { label: '渐变版R' })).json, c1 };
}

async function createProtectedRoom(versionId, extra = {}) {
  return request('POST', '/api/rooms', { version_id: versionId, overload_protection: true, ...extra });
}

test('创建房间：保护开关为布尔值，非布尔 400；启用/未启用体现在 protection 字段', async () => {
  const { version, c1 } = await seedProtectedVersion();

  let r = await request('POST', '/api/rooms', { version_id: version.id, overload_protection: 'yes' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /超载保护开关无效/);

  r = await createProtectedRoom(version.id, { label: '保护房' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.protection, {
    enabled: true,
    configured: true,
    overloaded_now: false,
    circuits_overloaded_now: [],
    next_trip: {
      time: 0.3,
      seconds_ahead: 0.3,
      circuit: { circuit_id: c1, name: '超载回路P', capacity: 100 },
    },
  });

  const r2 = await request('POST', '/api/rooms', { version_id: version.id });
  assert.equal(r2.status, 201);
  assert.deepEqual(r2.json.protection, { enabled: false });
});

test('旧版快照无回路配置：可启用保护，但 configured=false 且没有超载回路', async () => {
  await resetDraft();
  await request('POST', '/api/lights', { name: '旧版灯' });
  const lights = await getJson('/api/lights');
  await request('POST', '/api/cues', [
    { cue_no: 8301, light_id: lights[0].id, time: 0, target: 100, duration: 0 },
  ]);
  const v = (await request('POST', '/api/versions', { label: '无回路旧版' })).json;
  const r = await createProtectedRoom(v.id);
  assert.equal(r.status, 201);
  assert.equal(r.json.protection.enabled, true);
  assert.equal(r.json.protection.configured, false);
});

test('播放抵达首个超载区间左边界即自动暂停：GET 惰性落库、停在边界、不越过、修订号不变', async () => {
  const { version, c1 } = await seedProtectedVersion();
  const c = (await createProtectedRoom(version.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  let r = await ctrl({ revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);

  // 观看端 1 秒才轮询一次（远超 0.3s 边界）：返回必须停在 0.3，不得越过危险段
  await sleep(1000);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.status, 200);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.revision, 1, '自动暂停不增加控制修订号');
  assert.equal(g.json.protection.overloaded_now, true);
  assert.ok(g.json.protection.tripped, '返回触发回路与演出时码');
  assert.equal(g.json.protection.tripped.reason, 'overload_boundary');
  assert.equal(g.json.protection.tripped.time, 0.3);
  assert.equal(g.json.protection.tripped.circuit.circuit_id, c1);

  // 已落库：再查仍是暂停在边界、修订号不变
  const g2 = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g2.json.playing, false);
  assert.ok(Math.abs(g2.json.time - 0.3) < 1e-6);
  assert.equal(g2.json.revision, 1);
});

test('当前时码已超载：拒绝播放（400、不改房间、不加修订号）', async () => {
  const { version, c1 } = await seedProtectedVersion();
  const c = (await createProtectedRoom(version.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  // 暂停状态允许跳入超载段避险（房间更新为暂停在 0.5）
  let r = await ctrl({ revision: 0, action: 'seek', time: 0.5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, false);
  assert.ok(Math.abs(r.json.time - 0.5) < 1e-6);
  assert.equal(r.json.revision, 1);
  assert.equal(r.json.protection.overloaded_now, true);

  // 在超载段按播放：400 拒绝，房间不变
  r = await ctrl({ revision: 1, action: 'play' });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, 'overloaded_timecode');
  assert.ok(Math.abs(r.json.time - 0.5) < 1e-6);
  assert.equal(r.json.circuits[0].circuit_id, c1);
  assert.match(r.json.error, /拒绝播放/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.5) < 1e-6);
  assert.equal(g.json.revision, 1);
});

test('播放中跳入超载段：400 拒绝且房间不变；跳到安全段继续播放', async () => {
  const { version, c1 } = await seedProtectedVersion();
  const c = (await createProtectedRoom(version.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  await ctrl({ revision: 0, action: 'play' });
  // 播放中立刻（还在 t≈0 的安全段）尝试跳入超载段：拒绝
  let r = await ctrl({ revision: 1, action: 'seek', time: 0.8 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /播放中不得跳入超载段/);
  assert.equal(r.json.circuits[0].circuit_id, c1);

  // 拒绝后立刻查询：房间仍是从 t=0 播放的原状态（修订号仍为 1，时尚未到 0.3）
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, true);
  assert.ok(g.json.time < 0.3, `time=${g.json.time}`);
  assert.equal(g.json.revision, 1);

  // 时间越过边界后：在 0.3 被保护截停并惰性落库
  await sleep(700);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.revision, 1);

  // 暂停态（已被自动暂停）跳到起点安全段，再播放成功
  r = await ctrl({ revision: 1, action: 'seek', time: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, false);
  assert.equal(r.json.protection.tripped, undefined, '跳转离开后清除触发标记');
  r = await ctrl({ revision: 2, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
});

test('渐变超载交点（开端点 t=0.5）：自动暂停在 0.5；在交点本身（负载恰等于容量）允许播放', async () => {
  const { version, c1 } = await seedRampVersion();
  const c = (await createProtectedRoom(version.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  // 暂停跳到交点 0.5：负载恰好等于容量（严格大于才超载），可播放
  let r = await ctrl({ revision: 0, action: 'seek', time: 0.5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.protection.overloaded_now, false);
  r = await ctrl({ revision: 1, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);

  await sleep(700); // 越过 0.5 很远
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.5) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.protection.tripped.circuit.circuit_id, c1);
  assert.equal(g.json.revision, 2); // play 一次 +1，自动暂停不再 +1
});

test('倍速从实时推算时码继续：2 倍速在同样墙钟时间内抵达边界', async () => {
  const { version, c1 } = await seedRampVersion();
  const c = (await createProtectedRoom(version.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  // 暂停跳到 0.1，再设 2 倍速（速度变化从实时时码继续）
  await ctrl({ revision: 0, action: 'seek', time: 0.1 });
  const sp = await ctrl({ revision: 1, action: 'speed', speed: 2 });
  assert.equal(sp.json.speed, 2);
  assert.ok(Math.abs(sp.json.time - 0.1) < 1e-6);
  await ctrl({ revision: 2, action: 'play' });

  // 2 倍速：从 0.1 到 0.5 需墙钟 0.2s；睡 700ms 后必须停在 0.5
  await sleep(700);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.5) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.protection.tripped.circuit.circuit_id, c1);
  assert.equal(g.json.revision, 3);
});

test('自动暂停后可暂停态跳转避险，再从安全位置播放', async () => {
  const { version, c1 } = await seedProtectedVersion();
  const c = (await createProtectedRoom(version.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  await ctrl({ revision: 0, action: 'play' });
  await sleep(700);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(g.json.protection.tripped);

  // 跳回安全段 t=0.1（暂停态允许），播放成功
  let r = await ctrl({ revision: 1, action: 'seek', time: 0.1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.protection.overloaded_now, false);
  r = await ctrl({ revision: 2, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
});

test('未启用保护的房间沿用原行为：可在超载段播放、不返回 tripped', async () => {
  const { version, c1 } = await seedProtectedVersion();
  const c = (await request('POST', '/api/rooms', { version_id: version.id })).json;
  assert.deepEqual(c.protection, { enabled: false });
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  // 暂停跳进超载段，再播放——未启用保护，全部允许
  let r = await ctrl({ revision: 0, action: 'seek', time: 0.8 });
  assert.equal(r.status, 200);
  r = await ctrl({ revision: 1, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  assert.equal(r.json.protection.enabled, false);

  await sleep(300);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false); // 到版本末尾停住（原行为）
  assert.equal(g.json.time, g.json.duration);
  assert.equal(g.json.protection.tripped, undefined);
});

test('保护触发后服务重启：仍按墙钟与冻结版本恢复为暂停在边界（修订号不变）', async () => {
  const { version, c1 } = await seedRampVersion();
  const c = (await createProtectedRoom(version.id)).json;
  await request('POST', `/api/rooms/${c.code}/control`, {
    control_key: c.control_key,
    revision: 0,
    action: 'play',
  });
  await sleep(700);
  // 惰性落库（触发状态持久化）
  const g0 = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(Math.abs(g0.json.time - 0.5) < 1e-6);
  assert.ok(g0.json.protection.tripped);

  // 同一 DB 上再开一个“重启”实例
  const { app: app2 } = require('../server.js');
  const s2 = http.createServer(app2);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const g = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s2.address().port, path: `/api/rooms/${c.code}` }, (res) => {
        let d = '';
        res.on('data', (x) => (d += x));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    assert.equal(g.playing, false);
    assert.ok(Math.abs(g.time - 0.5) < 1e-6);
    assert.equal(g.revision, 1);
    assert.equal(g.protection.enabled, true);
    assert.ok(g.protection.tripped);
    assert.equal(g.protection.tripped.circuit.circuit_id, c1);
  } finally {
    await new Promise((r) => s2.close(r));
  }
});
