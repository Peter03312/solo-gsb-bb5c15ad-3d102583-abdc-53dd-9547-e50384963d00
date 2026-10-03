'use strict';

// 共享房间「讨论停点」HTTP 单元测试：
// 整组替换鉴权（密钥/修订号）、时码校验（非负、不超过末尾、互不重复、空组清除）、
// 播放连续经过停点自动暂停（准确停在停点、显示原因、不加修订号）、继续播放越过
// 刚触发停点、循环排演重新经过仍暂停（段尾瞬跳不触发跳过的停点）、手动跳转沿用
// 取消编排规则且跳到停点不立即触发、超载同时码优先及先抵达者生效、停点不随跳转/
// 交接/编排丢失、观看者只读、重启恢复。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-room-stops-'));
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
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
        method,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : '';
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
  const l = (await request('POST', '/api/lights', { name: '停点大灯' })).json.id;
  await request('POST', '/api/cues', [{ cue_no: 9301, light_id: l, time: 0, target: 100, duration: 10 }]);
  return (await request('POST', '/api/versions', { label: '停点排演版' })).json;
}

/**
 * 超载版本：容量 100W、额定 200W；t=0 瞬变 50（恰等于容量），t=0.3 瞬变 100
 * （严格超载，闭左边界 0.3），t=1 瞬变 0；版本末尾 1 秒。
 */
async function seedProtectedVersion() {
  await resetDraft();
  const c1 = (await request('POST', '/api/circuits', { name: '超载回路S', capacity: 100 })).json.id;
  const l1 = (await request('POST', '/api/lights', { name: '大灯S' })).json.id;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c1, watts: 200 });
  await request('POST', '/api/cues', [
    { cue_no: 9401, light_id: l1, time: 0, target: 50, duration: 0 },
    { cue_no: 9402, light_id: l1, time: 0.3, target: 100, duration: 0 },
    { cue_no: 9403, light_id: l1, time: 1, target: 0, duration: 0 },
  ]);
  return { version: (await request('POST', '/api/versions', { label: '停点保护版' })).json, c1 };
}

async function createRoom(versionId, body = {}) {
  return request('POST', '/api/rooms', { version_id: versionId, ...body });
}
const stopsUrl = (code) => `/api/rooms/${code}/stops`;
const setStops = (c, times, revision) =>
  request('POST', stopsUrl(c.code), {
    control_key: c.control_key,
    revision: revision === undefined ? c.revision : revision,
    times,
  });
const ctrl = (c, body) =>
  request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

test('替换停点：缺/错密钥 403、修订号缺失非法 400、过期 409，均不改变房间', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;

  let r = await request('POST', stopsUrl(c.code), { revision: 0, times: [1] });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await request('POST', stopsUrl(c.code), { control_key: 'deadbeef'.repeat(6), revision: 0, times: [1] });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  r = await request('POST', stopsUrl(c.code), { control_key: c.control_key, times: [1] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await request('POST', stopsUrl(c.code), { control_key: c.control_key, revision: -2, times: [1] });
  assert.equal(r.status, 400);

  // 先让修订号前进，再用过时修订号提交
  await ctrl(c, { revision: 0, action: 'pause' });
  r = await setStops(c, [1], 0);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.times, []);
  assert.equal(g.json.stops.configured, false);
  assert.equal(g.json.revision, 1, '拒绝不改变房间、不增加修订号');
});

test('时码校验：非数组、负数、非数字、超过末尾、重复均整次拒绝（原子性）', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const submit = (times) => setStops(c, times);

  let r = await submit('1,2,3');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /须为时码数组/);

  r = await submit([-0.5]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /非法/);

  r = await submit(['x']);
  assert.equal(r.status, 400);

  r = await submit([null]);
  assert.equal(r.status, 400);

  r = await submit([10.01]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /越界/);

  r = await submit([3, 5, 3]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /重复/);

  // 合法边界值：0 与版本末尾 10 都允许
  r = await submit([10, 0, 5.5]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stops.times, [0, 5.5, 10], '成功后按升序返回');
  assert.equal(r.json.stops.configured, true);
  assert.equal(r.json.revision, 1);
  assert.equal(r.json.control_key, undefined, '不回显密钥');

  // 前面整组非法提交都未落库
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.times, [0, 5.5, 10]);
});

test('空组清除：times=[] 删除停点、修订号 +1；GET 中 stops 字段始终存在', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;

  const g0 = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g0.json.stops, { times: [], configured: false, next_stop: null });

  await setStops(c, [2, 4]);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.times, [2, 4]);
  assert.equal(g.json.revision, 1);
  assert.ok(g.json.stops.next_stop); // 当前在 0，下一个为 2

  const r = await setStops(c, [], 1);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stops.times, []);
  assert.equal(r.json.stops.configured, false);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.times, []);
  assert.equal(g.json.revision, 2);
});

