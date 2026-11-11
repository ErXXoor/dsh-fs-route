# dsh-fs-route：按工作区路由执行世界的 DSH 插件

面向：想知道"为什么自带 SSH 插件不行、这个插件怎么解决"的人。
状态：**核心功能已验证通过（20/20 确定性用例）**，尚未装入日常 profile。

---

## 1. 它解决什么问题

DSH 的 `ctx.fs` 与 `ctx.subprocess` 是**单槽服务**（一个 context 只能有一个 provider）。
官方与社区的所有 SSH 插件都只能**整体替换**执行世界，于是：

- 装了 SSH 插件 → 所有会话都搬到远端 → 本地工作区全部报
  `working-directory: directory does not exist: "C:\..."`
- 不装 → 远端工作区无从谈起

`dsh-fs-route` 保留一个槽位，改为**按操作路由**：

| 调用形态 | 落到哪里 |
|---|---|
| 本地路径（`C:\…`、相对路径） | 真实本地文件系统 / 本地进程 |
| `ssh://<alias>/<abs path>` | 该主机的 SFTP / SSH exec |

因此**同一个会话可以既读本地文件，又在服务器上跑命令**——这是之前所有方案都做不到的。

---

## 2. 设计

两个 provider 都**继承**自官方本地实现（而不是包装或重写）：

```js
class RoutedFileSystem extends LocalFileSystem { … }        // 非路由操作 = super.*
class RoutedSubprocessRuntime extends LocalSubprocessRuntime { … }
```

这与官方 `dsh-fs-sandbox extends dsh-fs-local` 是同一套装饰器思路。好处是本地语义
（realpath 身份、原子写入、stale guard、平台沙箱探测、进程树清理）**原封不动**是官方的实现。

路由信息编码进不透明的 `FsTargetKey`（契约明确允许："a remote backend might use a
workspace URI or file id"），格式为 `<alias>\0<path>`，本地路由 alias 为空串。

### 文件布局

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口，挂载两个 provider |
| `lib/route.js` | 路由解析、key 编解码、POSIX 路径拼接 |
| `lib/ssh.js` | ssh2 连接池（每 alias 一条长连接）、SFTP/exec 原语、引号 |
| `lib/fs.js` | 路由文件系统 provider（16 个契约方法） |
| `lib/subprocess.js` | 路由子进程 provider（spawn / terminal / resolveExecutable） |
| `lib/patch.js` | 远端文件的 unified-hunk 应用 |

---

## 3. 开发中踩到的真实坑（都已修复）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `ctx.fs` 在 context 里能用，内核里却 pending | `LocalFileSystem` 要求**已解析**的 config：构造器断言 `diffBasisMaxBytes` 是正整数，从不自己补默认值（那是 Schemastery 在挂载时做的） | 构造前显式过一遍 `LocalFileSystem.Config(...)` |
| 2 | `Receiver must be an instance of class RoutedSubprocessRuntime` | ES **私有方法**（`#spawnRemote`）经 Cordis 的服务 Proxy 调用时 brand check 失败 | 私有方法改为下划线普通方法（私有**字段**不受影响，但非 Service 类里才安全） |
| 3 | `bash -c exit 42` 返回 0 | `-c` 的脚本被当作裸 shell 词，`exit` 成了命令名、`42` 成了 `$0` | 脚本参数用双引号包裹（保持单参数，同时允许内层展开 glob） |
| 4 | `ls *.py` 得到 `*.py` 字面量 | 早期实现把脚本整体单引号包裹，冻结了通配符 | 同 #3 |
| 5 | `resolveExecutable('bash')` 在 Windows 直接抛错，整条 bash 链崩掉 | bash executor 在 spawn **之前**就预检可执行文件，而该 seam 不带 cwd | 本地解析失败时回退到远端 `command -v`；仍失败则返回裸名交给远端 shell 决定 |
| 6 | 内核里 `ssh://` 路由不生效，报 `spawn bash ENOENT` | 工具层 `resolveWorkdir()` 用 `path.isAbsolute('ssh://…')` 判断，**Windows 上返回 false**，于是把 `ssh://gpu/…` 当相对路径拼到 session cwd 后面，变成 `C:\…\workspace\ssh://gpu/…` | 两个 provider 的 `route()`/`routeOf()` 都会在字符串中部查找 `ssh://` 并还原路由 |
| 7 | `writeText` 在远端失败 "Failure" | SFTP 的 `rename` 并非在所有服务端都覆盖已存在文件 | 先 `unlink` 目标再 `rename`（临时文件仍保证读者不会看到半成品） |
| 8 | 远端命令的 `pwd` 显示 `/home/user` 而非配置的 cwd | ssh2 的 `exec(cmd, {cwd})` 起点目录不被所有服务端尊重 | 改为显式 `cd '<path>' && <command>` |

