import { OmpRpc } from "./client.js";

const rpc = new OmpRpc();
console.log("starting omp rpc...");
await rpc.start({ cwd: "/tmp" });
console.log("ready + v2 OK");

const state: any = await rpc.getState();
console.log("model:", state?.data?.model?.id ?? state?.data?.model);
console.log("session:", state?.data?.sessionId ?? state?.data?.sessionFile);

await rpc.stop();
console.log("probe OK");
process.exit(0);
