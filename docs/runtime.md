# Runtime Metadata Propagation

This document explains how the AI SDK package binds RID and node-name metadata
to actual scheduler-backed LLM calls.

## AsyncLocalStorage Is the Source of Truth

The runtime context lives in `src/context.ts`.

It stores:

- the active run RID
- the active node name
- pending tool-call bindings
- the current nested node prefix
- any open parallel task bookkeeping

The context is per top-level run.

## Top-Level Run Context

`withAgentIRRun(...)` creates one top-level runtime scope.

Inside that scope:

- a RID is created if one is not already present
- every nested helper sees the same RID
- node-name updates become local to that run

This is the boundary that keeps one agent invocation coherent from the
scheduler’s perspective.

## Step Nodes

`defineToolLoopAgent(...)` installs a `prepareStep(...)` hook on the wrapped AI
SDK agent.

Before each repeated step call, the hook sets:

- the current unrolled node name
- the current nested prefix for any child tool work

That is why the scheduler sees concrete step names like:

- `tool_loop_assistant.iter_1.step`

instead of a generic `tool_loop_assistant`.

## Tool Calls

When the scripted model decides to emit tool calls, it registers each tool-call
id with:

- the concrete tool node name
- the nested prefix that tool body work should inherit

When the wrapped tool executes, `defineAgentIRTool(...)` resolves that pending
binding and runs the tool body inside the correct node-name scope.

That is what makes downstream tool-body LLM calls inherit names such as:

- `manual_parallel_assistant.iter_0.choice_0.tool.fetch_a.llm.fetch_a_pass`

## Scheduler Header Helpers

`getSchedulerHeaders()` reads the active RID and node name from the context and
returns them as HTTP headers.

`bindSchedulerHeaders(headers)` merges those values into a caller-provided header
map.

A scheduler-backed gateway or model wrapper should call
`bindSchedulerHeaders(...)` before every outbound request.

## Nested Agents

`toolLoop(...)` and `parallelToolLoop(...)` run the nested subagent inside the
parent tool’s node-name scope, but with a deeper nested prefix.

That prefix is what causes the child agent to emit:

- `...tool.delegate.subagent.delegate_worker.iter_0.step`

instead of a top-level `delegate_worker.iter_0.step`.

## Parallel Groups

`parallelLlmCall(...)` and `parallelToolLoop(...)` both register work against
the current open parallel group.

At runtime they also add pending tasks into the active context so
`closeParallel()` can wait for all of them before the sequential continuation
runs.

Compile-time and runtime semantics are aligned:

- compile-time: one explicit fanout plus one explicit join
- runtime: one explicit task set plus one synchronization point
