// 职责：用状态栏常驻显示最近一次启动备份的结果；备份被保护拦截或失败时，再弹出通知。
// 不负责：备份本身、备份何时触发、关闭窗口时的备份结果（此时窗口正在销毁，无处展示）。
'use strict';

const path = require('node:path');
const vscode = require('vscode');

const STATUS_ITEM_ID = 'autoBackupVscdb.status';
const BYTES_PER_MB = 1024 * 1024;

/**
 * 把字节数格式化为 MB 文本，如 "10.1 MB"。
 * @param {number} bytes 字节数
 * @returns {string} MB 文本
 */
function toMb(bytes) {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

class StatusView {
  /**
   * 创建状态栏项并立即显示"备份中"；备份结束后由 showResult / showFailure 更新。
   * 状态栏项带固定 id，用户可在状态栏右键菜单里自行隐藏它。
   * @param {string} backupPath 备份文件路径，用于悬停提示
   */
  constructor(backupPath) {
    this.backupPath = backupPath;
    this.item = vscode.window.createStatusBarItem(STATUS_ITEM_ID, vscode.StatusBarAlignment.Right, 0);
    this.item.name = 'Cursor 状态库备份';
    this.item.text = '$(sync~spin) 状态库备份中';
    this.item.tooltip = '正在备份 Cursor 状态库 state.vscdb';
    this.item.show();
  }

  /**
   * 展示一次备份的结果：成功只更新状态栏，被保护拦截时再弹警告通知。
   * @param {{status: string}} result snapshotDatabase 的返回值
   */
  showResult(result) {
    if (result.status === 'ok') {
      this.showOk(result);
    } else {
      this.showSkipped(result);
    }
  }

  /**
   * 状态栏显示"备份 HH:mm"，悬停提示给出完整时间、大小与备份文件路径。
   * @param {{size: number}} result 备份成功的结果
   */
  showOk(result) {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    this.item.text = `$(database) 备份 ${time}`;
    this.item.tooltip = `最近一次备份成功\n时间：${now.toLocaleString('zh-CN', { hourCycle: 'h23' })}\n`
      + `大小：${toMb(result.size)}\n文件：${this.backupPath}`;
  }

  /**
   * 状态栏变为警告色并弹出警告通知，说明旧备份保持不变、新快照另存到了哪里。
   * @param {{newSize: number, oldSize: number, percent: number, skippedPath: string}} result 被拦截的结果
   */
  showSkipped(result) {
    const message = `Cursor 状态库备份已被拦截：新快照 ${toMb(result.newSize)}，`
      + `仅为旧备份 ${toMb(result.oldSize)} 的 ${result.percent}%。`
      + `旧备份保持不变，新快照已另存为 ${path.basename(result.skippedPath)}。`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.text = '$(warning) 备份被拦截';
    this.item.tooltip = `${message}\n确认是正常清理的话，删除旧的 ${path.basename(this.backupPath)} 即可接受新的基线。`;
    vscode.window.showWarningMessage(message);
  }

  /**
   * 状态栏变为错误色并弹出错误通知。
   * @param {Error} err 备份失败的原因
   */
  showFailure(err) {
    const message = `Cursor 状态库备份失败：${err.message}`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.item.text = '$(error) 备份失败';
    this.item.tooltip = message;
    vscode.window.showErrorMessage(message);
  }

  /**
   * 释放状态栏项，随扩展停用一并调用。
   */
  dispose() {
    this.item.dispose();
  }
}

module.exports = { StatusView };
