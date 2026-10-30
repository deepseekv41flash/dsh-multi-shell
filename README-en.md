# dsh-multi-shell

[English](README-en.md) · [简体中文](README.md)

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/deepseekv41flash/dsh-multi-shell)
[![npm](https://img.shields.io/npm/v/dsh-multi-shell.svg)](https://www.npmjs.com/package/dsh-multi-shell)
[![license](https://img.shields.io/npm/l/dsh-multi-shell.svg)](./LICENSE)

A DSH (DeepSeek Harness) plugin that registers **one** `shell` tool, but lets the
**model choose the backend on every call** — Git Bash (default), PowerShell, or WSL.
It differs from `dsh-bash-terminal` in exactly two ways, and those are the point:

| | dsh-bash-terminal | dsh-multi-shell |
|---|---|---|
| Who picks the backend | The user (Settings → Default terminal); the model cannot | The model (`shell` parameter, per call) |
| Across DSH versions | Declares exact `peerDependencies` ranges such as `^0.1.5-rc.1`; a host upgrade to 0.2.x fails the version gate | Only `*` ranges and **zero version checks in code**; every optional service is resolved at call time, so one missing/renamed service breaks one call instead of failing the whole fiber |

## The tool

`shell` parameters:

| Parameter | Required | Meaning |
|---|---|---|
| `command` | yes | The command body, written in the selected backend's syntax |
| `description` | yes | 5–10 word active-voice description (shown in the UI) |
| `shell` | no | `gitbash` (default) / `powershell` / `wsl` |
| `distro` | no | WSL distribution name; only valid with `shell=wsl`; defaults to the system default |
| `workdir` | no | Working directory; a relative path resolves against the session directory; gitbash/powershell accept `C:\...` or `/c/...`, wsl accepts a Windows path (mapped to `/mnt/...`) or an absolute Linux path |
| `timeoutMs` | no | Foreground timeout (ms); default 120000, capped at 600000; kills the process tree on expiry |
| `run_in_background` | no | Background job; returns a job id (collect with `job_output`, stop with `job_kill`); no timeout |
| `sandbox_permissions` + `justification` | no | Sandbox escalation (only meaningful for `powershell`); goes through `ctx.approval` |

Exact argv per backend:

- `gitbash` → `<Git>\bin\bash.exe -lc <command>` (POSIX; `$VAR`; PATH includes `/usr/bin`, `/mingw64/bin`)
- `powershell` → `pwsh -NoLogo -NoProfile -NonInteractive -Command <UTF-8 preamble + command>`
  (the preamble pins `[Console]::OutputEncoding` / `$OutputEncoding` to UTF-8 so non-ASCII output is not mojibake).
  The preamble carries a `LanguageMode` guard: the read-only sandbox runs pwsh in ConstrainedLanguage, where
  constructing the encoding object is rejected; the guard stops **two `InvalidOperation` lines on stderr on every call**
  in confined sessions (the shipped `pwsh` tool still prints them). The trade-off: in constrained read-only sessions
  non-ASCII output stays code-page encoded (the language mode makes a fix impossible).
- `wsl` → `wsl [-d <distro>] -e bash -lc <command>`; `DSH_*` variables cross the boundary through `WSLENV`

Non-zero exits end with `[exit code: N]` (last line, so the terminal card can parse it); a timeout starts with
`[timed out after Nms]` and still ends with `[exit code: N]`. Output over 64 KiB is truncated to its tail with the
full-output file path.

## Sandbox semantics

- **PowerShell**: under `read-only` / `workspace-write` the argv is wrapped by `ctx.sandbox.confine` (fail-closed).
  With no usable provider the command is **refused**, never silently run unconfined; a runner failure
  (e.g. the ACL runner exiting 127) is reported as a `SANDBOX_UNAVAILABLE`-style error
  ("the command did not run, the sandbox is broken") instead of a command failure.
- **Git Bash / WSL**: not confined. The DSH Windows ACL restricted-token runner cannot start Cygwin/MSYS2
  (bash aborts with `CreateFileMapping ... Win32 error 5`), and WSL is only process isolation — `/mnt/c` is still
  writable. Besides the structured `sandbox.enforcement` (`gitbash-unconfined` / `wsl-isolation`), **every render
  in a confined session appends a model-visible line**
  `[sandbox: <backend> runs unconfined under <mode> — file effects are not restricted ...]`, so "not confined" is
  never hidden in a structured field only.
- Sandbox escalation (`sandbox_permissions`) is PowerShell-only; passing it with gitbash/wsl is an error because
  those backends are not confined at all. Requesting the mode the session already runs under is a no-op and does
  not prompt (same as the shipped bash tool).
- Denial detection uses the shared `matchesSignature` (non-zero exit + case-insensitive stderr signature), so a
  successful command's non-terminating error is not mislabelled as a sandbox denial.

## Admin PowerShell (sudo hint)

The hint is embedded in the tool description (the model sees it on every request): if the host runs
**Sudo for Windows in inline mode** (`sudo config` reports inline), elevate from the **gitbash** backend:

```bash
MSYS_NO_PATHCONV=1 sudo --disable-input pwsh -NoProfile -NonInteractive -Command '<script>' </dev/null
```

Constraints: one UAC prompt per call, no credential cache; the elevated process cannot be killed by this tool, so
the script must enforce its own timeout and cleanup. **Do not** click the UAC prompt with UI automation
(it lives on the secure desktop and cannot be reached).

## Configuration (override in the profile patch)

```yaml
- id: tool-multi-shell
  config:
    defaultShell: gitbash        # backend when the model omits `shell`
    pwshPath: ''                 # empty = auto-detect (Program Files\PowerShell\7 → WindowsApps → PATH → 5.1)
    gitBashPath: ''
    wslPath: ''
    timeoutMs: 120000
    maxTimeoutMs: 600000
    maxOutputBytes: 65536
    maxSpillBytes: 67108864
    graceMs: 3000
    enableRunInBackground: true
```

Config is a plain object (no schemastery schema), so it does not depend on DSH's settings-page API. `apply()`
validates every numeric field at startup (positive finite, `graceMs ≤ 2147483647`) and fails with a clear startup
error naming the field instead of crashing later inside a stream callback.

## Install / rollback

The package is **plain ESM with no build step**: `package.json` + `lib/` + `cordis.patch.yml` are enough.
npm: `dsh-multi-shell` (https://www.npmjs.com/package/dsh-multi-shell).

Install into a profile from npm (add the package, then register it in the profile's bundles; restart DSH):

```bash
dsh plugin --profile desktop add dsh-multi-shell
# then add "dsh-multi-shell" to that profile's dsh.profile.bundles array
# (or use the plugin manager in the DSH settings UI, which writes dependencies + bundles for you)
```

This machine's `desktop` profile currently uses a local link (development mode):

- `package.json`: `"dsh-multi-shell": "link:C:\\Users\\Admin\\dsh-multi-shell"`
- `dsh.profile.bundles`: `dsh-multi-shell`
- `node_modules/dsh-multi-shell` junction → the plugin directory

Rollback:

1. Remove `dsh-multi-shell` from the profile's `dsh.profile.bundles` and `dependencies`, delete the junction;
2. To go back to the old plugin, delete `disabled: true` from the `tool-bash-terminal` row in
   `~/.dsh/profiles/desktop/cordis.patch.yml`. Both plugins register a tool named `shell`, so **only one may be
   enabled at a time** (the second registration fails).

## Verified (2026-10-30, DSH `0.2.1-rc.4` / desktop-next `2.0.21-next`)

| Item | Result |
|---|---|
| Default gitbash | `bash 5.3.15(1)`, MINGW64, `/c/...` workdir correct |
| powershell | `pwsh 7.6.8`, non-ASCII output correct (UTF-8 preamble) |
| wsl | Debian; Windows paths map to `/mnt/c/...`; a Linux `workdir=/home` works through the `cd` prefix |
| Timeout | `timeoutMs=500` kills `sleep 3` → `[timed out after 500ms]` + final `[exit code: 1]` |
| Background jobs | returns `job shell/gitbash-…`; `job_output` streams and reports completion; `job_kill` yields `[status: killed]`; WSL background works too (first VM start buffers output until exit) |
| Blank arguments | `justification: ""` / `distro: ""` are treated as omitted; a blank `shell` is still rejected by the schema enum |
| Error paths | missing workdir → clear error; `/usr/bin` with gitbash → teaching error (use `/c/...`); `distro` with gitbash → rejected; `run_in_background` without a jobs registry → rejected |
| Output truncation | a 200k-line output is tail-truncated with the full spill-file path |
| Sandbox (isolated probe) | under `workspace-write`, `ctx.sandbox.confine` + pwsh argv runs (`enforcement: partial`); a write outside the workspace is rejected and matches the `access to the path` signature |
| Sandbox (this session) | the workspace is `C:\Users\Admin` and the temp dir `…\AppData\Local\Temp` is inside it, so the ACL provider refuses (`temp root must be outside the workspace`); the shipped `pwsh` tool reports the same — a host-environment limit, not a plugin defect |
| Constrained read-only encoding | with the `LanguageMode` guard our stderr is clean; the shipped `pwsh` tool still prints two `InvalidOperation` lines; non-ASCII stays code-page encoded in ConstrainedLanguage (identical, impossible to fix) |
| Bundles assembly after restart | loader entry is `{id: "tool-multi-shell", parent: "include", fiber: 2}` — stable bundle-row id, under `include`, active; the injector registry has no such package, so no duplicate injection |
| Approval allow-once | a read-only write is denied → the same command with `sandbox_permissions: danger-full-access` + justification → user approves → it runs and the written content is read back |
| Approval rejected | same command, user rejects → `the user rejected escalating this command to "danger-full-access"; it stays denied, so stop and explain instead of working around it`; the command never runs, no probe file exists, the session stays read-only |
| Admin PowerShell (sudo) | the tool-description template from gitbash: `MSYS_NO_PATHCONV=1 sudo --disable-input pwsh ... </dev/null` → `IsInRole(Administrator)` returns `True`, `net session` succeeds (`NET_SESSION_OK`); one UAC click |

**Not verified**: the approval `cancelled` branch (cancel instead of reject); actual execution after a
`workspace-write` escalation (this session's workspace and temp dir share a root, so the ACL provider refuses after
approval — a host-environment limit shared with the shipped pwsh tool).

## Layout

```
dsh-multi-shell/
├── package.json          # name/exports/peerDependencies (all "*")/dsh.bundle.patch
├── cordis.patch.yml      # bundle layer: inserts one row with id=tool-multi-shell
├── lib/
│   ├── index.js          # tool definition, subprocess/jobs/sandbox/approval/rendering
│   └── shells.js         # pure helpers: discovery, argv, env, workdir, deadline, config validation
├── scripts/check.sh      # zero-build check: node --check + unit tests + npm pack dry-run
├── test/shells.test.mjs  # offline unit tests (node --test, 12 cases)
└── README.md             # Chinese README
```
