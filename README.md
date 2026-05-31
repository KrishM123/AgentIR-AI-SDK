# AgentIR AI SDK

`agentir-ai-sdk` is the standalone TypeScript annotation module for wiring
Vercel AI SDK agents into AgentIR.

## Purpose

- annotate AI SDK agents and tools with compile-time structure
- build scheduler-facing contracts for ReAct-style loops
- propagate RID and node-name metadata into scheduler-backed model calls
- bind scheduler headers into custom model or gateway wrappers
- support real AI SDK `ToolLoopAgent` executions against OpenAI-compatible
  `/v1/chat/completions` endpoints

Read the full interface and implementation docs here:

- `interface.md`
- `docs/README.md`
- `docs/how-it-works.md`
- `docs/runtime.md`
- `docs/annotation-patterns.md`
- `docs/limitations.md`

## What Belongs Here

- public API exports in `src/index.ts`
- contract structures in `src/contract.ts`
- the contract compiler in `src/compiler.ts`
- runtime RID and node-name propagation in `src/context.ts`
- agent and tool wrappers in `src/definitions.ts`
- marker helpers in `src/markers.ts`
- usage guidance in `interface.md` and `docs/`
- Blackbox runtime header helpers for OpenAI-compatible chat requests

## Install

```bash
npm install agentir-ai-sdk ai
```

If your tool schemas use Zod, install `zod` in your application as usual.

Import the annotation API from the package root:

```ts
import {
  buildContract,
  defineAgentIRTool,
  defineManualAgent,
  defineToolLoopAgent,
  llmCall,
} from "agentir-ai-sdk";
```

## Important Invariants

- Agent loop bounds must be explicit. The compiler does not infer or tolerate unbounded loops.
- Tool fanout must be declared through `allowedToolSets`. The compiler does not infer dynamic tool availability.
- Helper bodies are compile-visible only through the explicit marker calls above.
- Runtime RID and node-name propagation is mandatory for scheduler-backed model calls.
- Use `bindBlackboxHeaders(workflowApiKey, headers?)` or `getBlackboxHeaders(workflowApiKey, headers?)`
  when a runtime client needs bearer auth plus the current `rid` and `node-name`.
- Tool `execute(...)` and compile-visible `body` markers must describe the same
  LLM work. The `body` is annotation metadata, not a fallback runtime path.
