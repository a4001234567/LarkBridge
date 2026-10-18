import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import type { Config } from "./config.js";

export class Bridge extends EventEmitter {
  private socket?: Socket;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    readonly cfg: Config,
    readonly session: { session_id: string; name: string; harness: string },
  ) {
    super();
  }
  async open(autoStart = true) {
    try {
      await this.dial();
    } catch (e: any) {
      if (!autoStart || !["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
      let launchError: Error | undefined;
      const launch = () => {
        const log = openSync(join(this.cfg.stateDir, "broker.log"), "a", 0o600);
        const child = spawn(
          "flock",
          [
            "-n",
            join(this.cfg.stateDir, "broker.lock"),
            process.execPath,
            ...process.execArgv,
            fileURLToPath(
              new URL(
                "./broker" + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"),
                import.meta.url,
              ),
            ),
            "--locked-worker",
          ],
          { detached: true, stdio: ["ignore", log, log], env: process.env },
        );
        child.on("error", (e) => { launchError = e; });
        child.unref();
        closeSync(log);
      };
      let connected = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (launchError) throw launchError;
        // The previous broker may still hold its startup lock while closing.
        // Retry launching after it exits, as well as retrying the socket dial.
        if (attempt % 10 === 0) launch();
        await new Promise((r) => setTimeout(r, 100));
        try {
          await this.dial();
          connected = true;
          break;
        } catch {}
      }
      if (!connected)
        throw new Error(
          "Broker did not start; inspect broker.log in the state directory",
        );
    }
    try {
      await this.call("register", this.session);
    } catch (e) {
      this.close();
      throw e;
    }
    this.heartbeat = setInterval(() => {
      void this.call("heartbeat").catch(() => {});
    }, 10_000);
    this.heartbeat.unref();
  }
  private dial() {
    return new Promise<void>((resolve, reject) => {
      const socket = connect(this.cfg.socket);
      socket.setEncoding("utf8");
      let buffer = "";
      const timeout = setTimeout(
        () => socket.destroy(new Error("Broker connection timeout")),
        2000,
      );
      socket.once("error", reject);
      socket.once("connect", () => {
        clearTimeout(timeout);
        this.socket = socket;
        resolve();
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
          socket.destroy();
          return;
        }
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          let data: any;
          try {
            data = JSON.parse(buffer.slice(0, index));
          } catch {
            socket.destroy();
            return;
          }
          buffer = buffer.slice(index + 1);
          if (data.notice) {
            this.emit("notice", data);
            continue;
          }
          const pending = this.pending.get(data.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(data.id);
          data.error
            ? pending.reject(new Error(data.error))
            : pending.resolve(data.result);
        }
      });
      socket.on("close", () => {
        clearTimeout(timeout);
        if (this.socket !== socket) return;
        clearInterval(this.heartbeat);
        this.socket = undefined;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("Broker disconnected"));
        }
        this.pending.clear();
        this.emit("disconnect");
      });
    });
  }
  call(method: string, params: unknown = {}): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error("Broker disconnected"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Broker request timeout"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close() {
    clearInterval(this.heartbeat);
    this.socket?.destroy();
  }
}
let current: Bridge;
export function setBridge(bridge: Bridge) {
  current = bridge;
}
export function getBridge() {
  if (!current) throw new Error("Bridge not initialized");
  return current;
}
