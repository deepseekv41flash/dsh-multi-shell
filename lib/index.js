// dsh-multi-shell — one model-facing `shell` tool, three Windows terminals.
//
// Unlike dsh-bash-terminal (which obeys a USER-chosen terminal and cannot be
// switched per call), this tool lets the MODEL pick the backend on every call:
//
//   shell: "gitbash"    Git for Windows bash -lc          (default; POSIX)
//   shell: "powershell" pwsh -NoLogo -NoProfile -NonInteractive -Command (native)
//   shell: "wsl"        wsl [-d <distro>] -e bash -lc     (Linux)
//
// Design notes (why this file looks the way it does):
//
// - No version gate of its own. The manifest declares only `peerDependencies`
//   names with `*` ranges, so a DSH update never turns the plugin off by
//   version arithmetic. There is no settings-service registration (that API
//   moved twice upstream) and no build step at all: the package is plain ESM
//   and the host resolves the `@deepseek-ai/*` imports through its own
//   profile runtime resolution.
// - Optional seams are resolved at call time through `ctx.get(...)` instead of
//   being hard `inject` dependencies, so a renamed/absent optional service
//   degrades one call (with a teaching error) rather than failing the fiber at
//   load and taking the whole tool offline.
// - The only hard dependency is the tools registry plus the four small,
//   long-stable packages used by the shipped bash/pwsh tools for the same
//   jobs: tool definition, abort error, sandbox escalation vocabulary, and the
//   exit-status marker parser.
//
// Command execution mirrors the shipped executors: everything goes through
// `ctx.subprocess.spawn` (process-tree termination, SIGTERM→grace→SIGKILL,
// spill files) and background work goes through `ctx.jobs`. Confined modes
// wrap PowerShell argv through `ctx.sandbox.confine` (fail-closed); Git Bash
// and WSL run unconfined because the Windows ACL restricted-token runner
// cannot host MSYS2 (bash aborts with CreateFileMapping Win32 error 5) and WSL
// is already its own isolation boundary.

import { statSync } from "node:fs";
import { defineTool, TOOL_ABORTED } from "@deepseek-ai/dsh-tools";
import {
  ESCALATION_TARGETS,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
  classifyRunnerFailure,
  matchesSignature
} from "@deepseek-ai/dsh-sandbox";
import { parseExitStatus } from "@deepseek-ai/dsh-shell";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import {
  DEFAULT_SHELL,
  SHELLS,
  createDeadline,
  buildArgv,
  buildEnv,
  clampTimeout,
  normalizeOptionalText,
  normalizeShell,
  resolveExecutables,
  resolveWorkdirForShell,
  validateSettings
} from "./shells.js";

/** Stable Cordis plugin name. */
export const name = "multi-shell";

/** Only the tools registry is a hard dependency; every other seam is optional at call time. */
export const inject = ["tools"];

/** Tool name registered on the tools registry. */
export const TOOL_NAME = "shell";

/** Plugin defaults; a profile patch may override every one of them. */
export const DEFAULTS = {
  defaultShell: DEFAULT_SHELL,
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64 * 1024,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 3_000,
  enableRunInBackground: true
};

/** Timeout code stamped on the deadline for diagnostics. */
// (kept in shells.js: createDeadline owns the first-cause classification)
// ---- model-facing text --------------------------------------------------------

const SHELL_LEAD = {
  gitbash:
    "gitbash = Git for Windows `bash -lc` (POSIX syntax; paths like `/c/Users/Admin`; environment variables via `$NAME`)",
  powershell:
    "powershell = `pwsh -NoLogo -NoProfile -NonInteractive -Command` (native Windows paths `C:\\...`; environment variables via `$env:NAME`)",
  wsl: "wsl = `wsl [-d <distro>] -e bash -lc` (Linux syntax; Windows files under `/mnt/c/...`; environment variables via `$NAME`)"
};

/**
 * Render the model-facing tool description. The default backend is stated up
 * front so a call that omits `shell` never has to guess which syntax applies.
 * @param {boolean} background - whether run_in_background is available.
 * @param {string} [defaultShell] - configured default backend.
 * @returns {string} the tool description.
 */
