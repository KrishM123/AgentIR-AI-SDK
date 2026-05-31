# AgentIR AI SDK Interface Guide

This document defines the public interface for `AgentIR-AI-SDK/`.

The package has one job: make an AI SDK agent explicit enough that AgentIR can
compile a stable contract and propagate runtime scheduler metadata without
forcing the user to rewrite the agent into a different framework.

The implementation is intentionally strict. It supports the specific annotated
surface described below and does not attempt to infer arbitrary ReAct code.

## Package Boundary

`AgentIR-AI-SDK/` owns:

- the public TypeScript API
- contract construction
- runtime RID and node-name propagation

It does not own repository-local integration code. The shipped SDK surface is
only the annotation, compilation, and runtime metadata layer described below.

## Public API

The public exports live in `src/index.ts`.

### `defineToolLoopAgent(...)`

Wrap an AI SDK `ToolLoopAgent` with AgentIR metadata.

Required metadata:

- `name`: stable agent name
- `modelId`: scheduler-visible model identifier
- `maxIterations`: explicit loop bound
- `allowedToolSets`: explicit mutually-exclusive tool sets
- `instructions`: stable system prompt text used by the repeated loop step
- `settings`: `ToolLoopAgent` construction settings

Semantics:

- AgentIR treats each loop step as one repeated LLM node.
- `allowedToolSets` describe which sibling tool calls may appear after that
  step.
- `prepareStep` is used to bind the current unrolled node name at runtime.
- Real AI SDK `ToolLoopAgent` runs may execute tool calls directly from the
  model response. Users do not need private helper imports or out-of-band
  tool-call registration.

### `defineManualAgent(...)`

Define a manual multi-step agent loop that AgentIR owns.

Required metadata:

- `name`
- `modelId`
- `maxIterations`
- `allowedToolSets`
- `instructions`
- `tools`
- `runStep(invocation)`

`runStep(...)` receives the current message transcript and tool registry. It
returns either:

- final text, or
- one allowed set of tool calls

AgentIR repeats `runStep(...)` until the agent finishes or reaches the explicit
loop bound.

This is the supported manual-loop surface. The compiler does not recover
semantics from arbitrary user-authored `while` loops.

### `defineAgentIRTool(...)`

Wrap a tool with:

- a stable tool name
- the runtime AI SDK tool implementation
- an optional compile-visible `body`
- optional `nestedAgents`

Important fields:

- `name`: stable tool name
- `tool`: the runtime AI SDK tool definition
- `body`: an optional annotated helper body that the compiler parses
- `nestedAgents`: named child agents reachable through `toolLoop(...)` markers

The `body` function is compile-time metadata. It is not a fallback runtime path.
Its purpose is to expose explicit marker calls so the compiler can build a
subgraph for work performed inside the tool.

### Explicit Marker Calls

These markers are the only compile-visible operations inside tool or helper
bodies:

- `llmCall(name, metadata, fn)`
- `parallelLlmCall(name, metadata, fn)`
- `toolLoop(name, fn)`
- `parallelToolLoop(name, fn)`
- `closeParallel()`

Marker semantics:

- `llmCall(...)` creates one sequential LLM node.
- `parallelLlmCall(...)` creates one child inside the currently open parallel
  group.
- `toolLoop(...)` expands a nested agent under the current tool body.
- `parallelToolLoop(...)` expands a nested agent as a sibling in the current
  parallel group.
- `closeParallel()` closes the currently open parallel group and inserts the
  synthetic join node the downstream step reads from.

The compiler only reads the lexical marker sequence. Any other logic in the body
is ignored for graph construction.

### Contract Builders

- `buildContract(agent)`
- `contractToJson(contract)`

`buildContract(...)` returns the in-memory contract shape any downstream
integration can serialize or register.

`contractToJson(...)` returns a plain JSON object containing:

- `entry`
- `end`
- `nodes[name].writes`
- `nodes[name].llm_calls[]`
- `edges[]`

### Runtime Helpers

- `withAgentIRRun(...)`
- `getSchedulerHeaders()`
- `bindSchedulerHeaders(headers)`

These helpers expose the runtime metadata required by a scheduler-backed model
client.

`withAgentIRRun(...)` creates one top-level RID context.

