// 职责：在扩展宿主启动完成与退出（Cursor 打开 / 关闭窗口、退出）时触发备份：启动时在后台线程备份并更新状态栏，退出时同步备份。
// 不负责：快照与覆盖保护的实现（见 snapshot.js）、状态栏与通知的展示（见 statusView.js）、定时或手动备份、保留多个历史版本、备份的还原。
'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { snapshotDatabase } = require('./snapshot');
const { StatusView } = require('./statusView');

const DB_FILE_NAME = 'state.vscdb';
const BACKUP_FILE_NAME = 'state.vscdb.bak';

let sourcePath = null;
let backupPath = null;
// 启动补备份的执行进度。backupInWorker 内部处理了所有异常，该 Promise 不会 reject
let startupBackup = Promise.resolve();

/**
 * 激活插件：推导 state.vscdb 与备份文件的路径，并在后台线程立即备份一次。
 * 立即备份是为了覆盖上次崩溃、被强制结束等没有触发关闭备份的情况；
 * 放在后台线程是为了库很大时不卡住扩展宿主。
 * @param {import('vscode').ExtensionContext} context 扩展上下文
 */
function activate(context) {
  // globalStorageUri 形如 <User>/globalStorage/<publisher.name>，其父目录即 state.vscdb 所在目录
  const storageDir = path.dirname(context.globalStorageUri.fsPath);
  sourcePath = path.join(storageDir, DB_FILE_NAME);
  backupPath = path.join(storageDir, BACKUP_FILE_NAME);
  const view = new StatusView(backupPath);
  context.subscriptions.push(view);
  startupBackup = backupInWorker(view);
}

/**
 * 停用插件：扩展宿主退出前同步备份一次。
 * 先等启动补备份结束：宿主退出会直接杀掉仍在运行的后台线程并留下临时文件，
 * 而线程与主线程共用 pid，两次快照同时进行还会写同一个临时文件。
 * @returns {Promise<void>} 备份结束后兑现，宿主会等待它（上限 5 秒）
 */
async function deactivate() {
  if (!sourcePath) {
    return;
  }
  await startupBackup;
  backupSync();
}

/**
 * 在后台线程里备份一次，并把结果交给状态视图展示。全程不抛异常。
 * @param {StatusView} view 状态视图
 * @returns {Promise<void>} 备份与展示结束后兑现
 */
async function backupInWorker(view) {
  try {
    const result = await runSnapshotInWorker(sourcePath, backupPath);
    logResult(result);
    view.showResult(result);
  } catch (err) {
    console.error(`[autoBackupVscdb] 备份失败: ${err.message}`);
    view.showFailure(err);
  }
}

/**
 * 在当前线程同步备份一次，失败只写日志、不抛异常。
 * 退出时不能依赖后续的事件循环，所以必须同步完成；此时窗口正在销毁，不更新状态栏。
 */
function backupSync() {
  try {
    logResult(snapshotDatabase(sourcePath, backupPath));
  } catch (err) {
    console.error(`[autoBackupVscdb] 备份失败: ${err.message}`);
  }
}

/**
 * 启动后台线程执行一次快照。
 * @param {string} srcPath 源数据库路径
 * @param {string} dstPath 备份文件路径
 * @returns {Promise<object>} 兑现为 snapshotDatabase 的返回值；快照失败或线程异常退出时 reject
 */
function runSnapshotInWorker(srcPath, dstPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'snapshotWorker.js'), { workerData: { srcPath, dstPath } });
    worker.once('message', (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)));
    worker.once('error', reject);
    // 线程在回传结果前就退出（被终止、崩溃）时兜底；已回传结果则这里的 reject 无效
    worker.once('exit', (code) => reject(new Error(`备份线程异常退出，退出码 ${code}`)));
  });
}

/**
 * 把备份结果写入扩展宿主日志；只有被保护拦截时才有内容需要记录。
 * @param {{status: string, newSize?: number, oldSize?: number, percent?: number, skippedPath?: string}} result snapshotDatabase 的返回值
 */
function logResult(result) {
  if (result.status !== 'skipped') {
    return;
  }
  console.warn(`[autoBackupVscdb] 新快照(${result.newSize} 字节)仅为旧备份(${result.oldSize} 字节)的 ${result.percent}%，`
    + `低于保护阈值，旧备份保持不变，新快照另存为 ${result.skippedPath}`);
}

module.exports = { activate, deactivate };
