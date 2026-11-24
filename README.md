# Cursor 状态库自动备份

在 Cursor 启动完成和关闭时，自动备份它的状态库 `state.vscdb`（配置、聊天记录等都存放在这个 SQLite 数据库里）。备份始终只有一份，文件名固定，新备份覆盖旧备份，没有日期后缀。

## 功能

- **启动时补备份**：窗口启动完成后在后台线程备份一次，覆盖上次崩溃或被强制结束、没来得及做退出备份的情况，不会卡住窗口启动。
- **退出时备份**：关闭窗口或退出 Cursor 时同步备份一次。
- **只留一份**：备份固定为同目录下的 `state.vscdb.bak`。先写临时文件、再原子改名，备份中途失败不会损坏已有的备份。
- **覆盖前保护**：新快照不足旧备份的 50% 时（例如库被重置、清空）不覆盖旧备份，新快照另存为 `state.vscdb.bak.skipped`，同时弹出警告。确认是正常清理的话，删除旧的 `state.vscdb.bak` 即可接受新基线；之后一次正常的备份会自动清掉 `.skipped`。
- **状态栏显示**：右下角常驻显示最近一次结果：`备份 HH:mm`、`备份被拦截`、`备份失败`；被拦截或失败时额外弹出通知。
- **立即备份**：命令面板执行 `Cursor 状态库备份：立即备份`，成功时弹出提示。
- **从备份还原**：命令面板执行 `Cursor 状态库备份：从备份还原`，流程见下文。
- **多窗口、多个 Cursor 同时运行不冲突**：每个进程使用各自的临时文件，最后原子改名。

## 文件位置

备份与 `state.vscdb` 在同一个目录，路径由扩展宿主提供的 `globalStorageUri` 推导，不写死。Windows 上是：

```
%APPDATA%\Cursor\User\globalStorage\
```

| 文件 | 说明 |
| --- | --- |
| `state.vscdb.bak` | 最新备份 |
| `state.vscdb.bak.skipped` | 被覆盖前保护拦下的新快照，仅在被拦截时存在 |
| `state.vscdb.bak.restore` | 还原副本，仅在执行过「从备份还原」且尚未用掉时存在 |

## 备份是怎么做的

Cursor 的状态库使用 SQLite 的 WAL 模式，最新写入的数据可能还在 `state.vscdb-wal` 里。只复制 `state.vscdb` 一个文件会丢掉这部分数据，所以这里用 `VACUUM INTO` 生成一份一致的快照：

- 以只读方式打开源库，并设置 2 秒的忙等待。
- 快照是整理压缩过的单文件，不带 `-wal` / `-shm`，所以比原库小是正常的。
- 依赖 Node 内置的 `node:sqlite`，没有第三方依赖。

## 还原

运行中的 Cursor 持有着状态库，从外部覆盖它不会报错，但会悄悄把数据库弄坏；旧的 `-wal` / `-shm` 残留还会让还原后的库打不开，或读到旧数据。所以还原必须在 Cursor 完全退出后进行，命令只负责准备并引导：

1. 执行 `Cursor 状态库备份：从备份还原`。扩展把备份复制成 `state.vscdb.bak.restore`，打开所在目录，并弹出步骤说明。
2. 完全退出 Cursor（关闭所有窗口）。
3. 把 `state.vscdb`、`state.vscdb-wal`、`state.vscdb-shm` 中存在的文件都移到别处（建议不要直接删除）。
4. 把 `state.vscdb.bak.restore` 重命名为 `state.vscdb`。
5. 重新打开 Cursor。

为什么要单独复制一份，而不是直接用 `state.vscdb.bak`：退出 Cursor 时退出备份仍会运行，可能把 `state.vscdb.bak` 覆盖成当前（可能已经有问题的）库，而覆盖前保护只拦得住缩水到 50% 以下的情况。还原副本不会被任何备份流程改动。

放弃还原而遗留的副本，创建超过 7 天后会在下次启动时自动清理（按创建时间判断）。

## 安装

目前没有发布到扩展市场，从 VSIX 安装：

```powershell
# 在项目根目录打包（需要 Node.js，无需 npm install）
npx --yes @vscode/vsce package --allow-missing-repository --skip-license

# 安装到 Cursor，然后执行「Developer: Reload Window」
cursor --install-extension auto-backup-vscdb-<版本>.vsix
```

也可以在扩展面板右上角的 `...` 菜单里选择「从 VSIX 安装...」。

## 环境

- 在 Cursor 3.25.6（VS Code 1.128.0，内置 Node.js 24.18.1）上开发并验证，更早的版本未测试。
- 仅在 Windows 上验证过。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `extension.js` | 扩展入口：启动与退出时触发备份，注册命令，后台备份排队执行 |
| `snapshot.js` | 快照与覆盖前保护 |
| `snapshotWorker.js` | 后台线程入口，调用 `snapshot.js` |
| `statusView.js` | 状态栏与通知 |
| `restoreGuide.js` | 还原引导与遗留副本清理 |

## 已知限制

- 只保留一份备份，不是历史版本，无法回到更早的状态。
- 进程被强制结束时不会触发退出备份，要等下次启动时的补备份。
- 保护阈值（50%）和清理期限（7 天）是固定值，没有设置项。