test('播放连续经过停点：准确暂停在停点、显示原因、自动暂停不加修订号', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;

  await setStops(c, [0.4]);
  const play = await ctrl(c, { revision: 1, action: 'play' });
  assert.equal(play.status, 200);
  assert.equal(play.json.playing, true);

  // 观看端 1 秒才轮询一次（远超 0.4s 停点）：必须停在 0.4，不得越过
  await sleep(1000);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.4) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.revision, 2, '自动暂停不增加修订号（play 已 +1）');
  assert.ok(g.json.stops.tripped);
  assert.equal(g.json.stops.tripped.reason, 'stop_point');
  assert.equal(g.json.stops.tripped.time, 0.4);
  assert.match(g.json.stops.tripped.reason_text, /讨论停点/);

  // 已惰性落库：再查仍暂停在停点
  const g2 = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g2.json.playing, false);
  assert.ok(Math.abs(g2.json.time - 0.4) < 1e-6);
  assert.equal(g2.json.revision, 2);
});

test('继续播放越过刚触发的停点：暂停在 0.4 再播放不会立刻触发，直达下一停点', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await setStops(c, [0.3, 0.8]);
  await ctrl(c, { revision: 1, action: 'play' });
  await sleep(900);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `time=${g.json.time}`);
  assert.ok(g.json.stops.tripped);
  const rev = g.json.revision;

  // 继续播放：越过 0.3，不停在原地，直达 0.8
  const play = await ctrl(c, { revision: rev, action: 'play' });
  assert.equal(play.status, 200);
  assert.equal(play.json.playing, true);
  assert.equal(play.json.stops.tripped, undefined, '继续播放清除已触发标记');
  await sleep(900);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.8) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.stops.tripped.time, 0.8);
  assert.equal(g.json.revision, rev + 1, '仅 play 增加过一次修订号');
});

test('循环排演：每次重新经过同一停点仍暂停；段尾瞬时跳转不触发跳过的停点', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  // 编排段 [0,0.5)×3；停点 0.2（每轮都会连续经过），停点 0.8 只在段外（瞬跳不经过）
  await setStops(c, [0.2, 0.8]);
  const r = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 1,
    segments: [{ start: 0, end: 0.5, repeat: 3 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);

  await sleep(700); // 远超 0.2
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.2) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.stops.tripped.time, 0.2);
  assert.equal(g.json.program.loop, 1, '停在第 1 轮');
  const rev = g.json.revision; // =2（program 提交 +1）

  // 继续：越过 0.2，到段尾 0.5 瞬时跳回 0（0.8 不触发），第 2 轮再到 0.2 暂停
  await ctrl(c, { revision: rev, action: 'play' });
  await sleep(900);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.2) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.stops.tripped.time, 0.2);
  assert.equal(g.json.program.loop, 2, '重新经过仍暂停：停在第 2 轮');
  assert.equal(g.json.revision, rev + 1);

  // 第 3 轮同样再触发一次
  await ctrl(c, { revision: g.json.revision, action: 'play' });
  await sleep(900);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.2) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.program.loop, 3, '停在第 3 轮');
});

test('手动跳转沿用取消编排规则：跳到停点不立即触发；播放后连续经过才触发', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  // 先编排，再手动跳转：取消编排（现有规则），停点配置保留
  await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 0,
    segments: [{ start: 0, end: 2, repeat: 3 }],
  });
  await setStops(c, [0.5], 1);
  await sleep(100);
  // 暂停后直接跳到停点 0.5：不触发（此时修订号：编排 +1、停点 +1 → 2）
  const seek = await ctrl(c, { revision: 2, action: 'pause' });
  assert.equal(seek.status, 200);
  const seek2 = await ctrl(c, { revision: 3, action: 'seek', time: 0.5 });
  assert.equal(seek2.status, 200);
  assert.equal(seek2.json.playing, false);
  assert.ok(Math.abs(seek2.json.time - 0.5) < 1e-6);
  assert.equal(seek2.json.stops.tripped, undefined, '跳到停点不立即触发');
  assert.equal(seek2.json.program, undefined, '手动跳转取消编排');
  assert.deepEqual(seek2.json.stops.times, [0.5], '停点配置不随跳转丢失');

  // 从 0.5 播放：越过 0.5，该停点不再触发（前方无停点，播放持续线性推进）
  const play = await ctrl(c, { revision: 4, action: 'play' });
  assert.equal(play.status, 200);
  await sleep(600);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, true, '越过停点后继续播放，未被暂停');
  assert.ok(g.json.time > 0.8, `time=${g.json.time}（应已越过停点 0.5）`);
  assert.equal(g.json.stops.tripped, undefined);
});

test('停点在段尾：连续抵达段尾时触发暂停（不是瞬时跳回）', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await setStops(c, [0.5]);
  await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 1,
    segments: [{ start: 0, end: 0.5, repeat: 3 }],
  });
  await sleep(900);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.5) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.stops.tripped.time, 0.5);
  // 停在段尾属于第 1 轮走完前的暂停：断点保留在第 1 轮
  assert.equal(g.json.program.loop, 1);
});

