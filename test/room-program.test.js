'use strict';

// 共享房间「循环排演」HTTP 单元测试：
// 提交鉴权（密钥/修订号）、段校验（1～8 段、非负起止、start<end、end≤末尾、正整数重复）、
// 成功后从首段开始并 +1 修订号、段尾跳回/跳段的服务端墙钟推算、轮次/段查询、
// 全部完成停在末段终点、暂停与改速保留进度（断点接续）、手动跳转取消编排、
// 超载保护（超载段起点拒绝整次编排、运行途中在边界自动暂停不越界）、
// 主持权交接后新主持人可控制、观看者只读且不见密钥、未编排房间行为兼容、重启恢复。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-room-program-'));
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

// 普通版本：灯 L，t=0 渐变到 100、duration 10 → 末尾 10 秒
async function seedPlainVersion() {
  await resetDraft();
  const l = (await request('POST', '/api/lights', { name: '排演大灯' })).json.id;
  await request('POST', '/api/cues', [{ cue_no: 9101, light_id: l, time: 0, target: 100, duration: 10 }]);
  return (await request('POST', '/api/versions', { label: '排演版' })).json;
}

/**
 * 带超载保护的版本（同 room-overload-protection 口径）：
 *  - L1 接「超载回路」，容量 100W、额定 200W；
 *    t=0 瞬变 50（恰等于容量，不超载），t=0.3 瞬变 100（严格超载，闭左边界 0.3），
 *    t=1 瞬变 0；版本末尾 1 秒。
 */
async function seedProtectedVersion() {
  await resetDraft();
  const c1 = (await request('POST', '/api/circuits', { name: '超载回路PG', capacity: 100 })).json.id;
  const l1 = (await request('POST', '/api/lights', { name: '大灯PG' })).json.id;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c1, watts: 200 });
  await request('POST', '/api/cues', [
    { cue_no: 9201, light_id: l1, time: 0, target: 50, duration: 0 },
    { cue_no: 9202, light_id: l1, time: 0.3, target: 100, duration: 0 },
    { cue_no: 9203, light_id: l1, time: 1, target: 0, duration: 0 },
  ]);
  return { version: (await request('POST', '/api/versions', { label: '保护排演版' })).json, c1 };
}

async function createRoom(versionId, body = {}) {
  return request('POST', '/api/rooms', { version_id: versionId, ...body });
}
const programUrl = (code) => `/api/rooms/${code}/program`;

test('提交编排：缺/错密钥 403、修订号缺失非法 400、过期 409，均不改变房间', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const segs = [{ start: 0, end: 2, repeat: 2 }];

  let r = await request('POST', programUrl(c.code), { revision: 0, segments: segs });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await request('POST', programUrl(c.code), {
    control_key: 'deadbeef'.repeat(6),
    revision: 0,
    segments: segs,
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  r = await request('POST', programUrl(c.code), { control_key: c.control_key, segments: segs });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: -1,
    segments: segs,
  });
  assert.equal(r.status, 400);

  // 先让房间修订号前进一次，再用过时的 0 提交
  await request('POST', `/api/rooms/${c.code}/control`, {
    control_key: c.control_key,
    revision: 0,
    action: 'pause',
  });
  r = await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: segs,
  });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.program, undefined, '拒绝提交后房间仍为未编排');
  assert.equal(g.json.revision, 1);
});

