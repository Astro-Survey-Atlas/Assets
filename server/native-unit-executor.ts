import { runNativeUnitWorker } from "./native-unit-worker.js";
import type { NativeWorkerRequest } from "./native-unit-model.js";

process.once("message", (request: NativeWorkerRequest) => {
  const timer = setInterval(() => process.send?.({ operation: "heartbeat" }), 15_000);
  void runNativeUnitWorker(request, message => process.send?.({ operation: "progress", message })).then(result => {
    process.send?.({ operation: "result", result }, () => { clearInterval(timer); process.disconnect(); });
  }).catch(error => {
    process.send?.({ operation: "error", message: error instanceof Error ? error.message : "Native metadata task failed" }, () => { clearInterval(timer); process.disconnect(); });
  });
});