---

## 4. 验证结果

确定性套件（不经过模型，直接驱动挂载后的服务），**20/20 通过**：

```
PASS  fs local read                     PASS  fs remote write (create)
PASS  fs local processPath              PASS  fs remote edit  "alpha\nBETA\n"
PASS  fs remote stat  size=13959        PASS  fs remote read-after-edit
PASS  fs remote read                    PASS  fs remote edit miss throws  FS_EDIT_NOT_FOUND
PASS  fs remote processPath is POSIX    PASS  fs remote delete
PASS  fs remote listDir  20 entries     PASS  subprocess remote identity
PASS  fs contains remote                PASS  subprocess remote exit 0
PASS  fs contains cross-world false     PASS  subprocess remote glob  11 py files
PASS  subprocess remote rg              PASS  subprocess remote exit code  42
PASS  subprocess remote exit 3          PASS  subprocess recovers displaced route
```

内核端到端（真实 `dsh headless` + 模型 + 工具）也已跑通：

```
调用 bash 工具，workdir = ssh://gpu/home/user/code/preprocess
→ 输出：/home/user/code/preprocess
        remote-host
        user
```

同一回合内读本地 `package.json` 与读远端 `sam2_compare.py` 也各自正确。

---

## 5. 已知限制

- **远端 PTY 未实现**：`spawnTerminal` 对 `ssh://` 直接报"不支持"。持久终端暂不可用。
- **远端 watch 不支持**：SFTP 没有 inotify，按契约显式抛 `FS_IO_ERROR`。
- **远端沙箱不强制**：`sandboxMode` 返回 `undefined`，远端写入不受 `workspace-safe` 围栏约束。
  需要约束时应在远端用文件权限或容器实现。
- **远端 `patchText` 是简化实现**：对顺序、单文件 hunk 正确，复杂的模糊匹配不如本地后端。
- **单连接无自动重连**：断线后下一次操作重新建连，但不做连接内重放。
- **只验证了 headless**：Web/桌面 GUI 下的 Add-workspace 流程未测。

---

## 6. 如何安装

### 从 tarball 安装（可分发形态）

```sh
dsh plugin --profile <name> add ./dsh-fs-route-1.0.0.tgz
```

**已知**：pnpm 会因 `ssh2`/`cpu-features` 的 install script 被忽略而以退出码 1 结束
（`ERR_PNPM_IGNORED_BUILDS`），`dsh plugin` 因此**不会**把包写进
`dsh.profile.bundles`，虽然依赖已经装好。任何依赖 `ssh2` 的插件都有这个行为。
补一步即可：

```jsonc
// <profile>/package.json
"dsh": { "profile": { "bundles": [ ..., "dsh-fs-route" ] } }
```

### 部署配置写在 profile patch 里，不在包里

包内的 `cordis.patch.yml` 只负责**结构与禁用**（替换 4 个单槽行、关掉内置选择器、
插入 `fs-route` 空配置），**不含任何主机名、用户名或密钥路径**。

主机连接配置由各 profile 自己的 `cordis.patch.yml` 提供（patch 会整体替换 config）：

```yaml
- id: fs-route
  name: dsh-fs-route
  config:
    defaultHost: myhost
    watchIntervalMs: 3000        # 远端 watch 轮询周期；0 = 关闭并拒绝
    hosts:
      myhost:
        host: 203.0.113.10
        port: 22
        username: someone
        privateKey: C:/Users/someone/.ssh/id_ed25519
        cwd: /home/someone/project
        keepaliveInterval: 15000
        keepaliveCountMax: 4
        readyTimeout: 20000
```