test('段校验：1～8 段、非负起止、start<end、end≤末尾、正整数重复——非法整次拒绝', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const submit = (segments) =>
    request('POST', programUrl(c.code), { control_key: c.control_key, revision: c.revision, segments });

  let r = await submit([]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /1～8 段/);

  r = await submit(Array.from({ length: 9 }, () => ({ start: 0, end: 1, repeat: 1 })));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /1～8 段/);

  r = await submit([{ start: -1, end: 2, repeat: 1 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /起点无效/);

  r = await submit([{ start: 2, end: 'x', repeat: 1 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /终点无效/);

  r = await submit([{ start: 5, end: 5, repeat: 1 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /须严格早于终点/);

  r = await submit([{ start: 6, end: 5, repeat: 1 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /须严格早于终点/);

  r = await submit([{ start: 0, end: 10.01, repeat: 1 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /终点越界/);

  r = await submit([{ start: 0, end: 2, repeat: 0 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /重复次数无效/);

  r = await submit([{ start: 0, end: 2, repeat: 1.5 }]);
  assert.equal(r.status, 400);

  r = await submit('not-array');
  assert.equal(r.status, 400);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.program, undefined, '非法段全部不落库');
  assert.equal(g.json.revision, 0);
});

test('提交成功：从首段开始播放、修订号 +1，program 块报告段列表与当前段/轮次', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const segs = [
    { start: 1, end: 3, repeat: 2 },
    { start: 7, end: 9, repeat: 1 },
  ];
  const r = await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: segs,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  assert.ok(Math.abs(r.json.time - 1) < 1e-6);
  assert.equal(r.json.revision, 1);
  assert.deepEqual(r.json.program.segments, segs);
  assert.equal(r.json.program.segment_index, 1);
  assert.equal(r.json.program.segment_count, 2);
  assert.equal(r.json.program.loop, 1);
  assert.equal(r.json.program.loop_total, 2);
  assert.equal(r.json.program.status, 'playing');
  assert.equal(r.json.program.finished, false);
  assert.equal(r.json.program.total_loops, 3);
  assert.equal(r.json.control_key, undefined, '提交响应不回显密钥');
});

test('段尾跳回本段起点：墙钟推算时码循环、轮次递增', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  // 段 [2,4) 重复 3 次
  const r = await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 2, end: 4, repeat: 3 }],
  });
  assert.equal(r.status, 200);
  const wall0 = r.json.server_wall;

  // 2.5 秒墙钟：第一轮(2s)走完回到 2，再前进 0.5 → 2.5，轮次 1（0 基）
  await sleep(2550);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, true);
  const dt = g.json.server_wall - wall0;
  const expectT = 2 + (dt - 2);
  assert.ok(Math.abs(g.json.time - expectT) < 0.08, `time=${g.json.time} expect~${expectT}`);
  assert.ok(g.json.time >= 2 && g.json.time < 3, `time=${g.json.time}`);
  assert.equal(g.json.program.segment_index, 1);
  assert.equal(g.json.program.loop, 2, '第 2 轮（1 基）');
  assert.equal(g.json.program.status, 'playing');

  // 暂停固化，轮次保持
  const rev = g.json.revision;
  const pause = await ctrl({ revision: rev, action: 'pause' });
  assert.equal(pause.status, 200);
  assert.equal(pause.json.playing, false);
  assert.equal(pause.json.program.status, 'paused');
  assert.equal(pause.json.program.loop, 2);
  const pausedAt = pause.json.time;
  await sleep(120);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(Math.abs(g.json.time - pausedAt) < 1e-6);
  assert.equal(g.json.program.loop, 2);

  // 继续播放从断点接续（不重置段/轮）
  const play = await ctrl({ revision: rev + 1, action: 'play' });
  assert.equal(play.status, 200);
  assert.equal(play.json.playing, true);
  assert.equal(play.json.program.segment_index, 1);
  assert.equal(play.json.program.loop, 2);
});

test('多段：段尾跳到下段起点；全部完成后停在末段终点（finished，修订号不变）', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  // 段 [0,0.3)×2（0.6s 墙钟）+ [0.8,1]×1（0.2s）= 0.8s 墙钟
  const r = await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [
      { start: 0, end: 0.3, repeat: 2 },
      { start: 0.8, end: 1, repeat: 1 },
    ],
  });
  assert.equal(r.status, 200);
  const wall0 = r.json.server_wall;

  // 约 0.68 秒：第一段两轮（0.6s）已走完跳到第二段 0.8，并在 [0.8,1] 内前进
  await sleep(680);
  let g = await request('GET', `/api/rooms/${c.code}`);
  const dt = g.json.server_wall - wall0;
  assert.ok(dt > 0.6 && dt < 0.8, `dt=${dt}`);
  assert.equal(g.json.playing, true);
  assert.equal(g.json.program.segment_index, 2);
  assert.equal(g.json.program.loop, 1);
  const expectSeg2 = 0.8 + Math.max(0, dt - 0.6);
  assert.ok(Math.abs(g.json.time - expectSeg2) < 0.08, `time=${g.json.time} expect~${expectSeg2}`);

  // 睡过 0.8s：整次编排完成，停在末段终点 1
  await sleep(700);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 1) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.program.status, 'finished');
  assert.equal(g.json.program.finished, true);
  assert.equal(g.json.program.segment_index, 2);
  assert.equal(g.json.program.loop, 1);
  assert.equal(g.json.revision, 1, '自动走完不增加修订号');

  // 已惰性落库：再查仍停在末段终点
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.equal(g.json.program.finished, true);
  assert.equal(g.json.revision, 1);
});