export function toolDescription(background, defaultShell = DEFAULT_SHELL) {
  const fallback = SHELLS.includes(defaultShell) ? defaultShell : DEFAULT_SHELL;
  const base = [
    "Execute one terminal command through the backend given by `shell` and return its stdout/stderr.",
    `Backends: ${SHELL_LEAD.gitbash}; ${SHELL_LEAD.powershell}; ${SHELL_LEAD.wsl}.`,
    `\`shell\` defaults to ${fallback}; choose powershell for Windows-native tooling/.NET and wsl for Linux tooling. Each call spawns a fresh shell: no state (cwd, variables, aliases) persists between calls — pass \`workdir\` instead of using \`cd\`.`,
    "Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available.",
    "Confined modes (read-only / workspace-write) wrap the powershell backend through the DSH sandbox and deny fail-closed; gitbash and wsl run unconfined (the Windows sandbox runner cannot start MSYS2, and WSL is its own isolation), and their results say so when the session is confined.",
    "Admin PowerShell: when the host runs Sudo for Windows in inline mode (`sudo config` reports 内联/inline), elevate from the gitbash backend with `MSYS_NO_PATHCONV=1 sudo --disable-input pwsh -NoProfile -NonInteractive -Command '<script>' </dev/null`. Every call prompts UAC once, there is no credential cache, and this tool cannot kill the elevated process — the script must enforce its own timeout and cleanup. Do not try to click the UAC prompt with UI automation; stay unprivileged when the task does not truly need admin."
  ].join(" ");
  if (!background) return base;
  return (
    base +
    " Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with job_output and stop it with job_kill. No timeout applies to background runs."
  );
}

const WORKDIR_DESCRIPTION =
  "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it. gitbash/powershell take a Windows path (native `C:\\...` or `/c/...`); wsl takes a Windows path (mapped to `/mnt/...`) or an absolute Linux path.";

const TIMEOUT_DESCRIPTION =
  "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.";

// ---- small runtime helpers ----------------------------------------------------

/**
 * True for values that mean "this call was cancelled" rather than "the command
 * failed". Mirrors the shipped shell tools so the tool runtime classifies the
 * call as aborted instead of an execution error.
 * @param {AbortSignal} signal - fused execution signal.
 * @returns {HarnessError} the abort error to throw.
 */
function toolAborted(signal) {
  const error = new HarnessError("tool call aborted", TOOL_ABORTED);
  error.name = "AbortError";
  if (signal?.reason !== undefined && error.cause === undefined) error.cause = signal.reason;
  return error;
}

/** Project one collect-mode reader into the canonical result stream shape. */
function finalOutput(reader) {
  const read = reader.readFrom(0);
  return {
    text: read.text,
    truncated: read.lossy === true,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {})
  };
}

/** The executor's own request: both collect readers exist by construction. */
function collectedOutput(handle) {
  const { stdout, stderr } = handle.collected;
  if (stdout === undefined || stderr === undefined) {
    throw new Error("multi-shell: the subprocess provider dropped a requested collect stream");
  }
  return { stdout, stderr };
}

/** Fully-specified subprocess spawn request for one backend. */
function spawnSpec({ argv, cwd, env, signal, maxOutputBytes, maxSpillBytes, graceMs }) {
  const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: maxSpillBytes } });
  return {
    argv,
    cwd,
    stdio: {
      stdin: "ignore",
      stdout: collect(maxOutputBytes),
      stderr: collect(Math.min(maxOutputBytes, 64 * 1024))
    },
    graceMs,
    signal,
    env
  };
}

/**
 * Run one command in the foreground, bounded by the deadline.
 *
 * A rejection from `done` is not always an infrastructure failure: the
 * subprocess provider also rejects it when the deadline or the caller
 * cancelled during the launch handshake. Those two cases must resolve as
 * timed-out/aborted results, exactly like the shipped executor classifies its
 * own launch window.
 * @returns foreground facts (never rejects for a non-zero exit or a cancellation).
 */
