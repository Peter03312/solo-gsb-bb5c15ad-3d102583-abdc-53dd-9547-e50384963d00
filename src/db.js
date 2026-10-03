'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lights (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL,
  circuit_id INTEGER,                       -- 所属回路；NULL = 未分配（不计入任何回路负载）
  watts      REAL                           -- 正数额定瓦数；仅分配回路时填写
);

CREATE TABLE IF NOT EXISTS cues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cue_no     INTEGER NOT NULL,
  light_id   INTEGER NOT NULL REFERENCES lights(id),
  time       REAL NOT NULL CHECK (time >= 0),
  target     REAL NOT NULL CHECK (target >= 0 AND target <= 100),
  duration   REAL NOT NULL CHECK (duration >= 0),
  UNIQUE (cue_no)
);

CREATE INDEX IF NOT EXISTS idx_cues_time ON cues (time, cue_no);
CREATE INDEX IF NOT EXISTS idx_cues_light ON cues (light_id);

-- 灯光回路（草稿）：正数容量（瓦）。灯具经 lights.circuit_id 归属回路
CREATE TABLE IF NOT EXISTS circuits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  capacity   REAL NOT NULL CHECK (capacity > 0),
  created_at REAL NOT NULL
);

-- 已发布的不可变演出版本
CREATE TABLE IF NOT EXISTS versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  created_at REAL NOT NULL,
  cue_count  INTEGER NOT NULL DEFAULT 0
);

