import assert from "node:assert/strict";
import test from "node:test";

import {
  BASH_ENV_OVERRIDES,
  DEFAULT_SHELL,
  ENV_OVERRIDES,
  NODE_TIMER_MAX,
  POWERSHELL_UTF8_PREAMBLE,
  SHELLS,
  buildArgv,
  buildEnv,
  candidateGitBashPaths,
  candidatePwshPaths,
  clampTimeout,
  createDeadline,
  normalizeOptionalText,
  normalizeShell,
  quotePosix,
  resolveExecutables,
  resolveWorkdirForShell,
  validateSettings
} from "../lib/shells.js";

const FAKE_ENV = {
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
  SystemRoot: "C:\\Windows",
  USERPROFILE: "C:\\Users\\Admin",
  PATH: ["C:\\Program Files\\Git\\cmd", "C:\\Windows\\System32", "C:\\Tools"].join(";")
};

test("normalizeShell defaults and rejects typos", () => {
  assert.equal(normalizeShell(undefined), DEFAULT_SHELL);
  assert.equal(normalizeShell(""), DEFAULT_SHELL);
  assert.equal(normalizeShell("   "), DEFAULT_SHELL);
  assert.equal(normalizeShell(null), DEFAULT_SHELL);
  assert.equal(normalizeShell("PowerShell"), "powershell");
  assert.equal(normalizeShell("gitbash", "wsl"), "gitbash");
  assert.equal(normalizeShell(undefined, "wsl"), "wsl");
  assert.throws(() => normalizeShell("cmd"), /invalid shell/);
  assert.deepEqual(SHELLS, ["gitbash", "powershell", "wsl"]);
  assert.equal(DEFAULT_SHELL, "gitbash");
});

test("normalizeOptionalText treats blank strings as absent", () => {
  assert.equal(normalizeOptionalText(undefined), undefined);
  assert.equal(normalizeOptionalText(null), undefined);
  assert.equal(normalizeOptionalText(""), undefined);
  assert.equal(normalizeOptionalText("   "), undefined);
  assert.equal(normalizeOptionalText("Debian"), "Debian");
  assert.equal(normalizeOptionalText("  Debian  "), "  Debian  ");
  assert.equal(normalizeOptionalText(42), 42);
});

