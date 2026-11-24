// 职责：「从备份还原」命令的引导流程：把备份复制成不会被备份流程覆盖的还原副本（已有副本时沿用，用户明确要求才重新生成），打开所在目录，并弹出分步说明；以及清理放弃还原后遗留的过期副本。
// 不负责：直接替换 state.vscdb（运行中的 Cursor 持有该库，在进程内覆盖会静默损坏数据库，必须等 Cursor 完全退出后由用户手动替换）、校验备份内容。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// 还原副本的后缀。备份流程只写 .bak 与 .bak.skipped，不会碰它；
// 而退出 Cursor 时 .bak 可能被当前的库覆盖，所以还原必须用这份副本
const RESTORE_SUFFIX = '.restore';
// 还原副本的保留期限。说明对话框会随 Cursor 退出消失，用户退出后重开窗口再看一遍是正常操作，
// 所以不能一启动就删，超过这个期限才视为放弃还原
const STALE_RESTORE_MS = 7 * 24 * 60 * 60 * 1000;
// 已有还原副本时，步骤对话框上用于“覆盖重做”的按钮文字
const REGENERATE_LABEL = '用最新备份重新生成';

/**
 * 「从备份还原」命令入口：打开还原副本所在目录并弹出还原步骤，失败时弹错误通知。
 * 已有还原副本（上次还原后尚未用掉）时沿用它而不覆盖：用户退出 Cursor 时 .bak 可能已被有问题的库顶替，
 * 此时再生成副本会丢掉原本想恢复的内容；只有用户在对话框上明确选择重新生成才覆盖。
 * @param {string} sourcePath 数据库路径（state.vscdb），用于在说明里写出要处理的文件名
 * @param {string} backupPath 备份文件路径（state.vscdb.bak）
 * @returns {Promise<void>} 用户关掉说明对话框后兑现
 */
async function startGuidedRestore(sourcePath, backupPath) {
  const restorePath = `${backupPath}${RESTORE_SUFFIX}`;
  if (fs.existsSync(restorePath)) {
    await guideRestore(sourcePath, backupPath, restorePath, true);
    return;
  }
  await generateAndGuide(sourcePath, backupPath, restorePath);
}

/**
 * 用当前备份生成（或覆盖）还原副本，再引导用户还原。备份不存在或复制失败时弹错误通知并结束。
 * @param {string} sourcePath 数据库路径
 * @param {string} backupPath 备份文件路径
 * @param {string} restorePath 还原副本路径
 * @returns {Promise<void>} 用户关掉说明对话框后兑现
 */
async function generateAndGuide(sourcePath, backupPath, restorePath) {
  if (!fs.existsSync(backupPath)) {
    vscode.window.showErrorMessage(`没有找到备份文件 ${path.basename(backupPath)}，无法还原。`);
    return;
  }
  try {
    makeRestoreCopy(backupPath, restorePath);
  } catch (err) {
    vscode.window.showErrorMessage(`生成还原副本失败：${err.message}`);
    return;
  }
  await guideRestore(sourcePath, backupPath, restorePath, false);
}

/**
 * 打开还原副本所在目录并弹出步骤；沿用已有副本时，用户可在对话框上选择重新生成。
 * @param {string} sourcePath 数据库路径
 * @param {string} backupPath 备份文件路径
 * @param {string} restorePath 还原副本路径
 * @param {boolean} reused 是否沿用了已有副本（true 时对话框带“重新生成”按钮）
 * @returns {Promise<void>} 用户关掉说明对话框后兑现
 */
async function guideRestore(sourcePath, backupPath, restorePath, reused) {
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(restorePath));
  const picked = await showSteps(sourcePath, backupPath, restorePath, reused);
  if (picked === REGENERATE_LABEL) {
    await generateAndGuide(sourcePath, backupPath, restorePath);
  }
}

/**
 * 删除创建超过 7 天的遗留还原副本（用户放弃还原后留下的）。失败只写日志、不抛异常。
 * 按创建时间而不是修改时间判断：复制会保留源文件的修改时间，创建时间才是副本生成的时刻（已实测）。
 * 取不到创建时间（为 0）时不删，宁可多留一份副本。
 * @param {string} backupPath 备份文件路径（state.vscdb.bak），还原副本与它同目录
 */
function removeStaleRestoreCopy(backupPath) {
  const restorePath = `${backupPath}${RESTORE_SUFFIX}`;
  try {
    const { birthtimeMs } = fs.statSync(restorePath);
    if (birthtimeMs > 0 && Date.now() - birthtimeMs > STALE_RESTORE_MS) {
      fs.rmSync(restorePath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[autoBackupVscdb] 清理遗留还原副本失败: ${err.message}`);
    }
  }
}

/**
 * 把备份复制成还原副本，已有的旧副本直接覆盖。
 * 先复制到临时文件再改名，复制中途失败不会留下残缺的还原副本。
 * @param {string} backupPath 备份文件路径
 * @param {string} restorePath 还原副本路径
 */
function makeRestoreCopy(backupPath, restorePath) {
  const tmpPath = `${restorePath}.tmp`;
  try {
    fs.copyFileSync(backupPath, tmpPath);
    fs.renameSync(tmpPath, restorePath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

/**
 * 弹出模态对话框，写明 Cursor 完全退出后手动替换的四个步骤。
 * 沿用已有副本时，标题说明副本内容取自哪个时刻的备份（复制会保留源文件的修改时间），并附带“重新生成”按钮。
 * @param {string} sourcePath 数据库路径，其文件名及 -wal / -shm 伴生文件名写进步骤
 * @param {string} backupPath 备份文件路径
 * @param {string} restorePath 还原副本路径
 * @param {boolean} reused 是否沿用了已有副本
 * @returns {Thenable<string | undefined>} 用户关掉对话框后兑现被点击的按钮文字，点“取消”或关闭则为 undefined
 */
function showSteps(sourcePath, backupPath, restorePath, reused) {
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
  const message = reused ? describeReusedCopy(restorePath) : `已生成还原副本 ${restoreName}，并打开了所在目录。`;
  const buttons = reused ? [REGENERATE_LABEL] : [];
  return vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons);
}

/**
 * 生成“沿用已有还原副本”的对话框标题，让用户判断它是不是自己想恢复的那份。
 * @param {string} restorePath 还原副本路径
 * @returns {string} 标题文本
 */
function describeReusedCopy(restorePath) {
  const time = fs.statSync(restorePath).mtime.toLocaleString('zh-CN', { hourCycle: 'h23' });
  return `已存在还原副本 ${path.basename(restorePath)}（内容取自 ${time} 的备份），已沿用，没有用当前备份覆盖它，并打开了所在目录。`
    + `如果它不是你想恢复的内容，点“${REGENERATE_LABEL}”。`;
}

module.exports = { startGuidedRestore, removeStaleRestoreCopy };
