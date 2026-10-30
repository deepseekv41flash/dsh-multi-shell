// dsh-multi-shell / shells.js
//
// Pure backend helpers for the model-facing `shell` tool: which terminal
// backends exist, where their executables live, the exact argv each receives,
// and the environment that crosses into the child process. No cordis and no
// DSH imports here on purpose — every function is a pure function of
// (config, env, platform, args), so the module can be unit-tested outside the
// harness and keeps working when the host API moves.

import { lstatSync } from "node:fs";
import { join } from "node:path";

/** The terminal backends this tool exposes, in catalog order. */
export const SHELLS = ["gitbash", "powershell", "wsl"];

/** The backend used when the caller does not name one. */
export const DEFAULT_SHELL = "gitbash";

/** Largest delay Node's timers accept without overflowing to 1 ms. */
export const NODE_TIMER_MAX = 2147483647;

/**
 * Model-friendly environment overrides shared by both shell families
 * (dsh-bash-local / dsh-pwsh-local): no color escapes, no pagers.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: "1",
  PAGER: "cat",
  GIT_PAGER: "cat"
};

/**
 * Bash-family overrides. TERM is deliberately absent from the PowerShell set:
 * the shipped pwsh executor does not set it, and a fake dumb terminal confuses
 * some Windows console programs.
 */
export const BASH_ENV_OVERRIDES = { ...ENV_OVERRIDES, TERM: "dumb" };

/**
 * UTF-8 output pinning prepended to every PowerShell command. The subprocess
 * collector decodes bytes as UTF-8 while PowerShell writes the console code
 * page (GBK here) by default, which turns Chinese output into mojibake.
 *
 * The LanguageMode guard matters under the confined read-only sandbox: that
 * token runs PowerShell in ConstrainedLanguage, where constructing
 * `[System.Text.UTF8Encoding]::new(...)` is blocked and would print two
 * `InvalidOperation` lines to stderr on EVERY call. The guard keeps the pin in
 * FullLanguage (danger-full-access / workspace-write) and degrades silently in
 * ConstrainedLanguage — where the type construction simply cannot exist, so
 * non-ASCII output stays code-page encoded. Matches the observed platform
 * baseline of the shipped pwsh tool, minus the noise.
 */
export const POWERSHELL_UTF8_PREAMBLE =
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false) }; ";

/**
 * Validate and normalize the caller's `shell` argument.
 * A missing/empty value means the configured default; an unknown value is an
 * error rather than a silent fallback, so a typo never runs in the wrong
 * terminal.
 * @param {unknown} value - raw `shell` argument.
 * @param {string} fallback - configured default backend.
 * @returns {string} one of {@link SHELLS}.
 */
export function normalizeShell(value, fallback = DEFAULT_SHELL) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const shell = String(value).trim().toLowerCase();
  if (!SHELLS.includes(shell)) {
    throw new Error(
      `invalid shell: ${JSON.stringify(value)} (expected one of ${SHELLS.join(", ")})`
    );
  }
  return shell;
}

/**
 * Treat a blank optional string as "not provided". Models routinely fill
 * optional string parameters with `""`; the shipped bash tool normalizes the
 * same way, and a blank value must never become a hard validation error.
 * @param {unknown} value - raw argument value.
 * @returns {string|undefined} the trimmed value, or undefined when blank.
 */
export function normalizeOptionalText(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  return value.trim().length === 0 ? undefined : value;
}

/** Whether a candidate executable can be spawned (reparse points included). */
export function candidateExists(candidate) {
  try {
    const stat = lstatSync(candidate);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) if (candidateExists(candidate)) return candidate;
  return undefined;
}

function pathEntries(env) {
  const path = env.PATH ?? env.Path ?? "";
  const delimiter = path.includes(";") ? ";" : ":";
  return path
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
}

