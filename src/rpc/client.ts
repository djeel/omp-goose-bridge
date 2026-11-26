import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { eventAppend, summarizeEvent } from "../events/store.js";
import { ompBin, PROMPT_TIMEOUT_MS } from "../config.js";

// Client RPC OMP : 1 process = 1 session vivante (--mode rpc --no-ui).
// IMPORTANT : stdout est réservé au protocole MCP côté serveur ; ici, tous les
// diagnostics vont sur stderr (sinon le transport stdio MCP est corrompu).

const VERBOSE = process.env.OMP_BRIDGE_VERBOSE === "1";

export type RpcCommand = Record<string, unknown> & { id: string; type: string };

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class OmpRpc {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private promptSeq = 0;
  private pending = new Map<string, Pending>();
  private resultWaiters = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
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

  async start(
    opts: { cwd?: string; sessionDir?: string; extraArgs?: string[] } = {},
  ): Promise<void> {
    if (this.proc) return;
    const args = ["--mode", "rpc", "--no-ui", "--no-session", ...(opts.extraArgs ?? [])];
    if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);

    const bin = ompBin();
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => reject(new Error("timeout: OMP ne répond pas (ready)")), 15000);
      timer.unref?.();

      proc.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new Error(
            e.code === "ENOENT"
              ? `binaire OMP introuvable: "${bin}". Installe-le ou définis OMP_BIN.`
              : `échec lancement OMP: ${e.message}`,
          ),
        );
      });

      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        const l = line.trim();
        if (!l) return;
        if (!ready) {
          try {
            if (JSON.parse(l).type === "ready") {
              ready = true;
              clearTimeout(timer);
              resolve();
              return;
            }
          } catch {}
        }
        this.onLine(l);
      });

      proc.stderr?.on("data", (d) => {
        if (VERBOSE) process.stderr.write(`[omp-rpc] ${d}`);
      });

      proc.on("exit", (code) => {
        clearTimeout(timer);
        const err = new Error(`process OMP terminé (code=${code})`);
        for (const [, p] of this.pending) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        // Rejette aussi les attentes de prompt : sinon un crash laisse pendre 300 s.
        for (const [id, w] of this.resultWaiters) {
          this.resultWaiters.delete(id);
          w.reject(err);
        }
        this.proc = null;
        if (!ready) reject(err);
      });
    });

    // handshake protocole v2
    try {
      const r: any = await this.send({ type: "negotiate_protocol", protocolVersion: 2 });
      if (r?.data?.protocolVersion !== 2) throw new Error("négociation protocole v2 échouée");
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  private saveEvent(kind: string, msg: any) {
    try {
      eventAppend({
        session_id: this.bridgeSessionId || "default",
        kind,
        summary: summarizeEvent(msg),
        data: JSON.stringify(msg).slice(0, 8000),
      });
    } catch {}
    this.emit(msg);
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.type === "response" && msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.success) p.resolve(msg);
      else {
        const e = msg.error;
        p.reject(new Error(typeof e === "string" ? e : (e?.message ?? JSON.stringify(e ?? "erreur rpc"))));
      }
      return;
    }
    if (!msg?.type || msg.type === "response") return;

    const kind = msg.type;
    if (kind === "prompt_result" && msg.id && this.resultWaiters.has(msg.id)) {
      this.saveEvent(kind, msg);
      const w = this.resultWaiters.get(msg.id)!;
      this.resultWaiters.delete(msg.id);
      w.resolve(msg);
      return;
    }
    if (kind === "message_update") {
      try {
        const t = msg?.message?.text ?? msg?.text ?? msg?.delta?.text ?? "";
        if (typeof t === "string" && t) this.lastText = t;
      } catch {}
      // message_update est très verbeux : jamais persisté (bloat SQLite).
      if (VERBOSE) process.stderr.write("[omp-rpc] message_update\n");
      return;
    }
    if (
      kind === "prompt_result" ||
      kind === "session_settled" ||
      kind === "subagent_progress" ||
      kind === "subagent_lifecycle"
    ) {
      this.saveEvent(kind, msg);
      if (VERBOSE) process.stderr.write(`[omp-rpc] event ${kind}\n`);
    }
  }

  send(cmd: Omit<RpcCommand, "id"> & { id?: string; type?: string }): Promise<any> {
    if (!this.proc?.stdin) return Promise.reject(new Error("rpc non démarré"));
    const id = cmd.id ?? String(++this.seq);
    const full: any = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout rpc cmd=${full.type} id=${id}`));
        }
      }, 120_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(JSON.stringify(full) + "\n", (err) => {
        if (err && this.pending.has(id)) {
          this.pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // --- helpers ---
  getState() {
    return this.send({ type: "get_state" });
  }

  prompt(message: string) {
    return this.send({ type: "prompt", message });
  }

  /** Envoie un prompt et attend le prompt_result (waiter enregistré AVANT l'envoi). */
  async promptAndWait(message: string, timeoutMs = PROMPT_TIMEOUT_MS): Promise<string> {
    this.lastText = "";
    const id = `p${++this.promptSeq}`;
    const resultP = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.resultWaiters.delete(id)) {
          reject(new Error(`timeout prompt_result id=${id}`));
        }
      }, timeoutMs);
      timer.unref?.();
      this.resultWaiters.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    try {
      await this.send({ id, type: "prompt", message });
    } catch (e) {
      this.resultWaiters.delete(id);
      throw e;
    }

    const result = await resultP;
    if (result.status === "error") throw new Error(result?.error?.message ?? "prompt échoué");

    try {
      const t: any = await this.send({ type: "get_last_assistant_text" });
      if (typeof t?.data?.text === "string" && t.data.text) return t.data.text;
    } catch {}
    return this.lastText;
  }

  abort() {
    // Rejette immédiatement les attentes en cours (évite un blocage de 300 s).
    for (const [id, w] of this.resultWaiters) {
      this.resultWaiters.delete(id);
      w.reject(new Error("aborted"));
    }
    return this.send({ type: "abort" });
  }

  getSubagents() {
    return this.send({ type: "get_subagents" });
  }

  /** Arrête le process et attend sa sortie (évite les orphelins). */
  async stop(timeoutMs = 3000): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once("exit", () => resolve());
    });
    try {
      proc.kill("SIGTERM");
    } catch {}
    const timer = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        resolve();
      }, timeoutMs);
      t.unref?.();
    });
    await Promise.race([exited, timer]);
  }
}