test('finished 后再播放：从首段重新开始整次编排', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0, end: 0.1, repeat: 1 }],
  });
  await sleep(400);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.program.finished, true);
  assert.equal(g.json.playing, false);

  const r = await ctrl({ revision: 1, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  assert.equal(r.json.program.finished, false);
  assert.equal(r.json.program.segment_index, 1);
  assert.equal(r.json.program.loop, 1);
  assert.ok(Math.abs(r.json.time - 0) < 1e-6);
});

test('改速保留编排进度：以实时推算为新基准，按新倍速穿段', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  // 段 [0,0.8)×3；1 倍速播 0.2s 后改 2 倍速
  const r = await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0, end: 0.8, repeat: 3 }],
  });
  const wall0 = r.json.server_wall;
  await sleep(200);
  const sp = await ctrl({ revision: 1, action: 'speed', speed: 2 });
  assert.equal(sp.status, 200);
  assert.equal(sp.json.speed, 2);
  // 逻辑进度按实时推算固化（仍在第 1 轮、约 0.2）
  assert.equal(sp.json.program.loop, 1);
  assert.ok(sp.json.time > 0.1 && sp.json.time < 0.3, `time=${sp.json.time}`);
  const wall1 = sp.json.server_wall;
  const t1 = sp.json.time;
  await sleep(150);
  const g = await request('GET', `/api/rooms/${c.code}`);
  const expect = t1 + (g.json.server_wall - wall1) * 2; // 2 倍速墙钟流逝
  // 段长 0.8：若超过段尾会瞬时跳回；校验时码按段循环映射
  let mapped = expect;
  while (mapped >= 0.8 - 1e-9) mapped -= 0.8;
  assert.ok(Math.abs(g.json.time - mapped) < 0.08, `time=${g.json.time} mapped=${mapped}`);
  assert.equal(wall1 > wall0, true);
});

test('手动跳转取消编排：seek 后 program 消失，沿用普通房间语义（修订号 +1）', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0, end: 2, repeat: 5 }],
  });
  await sleep(150);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(g.json.program);
  assert.equal(g.json.playing, true);

  // 播放中手动跳转：取消编排，播放状态沿用（继续播放），时码就是普通房间时码
  const seek = await ctrl({ revision: 1, action: 'seek', time: 8 });
  assert.equal(seek.status, 200);
  assert.equal(seek.json.playing, true);
  assert.ok(Math.abs(seek.json.time - 8) < 1e-6);
  assert.equal(seek.json.program, undefined, '编排已取消');
  assert.equal(seek.json.revision, 2);

  await sleep(200);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.program, undefined);
  assert.ok(g.json.time > 8, '普通房间线性推进，不再段尾跳回');
});

test('显式取消接口：删除编排，播放状态与时码保留，修订号 +1', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0, end: 2, repeat: 5 }],
  });
  await sleep(150);
  const r = await request('POST', `/api/rooms/${c.code}/program/clear`, {
    control_key: c.control_key,
    revision: 1,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  assert.equal(r.json.program, undefined);
  assert.equal(r.json.revision, 2);
  assert.ok(r.json.time > 0, '当前时码保留');

  // 无密钥观看者不能取消
  const deny = await request('POST', `/api/rooms/${c.code}/program/clear`, { revision: 2 });
  assert.equal(deny.status, 403);
});

test('超载保护：超载段起点使整次编排被拒绝（400、不落库、不改房间）', async () => {
  const { version } = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  const segs = [
    { start: 0, end: 0.2, repeat: 1 },
    { start: 0.5, end: 0.9, repeat: 2 }, // 0.5 处于严格超载区间 [0.3,1)
  ];
  const r = await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: segs,
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, 'overloaded_segment_start');
  assert.equal(r.json.segment_index, 2);
  assert.ok(Math.abs(r.json.time - 0.5) < 1e-9);
  assert.match(r.json.error, /整次循环排演被拒绝/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.program, undefined);
  assert.equal(g.json.playing, false);
  assert.equal(g.json.revision, 0, '房间未改变');
});