不配置任何 host 时，选择器只提供 **Local folder** 页签——这是全新安装的安全默认。

### profile 需要替换哪些行

包内的 bundle patch 已经处理，无需手工再写：

| 行 | 动作 | 原因 |
|---|---|---|
| `fs-sandbox` | 禁用 | 由路由文件系统接管 |
| `subprocess` | 禁用 | 由路由子进程接管 |
| `pwsh-sandbox` / `bash-sandbox` | 禁用 | 由路由 shell 接管（单槽） |
| `directory-picker` | 禁用 | 其客户端半占用同一批 `single` 插槽 |
| `sandbox` / `sandbox-policy` | **保留** | `dsh-shell` 依赖它们 |

原有 `tool-bash` / `tool-pwsh` 都可保持启用：路由 shell 按 workdir 分派，
远端一律 POSIX，本地仍是平台 shell。

### 试跑实例（2026-11-10 已搭好）

| 项 | 值 |
|---|---|
| 独立 `DSH_HOME` | `%TEMP%\dsh-home`（与桌面端 `.dsh` 完全隔离） |
| GUI profile | `sshroute`（web 模板 + 插件 + n1n 模型路由） |
| 地址 | `http://127.0.0.1:60625/?token=<见启动日志>` |
| 无头复测 profile | `sshroute-hl`（同配置，`dsh headless` 用） |
| 远端 alias | `gpu` → `user@203.0.113.10`，默认目录 `/home/user/code/preprocess` |

启动干净（**零激活警告**），且已实测：

- GUI 实例：HTTP 200，pid 独立于桌面端；
- 无头 twin 里模型调用 `bash` 工具 `workdir=ssh://gpu/...` → 真实返回
  `/home/user/code/preprocess` + `remote-host` + `user`；
- client bundle 已进入 boot graph（`dsh-fs-route` 行 + 200 响应 + 两个 hole 名）；
- 浏览接口全通：`list`（20 条、9 个目录）、`mkdir`、错误码（坏路径 502、坏 alias 400）。

桌面端全程未被触碰（`package.json` / `cordis.yml` 哈希不变，pid 51548 存活）。

---

## 6.1 浏览器端 UI（工作区选择器）

插件填了 `ui-workspace` 声明的两个 **directory-flow hole**：

```
conversation.hero.workspace.directoryFlow
sidebar.workspaces.directoryFlow
```

`ui-workspace` 负责"添加工作区…"入口和采纳（`createWorkspace({ path })`）；
本插件负责从 `open` 到用户选定路径之间的全部交互 —— 一个 SSH 目录浏览器。
选中后交回 `ssh://<alias>/<绝对路径>`，由路由 provider 接管。

**关键实现约束（踩坑）**：`dsh.client` 只声明 `platform` 是不够的 ——
扫描器用 `internal.resolveSync` 解析包，再向上找 `package.json`；而客户端 bundle
必须能从包的 **`./client` 导出子路径**解析到。缺这一条时：

- 宿主侧路由完全正常（`/api/dsh-fs-route/*` 全部 200）；
- 但 boot graph 里**没有该行**，页面上什么都不会出现；
- 而且**没有任何报错** —— 扫描器静默跳过。

加上 `"exports": { "./client": "./lib/client.js" }` 后立即生效。
bundle 本身必须是 **classic script**，执行时调用
`window.__ModuleLoader__.load({ id: <包名>, factory(require) {...} })`，
且所有副作用（含注入 `<style>`）都放在 factory 闭包里（lazy-CJS 契约）。

### 还必须禁用内置选择器

只把 client bundle 接上仍然不够：**"添加工作区…" 依旧弹系统文件框**，因为
`@deepseek-ai/dsh-host-directory-picker-auto` 会挂载 `native`（Windows/macOS）
或 `browse` 后端，而它的**浏览器半填的是同一批 `single` 插槽**。
该包 README 原话："Mounting the chooser and a backend row together fails loud
(duplicate `directoryPicker` service, **duplicate client flow in the `single` holes**)"

