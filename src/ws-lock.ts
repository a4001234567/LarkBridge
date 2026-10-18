import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WsLease = { release(): Promise<void>; onLost(callback: () => void): void };

// Every local implementation of this Lark app must use this path and hold the
// same kernel lock for the full WebSocket lifetime. The lock-holder exits when
// its parent's stdin pipe closes, including after an unclean parent exit.
export function wsLockPath(appId: string): string {
  const directory = join(homedir(), ".local", "state", "lark-bridge", "ws-locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${createHash("sha256").update(appId).digest("hex")}.lock`);
}

export async function acquireWsLock(appId: string): Promise<WsLease | null> {
  const holder = spawn(
    "flock",
    [
      "-n", "-E", "75", wsLockPath(appId), process.execPath, "-e",
      'process.stdout.write("READY\\n"); process.stdin.on("end", () => process.exit(0)); process.stdin.resume();',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  holder.stdin.on("error", () => {});
  holder.stderr.resume();
  let released = false, lost = false, lossHandler: (() => void) | undefined;
  holder.once("close", () => {
    lost = true;
    if (!released) lossHandler?.();
  });
  let settled = false;
  const acquired = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => {
      holder.kill("SIGTERM");
      finish(new Error("Timed out acquiring Lark WebSocket lock"));
    }, 5000);
    const finish = (result: boolean | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      result instanceof Error ? reject(result) : resolve(result);
    };
    let output = "";
    holder.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("READY\n")) finish(true);
    });
    holder.once("error", (error) => finish(error));
    holder.once("close", (code) =>
      finish(code === 75 ? false : new Error(`Lark WebSocket lock holder exited ${code}`)),
    );
  });
  if (!acquired) return null;
  return {
    onLost: (callback) => {
      lossHandler = callback;
      if (lost && !released) callback();
    },
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      return new Promise<void>((resolve) => {
        if (lost) return resolve();
        const timeout = setTimeout(() => holder.kill("SIGTERM"), 2000);
        holder.once("close", () => { clearTimeout(timeout); resolve(); });
        holder.stdin.end();
      });
    },
  };
}