test('超载保护：安全段起点可提交；运行途中抵达超载边界自动暂停，不越过且不加修订号', async () => {
  const { version, c1 } = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  // 段 [0,0.9)×2：起点 0 安全（负载恰等于容量），播放会在 0.3 闭边界自动暂停
  const r = await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0, end: 0.9, repeat: 2 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);

  await sleep(900); // 远超 0.3s 边界
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.revision, 1, '自动暂停不增加修订号');
  assert.ok(g.json.protection.tripped);
  assert.equal(g.json.protection.tripped.circuit.circuit_id, c1);
  // 编排仍在：停在第 1 轮，断点保留
  assert.ok(g.json.program);
  assert.equal(g.json.program.finished, false);
  assert.equal(g.json.program.loop, 1);

  // 已落库：再查仍暂停在边界
  const g2 = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g2.json.playing, false);
  assert.ok(Math.abs(g2.json.time - 0.3) < 1e-6);
  assert.equal(g2.json.revision, 1);
});

test('超载保护：暂停在边界后，手动跳转避险并取消编排，可重新播放', async () => {
  const { version } = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0, end: 0.9, repeat: 2 }],
  });
  await sleep(700);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6);

  // 暂停态跳回安全时码 0（同时取消编排）
  const seek = await ctrl({ revision: 1, action: 'seek', time: 0 });
  assert.equal(seek.status, 200);
  assert.equal(seek.json.playing, false);
  assert.equal(seek.json.program, undefined);
  assert.equal(seek.json.protection.tripped, undefined);
});

test('观看者只读：GET 可见编排进度但无密钥；控制/提交均 403', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 1, end: 3, repeat: 2 }],
  });
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(g.json.program, '观看者可见编排段/轮次');
  assert.equal(g.json.control_key, undefined);

  let r = await request('POST', programUrl(c.code), {
    revision: 1,
    segments: [{ start: 0, end: 1, repeat: 1 }],
  });
  assert.equal(r.status, 403);
  r = await request('POST', `/api/rooms/${c.code}/control`, { revision: 1, action: 'pause' });
  assert.equal(r.status, 403);
});

test('主持权交接后新主持人可继续控制编排，播放/段/轮次进度不重置', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (key, body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: key, ...body });

  await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0, end: 0.4, repeat: 4 }],
  });
  await sleep(200); // 第一轮内
  // 发起交接
  const issue = await request('POST', `/api/rooms/${c.code}/handover/issue`, {
    control_key: c.control_key,
    revision: 1,
  });
  assert.equal(issue.status, 200);
  const token = issue.json.handover_token;
  // 领取新密钥（修订号 +1）
  const claim = await request('POST', `/api/rooms/${c.code}/handover/claim`, {
    handover_token: token,
    revision: 1,
  });
  assert.equal(claim.status, 200);
  const newKey = claim.json.control_key;
  assert.ok(newKey);
  assert.ok(claim.json.program, '交接不取消编排');
  assert.equal(claim.json.playing, true, '播放状态延续');

  // 旧主持人再控制 403
  const old = await ctrl(c.control_key, { revision: 2, action: 'pause' });
  assert.equal(old.status, 403);
  // 新主持人暂停成功，编排进度保留
  const pause = await ctrl(newKey, { revision: 2, action: 'pause' });
  assert.equal(pause.status, 200);
  assert.equal(pause.json.playing, false);
  assert.ok(pause.json.program);
});

test('未编排房间行为兼容：GET 无 program 字段，普通播放/到末尾停住不变', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.program, undefined);

  await request('POST', `/api/rooms/${c.code}/control`, {
    control_key: c.control_key,
    revision: 0,
    action: 'play',
  });
  await sleep(150);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.program, undefined);
  assert.equal(g.json.playing, true);
  assert.ok(g.json.time > 0);
});

test('重启后编排进度一致（段/轮/时码持久化在数据库）', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  await request('POST', programUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 2, end: 6, repeat: 5 }],
  });
  await sleep(150);
  // 暂停固化断点
  const g0 = await request('GET', `/api/rooms/${c.code}`);
  await ctrl({ revision: g0.json.revision, action: 'pause' });
  const paused = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(paused.playing, false);

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
    assert.ok(g.program, '编排仍在');
    assert.ok(Math.abs(g.time - paused.time) < 1e-6);
    assert.equal(g.program.loop, paused.program.loop);
    assert.deepEqual(g.program.segments, paused.program.segments);
  } finally {
    await new Promise((r) => s2.close(r));
  }
});
