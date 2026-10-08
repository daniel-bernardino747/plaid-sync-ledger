import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

/**
 * Child-process management for the chaos harness. Workers, the Plaid fake and
 * `wrangler dev` are real OS processes (ADR 0010): "kill the worker" means the
 * process really dies, and "two workers" means two processes.
 */

export interface Proc {
  name: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

export function startProc(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; log: WriteStream; shell?: boolean },
): Proc {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: opts.shell ?? false,
    windowsHide: true,
    // On POSIX, a process group of its own, so killTree() can signal the whole
    // tree (wrangler spawns workerd) with kill(-pid). Windows uses taskkill /T.
    detached: process.platform !== "win32",
  });
  const tag = (chunk: Buffer) => opts.log.write(chunk.toString("utf8").replace(/^(?=.)/gm, `[${name}] `));
  child.stdout?.on("data", tag);
  child.stderr?.on("data", tag);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    name,
    child,
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killTree(child.pid!);
      await Promise.race([exited, sleep(10_000)]);
    },
  };
}

/** Kills a process and its children. wrangler spawns workerd, so a plain kill is not enough. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

export function openLog(path: string): WriteStream {
  return createWriteStream(path, { flags: "w" });
}

/** Carries only a harness-owned label, so it is safe to print (ADR 0013). */
export class HarnessTimeout extends Error {
  readonly label: string;
  constructor(label: string) {
    super("harness timeout");
    this.name = "HarnessTimeout";
    this.label = label;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number, everyMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await sleep(everyMs);
  }
  throw new HarnessTimeout(what);
}
