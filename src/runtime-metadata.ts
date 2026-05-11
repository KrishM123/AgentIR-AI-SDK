import type {
  AgentIRAgentDefinition,
  AgentIRToolDefinition,
  AgentIRToolMetadata,
  ManualAgentMetadata,
  ToolLoopAgentMetadata,
} from "./internal-types.js";

export function getToolMetadata(value: unknown): AgentIRToolMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as AgentIRToolDefinition).__agentir_tool__;
}

export function getAgentMetadata(
  value: unknown,
): ToolLoopAgentMetadata | ManualAgentMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as AgentIRAgentDefinition).__agentir_agent__;
}