`getSchedulerHeaders()` returns the active runtime headers:

- `rid`
- `node-name`

`bindSchedulerHeaders(...)` merges those headers into an outbound request.

## Contract Model

The contract is a bounded DAG. AgentIR does not emit cycles for AI SDK loops.
Instead it unrolls each loop iteration into fresh nodes.

Stable naming pattern:

- `agent.iter_0.step`
- `agent.iter_0.finish`
- `agent.iter_0.choice_0`
- `agent.iter_0.choice_0.tool.search`
- `agent.iter_0.join_0`
- `agent.done`

Key synthetic nodes:

- `step`: repeated loop LLM call
- `finish`: explicit no-tool branch for that iteration
- `choice_*`: mutually-exclusive branch roots for one allowed tool set
- `join_*`: synthetic joins for sibling tool work
- `done`: terminal node for the unrolled graph

## Runtime Propagation Rules

The scheduler must see one consistent RID for the full top-level agent run and a
precise node name for each individual LLM call.

The package enforces that by:

- creating one `AsyncLocalStorage` context per run
- setting the current step node before each `ToolLoopAgent` step
- binding tool-call ids to the concrete unrolled tool node they represent in
  manual-agent paths
- inferring the concrete tool node from the active step context and current
  tool-call execution state in `ToolLoopAgent` paths
- restoring nested node prefixes while tool bodies and subagents execute

If a scheduler-backed client uses `bindSchedulerHeaders(...)`, every outbound
call inherits the active RID and node name automatically.

## OpenAI-Compatible ToolLoopAgent Pattern

The supported user pattern is:

1. build or keep a normal AI SDK model wrapper that calls
   `/v1/chat/completions`
2. call `bindBlackboxHeaders(workflowApiKey, headers?)` before each outbound
   request
3. return tool calls exactly as the endpoint emitted them
4. run tool-body LLM work inside `llmCall(...)`
5. keep the compile-visible `body` markers aligned with that runtime LLM work

AgentIR does not require a custom control loop, private imports, or a separate
tool-call planner for this path.

## Supported Patterns

Supported:

- `ToolLoopAgent` entrypoints with explicit `allowedToolSets`
- manual loops implemented through `defineManualAgent(...)`
- nested tool-loop agents
- tool bodies with explicit sequential markers
- tool bodies with one or more explicit parallel groups

Unsupported:

- dynamic tool-set changes across iterations
- data-dependent loop bounds
- arbitrary unannotated helper logic
- raw `Promise.all(...)` fanout without `parallelLlmCall(...)` /
  `parallelToolLoop(...)` and `closeParallel()`
- best-effort recovery of implicit ReAct control flow

## Minimal Example

```ts
import { generateText } from "ai";
import { z } from "zod";

import {
  defineAgentIRTool,
  defineManualAgent,
  llmCall,
  buildContract,
} from "agentir-ai-sdk";

const model = /* your tool-calling AI SDK model */;

const fetchNotes = defineAgentIRTool({
  name: "fetch_notes",
  tool: {
    inputSchema: z.object({ topic: z.string() }),
    async execute(input) {
      return await llmCall(
        "fetch_notes_pass",
        { modelId: "scheduler", staticVars: ["fetch-notes"] },
        async () => `notes:${input.topic}`,
      );
    },
  },
  body: async function fetchNotesBody() {
    await llmCall(
      "fetch_notes_pass",
      { modelId: "scheduler", staticVars: ["fetch-notes"] },
      async () => "",
    );
  },
});

const agent = defineManualAgent({
  name: "research_assistant",
  modelId: "scheduler",
  maxIterations: 2,
  allowedToolSets: [["fetch_notes"]],
  instructions: "Research assistant",
  tools: { fetch_notes: fetchNotes },
  async runStep(invocation) {
    const result = await generateText({
      model,
      tools: invocation.tools,
      messages: invocation.messages,
    });
    return {
      text: result.text,
      toolCalls: result.toolCalls.map((toolCall) => ({
        toolName: toolCall.toolName,
        input: toolCall.input,
      })),
    };
  },
});

const contract = buildContract(agent);
```

## Recommended Reading

- `README.md`
- `docs/how-it-works.md`
- `docs/runtime.md`
- `docs/annotation-patterns.md`
- `docs/limitations.md`
