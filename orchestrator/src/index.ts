// orchestrator/ — barrel
// TypeScript runtime driving the two-mode pipeline via the Claude Agent SDK.

export {
  startGateServer,
  waitForGateDecision,
  resolveGateFilePath,
  tryResolveGateFile,
  type GateServerHandle,
  type StartGateServerArgs,
  type WaitForGateDecisionArgs,
} from "./gate-server-lifecycle.js";
export {
  fileDropWaitForGate,
  runPipeline,
  type GateResolution,
  type PipelineConfig,
  type PipelineResult,
  type SaveContextFn,
  type WaitForGateFn,
} from "./pipeline.js";
