# Annotation Patterns

This document shows the intended annotation patterns for `AgentIR-AI-SDK`.

The examples focus on the public annotation surface only:

- `defineToolLoopAgent(...)`
- `defineManualAgent(...)`
- `defineAgentIRTool(...)`
- `llmCall(...)`
- `parallelLlmCall(...)`
- `toolLoop(...)`
- `parallelToolLoop(...)`
- `closeParallel()`

Assume the examples import these helpers from `agentir-ai-sdk`.

## 1. Single LLM Tool

Use `defineAgentIRTool(...)` when one tool execution corresponds to one LLM
call.

```ts
const summarize = defineAgentIRTool({
  name: "summarize",
  tool: {
    inputSchema: z.object({ text: z.string() }),
    async execute(input) {
      return await llmCall(
        "summarize_pass",
        { modelId: "scheduler", staticVars: ["summarize"] },
        async () => await client.invoke(`summarize:${input.text}`),
      );
    },
  },
  body: async function summarizeBody() {
    await llmCall(
      "summarize_pass",
      { modelId: "scheduler", staticVars: ["summarize"] },
      async () => "",
    );
  },
});
```

The important invariant is that the compile-visible `body` reflects the real
LLM work performed by `execute(...)`.

## 2. Nested Subagent Tool

Use `toolLoop(...)` when a tool delegates to another AgentIR agent.

```ts
const delegate = defineAgentIRTool({
  name: "delegate",
  tool: {
    inputSchema: z.object({ topic: z.string() }),
    async execute(input) {
      return await toolLoop("research_worker", async () => {
        const result = await researchWorker.generate({
          prompt: `research:${input.topic}`,
        });
        return result.text;
      });
    },
  },
  body: async function delegateBody() {
    await toolLoop("research_worker", async () => "");
  },
  nestedAgents: {
    research_worker: researchWorker,
  },
});
```

Important invariants:

- the marker name passed to `toolLoop(...)` must match a key in `nestedAgents`
- the nested agent must itself be an AgentIR agent definition
- the tool body should expose the same nested structure as the runtime path

## 3. Parallel LLM Group Inside a Tool

Use `parallelLlmCall(...)` and `closeParallel()` when sibling LLM calls can run
in parallel before a later sequential merge.

```ts
const compare = defineAgentIRTool({
  name: "compare",
  tool: {
    inputSchema: z.object({ left: z.string(), right: z.string() }),
    async execute(input) {
      const left = parallelLlmCall(
        "score_left",
        { modelId: "scheduler", staticVars: ["left"] },
        async () => await client.invoke(`left:${input.left}`),
      );
      const right = parallelLlmCall(
        "score_right",
        { modelId: "scheduler", staticVars: ["right"] },
        async () => await client.invoke(`right:${input.right}`),
      );
      await closeParallel();
      return await llmCall(
        "merge_scores",
        { modelId: "scheduler", staticVars: ["merge"] },
        async () => await client.invoke(`${await left}|${await right}`),
      );
    },
  },
  body: async function compareBody() {
    await parallelLlmCall(
      "score_left",
      { modelId: "scheduler", staticVars: ["left"] },
      async () => "",
    );
    await parallelLlmCall(
      "score_right",
      { modelId: "scheduler", staticVars: ["right"] },
      async () => "",
    );
    await closeParallel();
    await llmCall(
      "merge_scores",
      { modelId: "scheduler", staticVars: ["merge"] },
      async () => "",
    );
  },
});
```

Important invariant:

- every open parallel group must be closed explicitly before the sequential
  continuation

## 4. ToolLoopAgent Entry Point

Use `defineToolLoopAgent(...)` when the top-level control flow is an AI SDK
`ToolLoopAgent`.

```ts
const agent = defineToolLoopAgent({
  name: "assistant",
  modelId: "scheduler",
  maxIterations: 3,
  allowedToolSets: [["search"], ["draft"]],
  instructions: "Assistant",
  settings: {
    model,
    tools: { search, draft },
    stopWhen: ({ steps }) => steps.length >= 3,
  },
});
```

Important invariants:

- `maxIterations` must be explicit
- `allowedToolSets` must enumerate the actual mutually exclusive tool sets
- the repeated model step is treated as one unrolled `.step` node per iteration

## 5. Manual Loop Entry Point

Use `defineManualAgent(...)` when the repo owns the step loop and you want the
compiler to treat it the same way as a ToolLoopAgent.

```ts
const agent = defineManualAgent({
  name: "manual_assistant",
  modelId: "scheduler",
  maxIterations: 2,
  allowedToolSets: [["search"]],
  instructions: "Manual assistant",
  tools: { search },
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
```

Important invariant:

- `runStep(...)` must return tool calls that match exactly one declared
  `allowedToolSets` entry
