import type {
  GenerateTextResult,
  ModelMessage,
  Tool,
  ToolSet,
  ToolLoopAgentSettings,
  ToolLoopAgent,
  StreamTextResult,
} from "ai";

export interface LlmMarkerOptions {
  modelId?: string;
  staticVars?: string[];
}

export type MarkerKind =
  | "llmCall"
  | "parallelLlmCall"
  | "toolLoop"
  | "parallelToolLoop"
  | "closeParallel";

export interface MarkerOperation {
  kind: MarkerKind;
  name?: string;
  modelId?: string;
  staticVars?: string[];
}

export interface AgentIRToolMetadata<INPUT = any, OUTPUT = any> {
  kind: "tool";
  name: string;
  body?: (...args: any[]) => any;
  nestedAgents: Record<string, AgentIRAgentDefinition>;
  tool: Tool<INPUT, OUTPUT>;
}

export interface ToolLoopAgentMetadata<TOOLS extends ToolSet = ToolSet> {
  kind: "tool-loop";
  name: string;
  modelId: string;
  maxIterations: number;
  allowedToolSets: string[][];
  instructions?: string | string[];
  tools: Record<string, AnyAgentIRToolDefinition>;
  agent: ToolLoopAgent<never, TOOLS, any>;
}

export interface ManualStepInvocation {
  stepNumber: number;
  prompt: string | undefined;
  messages: ModelMessage[];
  tools: Record<string, AnyAgentIRToolDefinition>;
}

export interface ManualStepDecision {
  text: string;
  toolCalls: Array<{
    toolName: string;
    input: unknown;
  }>;
}

export interface ManualAgentMetadata {
  kind: "manual";
  name: string;
  modelId: string;
  maxIterations: number;
  allowedToolSets: string[][];
  instructions?: string | string[];
  tools: Record<string, AgentIRToolDefinition>;
  runStep: (invocation: ManualStepInvocation) => Promise<ManualStepDecision>;
}

export interface AgentIRGeneratedResult {
  text: string;
  messages: ModelMessage[];
}

export interface AgentIRStreamResult {
  textStream: ReadableStream<string>;
  text: Promise<string>;
}

export type AgentIRToolDefinition<INPUT = any, OUTPUT = any> = Tool<INPUT, OUTPUT> & {
  __agentir_tool__: AgentIRToolMetadata<INPUT, OUTPUT>;
};

export type AnyAgentIRToolDefinition = AgentIRToolDefinition<any, any>;

export interface AgentIRToolLoopDefinition<TOOLS extends ToolSet = ToolSet> {
  __agentir_agent__: ToolLoopAgentMetadata<TOOLS>;
  generate(input: {
    prompt?: string;
    messages?: ModelMessage[];
    onStepFinish?: ToolLoopAgentSettings<any, TOOLS, any>["onStepFinish"];
  }): Promise<GenerateTextResult<TOOLS, any>>;
  stream(input: {
    prompt?: string;
    messages?: ModelMessage[];
    onStepFinish?: ToolLoopAgentSettings<any, TOOLS, any>["onStepFinish"];
  }): Promise<StreamTextResult<TOOLS, any>>;
}

export interface AgentIRManualDefinition {
  __agentir_agent__: ManualAgentMetadata;
  generate(input: {
    prompt?: string;
    messages?: ModelMessage[];
  }): Promise<AgentIRGeneratedResult>;
  stream(input: {
    prompt?: string;
    messages?: ModelMessage[];
  }): Promise<AgentIRStreamResult>;
}

export type AgentIRAgentDefinition =
  | AgentIRToolLoopDefinition
  | AgentIRManualDefinition;

export function isAgentIRToolDefinition(value: unknown): value is AgentIRToolDefinition {
  return Boolean(
    value &&
      typeof value === "object" &&
      "__agentir_tool__" in value &&
      (value as { __agentir_tool__?: { kind?: string } }).__agentir_tool__?.kind === "tool",
  );
}

export function isAgentIRAgentDefinition(value: unknown): value is AgentIRAgentDefinition {
  return Boolean(
    value &&
      typeof value === "object" &&
      "__agentir_agent__" in value &&
      ["tool-loop", "manual"].includes(
        (value as { __agentir_agent__?: { kind?: string } }).__agentir_agent__?.kind ?? "",
      ),
  );
}