所以必须在 profile patch 里关掉它：

```yaml
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
```

注意 `single` 插槽的语义：**没有占用者时，"添加工作区"入口会整个消失**
（"an unoccupied hole leaves the surface with no add affordance at all"）。
所以禁用内置选择器后必须由本插件接管，两者不能同时缺席。

### 验证清单（2026-11-10 实测）

| 检查 | 结果 |
|---|---|
| boot graph 含 `dsh-fs-route` 行 | ✅ |
| boot graph 含 `directory-picker` 客户端模块 | ✅ **NONE**（内置的已关掉） |
| bundle 声明两个 hole 名 | ✅ |
| `/api/dsh-fs-route/hosts` | ✅ 200 |
| `/api/dsh-fs-route/list` | ✅ 200，20 条 |
| 启动激活警告 | ✅ 零 |

### 还必须交回本地占位符，不能交 `ssh://`

点"Use this folder"后仍然失败：

```
workspace create failed: workspace/invalid-path:
cannot create a Workspace at "ssh://gpu/home/user/code/disagreement_detection":
Workspace path is not fully qualified
```

工作区控制器用 `path.isAbsolute()` 校验被采纳的路径，而 **Windows 上 `ssh://…`
不是绝对路径**（没有盘符）。这与 `resolveWorkdir` 那个坑同源，但发生在更外层，
provider 拦不住。

解法（`dsh-ssh` 用的是同一招）：交回一个**真实的宿主绝对路径**作为占位符。

```
<DSH_HOME>/dsh-fs-route-workspaces/<alias>/<远端路径各段>
例如 C:\…\dsh-home\dsh-fs-route-workspaces\gpu\mnt\data\user\code\disagreement_detection
```

- 对控制器：是个正常的绝对目录，它照常 `mkdir` 并建工作区；
- 对 provider：`parsePlaceholder()` 认出这段路径，反解回 `{alias, path}`。

客户端不再直接 `onPicked(ssh://…)`，而是先调 `POST /api/dsh-fs-route/route`
拿到占位符路径再采纳。占位符放在 `DSH_HOME` 下，所以隔离实例的占位符
不会污染真实 `~/.dsh`。

**决定性验证**（占位符作为 workdir）：

```
workdir = C:\…\dsh-home\dsh-fs-route-workspaces\gpu\mnt\data\user\code\disagreement_detection
→ bash 在服务器上执行：
   /home/user/code/disagreement_detection
   remote-host
   AUDIT.md / disagreement / README.md
```

### 工作区内任意一轮对话都会失败：`unknown ssh alias ".git"`

工作区建好、能进会话后，发第一句话就报：

```
This turn failed
dsh-fs-route: unknown ssh alias ".git"
```

栈追踪定位到两个**项目根发现**插件会从会话 cwd **逐级向上**找标记文件：

```
dsh-skill-filesystem   → findProjectRoot → ctx.fs.resolve("<root>/.git")
dsh-agent-instructions → findProjectRoot → ctx.fs.resolve("<root>/.git")
```

走到占位符根 `…\dsh-fs-route-workspaces\` 时拼出 `…\dsh-fs-route-workspaces\.git`，
而 `.git` 恰好通过了我当时的"别名合法字符"正则（`[A-Za-z0-9._-]+`），
于是被解析成 `ssh://.git/…` → 抛错 → 整轮失败。

**修法**：占位符识别必须校验别名**确实已配置**。

```js
parsePlaceholder(value, isKnownAlias)   // 未知别名 → 返回 null → 当普通本地路径
parseAnyRoute(value, isKnownAlias)
```

provider 传入 `(a) => this.registry.has(a)`。`ssh://` 显式拼写仍然**响亮失败**
（那是用户写错，应该报），只有占位符回溯产生的伪别名被降级为本地探测。

回归用例已补（`tests/route.mjs`，14/14）：`<root>/.git` 与 `<root>/AGENTS.md`
都必须判定为本地路径，而真实别名仍能路由。

### Web 会话里 bash 全部 exit 127：本地沙箱 runner 被送到远端