async function runForeground(subprocess, spec, signal, timeoutMs) {
  const deadline = createDeadline(signal, timeoutMs);
  try {
    let handle;
    try {
      handle = subprocess.spawn({ ...spec, signal: deadline.signal });
    } catch (error) {
      throw new Error(`multi-shell: failed to start ${spec.label ?? "the command"}: ${String(error)}`);
    }
    const emptyStreams = () => ({
      stdout: { text: "", truncated: false },
      stderr: { text: "", truncated: false }
    });
    let outcome;
    try {
      outcome = await handle.done;
    } catch (error) {
      const timedOut = deadline.timedOut();
      const aborted = !timedOut && (deadline.aborted() || signal?.aborted === true);
      if (timedOut || aborted) {
        return {
          exitCode: null,
          signal: null,
          timedOut,
          aborted,
          timeoutMs,
          ...emptyStreams()
        };
      }
      throw new Error(
        `multi-shell: ${spec.label ?? "the command"} failed to start or run: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const collected = collectedOutput(handle);
    const timedOut = deadline.timedOut();
    const aborted = !timedOut && (deadline.aborted() || signal?.aborted === true);
    return {
      exitCode: outcome.exitCode ?? null,
      signal: outcome.signal ?? null,
      timedOut,
      aborted,
      timeoutMs,
      stdout: finalOutput(collected.stdout),
      stderr: finalOutput(collected.stderr)
    };
  } finally {
    deadline.dispose();
  }
}

/**
 * Start one command for a background job. The process is spawned inside the
 * job starter (after admission) and only job cancellation kills it.
 */
function startBackground(subprocess, spec, sandboxFacts) {
  const controller = new AbortController();
  const running = subprocess.spawn({ ...spec, signal: controller.signal });
  const collected = collectedOutput(running);
  const proc = {
    status: "running",
    exitCode: null,
    signal: null,
    failure: undefined,
    sandbox: sandboxFacts,
    done: running.done.then(
      (outcome) => {
        if (proc.status === "running") {
          proc.status = outcome.signal !== null ? "killed" : "completed";
        }
        proc.exitCode = outcome.exitCode ?? null;
        proc.signal = outcome.signal ?? null;
      },
      (error) => {
        proc.status = "failed";
        proc.failure = error instanceof Error ? error.message : String(error);
      }
    ),
    readStream: (channel, offset) =>
      (channel === "stderr" ? collected.stderr : collected.stdout).readFrom(offset),
    kill: () => {
      if (proc.status !== "running") return false;
      proc.status = "killed";
      controller.abort(new Error("job cancelled"));
      running.terminate();
      return true;
    }
  };
  return proc;
}

/** Registry pull sources for one background job (absolute-offset readers). */
function backgroundSources(live) {
  const source = (channel) => ({
    channel,
    read: (fromByte) => {
      const proc = live.proc;
      if (proc === undefined) return { text: "", nextOffset: fromByte, lossy: false };
      return proc.readStream(channel, fromByte);
    }
  });
  return [source("stdout"), source("stderr")];
}

/** Map a settled background process onto the generic job-outcome vocabulary. */
function processOutcome(proc) {
  const base =
    proc.status === "failed"
      ? { status: "failed", detail: proc.failure ?? "failed before exit" }
      : proc.status === "killed"
        ? {
            status: "killed",
            detail: proc.signal !== null ? `signal: ${proc.signal}` : "killed before exit"
          }
        : { status: "completed", detail: `exit code: ${proc.exitCode ?? 0}` };
  if (proc.runnerFailed !== undefined) {
    return {
      ...base,
      detail: `${base.detail}; [sandbox: runner failed under ${proc.sandbox?.mode ?? "the confined mode"} — the command did not run: ${proc.runnerFailed}]`
    };
  }
  return base;
}

// ---- rendering ---------------------------------------------------------------

function streamText(output) {
  if (!output.truncated) return output.text;
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`;
}

/** Model-facing text for a finished foreground run (bash-tool compatible markers). */
export function renderResult(result, escalationModes = []) {
  let body = streamText(result.stdout);
  const err = streamText(result.stderr);
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = "(no output)";
  const markers = [];
  if (result.sandbox?.unconfined === true && result.sandbox.mode !== "danger-full-access") {
    markers.push(
      `[sandbox: ${result.sandbox.backend ?? "this backend"} runs unconfined under ${result.sandbox.mode} — file effects are not restricted by the DSH file sandbox]`
    );
  }
  if (result.sandbox?.denied === true) {
    markers.push(sandboxDenialMarker(result.sandbox.mode));
    if (escalationModes.length > 0) markers.push(escalationHintMarker("command"));
  }
  if (result.sandbox?.runnerFailed === true) {
    markers.push(
      `[sandbox: the sandbox runner itself failed under ${result.sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`
    );
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
  // The exit marker stays last even for timeouts: parseExitStatus (the terminal
  // card's inverse) reads the final line, and a missing marker would render the
  // killed run as a successful exit 0.
  else if (result.exitCode !== null && result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`);
  }
  if (markers.length === 0) return body;
  if (!body.endsWith("\n")) body += "\n";
  return body + markers.join("\n");
}

function canonicalForeground(result, { shell, cwd }) {
  const output = (stream) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {})
  });
  return {
    kind: "foreground",
    shell,
    cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...(result.sandbox !== undefined ? { sandbox: result.sandbox } : {})
  };
}

// ---- sandbox plumbing ---------------------------------------------------------

/**
 * Resolve the standing sandbox policy for this call, when the composition has
 * one. Absent sandboxPolicy means "this deployment does not confine commands",
 * which is reported honestly instead of being guessed.
 */
function standingPolicy(ctx, exec) {
  const policyService = ctx.get("sandboxPolicy");
  if (policyService === undefined || typeof policyService.resolve !== "function") return undefined;
  const request = exec.agent !== undefined ? { session: exec.agent.session } : {};
  return policyService.resolve(request);
}

/**
 * Wrap the spawn argv for the backend's enforcement story.
 *
 * - powershell under a confined mode: `ctx.sandbox.confine` (fail closed when
 *   no provider is mounted);
 * - powershell under danger-full-access: unconfined, no runner;
 * - gitbash / wsl: unconfined by design, reported with an explicit
 *   enforcement tag so results never imply confinement that did not happen.
 */
async function confineSpawn(ctx, argv, policy, shell, signal) {
  if (policy === undefined) {
    return { argv, sandbox: undefined };
  }
  if (shell !== "powershell") {
    return {
      argv,
      sandbox: {
        mode: policy.mode,
        backend: shell,
        enforcement: shell === "wsl" ? "wsl-isolation" : "gitbash-unconfined",
        unconfined: true
      }
    };
  }
  if (policy.mode === "danger-full-access") {
    return { argv, sandbox: { mode: policy.mode } };
  }
  const sandbox = ctx.get("sandbox");
  if (sandbox === undefined || typeof sandbox.confine !== "function") {
    throw new Error(
      `multi-shell: the session runs under the ${policy.mode} sandbox but no sandbox provider is mounted; refusing to run the PowerShell command unconfined. Switch the session to danger-full-access to run it.`
    );
  }
  let confined;
  try {
    confined = await sandbox.confine(argv, policy, signal);
  } catch (error) {
    throw new Error(
      `multi-shell: the sandbox provider could not confine this PowerShell command under ${policy.mode} mode: ${error instanceof Error ? error.message : String(error)}. The command did not run.`
    );
  }
  return {
    argv: confined.argv,
    sandbox: {
      mode: policy.mode,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureRules: confined.runnerFailureRules
    }
  };
}

// ---- arguments ----------------------------------------------------------------

/**
 * Normalize the raw tool arguments before validation: blank optional strings
 * become "not provided" (models fill optional fields with `""`), and the
 * command/description are trimmed only for the empty check.
 * @param {object} args - raw tool arguments.
 * @returns {object} normalized arguments.
 */
function normalizeArguments(args) {
  return {
    ...args,
    shell: normalizeOptionalText(args.shell),
    distro: normalizeOptionalText(args.distro),
    workdir: normalizeOptionalText(args.workdir),
    sandbox_permissions: normalizeOptionalText(args.sandbox_permissions),
    justification: normalizeOptionalText(args.justification)
  };
}

function validateArguments(args) {
  if (typeof args.command !== "string" || args.command.trim().length === 0) {
    throw new Error("invalid command: expected a non-empty string");
  }
  if (typeof args.description !== "string" || args.description.trim().length === 0) {
    throw new Error("invalid description: expected a non-empty string");
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
  }
  if (args.distro !== undefined && (typeof args.distro !== "string" || args.distro.trim().length === 0)) {
    throw new Error("invalid distro: expected a non-empty string");
  }
}

// ---- plugin -------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const settings = validateSettings({ ...DEFAULTS, ...(config ?? {}) });
  const backgroundEnabled = settings.enableRunInBackground !== false;
  const escalationModes = [...ESCALATION_TARGETS];
  const defaultShell = settings.defaultShell;

  /** Resolve the session's current directory without making it a hard dependency. */
  const sessionCwd = async (exec) => {
    const workingDirectory = ctx.get("workingDirectory");
    try {
      if (workingDirectory !== undefined && typeof workingDirectory.ensure === "function" && exec.agent !== undefined) {
        const ensured = await workingDirectory.ensure(exec.agent, exec.signal);
        if (typeof ensured === "string" && ensured.length > 0) return ensured;
      }
    } catch {
      /* fall through to the session header */
    }
    const header = exec.agent?.session?.header?.cwd;
    if (typeof header === "string" && header.length > 0) return header;
    return process.cwd();
  };

  /** Tools-registry contribution; rebuilt when the optional jobs service appears/disappears. */
  const buildTool = (jobs) => {
    const background = backgroundEnabled && jobs !== undefined;
    return defineTool({
      name: TOOL_NAME,
      description: toolDescription(background, defaultShell),
      parameters: {
        command: {
          type: "string",
          required: true,
          description:
            "The command to execute in the selected terminal. Write syntax that matches the chosen backend."
        },
        description: {
          type: "string",
          required: true,
          description:
            "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" -> \"List files in current directory\"; \"git status\" -> \"Show working tree status\"; \"npm install\" -> \"Install package dependencies\"."
        },
        shell: {
          type: "string",
          enum: [...SHELLS],
          description: `Terminal backend for this call: gitbash (POSIX), powershell (native Windows), or wsl (Linux). Omit to use the configured default (${defaultShell}).`
        },
        distro: {
          type: "string",
          description: "WSL distribution name; only valid with shell=wsl. Defaults to the system default distribution."
        },
        workdir: { type: "string", description: WORKDIR_DESCRIPTION },
        timeoutMs: { type: "number", description: TIMEOUT_DESCRIPTION },
        ...(background
          ? {
              run_in_background: {
                type: "boolean",
                description:
                  "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
              }
            }
          : {}),
        sandbox_permissions: {
          type: "string",
          enum: escalationModes,
          description: sandboxPermissionsDescription("command") + " Only meaningful with shell=powershell."
        },
        justification: {
          type: "string",
          description:
            "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user’s current request."
        }
      },
      output: {
        schema: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "background" },
                jobId: { type: "string", required: true },
                shell: { type: "string", required: true },
                cwd: { type: "string", required: true }
              }
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "foreground" },
                shell: { type: "string", required: true },
                cwd: { type: "string", required: true },
                exitCode: { required: true, oneOf: [{ type: "integer" }, { type: "null" }] },
                signal: { required: true, oneOf: [{ type: "string" }, { type: "null" }] },
                timedOut: { type: "boolean", required: true },
                aborted: { type: "boolean", required: true },
                timeoutMs: { type: "number", required: true },
                sandbox: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    mode: { type: "string", required: true },
                    enforcement: { type: "string" },
                    backend: { type: "string" },
                    unconfined: { type: "boolean" },
                    denied: { type: "boolean", required: true },
                    runnerFailed: { type: "boolean" }
                  }
                },
                stdout: {
                  type: "object",
                  additionalProperties: false,
                  required: true,
                  properties: {
                    text: { type: "string", required: true },
                    truncated: { type: "boolean", required: true },
                    spillPath: { type: "string" }
                  }
                },
                stderr: {
                  type: "object",
                  additionalProperties: false,
                  required: true,
                  properties: {
                    text: { type: "string", required: true },
                    truncated: { type: "boolean", required: true },
                    spillPath: { type: "string" }
                  }
                }
              }
            }
          ]
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.kind === "background"
                ? `started background job ${value.jobId}`
                : renderResult(value, escalationModes)
          }
        ],
        presentationMeta: (_args, value) => ({ cwd: value.cwd })
      },
      async execute(rawArgs, exec) {
        const args = normalizeArguments(rawArgs);
        validateArguments(args);
        const shell = normalizeShell(args.shell, defaultShell);
        if (args.distro !== undefined && shell !== "wsl") {
          throw new Error("invalid distro: only valid together with shell=wsl");
        }
        if (args.justification !== undefined && args.sandbox_permissions === undefined) {
          throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
        }
        if (args.sandbox_permissions !== undefined && shell !== "powershell") {
          throw new Error(
            "invalid escalation: gitbash and wsl are not confined by the Windows sandbox, so there is nothing to escalate — run the command without sandbox_permissions, or use shell=powershell for the confined surface"
          );
        }
        if (exec.signal?.aborted) throw toolAborted(exec.signal);
        if (args.run_in_background === true && !background) {
          throw new Error(
            backgroundEnabled
              ? "run_in_background is unavailable in this composition (no job registry is mounted); run the command in the foreground"
              : "run_in_background is disabled for this deployment (enableRunInBackground: false); run the command in the foreground"
          );
        }
        const executables = resolveExecutables(settings, process.env, process.platform);
        const subprocess = ctx.get("subprocess");
        if (subprocess === undefined || typeof subprocess.spawn !== "function") {
          throw new Error(
            "multi-shell: the subprocess service is not mounted in this composition, so no command can be started"
          );
        }
        const base = await sessionCwd(exec);
        const { cwd, prefix } = resolveWorkdirForShell(shell, args.workdir, base, process.env);
        if (cwd !== undefined) {
          let directory = false;
          try {
            directory = statSync(cwd).isDirectory();
          } catch {
            directory = false;
          }
          if (!directory) {
            if (shell !== "wsl" && cwd.startsWith("/") && !/^\/[a-zA-Z](\/|$)/.test(cwd)) {
              throw new Error(
                `working directory not found: ${JSON.stringify(cwd)}; use a Windows path (C:\\...) or an MSYS drive path (/c/...) for the ${shell} backend`
              );
            }
            throw new Error(`working directory not found: ${JSON.stringify(cwd)}`);
          }
        }
        const command = `${prefix}${args.command}`;
        const dshEnv = typeof ctx.get("shellEnv")?.collect === "function" ? ctx.get("shellEnv").collect(exec) : {};
        const env = buildEnv(shell, dshEnv);
        let policy = standingPolicy(ctx, exec);
        if (args.sandbox_permissions !== undefined) {
          if (policy === undefined) {
            throw new Error(
              "invalid escalation: this composition has no sandbox policy service, so sandbox_permissions cannot be approved"
            );
          }
          if (args.sandbox_permissions === policy.mode) {
            // Asking for the mode the session already runs under is a no-op,
            // not an escalation: the shipped bash tool accepts it without an
            // approval prompt, and so do we.
          } else {
            validateEscalationArgs(args.sandbox_permissions, args.justification);
            const approver = ctx.get("approval");
            if (approver === undefined) {
              throw new Error(
                "invalid escalation: no approval channel is mounted in this composition, so sandbox_permissions cannot be approved"
              );
            }
            const approvedMode = await approveEscalation(
              {
                requestedMode: args.sandbox_permissions,
                justification: args.justification,
                effectiveMode: policy.mode,
                subject: "command"
              },
              {
                approver,
                agent: exec.agent,
                callId: exec.callId,
                toolName: TOOL_NAME,
                signal: exec.signal
              }
            );
            policy = { ...policy, mode: approvedMode };
          }
        }
        const argv0 = buildArgv(shell, command, executables, args.distro);
        if (argv0[0] === undefined || argv0[0].length === 0) {
          throw new Error(
            `multi-shell: the ${shell} backend has no executable (looked for ${executables[shell === "powershell" ? "pwsh" : shell === "gitbash" ? "gitbash" : "wsl"]}); install it or set the *Path config`
          );
        }
        const { argv, sandbox } = await confineSpawn(ctx, argv0, policy, shell, exec.signal);
        const timeoutMs = clampTimeout(args.timeoutMs, settings.timeoutMs, settings.maxTimeoutMs, "shell timeoutMs");
        const spawnCwd = cwd ?? base ?? process.cwd();
        const spec = spawnSpec({
          argv,
          cwd: spawnCwd,
          env,
          signal: undefined,
          maxOutputBytes: settings.maxOutputBytes,
          maxSpillBytes: settings.maxSpillBytes,
          graceMs: settings.graceMs
        });
        if (background && args.run_in_background === true) {
          if (exec.signal?.aborted) throw toolAborted(exec.signal);
          const live = { proc: undefined };
          let jobId;
          try {
            jobId = jobs.start({
              kind: `shell/${shell}`,
              label: args.command,
              ...(exec.callId !== undefined
                ? { toolCall: { callId: exec.callId, rootCallId: exec.rootCallId } }
                : {}),
              ...(exec.agent !== undefined ? { owner: exec.agent.id } : {}),
              output: backgroundSources(live),
              run: () => {
                const proc = startBackground(subprocess, { ...spec, signal: undefined }, sandbox);
                live.proc = proc;
                return {
                  done: proc.done.then(() => {
                    const runnerFailure = classifyRunnerFailure(
                      proc.exitCode,
                      proc.readStream("stderr", 0).text,
                      proc.sandbox?.runnerFailureRules ?? []
                    );
                    if (runnerFailure !== undefined) proc.runnerFailed = runnerFailure.detail;
                    return processOutcome(proc);
                  }),
                  cancel: () => void proc.kill()
                };
              }
            });
          } catch (error) {
            throw new Error(
              `multi-shell: could not register the background job: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          return { kind: "background", jobId, shell, cwd: spawnCwd };
        }
        const result = await runForeground(subprocess, { ...spec, signal: undefined, label: shell }, exec.signal, timeoutMs);
        if (result.aborted) throw toolAborted(exec.signal);
        const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, sandbox?.runnerFailureRules ?? []);
        if (runnerFailure !== undefined) {
          throw new Error(
            `multi-shell: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure (${runnerFailure.detail})`
          );
        }
        const denied =
          sandbox?.denialSignatures !== undefined
            ? matchesSignature(result.exitCode, result.stderr.text, sandbox.denialSignatures)
            : false;
        const sandboxOut = sandbox === undefined
          ? undefined
          : {
              mode: sandbox.mode,
              ...(sandbox.enforcement !== undefined ? { enforcement: sandbox.enforcement } : {}),
              ...(sandbox.backend !== undefined ? { backend: sandbox.backend } : {}),
              ...(sandbox.unconfined === true ? { unconfined: true } : {}),
              denied
            };
        return canonicalForeground(
          { ...result, ...(sandboxOut !== undefined ? { sandbox: sandboxOut } : {}) },
          { shell, cwd: spawnCwd }
        );
      },
      presentCall: (args) => {
        if (args.run_in_background === true) {
          return {
            card: "generic",
            title: args.command,
            kind: "execute",
            rawInput: args.command,
            content: [{ type: "text", text: args.description }]
          };
        }
        return {
          card: "terminal",
          title: args.command,
          description: args.description,
          ...(args.workdir !== undefined ? { cwd: args.workdir } : {})
        };
      },
      presentResult: (args, result) => {
        const block = result.content.length === 1 ? result.content[0] : undefined;
        if (block === undefined || block.type !== "text") return undefined;
        if ((typeof args === "object" && args !== null && args.run_in_background === true) || result.isError) {
          return {
            card: "generic",
            content: [{ type: "text", text: "```console\n" + block.text.replace(/\n+$/, "") + "\n```" }]
          };
        }
        const { body, ...exit } = parseExitStatus(block.text);
        return { card: "terminal", output: body, ...exit };
      }
    });
  };

  // Register with the strongest available shape, then upgrade/downgrade as the
  // optional jobs service appears or tears down — the shipped bash tool's
  // pattern, so background support never costs a failed fiber at load.
  let foregroundOnly =
    ctx.get("jobs") === undefined ? ctx.tools.register(buildTool(undefined)) : undefined;
  ctx.inject(["jobs"], (jobCtx) => {
    foregroundOnly?.();
    foregroundOnly = undefined;
    const unregisterJobsTool = ctx.tools.register(buildTool(jobCtx.jobs));
    jobCtx.effect(() => () => {
      unregisterJobsTool();
      if (ctx.fiber.state === 2) {
        foregroundOnly = ctx.tools.register(buildTool(undefined));
      }
    });
  });

  ctx.inject(["systemPrompt"], (promptCtx) => {
    let order = 105;
    try {
      if (typeof promptCtx.systemPrompt.getSectionOrder === "function") {
        order = promptCtx.systemPrompt.getSectionOrder("TOOL_BASH") ?? order;
      }
    } catch {
      /* keep the numeric default when the host has no named order table */
    }
    promptCtx.systemPrompt.section({
      name: "tool:multi-shell",
      order,
      text: "Use the shell tool for terminal commands: it runs Git Bash by default and accepts shell=powershell or shell=wsl per call. Keep the pwsh tool for cases that specifically need the sandboxed PowerShell surface."
    });
  });
}

// ---- internals for tests ------------------------------------------------------

export const internals = {
  createDeadline,
  normalizeArguments,
  runForeground,
  startBackground,
  backgroundSources,
  processOutcome,
  renderResult,
  canonicalForeground,
  confineSpawn,
  validateArguments,
  validateSettings,
  toolDescription,
  TOOL_NAME
};