-- 版本快照：发布时灯具与 Cue 的完整冻结副本
CREATE TABLE IF NOT EXISTS version_lights (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  light_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  pos        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS version_cues (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  cue_no     INTEGER NOT NULL,
  light_id   INTEGER NOT NULL,
  time       REAL NOT NULL,
  target     REAL NOT NULL,
  duration   REAL NOT NULL,
  pos        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_version_cues ON version_cues (version_id, time, cue_no);

-- 版本快照中的回路（早期版本可能无回路配置：该版负载恒为空）
CREATE TABLE IF NOT EXISTS version_circuits (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  circuit_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  capacity   REAL NOT NULL,
  pos        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS version_light_wiring (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  light_id   INTEGER NOT NULL,
  circuit_id INTEGER,                       -- 发布时所属回路；NULL = 未分配
  watts      REAL                           -- 发布时正数额定瓦数
);

CREATE INDEX IF NOT EXISTS idx_version_circuits ON version_circuits (version_id, pos);
CREATE INDEX IF NOT EXISTS idx_version_wiring ON version_light_wiring (version_id, light_id);

-- 临时调光记录：针对已发布版本建立，绑定版本快照，独立于草稿
CREATE TABLE IF NOT EXISTS rehearsal_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  label      TEXT NOT NULL,
  created_at REAL NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 0  -- 操作序列修订号：成功追加次数，过期提交按它判冲突
);

-- 记录中的操作序列（按 seq 追加顺序；同秒操作也按 seq 顺序生效）
CREATE TABLE IF NOT EXISTS record_ops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  INTEGER NOT NULL REFERENCES rehearsal_records(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  light_id   INTEGER NOT NULL,
  time       REAL NOT NULL CHECK (time >= 0),
  op_type    TEXT NOT NULL CHECK (op_type IN ('override', 'return')),
  target     REAL,                       -- 仅 override 需要：0～100 目标亮度
  duration   REAL NOT NULL CHECK (duration >= 0),
  UNIQUE (record_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_record_ops ON record_ops (record_id, seq);

-- 草稿合并预览令牌：预览不写库，提交时凭令牌校验抉择并确认草稿未被改动
CREATE TABLE IF NOT EXISTS merge_previews (
  token        TEXT PRIMARY KEY,
  base_id      INTEGER NOT NULL REFERENCES versions(id),
  incoming_id  INTEGER NOT NULL REFERENCES versions(id),
  -- 生成预览时草稿内容（灯具/回路/Cue/接线）的版本戳；提交时须与当前一致
  draft_stamp  TEXT NOT NULL,
  -- 预览给出的自动改动与冲突（JSON），提交时复核抉择只能引用其中的冲突项
  payload      TEXT NOT NULL,
  created_at   REAL NOT NULL
);

-- 共享房间：基于一个已发布版本创建，创建者持控制密钥，其他人凭房间码观看同一舞台。
-- 房间固定所选版本（version_id 指向不可变快照）；保存播放/暂停、基准时码与基准墙钟、
-- 速度与修订号。服务端按 (time + (now - anchor_wall)*speed) 推算当前时码，
-- 到 duration 自动停住（惰性落库）；页面刷新、服务重启、观看者重连后均可据此恢复进度。
CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,          -- 房间码（6 位大写字母数字，去除易混字符）
  version_id  INTEGER NOT NULL REFERENCES versions(id), -- 房间固定的已发布版本
  control_key TEXT NOT NULL,                 -- 控制密钥（仅创建时返回一次）
  label       TEXT NOT NULL,
  playing     INTEGER NOT NULL DEFAULT 0,    -- 1 播放中 / 0 暂停或停在末尾
  time        REAL NOT NULL DEFAULT 0,       -- 基准时码（最近一次控制时的演出秒数）
  anchor_wall REAL NOT NULL,                 -- 基准墙钟（Date.now()/1000，播放按它推算）
  speed       REAL NOT NULL DEFAULT 1,       -- 仅允许 0.5 / 1 / 2
  duration    REAL NOT NULL,                 -- 创建时按版本快照算出的末尾时刻（一并冻结）
  revision    INTEGER NOT NULL DEFAULT 0,   -- 控制修订号：每次成功控制 +1，过期提交 409
  -- 回路超载保护：创建时可选启用；启用后只按固定版本快照内的回路容量与灯具接线判定
  -- （1 启用 / 0 未启用，未启用的房间完全沿用原行为）
  overload_protection INTEGER NOT NULL DEFAULT 0,
  -- 保护/停点自动暂停时固化的触发回路（快照回路编号）与触发时码；非保护触发状态为 NULL。
  -- 惰性落库与末尾停住一样不增加控制修订号；服务重启后据此恢复保护状态。
  tripped_circuit_id INTEGER,
  tripped_time       REAL,
  -- 讨论停点自动暂停时固化的触发时码；tripped_reason 区分自动暂停原因
  -- （'overload_boundary' 超载边界 / 'stop_point' 讨论停点），非自动暂停状态为 NULL。
  tripped_stop_time  REAL,
  tripped_reason     TEXT,
  created_at  REAL NOT NULL
);

-- 主持权交接凭证：当前持密钥者凭当前控制密钥与房间修订号发起，取得仅显示一次、
-- 五分钟有效的一次性交接凭证。同一房间同时只保留一份待领取凭证（以 room_id 为
-- 主键，再次发起 UPSERT 即覆盖旧凭证——旧凭证随即失效）。接班人凭房间码与凭证
-- 领取新的控制密钥：领取与房间修订号 +1 在同一事务内原子完成，旧密钥即刻失效。
-- 凭证发出后若原主持人成功控制房间（修订号前进），凭证的 revision 即过期，
-- 接班人领取时按“过期修订号”409 拒绝且控制权不变；凭证到达 expires_at 后同样
-- 拒绝（房间 GET 只报告 active 状态，不回显凭证本身或任何控制密钥）。
CREATE TABLE IF NOT EXISTS room_handovers (
  room_id    INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,                  -- 一次性交接凭证（仅发起响应中完整返回一次）
  revision   INTEGER NOT NULL,               -- 发起时房间修订号：领取时必须仍与房间修订号一致
  expires_at REAL NOT NULL,                  -- 墙钟秒：Date.now()/1000 + 300（五分钟有效）
  created_at REAL NOT NULL
);

-- 共享房间循环排演编排：主持人按房间固定版本提交 1～8 段循环；提交成功后从首段
-- 开始播放（rooms.playing=1）。编排的推进完全由 rooms 的基准时码 + 基准墙钟 +
-- 速度驱动（与普通房间同一套墙钟推算），本表只保存“逻辑进度”：当前段、本段
-- 已完成轮次与当前段内时码；段尾跳回/跳段是瞬时跳转、不耗墙钟。
-- 行不存在（含从未编排、手动跳转取消、编排走完后）= 未编排房间，沿用原行为。
-- 手动跳转（seek）删除本行并沿用原房间控制语义；编排全部走完把 finished 置 1
-- （停在末段终点；此时播放会从首段重新开始整次编排）。
CREATE TABLE IF NOT EXISTS room_programs (
  room_id    INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  segments   TEXT NOT NULL,                  -- JSON：[{start,end,repeat}]，1～8 段，提交时校验
  seg_index  INTEGER NOT NULL DEFAULT 0,     -- 当前段（0 基）
  iteration  INTEGER NOT NULL DEFAULT 0,     -- 当前段已完成的重复轮次（0 基）
  prog_time  REAL NOT NULL DEFAULT 0,        -- 当前段内（或段起点）演出时码
  finished   INTEGER NOT NULL DEFAULT 0      -- 1 = 整次编排已全部走完，停在末段终点
);

-- 共享房间讨论停点：主持人凭控制密钥与房间修订号原子替换整组停点。
-- times 为 JSON 数字数组（互不重复的非负演出时码，均不超过房间固定版本末尾，
-- 提交时已排序校验）；行不存在（含从未设置、空组清除）= 无停点房间，沿用原行为。
-- 播放按服务端墙钟连续向上经过任一停点时自动暂停并显示原因（惰性落库、不加修订号）。
-- 行只保存配置；自动暂停状态固化在 rooms.tripped_stop_time / tripped_reason。
CREATE TABLE IF NOT EXISTS room_stops (
  room_id    INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  times      TEXT NOT NULL                   -- JSON：[time,...]，非空数组（空组直接删行）
);
`;

let db;

// 既有库的轻量迁移：早期 lights 表没有回路字段，按需补列（新库由建表语句直接包含）
function migrate(database) {
  const cols = database.prepare('PRAGMA table_info(lights)').all().map((c) => c.name);
  if (!cols.includes('circuit_id')) {
    database.exec('ALTER TABLE lights ADD COLUMN circuit_id INTEGER');
  }
  if (!cols.includes('watts')) {
    database.exec('ALTER TABLE lights ADD COLUMN watts REAL');
  }

  // 共享房间超载保护：旧库补列（未启用保护的既有房间默认沿用原行为）
  const roomCols = database.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
  if (roomCols.length > 0) {
    if (!roomCols.includes('overload_protection')) {
      database.exec('ALTER TABLE rooms ADD COLUMN overload_protection INTEGER NOT NULL DEFAULT 0');
    }
    if (!roomCols.includes('tripped_circuit_id')) {
      database.exec('ALTER TABLE rooms ADD COLUMN tripped_circuit_id INTEGER');
    }
    if (!roomCols.includes('tripped_time')) {
      database.exec('ALTER TABLE rooms ADD COLUMN tripped_time REAL');
    }
    if (!roomCols.includes('tripped_stop_time')) {
      database.exec('ALTER TABLE rooms ADD COLUMN tripped_stop_time REAL');
    }
    if (!roomCols.includes('tripped_reason')) {
      database.exec('ALTER TABLE rooms ADD COLUMN tripped_reason TEXT');
    }
  }
}

function open(dbPath) {
  if (db) return db;
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function get() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

module.exports = { open, get };