test('超载与停点同一时码：超载优先（tripped 为超载原因，不是停点）', async () => {
  const { version, c1 } = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  await setStops(c, [0.3]); // 超载闭边界恰为 0.3
  await ctrl(c, { revision: 1, action: 'play' });
  await sleep(900);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `time=${g.json.time}`);
  assert.ok(g.json.protection.tripped, '报告超载触发');
  assert.equal(g.json.protection.tripped.circuit.circuit_id, c1);
  assert.equal(g.json.stops.tripped, undefined, '同一时码不报告停点触发');
  assert.equal(g.json.revision, 2);
});

test('先抵达者生效：停点早于超载边界时停在停点；越过停点后再播才到超载', async () => {
  const { version } = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  await setStops(c, [0.15, 0.3]);
  await ctrl(c, { revision: 1, action: 'play' });
  await sleep(800);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.15) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.stops.tripped.time, 0.15);
  assert.equal(g.json.protection.tripped, undefined);

  // 继续：越过 0.15，下一个先抵达的是 0.3——停点与超载边界同码，超载优先
  await ctrl(c, { revision: g.json.revision, action: 'play' });
  await sleep(800);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `time=${g.json.time}`);
  assert.ok(g.json.protection.tripped);
  assert.equal(g.json.stops.tripped, undefined);
});

test('超载当前时码拒绝播放的既有规则不因停点改变', async () => {
  const { version } = await seedProtectedVersion();
  const c = (await createRoom(version.id, { overload_protection: true })).json;
  await setStops(c, [0.15, 0.5]);
  // 暂停跳入超载段 0.5（暂停允许）：该时码也有停点，但 seek 不触发任何自动暂停
  const seek = await ctrl(c, { revision: 1, action: 'seek', time: 0.5 });
  assert.equal(seek.status, 200);
  assert.equal(seek.json.protection.overloaded_now, true);
  assert.equal(seek.json.stops.tripped, undefined);
  // 当前超载：播放仍被拒绝
  const play = await ctrl(c, { revision: 2, action: 'play' });
  assert.equal(play.status, 400);
  assert.equal(play.json.reason, 'overloaded_timecode');
});

test('停点不随编排/取消/交接丢失；交接后新主持人可维护', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await setStops(c, [2, 4]); // rev 1

  // 提交编排（rev 2）：停点保留
  let r = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 1,
    segments: [{ start: 0, end: 1, repeat: 1 }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stops.times, [2, 4]);

  // 取消编排（rev 3）：停点保留
  r = await request('POST', `/api/rooms/${c.code}/program/clear`, {
    control_key: c.control_key,
    revision: 2,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stops.times, [2, 4]);

  // 主持权交接（rev 4）：停点保留，新主持人可替换
  const issue = await request('POST', `/api/rooms/${c.code}/handover/issue`, {
    control_key: c.control_key,
    revision: 3,
  });
  assert.equal(issue.status, 200);
  const claim = await request('POST', `/api/rooms/${c.code}/handover/claim`, {
    handover_token: issue.json.handover_token,
    revision: 3,
  });
  assert.equal(claim.status, 200);
  assert.deepEqual(claim.json.stops.times, [2, 4]);
  const newKey = claim.json.control_key;

  // 旧主持人改停点 403
  const old = await request('POST', stopsUrl(c.code), { control_key: c.control_key, revision: 4, times: [9] });
  assert.equal(old.status, 403);
  // 新主持人替换成功（rev 5），交接凭证因修订号前进而作废的约定不变
  const ok = await request('POST', stopsUrl(c.code), { control_key: newKey, revision: 4, times: [9] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.stops.times, [9]);
});

test('观看者只读：GET 可见停点与触发状态，替换 403', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await setStops(c, [0.2]);
  await ctrl(c, { revision: 1, action: 'play' });
  await sleep(700);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.times, [0.2]);
  assert.ok(g.json.stops.tripped);
  assert.equal(g.json.control_key, undefined);

  const r = await request('POST', stopsUrl(c.code), { revision: g.json.revision, times: [1] });
  assert.equal(r.status, 403);
});

test('重启后停点配置与触发状态一致（持久化在数据库）', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await setStops(c, [0.25]);
  await ctrl(c, { revision: 1, action: 'play' });
  await sleep(800);
  const g0 = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(Math.abs(g0.json.time - 0.25) < 1e-6);
  assert.ok(g0.json.stops.tripped);

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
    assert.ok(Math.abs(g.time - 0.25) < 1e-6);
    assert.deepEqual(g.stops.times, [0.25]);
    assert.ok(g.stops.tripped);
    assert.equal(g.stops.tripped.time, 0.25);
  } finally {
    await new Promise((r) => s2.close(r));
  }
});
