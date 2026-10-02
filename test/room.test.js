'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 每个测试文件使用独立临时库，不触碰开发数据
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-rooms-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');

let server;
let base;

function request(method, urlPath, body, raw = false) {
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
          if (raw) return resolve({ status: res.statusCode, body: data });
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

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = '';
});
after(async () => {
  await new Promise((r) => server.close(r));
});

let seedSeq = 0;
// 每次“种版本”前清空草稿（先删 Cue 再删灯具），保证各用例基于独立草稿发布
async function resetDraft() {
  const cues = JSON.parse(
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/cues' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
    })
  );
  for (const c of cues) await request('DELETE', `/api/cues/${c.id}`);
  const lights = JSON.parse(
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/lights' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
    })
  );
  for (const l of lights) await request('DELETE', `/api/lights/${l.id}`);
}

async function seedVersion() {
  const n = ++seedSeq;
  await resetDraft();
  await request('POST', '/api/lights', { name: `面光${n}a` });
  await request('POST', '/api/lights', { name: `侧光${n}b` });
  // 取最新两盏灯的编号
  const lights = JSON.parse(
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/lights' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
    })
  );
  const [l1, l2] = lights.slice(-2).map((l) => l.id);
  await request('POST', '/api/cues', [
    { cue_no: 1000 + n * 10 + 1, light_id: l1, time: 0, target: 100, duration: 10 },
    { cue_no: 1000 + n * 10 + 2, light_id: l2, time: 2, target: 50, duration: 4 },
  ]);
  const v = await request('POST', '/api/versions', { label: `首演${n}` });
  return v.json;
}

async function createRoom(versionId, body = {}) {
  return request('POST', '/api/rooms', { version_id: versionId, ...body });
}

test('创建房间：无效/不存在版本明确报错（400/404）', async () => {
  let r = await createRoom('abc');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /版本编号无效/);
  r = await createRoom(-3);
  assert.equal(r.status, 400);
  r = await createRoom(9999);
  assert.equal(r.status, 404);
  assert.match(r.json.error, /版本不存在/);
});