`.git` 修好后，Web 实例里 bash 仍然全失败：

```
bash: line 1: …\@vscode\ripgrep-win32-x64\bin\rg.exe: command not found   (exit 127)
```

`echo hello`、`true`、`/usr/bin/pwd` 输出**逐字节相同**，说明命令文本根本没被执行到 ——
被送去远端的是**本地沙箱 runner 的路径**。

根因：会话默认沙箱模式是 `workspace-write`（Web 实例没设 `DSH_PERMISSION_MODE`）。
该模式下 `bash-sandbox.execute()` 会先调 `ctx.sandbox.confine()` 把命令包进
**本地**的 confinement runner，然后才交给 `ctx.subprocess`。workdir 是占位符
→ 走远端 → 远端 bash 拿到 Windows runner 路径 → 127。

**远端工作本来就用不了本地围栏**，所以这个实例按"无围栏 + 保留审批"运行：

```yaml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
```

只改这一条还不够：内置预设把 `danger-full-access` 钉死为 `approval: never`，
而组合出来的默认是 `approval: ask`，于是 `permission` 服务启动即失败
（`composed sandbox and approval defaults match no preset`）。需要显式给一个
匹配当前组合的预设：

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      workspace-write: { sandbox: workspace-write, approval: ask, name: workspace-write, description: … }
      danger-full-access: { sandbox: danger-full-access, approval: never, name: danger-full-access, description: … }
      remote-unfenced: { sandbox: danger-full-access, approval: ask, name: Remote (unfenced), description: … }
    defaultPreset: remote-unfenced
```

改完启动零警告，且实测：

```
workdir = 占位符
bash: pwd; hostname  → /home/user/code/disagreement_detection
                       remote-host
同一轮里闲聊（讲笑话）正常
```

### P2：远端 PTY —— 已实现

`spawnTerminal` 对路由 workdir 用 SSH **shell** 通道（请求 PTY）实现，这是传输层唯一
的交互式原语。

关键设计点：**终端方言由执行世界决定，不由调用方决定。**
Windows 上 shipped 终端后端传的是 pwsh argv，而 Linux 主机没有 pwsh ——
所以路由分支忽略 caller 的 argv，固定 `cd <path> && exec <远端 bash> -l`。

实测（同一实例）：

```
REMOTE pty  → 200
  user@remote-host:/home/user/code/preprocess$
  pwd      → /home/user/code/preprocess
  hostname → remote-host
  READY-42（算术求值）
  tty      → /dev/pts/30          ← 真 PTY，不是管道

LOCAL pty   → 200（未受影响，走 super.spawnTerminal）
  Get-Location → C:\Users\you\Documents\deepseek-harness\default-workspace
  LOCAL-OK
