# dsh-multi-shell

[English](README-en.md) · [简体中文](README.md)

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/deepseekv41flash/dsh-multi-shell)
[![npm](https://img.shields.io/npm/v/dsh-multi-shell.svg)](https://www.npmjs.com/package/dsh-multi-shell)
[![license](https://img.shields.io/npm/l/dsh-multi-shell.svg)](./LICENSE)

一个 DSH（DeepSeek Harness）插件：只注册**一个** `shell` 工具，但让**模型在每次调用时自己选后端**——
Git Bash（默认）、PowerShell、WSL。和 `dsh-bash-terminal` 的区别只有两点，但正是这两点：

| | dsh-bash-terminal | dsh-multi-shell |
|---|---|---|
| 选后端的人 | 用户（设置页「默认终端」），模型不能选 | 模型（`shell` 参数，逐次选择） |
| 跨 DSH 版本 | 声明 `peerDependencies: ^0.1.5-rc.1` 等精确范围，宿主升到 0.2.x 后过不了版本门控 | 只用 `*` 范围且模块内**没有任何版本判断**；可选服务全部按调用时解析，缺一个只坏一次调用，不会整条 fiber 加载失败 |

## 工具

`shell` 参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | 命令正文；按所选后端写对应语法 |
| `description` | 是 | 5–10 词的主动语态说明（UI 用） |
| `shell` | 否 | `gitbash`（默认）/ `powershell` / `wsl` |
| `distro` | 否 | WSL 发行版名，只能与 `shell=wsl` 同用；缺省用系统默认发行版 |
| `workdir` | 否 | 工作目录；相对路径按会话目录展开；gitbash/powershell 收 `C:\...` 或 `/c/...`，wsl 收 Windows 路径（自动映射 `/mnt/...`）或 Linux 绝对路径 |
| `timeoutMs` | 否 | 前台超时（ms），默认 120000、上限 600000；到点杀进程树 |
| `run_in_background` | 否 | 后台任务，返回 job id（用 `job_output` / `job_kill`）；无超时 |
| `sandbox_permissions` + `justification` | 否 | 沙箱升级（仅 `powershell` 后端有意义），经 `ctx.approval` 审批 |

三个后端实际执行的 argv：

- `gitbash` → `<Git>\bin\bash.exe -lc <command>`（POSIX；`$VAR`；PATH 含 `/usr/bin`、`/mingw64/bin`）
- `powershell` → `pwsh -NoLogo -NoProfile -NonInteractive -Command <UTF-8 前导 + command>`
  （前导把 `[Console]::OutputEncoding` / `$OutputEncoding` 钉成 UTF-8，中文不再乱码）。
  前导带 `LanguageMode` 守卫：只读沙箱会把 pwsh 跑在 ConstrainedLanguage 下，那里构造编码对象会被语言模式拒绝，
  守卫让受限会话**不再每次调用都往 stderr 打两条 `InvalidOperation`**（官方 `pwsh` 工具目前仍会打）；
  代价是受限只读下非 ASCII 输出仍是代码页编码（语言模式无解）。
- `wsl` → `wsl [-d <distro>] -e bash -lc <command>`；`DSH_*` 环境变量通过 `WSLENV` 过边界

非零退出以 `[exit code: N]` 标记返回（末行，供终端卡片反解）；超时以 `[timed out after Nms]` 开头、末尾仍带 `[exit code: N]`；
输出超过 64 KiB 截尾并给完整输出文件路径。

## 沙箱语义

- **PowerShell**：`read-only` / `workspace-write` 下经 `ctx.sandbox.confine` 包装 argv（fail-closed）。
  没有可用的 provider 时**拒绝执行**，不会偷偷裸跑；runner 自身失败（ACL runner 退出 127 等）会被识别为
  `SANDBOX_UNAVAILABLE` 类错误（"命令没跑，是沙箱坏了"），不会伪装成命令失败。
- **Git Bash / WSL**：不隔离。原因：DSH 的 Windows ACL 受限令牌 runner 起不动 Cygwin/MSYS2
  （bash 启动即 `CreateFileMapping ... Win32 error 5`），而 WSL 只是进程隔离、`/mnt/c` 仍可写。
  结果里除 `sandbox.enforcement`（`gitbash-unconfined` / `wsl-isolation`）外，**受限会话下每次渲染都会追加一行
  模型可见的** `[sandbox: <backend> runs unconfined under <mode> — file effects are not restricted ...]`，
  不让「未隔离」只躺在结构化字段里。
- 沙箱升级（`sandbox_permissions`）只对 `powershell` 开放；对 gitbash/wsl 传该参数会报错，
  因为这两个后端根本不受沙箱约束，没有「升级」可谈。请求的模式等于当前会话模式时按无操作放行，不弹审批
  （与官方 bash 工具一致）。
- 拒绝判定用官方的 `matchesSignature`（要求非零退出 + 命中小写 stderr 签名），不会把成功命令的
  非终止错误误标成沙箱拒绝。

## 管理员 PowerShell（sudo 提示）

插件把这条提示直接写进工具描述（模型每次都能看到）：宿主机若启用 **Sudo for Windows 内联模式**
（`sudo config` 显示内联/inline），从 **gitbash** 后端提权：

```bash
MSYS_NO_PATHCONV=1 sudo --disable-input pwsh -NoProfile -NonInteractive -Command '<脚本>' </dev/null
```

约束：每次调用弹一次 UAC、没有凭据缓存；提权进程本工具杀不掉，脚本必须自带超时与自清；
**不要**用 UI 自动化去点 UAC（点在安全桌面上，点不到）。

## 配置（profile patch 里按需覆盖）

```yaml
- id: tool-multi-shell
  config:
    defaultShell: gitbash        # 模型不传 shell 时的后端
    pwshPath: ''                 # 留空 = 自动探测（Program Files\PowerShell\7 → WindowsApps → PATH → 5.1）
    gitBashPath: ''
    wslPath: ''
    timeoutMs: 120000
    maxTimeoutMs: 600000
    maxOutputBytes: 65536
    maxSpillBytes: 67108864
    graceMs: 3000
    enableRunInBackground: true
```

配置是普通对象（没有 schemastery schema），因此不依赖 DSH 的设置页 API；`apply()` 启动时校验数值配置
（必须为正有限数，`graceMs ≤ 2147483647`），非法值直接给出字段名清楚的启动错误，不会拖到流回调里崩宿主。

## 安装 / 回滚

本体是**纯 ESM、零构建**的包：`package.json` + `lib/` + `cordis.patch.yml` 即可运行。
npm：`dsh-multi-shell`（ https://www.npmjs.com/package/dsh-multi-shell ）。

从 npm 安装到某个 profile（把包加进该 profile 并登记到 bundles，重启 DSH 后生效）：

```bash
dsh plugin --profile desktop add dsh-multi-shell
# 然后把 "dsh-multi-shell" 加进该 profile package.json 的 dsh.profile.bundles 数组
# （或用 DSH 设置页的插件管理器安装，它会同时写 dependencies + bundles）
```

本机当前 profile（`desktop`）用的是本地 link（开发态）：

- `package.json`：`"dsh-multi-shell": "link:C:\\Users\\Admin\\dsh-multi-shell"`
- `dsh.profile.bundles`：追加 `dsh-multi-shell`
- `node_modules/dsh-multi-shell` junction → 插件目录

本次会话里由 `loader.create` 热装配运行；重启后由 bundles 正常装配（bundles 行与 junction 已落盘）。
回滚：

1. 从 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 删掉 `dsh-multi-shell`，删 junction；
2. 若要回到旧插件，把 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `tool-bash-terminal` 的 `disabled: true` 删掉。
   两个插件都注册 `shell` 工具名，**同时只能启用一个**（重名注册会让后加载的那个 fiber 失败）。

## 已验证（2026-10-30，DSH `0.2.1-rc.4` / desktop-next `2.0.21-next`）

| 项 | 结果 |
|---|---|
| 默认 gitbash | `bash 5.3.15(1)`，MINGW64，`/c/...` workdir 正确 |
| powershell | `pwsh 7.6.8`，中文输出正常（UTF-8 前导生效） |
| wsl | Debian，Windows 路径自动映射 `/mnt/c/...`；`workdir=/home` 的 Linux 路径经 `cd` 前导生效 |
| 超时 | `timeoutMs=500` 杀 `sleep 3`，返回 `[timed out after 500ms]` + 末行 `[exit code: 1]`（终端卡片可反解为失败） |
| 后台任务 | 前台返回 `job shell/gitbash-…`，`job_output` 拿到增量与完成状态；`job_kill` 后 `[status: killed]`；WSL 后台同样可用（首次启动 VM 时输出会在结束时一次性出现） |
| 空串参数 | `justification: ""` / `distro: ""` 按未提供处理；`shell` 为空串仍被 schema enum 拒绝（模型侧极少见） |
| 错误路径 | 不存在的 workdir → 明确报错；gitbash 传 `/usr/bin` → 教学错误（改用 `/c/...`）；`distro` 配给 gitbash → 拒绝；`run_in_background` 在无 jobs 组合里 → 拒绝 |
| 输出截断 | 200k 行输出截尾并给出完整 spill 文件路径 |
| 沙箱（隔离探针） | `workspace-write` 下 `ctx.sandbox.confine` + pwsh argv 可执行（`enforcement: partial`）；越界写 `C:\Users\Public\...` 被拒绝，stderr 命中 `access to the path` 拒绝签名 |
| 沙箱（本会话） | 本会话工作区 = `C:\Users\Admin`，而临时目录 `…\AppData\Local\Temp` 在工作区内，ACL provider 直接拒绝（`temp root must be outside the workspace`）；官方 `pwsh` 工具同样报此错，属宿主环境限制，不是插件缺陷 |
| 受限只读编码 | 加 `LanguageMode` 守卫后：本插件 stderr 干净；官方 `pwsh` 工具对照仍打两条 `InvalidOperation`。中文在 ConstrainedLanguage 下仍是代码页编码（两者一致，语言模式无解） |
| 重启后 bundles 装配 | 重启后 loader 条目为 `{id: "tool-multi-shell", parent: "include", fiber: 2}`——稳定的 bundle 行 id、`include` 树、active；注入器 registry 无该包，不会二次注入 |
| 审批 allow-once | 只读下写盘被拒 → 同命令加 `sandbox_permissions: danger-full-access` + justification → 用户批准 → 命令执行成功并读回写入内容 |
| 审批 rejected | 同命令再次发起、用户点拒绝 → `the user rejected escalating this command to "danger-full-access"; it stays denied, so stop and explain instead of working around it`；命令未执行、探针文件不存在、会话仍只读 |
| 管理员 PowerShell（sudo） | 用工具描述里的模板从 gitbash 提权：`MSYS_NO_PATHCONV=1 sudo --disable-input pwsh ... </dev/null` → `IsInRole(Administrator)` 返回 `True`，`net session` 成功（`NET_SESSION_OK`）；一次 UAC 点击 |

**未验证**：审批弹窗的 `cancelled` 分支（需要点取消而不是拒绝）；`workspace-write` 升级后的实际执行
（本会话工作区与临时目录同根，ACL provider 会在批准后拒绝，属宿主环境限制，官方 pwsh 工具同样如此）。

## 结构

```
dsh-multi-shell/
├── package.json          # 名字/导出/peerDependencies（全部 "*"）/dsh.bundle.patch
├── cordis.patch.yml      # bundle 层：insert 一行 id=tool-multi-shell
├── lib/
│   ├── index.js          # 工具定义、子进程/后台任务/沙箱/审批/渲染
│   └── shells.js         # 纯函数：探测、argv、env、workdir、deadline、配置校验
├── scripts/check.sh      # 零构建校验：node --check + 单测 + npm pack dry-run
├── test/shells.test.mjs  # 离线单测（node --test，12 例）
└── README-en.md          # English README
```