/**
 * Well-known PowerShell locations, newest first, plus PATH entries, then
 * Windows PowerShell 5.1 as the last resort. Mirrors
 * `@deepseek-ai/dsh-pwsh-local` so both tools find the same executable.
 * @param {NodeJS.ProcessEnv} env - environment to probe.
 * @returns {string[]} candidate paths in resolution order.
 */
export function candidatePwshPaths(env = process.env) {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const localAppData = env.LOCALAPPDATA ?? "";
  const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];
  if (localAppData.length > 0) {
    candidates.push(join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe"));
  }
  for (const entry of pathEntries(env)) candidates.push(join(entry, "pwsh.exe"));
  candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  return candidates;
}

/**
 * Git for Windows locations, then PATH `bash.exe` entries EXCLUDING the
 * System32 launcher (`C:\Windows\System32\bash.exe` is the WSL forwarder, not
 * Git Bash).
 * @param {NodeJS.ProcessEnv} env - environment to probe.
 * @returns {string[]} candidate paths in resolution order.
 */
export function candidateGitBashPaths(env = process.env) {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = (env.SystemRoot ?? "C:\\Windows").toLowerCase();
  const localAppData = env.LOCALAPPDATA ?? "";
  const candidates = [
    join(programFiles, "Git", "bin", "bash.exe"),
    join(programFiles, "Git", "usr", "bin", "bash.exe")
  ];
  if (localAppData.length > 0) {
    candidates.push(join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  }
  for (const entry of pathEntries(env)) {
    if (entry.toLowerCase().includes(systemRoot)) continue; // WSL forwarder
    candidates.push(join(entry, "bash.exe"));
  }
  return candidates;
}

/**
 * Resolve the executable each backend spawns.
 *
 * An explicit config path is trusted as written. Otherwise the first existing
 * well-known location wins, and when nothing is found the bare command name is
 * returned so the provider's PATH lookup gets the final say — a backend is
 * never silently disabled just because it lives somewhere unexpected.
 *
 * @param {object} config - plugin config (may carry `pwshPath`/`gitBashPath`/`wslPath`).
 * @param {NodeJS.ProcessEnv} env - environment to probe.
 * @param {NodeJS.Platform} platform - target platform.
 * @returns {{pwsh: string, gitbash: string, wsl: string}} executable per backend.
 */
export function resolveExecutables(config = {}, env = process.env, platform = process.platform) {
  const configured = (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);
  const pwshConfigured = configured(config.pwshPath);
  const gitbashConfigured = configured(config.gitBashPath);
  const wslConfigured = configured(config.wslPath);
  if (platform !== "win32") {
    const which = (name) => {
      for (const entry of pathEntries(env)) {
        const candidate = join(entry, name);
        if (candidateExists(candidate)) return candidate;
      }
      return name;
    };
    return {
      pwsh: pwshConfigured ?? which("pwsh"),
      gitbash: gitbashConfigured ?? which("bash"),
      wsl: wslConfigured ?? "wsl"
    };
  }
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  return {
    pwsh: pwshConfigured ?? firstExisting(candidatePwshPaths(env)) ?? "pwsh.exe",
    gitbash: gitbashConfigured ?? firstExisting(candidateGitBashPaths(env)) ?? "bash.exe",
    wsl: wslConfigured ?? join(systemRoot, "System32", "wsl.exe")
  };
}

/**
 * The exact argv handed to the subprocess provider for one backend.
 * @param {string} shell - one of {@link SHELLS}.
 * @param {string} command - the caller's command text.
 * @param {{pwsh: string, gitbash: string, wsl: string}} executables - resolved executables.
 * @param {string} [distro] - WSL distribution name.
 * @returns {string[]} argv (no shell string interpolation happens here).
 */
export function buildArgv(shell, command, executables, distro) {
  switch (shell) {
    case "powershell":
      return [
        executables.pwsh,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${POWERSHELL_UTF8_PREAMBLE}${command}`
      ];
    case "gitbash":
      return [executables.gitbash, "-lc", command];
    case "wsl": {
      const distribution = typeof distro === "string" && distro.trim().length > 0 ? ["-d", distro.trim()] : [];
      return [executables.wsl, ...distribution, "-e", "bash", "-lc", command];
    }
    default:
      throw new Error(`invalid shell: ${JSON.stringify(shell)} (expected one of ${SHELLS.join(", ")})`);
  }
}

/**
 * Merge the model-friendly overrides and the trusted DSH_* snapshot over the
 * provider's scrubbed parent environment.
 *
 * WSL only forwards variables named in `WSLENV`, so every DSH_* key is
 * appended there (`VAR[/flag]` entries separated by `:`). Entries the parent
 * environment already carries are preserved: overwriting WSLENV would silently
 * drop the user's own forwarding rules.
 * @param {string} shell - backend whose boundary is being crossed.
 * @param {object} dshEnv - trusted `DSH_*` values from ctx.shellEnv.
 * @param {NodeJS.ProcessEnv} [parentEnv] - environment whose WSLENV is merged.
 * @returns {Record<string,string>} environment entries to merge.
 */
export function buildEnv(shell, dshEnv = {}, parentEnv = process.env) {
  const env = { ...(shell === "powershell" ? ENV_OVERRIDES : BASH_ENV_OVERRIDES), ...dshEnv };
  if (shell === "wsl") {
    const inherited = typeof parentEnv.WSLENV === "string" && parentEnv.WSLENV.length > 0
      ? parentEnv.WSLENV.split(":").filter((entry) => entry.length > 0)
      : [];
    const existing = [...inherited];
    const keys = Object.keys(dshEnv ?? {}).filter(
      (key) => key !== "WSLENV" && !existing.some((entry) => entry === key || entry.startsWith(`${key}/`))
    );
    if (keys.length > 0 || existing.length > 0) env.WSLENV = [...existing, ...keys].join(":");
  }
  return env;
}

/**
 * Resolve one `workdir` argument into what this backend can actually spawn in.
 *
 * - Absolute POSIX drive paths (`/c/Users/Admin`) become native (`C:/Users/Admin`)
 *   for gitbash/powershell so the provider can chdir there.
 * - A leading `~` expands to the user profile for gitbash/powershell.
 * - WSL accepts a native Windows path (wsl.exe maps it to /mnt/...) or an
 *   absolute Linux path; the latter cannot be a Windows spawn cwd, so it is
 *   returned as a Linux path and the caller prefixes `cd`.
 *
 * @param {string} shell - backend.
 * @param {string} workdir - absolute or session-relative directory.
 * @param {string} [base] - session directory for a relative path.
 * @param {NodeJS.ProcessEnv} [env] - environment for home expansion.
 * @returns {{cwd: string|undefined, prefix: string}} spawn cwd and any command prefix.
 */
export function resolveWorkdirForShell(shell, workdir, base, env = process.env) {
  if (typeof workdir !== "string" || workdir.trim().length === 0) {
    return { cwd: base, prefix: "" };
  }
  let target = workdir.trim();
  if (shell === "wsl") {
    if (target === "~") return { cwd: undefined, prefix: "cd ~ && " };
    if (target.startsWith("~/")) {
      // `~/'project'`: the tilde prefix ends at the unquoted slash, so bash
      // expands the home directory and the quoted remainder stays literal.
      return { cwd: undefined, prefix: `cd ~/${quotePosix(target.slice(2))} && ` };
    }
    if (target.startsWith("/") && !/^\/[a-zA-Z](\/|$)/.test(target)) {
      return { cwd: undefined, prefix: `cd ${quotePosix(target)} && ` };
    }
  }
  if (target === "~") {
    const home = env.USERPROFILE ?? env.HOME;
    if (typeof home !== "string" || home.length === 0) {
      throw new Error("cannot expand ~: neither USERPROFILE nor HOME is set; pass an absolute workdir");
    }
    target = home;
  } else if (target.startsWith("~/") || target.startsWith("~\\")) {
    const home = env.USERPROFILE ?? env.HOME;
    if (typeof home !== "string" || home.length === 0) {
      throw new Error("cannot expand ~: neither USERPROFILE nor HOME is set; pass an absolute workdir");
    }
    target = joinPath(home, target.slice(2));
  }
  if (base !== undefined && base.length > 0 && !isAbsoluteAny(target)) {
    return { cwd: joinPath(base, target), prefix: "" };
  }
  const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(target);
  if (drive !== null) target = `${drive[1].toUpperCase()}:${drive[2] ?? "/"}`;
  return { cwd: target, prefix: "" };
}

function isAbsoluteAny(value) {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

function joinPath(base, target) {
  const separator = base.includes("\\") ? "\\" : "/";
  if (/[\\/]$/.test(base)) return `${base}${target}`;
  return `${base}${separator}${target}`;
}

/** Quote one string as a single POSIX shell word. */
export function quotePosix(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Clamp the caller's timeout to the configured default/cap and Node's timer
 * bound. Requested values must be positive finite numbers; the cap is applied
 * silently because a cap that rejects calls is worse than a cap that bounds
 * them.
 * @param {unknown} requested - caller timeout in ms.
 * @param {number} fallback - default timeout in ms.
 * @param {number} max - configured maximum in ms.
 * @param {string} label - error label.
 * @returns {number} effective timeout in ms.
 */
export function clampTimeout(requested, fallback, max, label = "timeoutMs") {
  const value = requested === undefined ? fallback : requested;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid ${label}: expected a positive number, got ${JSON.stringify(requested)}`);
  }
  const cap = Math.min(Number.isFinite(max) && max > 0 ? max : NODE_TIMER_MAX, NODE_TIMER_MAX);
  return Math.min(value, cap);
}

/**
 * Validate the numeric plugin configuration before the tool starts serving.
 * A bad value (notably a non-positive output bound) must fail here with the
 * field name instead of throwing inside a stream callback later.
 * @param {object} settings - merged plugin settings.
 * @returns {object} the same settings, validated.
 */
export function validateSettings(settings) {
  for (const key of ["timeoutMs", "maxTimeoutMs", "maxOutputBytes", "maxSpillBytes", "graceMs"]) {
    const value = settings[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`multi-shell: config ${key} must be a positive finite number, got ${JSON.stringify(value)}`);
    }
  }
  if (settings.graceMs > NODE_TIMER_MAX) {
    throw new Error(`multi-shell: config graceMs must be no greater than ${NODE_TIMER_MAX}`);
  }
  if (!SHELLS.includes(settings.defaultShell)) {
    throw new Error(
      `multi-shell: config defaultShell must be one of ${SHELLS.join(", ")}, got ${JSON.stringify(settings.defaultShell)}`
    );
  }
  return settings;
}

/**
 * Fuse the caller's abort signal with a wall-clock deadline. The FIRST cause
 * wins: once the call was cancelled, a later timer tick no longer reports a
 * timeout (mirrors `dsh-timeout`'s first-cause rule the shipped executors use).
 * @param {AbortSignal|undefined} caller - tool call signal.
 * @param {number} timeoutMs - deadline in milliseconds.
 * @returns {{signal: AbortSignal, timedOut: () => boolean, aborted: () => boolean, dispose: () => void}} fused signal.
 */
export function createDeadline(caller, timeoutMs) {
  const controller = new AbortController();
  let cause;
  let disposed = false;
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    cause = "timeout";
    controller.abort(new Error("SHELL_TIMEOUT"));
  }, Math.min(timeoutMs, NODE_TIMER_MAX));
  timer.unref?.();
  const onCallerAbort = () => {
    if (controller.signal.aborted) return;
    cause = "caller";
    controller.abort(caller?.reason);
  };
  if (caller !== undefined) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => cause === "timeout",
    aborted: () => cause === "caller",
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    }
  };
}
