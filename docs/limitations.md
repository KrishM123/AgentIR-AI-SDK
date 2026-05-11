# Current Limitations

`AgentIR-AI-SDK` is intentionally narrow in v1.

## Structural Limits

- Loop bounds must be explicit.
- Tool availability must be static per agent definition.
- Tool bodies are compile-visible only through explicit marker calls.
- The compiler does not infer control flow from arbitrary JavaScript or
  TypeScript.

## Runtime Limits

- RID and node-name propagation only exist inside `withAgentIRRun(...)` scopes.
- Scheduler-backed clients must use `bindSchedulerHeaders(...)` or equivalent
  context-aware wiring.
- Tool-call fanout must match one declared `allowedToolSets` entry exactly.

## Unsupported Patterns

- dynamic `activeTools` changes per iteration
- runtime-mutated loop bounds
- implicit parallelism through raw `Promise.all(...)`
- compile recovery from plain helper calls with no marker annotations
- compile recovery from arbitrary ReAct transcripts

These are not bugs in the current design. They are boundary decisions that keep
the contract compiler deterministic and easy to reason about.
