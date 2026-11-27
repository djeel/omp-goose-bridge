#!/usr/bin/env bun
// Faux OMP pour les tests : parle le protocole RPC minimal du bridge.
// Knobs (env) : FAKE_OMP_SLOW=1 (prompt_result différé), FAKE_OMP_CRASH=1 (meurt après ack).
import { createInterface } from "node:readline";

const SLOW = process.env.FAKE_OMP_SLOW === "1";
const CRASH = process.env.FAKE_OMP_CRASH === "1";

// `fake-omp --version` : le bridge lit la version via `OMP_BIN --version` (omp_health).
if (process.argv.includes("--version")) {
  console.log(process.env.FAKE_OMP_VERSION || "omp/19.2.1-fake");
  process.exit(0);
}

let lastText = "";
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

out({ type: "ready" });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const l = line.trim();
  if (!l) return;
  let msg: any;
  try {
    msg = JSON.parse(l);
  } catch {
    return;
  }
  const { id, type } = msg;
  const ok = (data: unknown = {}) => out({ type: "response", id, success: true, data });

  switch (type) {
    case "negotiate_protocol":
      return ok({ protocolVersion: 2 });

    case "get_state":
      return ok({ model: { id: "fake-model" }, sessionId: "fake-session" });

    case "get_last_assistant_text":
      return ok({ text: lastText });

    case "get_subagents":
      return ok({ agents: [] });

    case "abort":
      return ok();

    case "prompt": {
      ok();
      lastText = `echo: ${String(msg.message ?? "").slice(0, 200)}`;
      out({ type: "message_update", id, message: { text: lastText } });
      if (CRASH) {
        setTimeout(() => process.exit(1), 10);
        return;
      }
      const emitResult = () =>
        out({
          type: "prompt_result",
          id,
          status: "completed",
          sessionSettled: true,
        });
      if (SLOW) setTimeout(emitResult, 5000);
      else emitResult();
      return;
    }

    default:
      return ok({});
  }
});
