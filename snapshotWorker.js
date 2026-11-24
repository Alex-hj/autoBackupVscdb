// 职责：后台线程的入口，在线程里执行一次 snapshotDatabase，并把结果或错误消息回传给主线程。
// 不负责：创建线程、展示结果。
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { snapshotDatabase } = require('./snapshot');

try {
  parentPort.postMessage({ result: snapshotDatabase(workerData.srcPath, workerData.dstPath) });
} catch (err) {
  // 只回传错误消息文本，主线程据此重建 Error
  parentPort.postMessage({ error: err instanceof Error ? err.message : String(err) });
}
