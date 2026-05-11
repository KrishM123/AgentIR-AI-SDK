# AgentIR-AI-SDK Documentation

This directory explains the annotation library from three angles:

- public interface
- compile model
- runtime execution model

Read in this order:

1. `../interface.md`
2. `how-it-works.md`
3. `runtime.md`
4. `annotation-patterns.md`
5. `limitations.md`

## What Each Document Covers

- `../interface.md`: the public API, required metadata, and contract shape
- `how-it-works.md`: how loop unrolling, tool-set branching, nested agents, and
  dependency vars are compiled
- `runtime.md`: how RID and node-name metadata propagate into scheduler-backed
  requests
- `annotation-patterns.md`: practical annotation patterns for tools, nested
  agents, parallel groups, and manual loops
- `limitations.md`: deliberate v1 boundaries and unsupported patterns
