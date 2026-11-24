// 职责：「从备份还原」命令的引导流程：把备份复制成不会被备份流程覆盖的还原副本，打开所在目录，并弹出分步说明。
// 不负责：直接替换 state.vscdb（运行中的 Cursor 持有该库，在进程内覆盖会静默损坏数据库，必须等 Cursor 完全退出后由用户手动替换）、校验备份内容。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// 还原副本的后缀。备份流程只写 .bak 与 .bak.skipped，不会碰它；
// 而退出 Cursor 时 .bak 可能被当前的库覆盖，所以还原必须用这份副本
const RESTORE_SUFFIX = '.restore';

/**
 * 「从备份还原」命令入口：生成还原副本、打开所在目录、弹出还原步骤。失败时弹错误通知。
 * @param {string} sourcePath 数据库路径（state.vscdb），用于在说明里写出要处理的文件名
 * @param {string} backupPath 备份文件路径（state.vscdb.bak）
 * @returns {Promise<void>} 用户关掉说明对话框后兑现
 */
async function startGuidedRestore(sourcePath, backupPath) {
  if (!fs.existsSync(backupPath)) {
    vscode.window.showErrorMessage(`没有找到备份文件 ${path.basename(backupPath)}，无法还原。`);
    return;
  }
  let restorePath;
  try {
    restorePath = makeRestoreCopy(backupPath);
  } catch (err) {
    vscode.window.showErrorMessage(`生成还原副本失败：${err.message}`);
    return;
  }
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(restorePath));
  await showSteps(sourcePath, backupPath, restorePath);
}

/**
 * 把备份复制成还原副本，已有的旧副本直接覆盖。
 * 先复制到临时文件再改名，复制中途失败不会留下残缺的还原副本。
 * @param {string} backupPath 备份文件路径
 * @returns {string} 还原副本路径
 */
function makeRestoreCopy(backupPath) {
  const restorePath = `${backupPath}${RESTORE_SUFFIX}`;
  const tmpPath = `${restorePath}.tmp`;
  try {
    fs.copyFileSync(backupPath, tmpPath);
    fs.renameSync(tmpPath, restorePath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  return restorePath;
}

/**
 * 弹出模态对话框，写明 Cursor 完全退出后手动替换的四个步骤。
 * @param {string} sourcePath 数据库路径，其文件名及 -wal / -shm 伴生文件名写进步骤
 * @param {string} backupPath 备份文件路径
 * @param {string} restorePath 还原副本路径
 * @returns {Thenable<string | undefined>} 用户关掉对话框后兑现
 */
function showSteps(sourcePath, backupPath, restorePath) {
  const db = path.basename(sourcePath);
  const restoreName = path.basename(restorePath);
  const detail = [
    '请按顺序操作，替换必须在 Cursor 完全退出后进行：',
    '',
    `1. 完全退出 Cursor（关闭所有窗口）。退出时 ${path.basename(backupPath)} 仍会被更新，但还原副本不会被改动。`,
    `2. 在刚打开的目录里，把 ${db}、${db}-wal、${db}-shm 中存在的文件都移到别处（建议不要直接删除，万一还原错了还能找回）。`
      + '只要旧的 -wal 还在，还原后的库就会打不开或读到旧数据。',
    `3. 把 ${restoreName} 重命名为 ${db}。`,
    '4. 重新打开 Cursor。',
  ].join('\n');
  return vscode.window.showInformationMessage(`已生成还原副本 ${restoreName}，并打开了所在目录。`, { modal: true, detail });
}

module.exports = { startGuidedRestore };
