import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { eventAppend, summarizeEvent } from "../events/store.js";

// OMP binaire réel : /home/djeel/.local/bin/omp = v19.2.1 (ELF natif).
// ~/.bun/bin/omp = v18.16.0 (shim node, à éviter).
const OMP_BIN =
  process.env.OMP_BIN ?? "/home/djeel/.local/bin/omp";

export type RpcCommand = Record<string, unknown> & { id: string; type: string };

export class OmpRpc {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private resultWaiters = new Map<string, (v: any) => void>();
  private lastText = "";
  private bridgeSessionId = "";
  private listeners = new Set<(msg: any) => void>();

  setBridgeSessionId(id: string) {
    this.bridgeSessionId = id;
  }

  onEvent(fn: (msg: any) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(msg: any) {
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch {}
    }
  }

  async start(opts: { cwd?: string; sessionDir?: string; extraArgs?: string[] } = {}): Promise<void> {
    if (this.proc) return;
    const args = ["--mode", "rpc", "--no-ui", "--no-session", ...(opts.extraArgs ?? [])];
    if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
    this.proc = spawn(OMP_BIN, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => this.onLine(line.trim()));
    this.proc.stderr?.on("data", (d) =>
      process.stderr.write(`[omp-rpc:stderr] ${d}`),
    );
    this.proc.on("exit", (code) => {
      const err = new Error(`omp rpc exited code=${code}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.proc = null;
    });

    // attend le ready
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout ready")), 15000);
      const check = (line: string) => {
        try {
          const o = JSON.parse(line);
          if (o.type === "ready") {
            clearTimeout(t);
            this.proc?.stdout?.off("data", onData);
            resolve();
          }
        } catch {}
      };
      const onData = (d: Buffer) => {
        for (const l of d.toString().split("\n")) if (l.trim()) check(l.trim());
      };
      this.proc!.stdout!.on("data", onData);
      this.proc!.on("exit", () => {
        clearTimeout(t);
        reject(new Error("omp exited before ready"));
      });
    });

    // handshake protocol v2
    const r: any = await this.send({ type: "negotiate_protocol", protocolVersion: 2 });
    if (r?.data?.protocolVersion !== 2)
      throw new Error("negotiate_protocol v2 failed");
  }

  private saveEvent(kind: string, msg: any) {
    try {
      const summary = summarizeEvent(msg);
      eventAppend({
        session_id: this.bridgeSessionId || "default",
        kind,
        summary,
        data: JSON.stringify(msg).slice(0, 8000),
      });
    } catch {}
    this.emit(msg);
  }

  private onLine(line: string) {
    if (!line) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.success) p.resolve(msg);
      else p.reject(new Error(msg.error ?? "rpc error"));
      return;
    }
    // événements : prompt_result débloque promptAndWait, message_update garde dernier texte
    if (msg.type && msg.type !== "response") {
      const kind = msg.type;
      if (kind === "prompt_result" && msg.id && this.resultWaiters.has(msg.id)) {
        this.saveEvent(kind, msg);
        const w = this.resultWaiters.get(msg.id)!;
        this.resultWaiters.delete(msg.id);
        w(msg);
        return;
      }
      if (kind === "message_update") {
        // garde le dernier texte assistant (delta ou full)
        try {
          const t =
            msg?.message?.text ?? msg?.text ?? msg?.delta?.text ?? "";
          if (typeof t === "string" && t) this.lastText = t;
        } catch {}
      }
      if (
        kind === "message_update" ||
        kind === "prompt_result" ||
        kind === "session_settled" ||
        kind === "subagent_progress" ||
        kind === "subagent_lifecycle"
      ) {
        // message_update très verbeux : ne persiste que si texte non vide
        if (kind !== "message_update" || this.lastText) this.saveEvent(kind, msg);
        process.stdout.write(`[event] ${kind}\n`);
      }
    }
  }

  send(cmd: Omit<RpcCommand, "id"> & { id?: string; type?: string }): Promise<any> {
    if (!this.proc?.stdin) throw new Error("rpc not started");
    const id = cmd.id ?? String(++this.seq);
    const full: any = { ...cmd, id };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(full) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`rpc timeout cmd=${full.type} id=${id}`));
        }
      }, 120_000).unref?.();
    });
  }

  // --- helpers Phase 1 ---
  getState() {
    return this.send({ type: "get_state" });
  }
  prompt(message: string) {
    return this.send({ type: "prompt", message });
  }
  async promptAndWait(message: string, timeoutMs = 300_000): Promise<string> {
    this.lastText = "";
    const ack: any = await this.send({ type: "prompt", message });
    const id: string = ack.id;
    const result: any = await new Promise((resolve, reject) => {
      this.resultWaiters.set(id, resolve);
      setTimeout(() => {
        if (this.resultWaiters.has(id)) {
          this.resultWaiters.delete(id);
          reject(new Error(`timeout prompt_result id=${id}`));
        }
      }, timeoutMs).unref?.();
    });
    if (result.status === "error")
      throw new Error(result?.error?.message ?? "prompt failed");
    // texte final via commande dédiée (fiable, pas du streaming)
    try {
      const t: any = await this.send({ type: "get_last_assistant_text" });
      if (typeof t?.data?.text === "string" && t.data.text) return t.data.text;
    } catch {}
    return this.lastText;
  }
  abort() {
    return this.send({ type: "abort" });
  }
  getSubagents() {
    return this.send({ type: "get_subagents" });
  }

  async stop() {
    this.proc?.kill();
    this.proc = null;
  }
}