test("candidate ordering prefers PowerShell 7 and Store alias before PATH / 5.1", () => {
  const candidates = candidatePwshPaths(FAKE_ENV);
  assert.equal(candidates[0], "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(candidates[1], "C:\\Users\\Admin\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe");
  assert.ok(candidates.includes("C:\\Program Files\\Git\\cmd\\pwsh.exe"));
  assert.equal(candidates.at(-1), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("git bash candidates never trust the System32 WSL forwarder", () => {
  const candidates = candidateGitBashPaths(FAKE_ENV);
  assert.equal(candidates[0], "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.ok(candidates.includes("C:\\Tools\\bash.exe"));
  assert.ok(!candidates.some((candidate) => candidate.toLowerCase().includes("system32")));
});

test("resolveExecutables honors explicit paths and falls back without hiding a backend", () => {
  const configured = resolveExecutables(
    { pwshPath: "D:\\pwsh.exe", gitBashPath: "D:\\bash.exe", wslPath: "D:\\wsl.exe" },
    FAKE_ENV,
    "win32"
  );
  assert.deepEqual(configured, { pwsh: "D:\\pwsh.exe", gitbash: "D:\\bash.exe", wsl: "D:\\wsl.exe" });

  const fallback = resolveExecutables(
    {},
    { PATH: "", SystemRoot: "X:\\Win", ProgramFiles: "X:\\PF" },
    "win32"
  );
  // Nothing exists under those fake roots, so the bare names keep PATH lookup in play.
  assert.equal(fallback.pwsh, "pwsh.exe");
  assert.equal(fallback.gitbash, "bash.exe");
  assert.equal(fallback.wsl, "X:\\Win\\System32\\wsl.exe");
});

test("buildArgv emits the exact shell invocation per backend", () => {
  const exes = { pwsh: "C:\\pwsh.exe", gitbash: "C:\\bash.exe", wsl: "C:\\wsl.exe" };

  assert.deepEqual(buildArgv("gitbash", "ls -la", exes), ["C:\\bash.exe", "-lc", "ls -la"]);

  const powershell = buildArgv("powershell", "Get-ChildItem", exes);
  assert.deepEqual(powershell.slice(0, 5), [
    "C:\\pwsh.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command"
  ]);
  assert.equal(powershell[5], `${POWERSHELL_UTF8_PREAMBLE}Get-ChildItem`);
  // The constrained-language guard must stay in front of the UTF-8 pin: the
  // read-only Windows sandbox cannot construct an Encoding instance
  // (method invocation is blocked), and an unguarded pin fails on every call.
  assert.match(powershell[5], /LanguageMode -ne 'ConstrainedLanguage'/);

  assert.deepEqual(buildArgv("wsl", "ls /mnt/c", exes), ["C:\\wsl.exe", "-e", "bash", "-lc", "ls /mnt/c"]);
  assert.deepEqual(buildArgv("wsl", "ls", exes, " Debian "), [
    "C:\\wsl.exe",
    "-d",
    "Debian",
    "-e",
    "bash",
    "-lc",
    "ls"
  ]);

  assert.throws(() => buildArgv("cmd", "dir", exes), /invalid shell/);
});

test("buildEnv merges overrides, keeps parent WSLENV, and forwards DSH_* across the WSL boundary", () => {
  const plain = buildEnv("gitbash", { DSH_SESSION_ID: "session-1" }, {});
  assert.equal(plain.NO_COLOR, ENV_OVERRIDES.NO_COLOR);
  assert.equal(plain.TERM, "dumb");
  assert.equal(plain.DSH_SESSION_ID, "session-1");
  assert.equal(plain.WSLENV, undefined);

  const powershell = buildEnv("powershell", {}, {});
  assert.equal(powershell.NO_COLOR, ENV_OVERRIDES.NO_COLOR);
  assert.equal(powershell.TERM, undefined, "the shipped pwsh executor does not set TERM");

  const wsl = buildEnv("wsl", { DSH_SESSION_ID: "session-1", DSH_PROFILE: "desktop" }, {});
  assert.equal(wsl.WSLENV, "DSH_SESSION_ID:DSH_PROFILE");

  const inherited = buildEnv("wsl", { DSH_SESSION_ID: "s" }, { WSLENV: "EXISTING:DSH_SESSION_ID" });
  assert.equal(inherited.WSLENV, "EXISTING:DSH_SESSION_ID");

  const merged = buildEnv("wsl", { DSH_SESSION_ID: "s" }, { WSLENV: "EXISTING" });
  assert.equal(merged.WSLENV, "EXISTING:DSH_SESSION_ID");

  assert.equal(BASH_ENV_OVERRIDES.TERM, "dumb");
});

test("resolveWorkdirForShell converts POSIX drive paths and resolves relative paths", () => {
  const posix = resolveWorkdirForShell("gitbash", "/c/Users/Admin", "C:\\Users\\Admin", FAKE_ENV);
  assert.deepEqual(posix, { cwd: "C:/Users/Admin", prefix: "" });

  const relative = resolveWorkdirForShell("powershell", "sub dir", "C:\\Users\\Admin", FAKE_ENV);
  assert.deepEqual(relative, { cwd: "C:\\Users\\Admin\\sub dir", prefix: "" });

  const home = resolveWorkdirForShell("gitbash", "~/project", "C:\\Users\\Admin", FAKE_ENV);
  assert.equal(home.cwd, "C:\\Users\\Admin\\project");

  const wslWindows = resolveWorkdirForShell("wsl", "C:\\Users\\Admin", "C:\\Users\\Admin", FAKE_ENV);
  assert.deepEqual(wslWindows, { cwd: "C:\\Users\\Admin", prefix: "" });

  const wslLinux = resolveWorkdirForShell("wsl", "/home/admin/project", "C:\\Users\\Admin", FAKE_ENV);
  assert.deepEqual(wslLinux, { cwd: undefined, prefix: "cd '/home/admin/project' && " });

  const wslHome = resolveWorkdirForShell("wsl", "~/project", "C:\\Users\\Admin", FAKE_ENV);
  assert.deepEqual(wslHome, { cwd: undefined, prefix: "cd ~/'project' && " });

  const wslHomeBare = resolveWorkdirForShell("wsl", "~", "C:\\Users\\Admin", FAKE_ENV);
  assert.deepEqual(wslHomeBare, { cwd: undefined, prefix: "cd ~ && " });

  assert.throws(
    () => resolveWorkdirForShell("gitbash", "~/x", "C:\\Users\\Admin", {}),
    /cannot expand ~/
  );
});

test("quotePosix survives single quotes", () => {
  assert.equal(quotePosix("a b"), "'a b'");
  assert.equal(quotePosix("it's"), "'it'\\''s'");
});

test("clampTimeout applies defaults, caps, and rejects nonsense", () => {
  assert.equal(clampTimeout(undefined, 1000, 5000), 1000);
  assert.equal(clampTimeout(2000, 1000, 5000), 2000);
  assert.equal(clampTimeout(9000, 1000, 5000), 5000);
  assert.equal(clampTimeout(Number.MAX_SAFE_INTEGER, 1000, Number.MAX_SAFE_INTEGER), NODE_TIMER_MAX);
  assert.throws(() => clampTimeout(0, 1000, 5000), /invalid/);
  assert.throws(() => clampTimeout("10", 1000, 5000), /invalid/);
});

test("validateSettings rejects a non-positive output bound and bad defaults", () => {
  const base = {
    defaultShell: "gitbash",
    timeoutMs: 1000,
    maxTimeoutMs: 2000,
    maxOutputBytes: 1024,
    maxSpillBytes: 4096,
    graceMs: 3000,
    enableRunInBackground: true
  };
  assert.deepEqual(validateSettings({ ...base }), base);
  assert.throws(() => validateSettings({ ...base, maxOutputBytes: -1 }), /maxOutputBytes/);
  assert.throws(() => validateSettings({ ...base, graceMs: 0 }), /graceMs/);
  assert.throws(() => validateSettings({ ...base, defaultShell: "cmd" }), /defaultShell/);
});

test("createDeadline keeps the FIRST cause", async () => {
  const caller = new AbortController();
  const deadline = createDeadline(caller.signal, 60_000);
  caller.abort(new Error("caller"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(deadline.timedOut(), false);
  assert.equal(deadline.aborted(), true);
  deadline.dispose();

  const timed = createDeadline(undefined, 10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(timed.timedOut(), true);
  assert.equal(timed.aborted(), false);
  timed.dispose();
});