上线未鉴权  → 401
```

**SSH PTY 的固有限制**（按契约如实上报，不假装支持）：

| 字段 | 值 | 原因 |
|---|---|---|
| `pid` | `-1` | 远端 shell 通道不报告 pid |
| `inspectForeground()` | `undefined` | 没有可移植的远端前台进程组读取方式 |
| `signalForeground()` | 发送到通道命令，返回 `0`（组号不可知） | 同上 |
| `inspectActivity()` | `{state:'unknown'}` | 无法观察远端作业状态，PTY 消费方会退回"输出静默"判定空闲 |

另：路由终端的 `spec.env` 被忽略（登录 shell 自带环境）。

### P3：远端 watch —— 改为轮询

SFTP 没有 inotify，OpenSSH 也没有可移植的变更通道，所以远端监视只能**采样**。
官方 `fs-ssh` 的选择是直接拒绝；这里改为可配置轮询，让监视真的能用：

- `watchIntervalMs`（profile 配置，默认 3000）：采样周期；**`0` 恢复"拒绝"语义**
- 文件 → 一次 `stat`；目录 → 一次 `readdir`，比较名字/大小/mtime 组成的指纹
- 只有指纹**真的变了**才回调 `changed`，安静目标不产生回调
- 关闭函数清定时器；有 `polling` 标志防止一次慢往返与下一次采样重叠
- 稳态成本：每个被监视目标每周期一次往返。监视很多目标时会成倍增长，
  所以周期应保持宽松

实测（`selftest/watch`，先写 `one`，监视生效后写 `two`，再关闭后写 `three`）：

```
changesWhileActive: 1     ← 检测到真实变更
changesAfterClose : 0     ← 关闭后确实不再回调
未鉴权            : 401
```

### 还差的最后一步：路由 shell —— 已实现

`ctx.shell` 是单槽，且 `ShellExecRequest` **没有方言字段**（`tool-bash` / `tool-pwsh`
在平台上互斥）。所以做法是：让**平台自带的沙箱执行器保持占槽**，子类只把
"路由 workdir" 的调用转走。

```
class RoutedShellExecutor extends <平台沙箱执行器> {
  async execute(spec) {
    const route = parseAnyRoute(spec.workdir, a => registry.has(a));
    if (route === null) return await super.execute(spec);   // 本地：真实 pwsh/bash
    return remoteExecution(...);                            // 远端：bash -c
  }
}
```

要点：

- 基类由 `process.platform` 选（Windows → `dsh-pwsh-sandbox`，其它 → `dsh-bash-sandbox`），
  本地命令因此保留**真实**语义（含沙箱）。
- 远端一律 `bash -c`：Linux 主机没有 PowerShell，方言由**执行世界**决定，而非工具名。
- profile 里必须把 `pwsh-sandbox` 与 `bash-sandbox` **都**禁用（插件占槽），
  但两个 tool 都保留启用，让模型按世界选择合适的方言。

实测（同一实例）：

```
bash  pwd; hostname   (远端) → /home/user/code/disagreement_detection
                               remote-host            exit 0
