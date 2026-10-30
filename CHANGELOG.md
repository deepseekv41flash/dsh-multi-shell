# Changelog

## 0.1.2 — 2026-10-30

首个公开发布版本（npm `dsh-multi-shell@0.1.2` + GitHub `deepseekv41flash/dsh-multi-shell`）。

- PowerShell 的 UTF-8 前导加 `LanguageMode` 守卫：
  `if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { ... }`。
  受限只读沙箱把 pwsh 跑在 ConstrainedLanguage 下，构造 `[System.Text.UTF8Encoding]` 会被语言模式拒绝，
  旧前导导致**每次调用**都在 stderr 打两条 `InvalidOperation`；官方 `pwsh` 工具至今如此。加守卫后：
  - FullLanguage（danger-full-access / workspace-write）：UTF-8 固定照旧，中文正常；
  - ConstrainedLanguage（read-only）：不再有 `InvalidOperation` 噪声；非 ASCII 输出仍是代码页编码（语言模式不允许构造编码对象，无解，与官方行为一致）。
- 单测新增一条断言，锁住"守卫必须在前导最前"这一契约（12 例全过）。

## 0.1.1 — 2026-10-30

独立代码审查后的修复版（0.1.0 是首个可运行版本，未单独发布）。

- 修复：`SHELLS` 未导入导致 `toolDescription` 抛 `ReferenceError`、整条 fiber 注册失败。
- 修复：默认后端文案参数化（`defaultShell` 可配置为 wsl/powershell 后描述不再写死 gitbash）。
- 修复：可选字符串参数填空串（`justification` / `distro` / `workdir` / `sandbox_permissions`）按「未提供」处理，
  不再变成硬校验错误；`sandbox_permissions` 等于当前会话模式时按无操作放行，不弹审批。
- 修复：准备阶段（launch handshake）的超时/取消不再被当成基础设施错误，按 `timedOut` / `aborted` 归类
  （`createDeadline` 现在严格首因，并随纯函数层一起可单测）。
- 修复：后台启动失败从 `killed` 改为 `failed` 并携带原始错误文本，不再丢失 ENOENT 之类的原因。
- 修复：沙箱拒绝判定改用官方 `matchesSignature`（要求非零退出）；接入 `runnerFailureRules` / `classifyRunnerFailure`，
  runner 自身失败（如 windows-acl 退出 127）会明确报告「命令没跑，是沙箱坏了」，后台任务写进 detail。
- 修复：超时结果仍保留末行 `[exit code: N]`，终端卡片不会再把它反解成成功退出 0。
- 修复：受限会话下 gitbash/wsl 的「未隔离」现在作为模型可见标记出现在结果文本里，
  不只躺在结构化 `sandbox.enforcement`。
- 修复：`apply()` 启动时校验数值配置（正有限、`graceMs ≤ 2^31-1`），坏配置以字段名清楚的启动错误失败，
  不会在流回调里崩宿主。
- 修复：`buildEnv` 按后端分流环境覆盖（PowerShell 不再设置 `TERM=dumb`），并合并父进程已有 `WSLENV`。
- 修复：`~` 无法展开、gitbash/powershell 传非盘符 POSIX workdir（如 `/usr/bin`）时给出教学错误。
- 修复：`systemPrompt` section 的 order 优先用宿主的 `getSectionOrder("TOOL_BASH")`。
- 文档：README/CHANGELOG 的验证状态改为实测事实；LICENSE 去掉行首 `//`。
- 单测：9 → 12 例（新增 normalizeOptionalText / validateSettings / createDeadline 首因 / WSLENV 合并与后端分流覆盖）。

## 0.1.0 — 2026-10-30

首个可运行版本，目标是替代 `dsh-bash-terminal` 的 `shell` 工具。

- 一个 `shell` 工具，模型用 `shell` 参数逐次选择 `gitbash`（默认）/ `powershell` / `wsl`。
- 三后端 argv、环境、workdir 规则统一由 `lib/shells.js` 纯函数生成：
  - Git Bash `bash -lc`；PowerShell `pwsh -NoLogo -NoProfile -NonInteractive -Command`（UTF-8 前导）；
  - WSL `wsl [-d <distro>] -e bash -lc`，`DSH_*` 经 `WSLENV` 过边界，Linux workdir 走 `cd` 前导。
- 前台超时杀进程树并返回 `[timed out after Nms]`；非零退出返回 `[exit code: N]`；
  超过 64 KiB 截尾并附完整输出文件路径。
- 后台任务接入 `ctx.jobs`：`run_in_background` 立即返回 job id，输出由 registry 的 pull source 收集，
  `job_kill` 杀进程树；jobs 服务缺席时工具自动降级为纯前台并**不**广告该参数。
- 沙箱：PowerShell 在受限模式经 `ctx.sandbox.confine` 包装（fail-closed，provider 不可用即拒绝）；
  Git Bash/WSL 不隔离并在结果里写明 `gitbash-unconfined` / `wsl-isolation`；
  `sandbox_permissions`/`justification` 经 `ctx.approval` 审批，仅对 PowerShell 开放。
- 抗版本漂移：`peerDependencies` 全部 `*`；不注册 settings；不 import schemastery；
  可选服务用 `ctx.get` 在调用时解析，核心依赖只有 tools registry 与
  `dsh-tools`/`dsh-llm`/`dsh-sandbox`/`dsh-shell` 四个稳定包。
- 工具描述内置管理员 PowerShell 的 Sudo for Windows（内联模式）标准模板与三条硬约束。
