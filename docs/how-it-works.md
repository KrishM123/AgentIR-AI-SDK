# How AgentIR-AI-SDK Works

This document explains the actual compile model used by `AgentIR-AI-SDK`.

## 1. The Compiler Starts From an Agent Definition

The package compiles one of two agent definitions:

- `defineToolLoopAgent(...)`
- `defineManualAgent(...)`

Each definition already contains the structural facts the compiler needs:

- the stable agent name
- the repeated system prompt
- the model id
- the explicit loop bound
- the explicit allowed tool sets

The compiler does not inspect arbitrary application files looking for hidden
control flow. It compiles the explicit AgentIR definition surface only.

## 2. Each Agent Loop Is Unrolled

AI SDK agents are iterative. AgentIR turns that into a bounded DAG by expanding
each possible loop step into a fresh set of nodes.

For a three-iteration loop, the top-level shape looks like:

```text
iter_0.step -> iter_0.{finish|choice_*}
iter_0.join_* -> iter_1.step
iter_1.join_* -> iter_2.step
iter_2.join_* -> done
```

There is no cycle in the compiled contract.

## 3. Tool Sets Become Explicit Branches

`allowedToolSets` are the compile-time description of which tool calls may
follow a loop step.

For each allowed set, the compiler emits:

- one `choice_*` node
- one unique `conditional::...` edge from the step node to that choice node
- one or more `all_or_nothing::...` edges from the choice node to the tool
  leaves for that set
- one join node that all tools in that set feed into

The no-tool exit path is explicit too:

- `step -> finish -> done`

That matters because the scheduler needs a branch-aware contract, not an
implicit absence of work.

## 4. Tool Bodies Are Parsed Through Explicit Markers

`defineAgentIRTool(...)` may provide a compile-visible `body`.

The compiler parses the function source text and only honors these call names:

- `llmCall`
- `parallelLlmCall`
- `toolLoop`
- `parallelToolLoop`
- `closeParallel`

The body is walked in lexical order. That means:

- sequential markers create sequential nodes
- parallel markers attach children to the current parallel anchor
- `closeParallel()` inserts the join that the next sequential marker reads from

Anything that is not one of those markers is ignored for graph construction.

## 5. Nested Agents Expand Inline

When a tool body uses `toolLoop("child_name", ...)`, the compiler looks up
`child_name` in `nestedAgents` and compiles the child agent under a namespaced
prefix.

Example:

```text
parent.iter_0.choice_0.tool.delegate
parent.iter_0.choice_0.tool.delegate.subagent.delegate_worker.iter_0.step
```

The child graph is not referenced symbolically. It is expanded into the parent
contract so the scheduler sees one concrete DAG.

## 6. Dependency Vars Are Synthesized Automatically

The compiler does not ask the user for LangGraph-style state keys.

Instead it synthesizes one result var per executable node:

- `result::<nodeName>`

Downstream executable nodes read the result vars written by their structural
predecessors.

That gives the scheduler a stable dependency surface without requiring the user
to manually mirror the agent transcript as graph state.

## 7. Parallel Groups Have Their Own Join Points

Parallel markers open a synthetic group anchor. Each child in the group fans out
from that anchor. `closeParallel()` creates the group join.

Example:

```text
tool.judge.parallel_0
tool.judge.parallel_0.llm.score_left
tool.judge.parallel_0.llm.score_right
tool.judge.parallel_0.join
tool.judge.llm.merge_scores
```

The merge step reads from `parallel_0.join`, not directly from the individual
children.

## 8. Manual Agents Use the Same Compile Model

`defineManualAgent(...)` does not change the contract structure. It only changes
how the runtime step is executed.

At compile time, a manual agent still has:

- the same unrolled iteration structure
- the same explicit tool-set branching
- the same tool-body parsing rules

The difference is that the user supplies `runStep(...)` instead of relying on
`ToolLoopAgent`.

## 9. Contract JSON Is a Direct Serialization

`contractToJson(...)` returns the compiled structure directly:

- `entry`
- `end`
- `nodes`
- `edges`

No second inference pass happens after serialization. The JSON is the same graph
`buildContract(...)` produced in memory.