pwsh  Get-Location    (本地) → C:\…\default-workspace
```

### 远端 grep/glob 的两个坑

1. **argv[0] 是宿主绝对路径**。搜索工具把打包的
   `…\@vscode\ripgrep-win32-x64\bin\rg.exe` 当 argv[0] 传给 subprocess，
   远端没有这个文件。现在路由 subprocess 会把宿主绝对路径降为 basename、
   去掉 `.exe` 后到远端 PATH 解析（→ `/usr/bin/rg`）。
2. **省略路径的 rg 会去读 stdin**。搜索工具的 argv 常常是 `<rg> --no-config <flags>`，
   靠 cwd 当搜索根，且 `stdin: 'ignore'`。本地 `NUL` 不触发该分支，但远端
   `/dev/null` 会让 ripgrep **读 stdin** → 立即 EOF → "无匹配"（假阴性）。
   现在 `withSearchRoot()` 会在 rg 缺少位置参数时补一个 `.`。

实测（远端，`disagreement_detection`）：

```
grep 'disagreement' include *.md → 15 处匹配（README 5 / AUDIT 1 / EXPERIMENTS 6 / 子目录 3）
glob '*.md'                     → ./README.md ./AUDIT.md ./EXPERIMENTS.md ./exp_results/…/README.md
```

### P0：浏览路由曾无鉴权（已修）

裸 `ctx.webServer.register` 不受 connection 的 admission fence 保护，实测：

```
GET /api/dsh-fs-route/hosts                      → 200 {"endpoint":"user@203.0.113.10",...}
GET /api/dsh-fs-route/mkdir  (POST, 无凭据)      → 200   ← 能触发远端建目录
GET /api/<不存在>                                 → 401
```

即围栏存在，只没罩住这条路由。修法是在 handler 最前面调用同一条 admission：

```js
const rejection = connection.requestRejection(req);  // 信任栅栏 + cookie/token 鉴权
```

`connection` 按请求惰性取（注册时机早于它激活，`ctx.get` 不会等待），
取不到就 **401 fail closed**，绝不退回无鉴权。

验证（隔离实例，P0）：

| 场景 | 结果 |
|---|---|
| 无 cookie | 401 |
| 伪造 cookie | 401 |
| 浏览器握手后 | 200 |
| `mkdir` 带凭据 | 200 |
| `mkdir` 无凭据 | 401 |

### P1：禁用内置选择器导致"无法新增本地工作区"（已修）

`directory-picker` 被关掉后，“添加工作区”只有 SSH 浏览器 —— 既有的本地工作区还能用，
但**新建本地文件夹的路没了**。这是 C20 说的能力损失，不修就等于削掉一条腿。

修法：同一个插槽内的对话框加"SSH host / Local folder"两个页签。

- 本地分支走新路由 `POST /api/dsh-fs-route/local/list`（宿主 `node:fs` 列举目录）；
- 远端分支仍是目录浏览 + `POST /route` 换占位符；
- **每个条目由宿主回传完整 `path`**，客户端不做任何分隔符运算（Windows/Linux 各自正确）；
- 相对路径在归一化**之前**就 400 拒绝（否则 `resolve()` 会把它锚到宿主进程的 cwd）。

默认页签由配置决定：有 host 就默认 SSH（这个部署的存在理由），否则本地。

验证（P1）：

```
local/list("")            → 200  C:\Users\you  40 个目录，home/parent 正确
descend（用宿主给的 path） → 200  C:\Users\you\.cache  5 个
local/list(C:\Windows\System32) → 200  191 个
local/list("relative/path")     → 400  path must be absolute
local/list 无凭据               → 401
ssh/list                        → 200  20 条，条目带完整远端 path
```

### P1b：本地选择器到不了别的盘 / 上一层（已修）

最初的本地页签只有一个目录树：从 home 往上走 **到 `C:\` 就到顶了**，
而盘符之间没有通路 —— `..` 只沿目录树走，永远跨不到 `F:` / `G:`。
服务端本身没问题（`C:\Users` → `C:\` → parent null，`F:\` `G:\` 都能列），
缺的是**卷列表**这一层。

修法：加一个"Drives"层级。

- 新路由 `GET /api/dsh-fs-route/local/roots`：Windows 逐盘符 `stat` 探测（A–Z），
  其它平台返回 `/`；同时回传 `home`，因为停在卷列表时不会调用目录列举，
  `~` 快捷键需要它；
- 客户端在本地页签把**空路径**约定为"Drives 层"（不请求目录、不进 home），
  列出卷；点卷进入其根，之后正常上下浏览；
- 路径栏加 `Drives` 按钮随时回到卷列表。

实测：

```
local/roots → 200  home=C:\Users\you  volumes: C:→C:\  F:→F:\  G:→G:\
enter C:\   → 200  17 项     descend → 200  C:\<子目录>
enter F:\   → 200  15 项     descend → 200  F:\<子目录>
enter G:\   → 200  15 项
roots 无凭据 → 401
```



**已可用**：远端会话的 bash / 读写 / 编辑 / 删除 / grep / glob / 工作区选择；
本地会话的 pwsh 与文件读写；两者在**同一实例**内共存；
"添加工作区"同时支持**本地文件夹**与 **SSH 主机**。

**尚未实现 / 未验证**：

| 项 | 状态 |
|---|---|
| 远端 PTY（`spawnTerminal`） | ✅ SSH shell 通道 + 真 PTY；`pid`/前台组/活动观察受协议限制，见 P2 节 |
| 远端 `watch` | ✅ 轮询实现（`watchIntervalMs`，默认 3s）；`0` 恢复拒绝语义，见 P3 节 |
| 远端 `patchText` / `moveFile` | ⚠️ 简化实现，未做完整回归 |
| 断线重连 | ⚠️ 下次操作会重连，但连接内不重放 |
| **第三方文件树面板** | ⚠️ `dsh-workspace-explorer` / `dsh-file-tree` 经 `dsh-api-workspace-files` 读**宿主**文件系统，远端工作区在它们面板里显示为空目录（占位符本身是空的）。不崩，但不是远端内容 |
| 发布 | ✅ 已打包 `dsh-fs-route-1.0.0.tgz`（脱敏、从 tarball 全新安装实测通过）；未发布到 npm registry |
| 装进 `desktop` | ✅ 已装并同步；bundle patch 中性、主机配置移到 desktop 的 profile patch |

---

## 7. 与桌面 profile 的关系

### 现状：已安装并生效

`dsh-fs-route` 是 desktop profile 的一个 bundle：替换
`fs-sandbox` / `subprocess` / `pwsh-sandbox` / `bash-sandbox` 四个行，
并接管 `directory-picker` 的插槽。四项验收全部通过（见文末"桌面验收结果"）。

### 首次安装（2026-11-10，我做的）

装进 desktop 后应用起不来：`ctx.shell` 被注册两次
（`service "shell" has been registered`），依赖 `shell` 的一串行全 pending；
同时客户端半与内置 `directory-picker` 抢同一批 `single` 插槽，web boot 有一条 entry 失败。
修复方式是把 4 条禁用写进**插件自己的 bundle patch**（见 C16），应用恢复。

### 备份与回滚

安装前已备份（仍在）：

```
package.json.bak.20261110-163921
cordis.yml.bak.20261110-163921
cordis.patch.yml.bak.20261110-163921
```

回滚：

```powershell
$d = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$d\package.json.bak.20261110-163921" "$d\package.json" -Force
Copy-Item "$d\cordis.yml.bak.20261110-163921" "$d\cordis.yml" -Force
Copy-Item "$d\cordis.patch.yml.bak.20261110-163921" "$d\cordis.patch.yml" -Force
```

（`dsh-fs-route` 是否仍随 bundle 加载由 `package.json` 的 bundles 决定；恢复备份即摘除。）

### 桌面验收结果（2026-11-10）

| 项 | 结果 |
|---|---|
| A 启动健康 | ✅ 5 个原有工作区全部健在 |
| B 本地能力 | ✅ `pwsh` 返回本地路径；`read` 读到本地文件（313 行） |
| C 远端能力 | ✅ 建远端工作区成功；`bash` 返回 `/home/user/code/preprocess` + 主机名 |
| D 本地新建 + 跨盘 | ✅ 通过新选择器在 `F:` 盘建出 `F:\scripts` |

**B 项独立复核**（我做的，`fencetest` profile 保持 `workspace-write`）：
`pwsh` → `C:\Users\you\Documents\deepseek-harness\default-workspace`；
`read ssh-plugin-task.md` → 正常返回前 3 行。说明本地读写仍走**真实**沙箱后端。

### 已知环境问题：新卷上的 Windows 沙箱 ACL

首次把 `F:\scripts` 当工作区跑命令时报：

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(F:\scripts)
```