test('创建房间成功：固定版本、6 位房间码与一次性控制密钥，初始暂停在 0', async () => {
  const v = await seedVersion();
  const r = await createRoom(v.id, { label: '联排房' });
  assert.equal(r.status, 201);
  assert.match(r.json.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(r.json.version.id, v.id);
  assert.equal(r.json.label, '联排房');
  assert.equal(r.json.duration, 10);
  assert.equal(r.json.playing, false);
  assert.equal(r.json.time, 0);
  assert.equal(r.json.speed, 1);
  assert.equal(r.json.revision, 0);
  assert.match(r.json.control_key, /^[0-9a-f]{48}$/);
  assert.equal(typeof r.json.server_wall, 'number');
});

test('凭房间码查看：无需密钥；错误码格式 400、不存在 404（大小写/连字符归一）', async () => {
  const v = await seedVersion();
  const c = (await createRoom(v.id)).json;

  let r = await request('GET', `/api/rooms/ab`);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /房间码无效/);

  r = await request('GET', `/api/rooms/ZZZZZZ`);
  assert.equal(r.status, 404);
  assert.match(r.json.error, /房间不存在/);

  // 小写与带连字符均能归一到同一房间
  r = await request('GET', `/api/rooms/${c.code.toLowerCase()}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.code, c.code);
  r = await request('GET', `/api/rooms/${c.code.slice(0, 3)}-${c.code.slice(3)}`);
  assert.equal(r.status, 200);
});

test('查看响应不回显控制密钥', async () => {
  const v = await seedVersion();
  const c = (await createRoom(v.id)).json;
  const r = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(r.json.control_key, undefined);
});

test('控制鉴权：缺少密钥 403、错误密钥 403，且不改房间', async () => {
  const v = await seedVersion();
  const c = (await createRoom(v.id)).json;

  let r = await request('POST', `/api/rooms/${c.code}/control`, { revision: 0, action: 'play' });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await request('POST', `/api/rooms/${c.code}/control`, {
    control_key: 'deadbeef'.repeat(6),
    revision: 0,
    action: 'play',
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.equal(g.json.revision, 0);
});

test('修订号：缺失/非法 400；过期 409 且不改房间', async () => {
  const v = await seedVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  let r = await ctrl({ action: 'play' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await ctrl({ revision: -1, action: 'play' });
  assert.equal(r.status, 400);

  r = await ctrl({ revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 1);

  // 旧修订号 0 已过期：409，房间保持播放、修订号仍为 1
  r = await ctrl({ revision: 0, action: 'pause' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, true);
  assert.equal(g.json.revision, 1);
});

test('非法动作/时码/速度：400 明确报错且不改房间', async () => {
  const v = await seedVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) =>
    request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, revision: c.revision, ...body });

  let r = await ctrl({ action: 'rewind' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /非法控制动作/);

  r = await ctrl({ action: 'seek', time: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /非法时码/);

  r = await ctrl({ action: 'seek', time: -0.5 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /非法时码/);

  r = await ctrl({ action: 'seek', time: 10.01 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /时码越界/);

  r = await ctrl({ action: 'speed', speed: 3 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /非法速度/);

  r = await ctrl({ action: 'speed', speed: 0.25 });
  assert.equal(r.status, 400);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.revision, 0);
  assert.equal(g.json.speed, 1);
});

test('播放由服务端按墙钟推算时码；暂停固化进度；速度改变斜率', async () => {
  const v = await seedVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  let r = await ctrl({ revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  const wall0 = r.json.server_wall;
  assert.ok(Math.abs(r.json.server_time - 0) < 1e-6);

  await sleep(300);
  let g = await request('GET', `/api/rooms/${c.code}`);
  const expected = (g.json.server_wall - wall0) * 1;
  assert.ok(Math.abs(g.json.time - expected) < 0.05, `time=${g.json.time} expected~${expected}`);
  assert.equal(g.json.playing, true);

  // 暂停：当前时码被固化，之后不再推进
  r = await ctrl({ revision: 1, action: 'pause' });
  const pausedAt = r.json.server_time;
  assert.ok(pausedAt > 0.2 && pausedAt < 1.5);
  await sleep(120);
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - pausedAt) < 1e-6);

  // 2 倍速：斜率变为 2
  r = await ctrl({ revision: 2, action: 'speed', speed: 2 });
  assert.equal(r.json.speed, 2);
  r = await ctrl({ revision: 3, action: 'play' });
  assert.equal(r.json.playing, true);
  const wall1 = r.json.server_wall;
  const t1 = r.json.server_time;
  await sleep(200);
  g = await request('GET', `/api/rooms/${c.code}`);
  const exp2 = t1 + (g.json.server_wall - wall1) * 2;
  assert.ok(Math.abs(g.json.time - exp2) < 0.05, `time=${g.json.time} exp2=${exp2}`);
});

test('到版本末尾自动停住：GET 惰性落库，时码不越界', async () => {
  await resetDraft();
  await request('POST', '/api/lights', { name: '短台灯' });
  const lights = JSON.parse(
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/lights' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
    })
  );
  const l1 = lights[0].id;
  // 短版本：末尾 0.05 秒
  await request('POST', '/api/cues', [
    { cue_no: 7001, light_id: l1, time: 0, target: 10, duration: 0.05 },
  ]);
  const v2 = (await request('POST', '/api/versions', { label: '短版' })).json;
  const c = (await createRoom(v2.id)).json;
  const ctrl = (body) => request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  let r = await ctrl({ revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  await sleep(300);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - g.json.duration) < 1e-6);
  assert.equal(g.json.time, g.json.duration);

  // 已落库：再查一次仍是暂停在末尾
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.equal(g.json.time, g.json.duration);

  // 停在末尾再播放：从头开始
  r = await ctrl({ revision: 1, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  assert.ok(Math.abs(r.json.server_time) < 1e-6);
});

test('跳转：暂停态锚住时码；播放态跳到新时码继续；跳到末尾停住', async () => {
  const v = await seedVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  let r = await ctrl({ revision: 0, action: 'seek', time: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, false);
  assert.ok(Math.abs(r.json.server_time - 5) < 1e-6);
  await sleep(100);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(Math.abs(g.json.time - 5) < 1e-6);

  // 播放后再跳转，保持播放并从新时码推进
  await ctrl({ revision: 1, action: 'play' });
  r = await ctrl({ revision: 2, action: 'seek', time: 2 });
  assert.equal(r.json.playing, true);
  const w = r.json.server_wall;
  await sleep(150);
  g = await request('GET', `/api/rooms/${c.code}`);
  const exp = 2 + (g.json.server_wall - w);
  assert.ok(Math.abs(g.json.time - exp) < 0.05, `time=${g.json.time} exp=${exp}`);

  // 跳到末尾：立即停住
  r = await ctrl({ revision: 3, action: 'seek', time: 10 });
  assert.equal(r.json.playing, false);
  assert.equal(r.json.server_time, 10);
});

test('速度设置：暂停态生效但不推进，恢复播放按新速度走', async () => {
  const v = await seedVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });

  await ctrl({ revision: 0, action: 'speed', speed: 0.5 });
  await sleep(100);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.speed, 0.5);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time) < 1e-6);

  const r = await ctrl({ revision: 1, action: 'play' });
  const w = r.json.server_wall;
  await sleep(200);
  g = await request('GET', `/api/rooms/${c.code}`);
  const exp = (g.json.server_wall - w) * 0.5;
  assert.ok(Math.abs(g.json.time - exp) < 0.05);
});

test('房间固定创建时版本：之后改草稿、发布新版本都不影响它', async () => {
  const v1 = await seedVersion();
  const c = (await createRoom(v1.id)).json;
  assert.equal(c.version.id, v1.id);

  // 改草稿（新增 Cue）并发布 v2
  const firstLight = (await request('GET', '/api/lights')).json[0].id;
  await request('POST', '/api/cues', { cue_no: 9001, light_id: firstLight, time: 20, target: 0, duration: 0 });
  const v2 = (await request('POST', '/api/versions', { label: '二版' })).json;
  assert.notEqual(v2.id, v1.id);

  const g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.version.id, v1.id);
  assert.equal(g.duration, 10); // 而非含 t=20 的新草稿
});

test('房间操作不改版本、草稿或调光记录', async () => {
  const v1 = await seedVersion();
  const cuesBefore = (await request('GET', '/api/cues')).json.length;
  const c = (await createRoom(v1.id)).json;
  const ctrl = (body) => request('POST', `/api/rooms/${c.code}/control`, { control_key: c.control_key, ...body });
  await ctrl({ revision: 0, action: 'play' });
  await ctrl({ revision: 1, action: 'pause' });
  await ctrl({ revision: 2, action: 'seek', time: 3 });
  await ctrl({ revision: 3, action: 'speed', speed: 2 });

  const snap = (await request('GET', `/api/versions/${v1.id}`)).json;
  assert.equal(snap.cues.length, 2);
  assert.equal((await request('GET', '/api/cues')).json.length, cuesBefore);
});

test('零时长版本（无 Cue）：房间可创建，播放报 400', async () => {
  // 新建一台没有任何 Cue 的灯再发布
  await resetDraft();
  await request('POST', '/api/lights', { name: `空台${Date.now()}` });
  const vz = (await request('POST', '/api/versions', { label: '空版' })).json;
  const c = (await createRoom(vz.id)).json;
  assert.equal(c.duration, 0);
  const r = await request('POST', `/api/rooms/${c.code}/control`, {
    control_key: c.control_key,
    revision: 0,
    action: 'play',
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /时长为 0/);
});

test('服务重启后房间进度可恢复（墙钟推算结果持久化在数据库）', async () => {
  // 直接再开一个指向同一 DB 文件的“重启”服务实例
  const { app: app2 } = require('../server.js'); // open() 单例：同一进程同一连接
  const s2 = http.createServer(app2);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const v = await seedVersion();
    const c = (await createRoom(v.id)).json;
    await request('POST', `/api/rooms/${c.code}/control`, {
      control_key: c.control_key,
      revision: 0,
      action: 'seek',
      time: 7,
    });
    const req2 = (method, p, body) =>
      new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const req = http.request(
          { host: '127.0.0.1', port: s2.address().port, path: p, method,
            headers: payload ? { 'Content-Type': 'application/json' } : {} },
          (res) => {
            let d = '';
            res.on('data', (x) => (d += x));
            res.on('end', () => resolve(JSON.parse(d || 'null')));
          }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    const g = await req2('GET', `/api/rooms/${c.code}`);
    assert.equal(g.code, c.code);
    assert.equal(g.playing, false);
    assert.ok(Math.abs(g.time - 7) < 1e-6);
    assert.equal(g.revision, 1);
    assert.equal(g.version.id, v.id);
  } finally {
    await new Promise((r) => s2.close(r));
  }
});
