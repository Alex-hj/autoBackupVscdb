// 职责：对 state.vscdb 做一致性快照，并决定新快照的去向（覆盖备份，或被保护拦截后另存为 .skipped），把结果以对象返回。
// 不负责：何时备份、在哪个线程执行、结果如何展示与记录日志。
'use strict';

const fs = require('node:fs');

const SKIPPED_SUFFIX = '.skipped';
// 退出时 Cursor 主进程可能仍在访问该库，给等待锁留一点时间；
// 整体仍需远小于扩展宿主给 deactivate 的 5 秒上限
const BUSY_TIMEOUT_MS = 2000;
// 新快照体积低于旧备份的这个比例，就视为库被重置或大幅缩水，不覆盖旧备份
const MIN_SIZE_RATIO = 0.5;

/**
 * 对数据库做一致性快照，并交给 publishSnapshot 决定去向。
 * 不直接复制文件：该库是 WAL 模式，最近写入的数据可能还在 -wal 中，只复制主文件会丢数据。
 * 本函数同步执行；启动备份由调用方放进后台线程运行它，避免大库卡住扩展宿主。
 * @param {string} srcPath 源数据库路径
 * @param {string} dstPath 备份文件路径，已存在则可能被覆盖
 * @returns {{status: 'ok', size: number} | {status: 'skipped', newSize: number, oldSize: number, percent: number, skippedPath: string}}
 *   ok：备份已更新；skipped：新快照过小，旧备份保持不变，新快照另存为 skippedPath。失败时抛出异常
 */
function snapshotDatabase(srcPath, dstPath) {
  // 延迟加载：node:sqlite 不可用时只影响本次备份，不让插件激活失败
  const { DatabaseSync } = require('node:sqlite');
  // 先写临时文件再改名：中途失败或被宿主超时终止时旧备份保持完好；
  // 带 pid 是为了多个窗口同时备份时互不冲突
  const tmpPath = `${dstPath}.${process.pid}.tmp`;
  const db = new DatabaseSync(srcPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.prepare('VACUUM INTO ?').run(tmpPath);
    return publishSnapshot(tmpPath, dstPath);
  } finally {
    db.close();
    fs.rmSync(tmpPath, { force: true });
  }
}

/**
 * 决定新快照的去向：正常则原子覆盖备份并清掉过期的 .skipped；
 * 比旧备份小得多则保持旧备份不变，新快照另存为 .skipped（固定文件名，下次被拦会覆盖它）。
 * 新旧都是 VACUUM INTO 的产物，体积可直接比较。
 * @param {string} tmpPath 刚生成的新快照（临时文件）
 * @param {string} dstPath 备份文件路径
 * @returns {object} 同 snapshotDatabase 的返回值
 */
function publishSnapshot(tmpPath, dstPath) {
  const skippedPath = `${dstPath}${SKIPPED_SUFFIX}`;
  const newSize = fs.statSync(tmpPath).size;
  const oldSize = fs.existsSync(dstPath) ? fs.statSync(dstPath).size : 0;
  if (newSize < oldSize * MIN_SIZE_RATIO) {
    fs.renameSync(tmpPath, skippedPath);
    // 向下取整：避免 49.6% 被四舍五入成 50%，与"低于 50% 才拦"的阈值自相矛盾
    const percent = Math.floor((newSize / oldSize) * 100);
    return { status: 'skipped', newSize, oldSize, percent, skippedPath };
  }
  fs.renameSync(tmpPath, dstPath);
  fs.rmSync(skippedPath, { force: true });
  return { status: 'ok', size: newSize };
}

module.exports = { snapshotDatabase };