这是 `dsh-sandbox-windows-acl` 为该卷provisioning 写权限时失败（该目录用户是 owner
但缺 `WRITE_OWNER`）。用 DSH 自带的 `diagnose-windows-sandbox-acl` skill 修好后恢复正常。

**归因**：不是本插件引入的。本地命令走的是 `RoutedShellExecutor extends SandboxPwshExecutor`
的 `super.execute()`，即 shipped 实现的 `confine()`；同一条路径在装插件之前就存在。
它之所以现在才出现，是因为 `F:\scripts` 是**通过新选择器第一次**作为工作区使用。

**运维提示**：在任何"用户是 owner 但缺 WRITE_OWNER"的卷上新建本地工作区，都可能首次
撞上这条错误；按该 skill 修一次即可。修复会**修改 ACL**（给当前用户加 full-control），
并留下备份与回滚脚本（本次在 `F:\dsh-acl-recovery\`）。

### 第三方插件冲突检查

重启前已确认 `dsh-workspace-explorer`、`@guimaxingtian/dsh-file-tree`、
`dsh-multi-window` 的客户端 bundle **都不占用** `directoryFlow` 两个 hole，
因此不会与本站的客户端注册冲突。


---

## 8. 新增约束

- **C13 私有方法不能出现在 Cordis Service 子类里。** 服务经 Proxy 暴露，
  `#method()` 会因 brand check 失败；改用下划线方法。
- **C14 继承官方 provider 时注意构造前校验。** 部分实现要求配置**已解析**
  （默认值由 Schemastery 在挂载时补），直接 `new` 会因缺失字段拒绝整个 provider。
- **C15 命令字符串的引号要区分层级。** `bash -c` 的脚本体是"单参数但需内层展开"，
  必须双引号包裹；外围参数单引号。
