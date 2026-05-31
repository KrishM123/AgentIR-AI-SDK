import { ToolLoopAgent } from "ai";
import type {
  GenerateTextResult,
  ModelMessage,
  Tool,
  ToolExecutionOptions,
  ToolLoopAgentSettings,
  ToolSet,
  StreamTextResult,
} from "ai";

import {
  getCurrentStepContext,
  takePendingToolCall,
  withAgentIRRun,
  withNodeName,
  setStepContext,
  registerPendingToolCall,
  getCurrentNestedPrefix,
} from "./context.js";
import type {
  AgentIRGeneratedResult,
  AgentIRManualDefinition,
  AgentIRStreamResult,
  AnyAgentIRToolDefinition,
  AgentIRToolDefinition,
  AgentIRToolLoopDefinition,
  ManualAgentMetadata,
  ManualStepDecision,
  ManualStepInvocation,
  ToolLoopAgentMetadata,
} from "./internal-types.js";

function sanitizeName(name: string) {
  return name.trim().replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function rootPrefix(name: string) {
  return sanitizeName(name);
}

function createUserMessage(prompt: string): ModelMessage {
  return {
    role: "user",
    content: [{ type: "text", text: prompt }],
  };
}

function createAssistantToolCallMessage(
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
): ModelMessage {
  return {
    role: "assistant",
    content: toolCalls.map((toolCall) => ({
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
    })),
  };
}

function normalizeToolResult(output: unknown) {
  if (output == null) {
    return null;
  }
  if (typeof output === "string" || typeof output === "number" || typeof output === "boolean") {
    return output;
  }
  return output as Record<string, unknown>;
}

function createToolResultMessage(
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>,
): ModelMessage {
  return {
    role: "tool",
    content: toolResults.map((toolResult) => ({
      type: "tool-result",
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      output:
        typeof toolResult.output === "string"
          ? { type: "text", value: toolResult.output }
          : { type: "json", value: normalizeToolResult(toolResult.output) as any },
    })),
  } as ModelMessage;
}

function createAssistantTextMessage(text: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function chunkText(text: string) {
  if (text.length <= 12) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 12) {
    chunks.push(text.slice(index, index + 12));
  }
  return chunks;
}

function createSimpleTextStream(text: string): AgentIRStreamResult {
  const chunks = chunkText(text);
  const stream = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return {
    textStream: stream,
    text: Promise.resolve(text),
  };
}

function resolveCurrentPrefix(name: string) {
  return getCurrentNestedPrefix() ?? rootPrefix(name);
}

function findAllowedToolSetIndex(allowedToolSets: string[][], toolNames: string[]) {
  const requested = [...toolNames].sort();
  return allowedToolSets.findIndex((candidate) => {
    const normalized = [...candidate].sort();
    return normalized.length === requested.length && normalized.every((name, index) => name === requested[index]);
  });
}

function parseStepNodeName(nodeName: string) {
  const match = /^(.*)\.iter_(\d+)\.step$/.exec(nodeName);
  if (!match) {
    return undefined;
  }
  return {
    prefix: match[1],
    iteration: Number.parseInt(match[2]!, 10),
  };
}

function toolCallNamesForExecution(messages: ModelMessage[], toolCallId: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    const toolCallParts = message.content.filter((part) => part.type === "tool-call");
    if (!toolCallParts.some((part) => part.toolCallId === toolCallId)) {
      continue;
    }
    return toolCallParts.map((part) => part.toolName);
  }
  return undefined;
}

function activeToolNamesForStepContext(
  stepContext: ReturnType<typeof getCurrentStepContext>,
  toolName: string,
) {
  const activeToolNames = stepContext?.activeToolNames;
  if (!activeToolNames || activeToolNames.length === 0) {
    return undefined;
  }
  return activeToolNames.includes(toolName) ? activeToolNames : undefined;
}

function inferToolLoopBinding(
  toolName: string,
  executionOptions: ToolExecutionOptions,
) {
  const stepContext = getCurrentStepContext();
  if (!stepContext) {
    return undefined;
  }

  const stepInfo = parseStepNodeName(stepContext.nodeName);
  if (!stepInfo) {
    return undefined;
  }

  const toolCallNames =
    activeToolNamesForStepContext(stepContext, toolName) ??
    (executionOptions.toolCallId
      ? toolCallNamesForExecution(
          executionOptions.messages,
          executionOptions.toolCallId,
        )
      : undefined);
  if (!toolCallNames) {
    return undefined;
  }

  const toolSetIndex = findAllowedToolSetIndex(
    stepContext.allowedToolSets,
    toolCallNames,
  );
  if (toolSetIndex < 0) {
    throw new Error(
      `Tool calls [${toolCallNames.join(", ")}] do not match any declared allowedToolSets entry.`,
    );
  }

  const sanitizedToolName = sanitizeName(toolName);
  const nodeName =
    `${stepInfo.prefix}.iter_${stepInfo.iteration}.choice_${toolSetIndex}.tool.${sanitizedToolName}`;
  return {
    nodeName,
    nestedPrefix: nodeName,
  };
}

function registerManualToolBindings(
  prefix: string,
  iteration: number,
  allowedToolSets: string[][],
  toolCalls: Array<{ toolCallId: string; toolName: string }>,
) {
  const requested = toolCalls.map((toolCall) => toolCall.toolName);
  const toolSetIndex = findAllowedToolSetIndex(allowedToolSets, requested);

  if (toolSetIndex < 0) {
    throw new Error(
      `Tool calls [${requested.join(", ")}] do not match any declared allowedToolSets entry.`,
    );
  }

  for (const toolCall of toolCalls) {
    const toolNodeName = `${prefix}.iter_${iteration}.choice_${toolSetIndex}.tool.${sanitizeName(toolCall.toolName)}`;
    registerPendingToolCall(toolCall.toolCallId, {
      nodeName: toolNodeName,
      nestedPrefix: toolNodeName,
    });
  }
}

export function defineAgentIRTool<INPUT, OUTPUT>(options: {
  name: string;
  tool: Tool<INPUT, OUTPUT>;
  body?: (...args: any[]) => any;
  nestedAgents?: Record<string, AgentIRToolLoopDefinition | AgentIRManualDefinition>;
}): AgentIRToolDefinition<INPUT, OUTPUT> {
  const { name, tool, body, nestedAgents = {} } = options;

  const wrappedTool = {
    ...tool,
    async execute(input: INPUT, executionOptions: ToolExecutionOptions) {
      if (!tool.execute) {
        return undefined as OUTPUT;
      }
      const binding =
        takePendingToolCall(executionOptions.toolCallId) ??
        inferToolLoopBinding(name, executionOptions);
      const nodeName = binding?.nodeName ?? sanitizeName(name);
      const nestedPrefix = binding?.nestedPrefix ?? nodeName;
      return await withNodeName(
        nodeName,
        async () => await tool.execute!(input, executionOptions),
        { nestedPrefix },
      );
    },
    __agentir_tool__: {
      kind: "tool",
      name,
      body,
      nestedAgents,
      tool,
    },
  } as unknown as AgentIRToolDefinition<INPUT, OUTPUT>;

  return wrappedTool;
}

function createWrappedToolLoopAgent<TOOLS extends ToolSet>(
  metadata: ToolLoopAgentMetadata<TOOLS>,
): AgentIRToolLoopDefinition<TOOLS> {
  return {
    __agentir_agent__: metadata,
    async generate(input) {
      return await withAgentIRRun(async () => {
        resolveCurrentPrefix(metadata.name);
        return await metadata.agent.generate({
          ...input,
          onStepFinish: input.onStepFinish,
        } as never);
      });
    },
    async stream(input) {
      return await withAgentIRRun(async () => {
        resolveCurrentPrefix(metadata.name);
        return await metadata.agent.stream({
          ...input,
          onStepFinish: input.onStepFinish,
        } as never);
      });
    },
  };
}

export function defineToolLoopAgent<TOOLS extends ToolSet>(options: {
  name: string;
  modelId: string;
  maxIterations: number;
  allowedToolSets: string[][];
  instructions?: string | string[];
  settings: Omit<ToolLoopAgentSettings<never, TOOLS, any>, "prepareStep" | "onStepFinish" | "tools" | "model"> & {
    model: ToolLoopAgentSettings<never, TOOLS, any>["model"];
    tools: Record<string, AnyAgentIRToolDefinition>;
    prepareStep?: ToolLoopAgentSettings<never, TOOLS, any>["prepareStep"];
    onStepFinish?: ToolLoopAgentSettings<never, TOOLS, any>["onStepFinish"];
  };
}): AgentIRToolLoopDefinition<TOOLS> {
  const { name, modelId, maxIterations, allowedToolSets, instructions, settings } = options;

  const agent = new ToolLoopAgent<never, TOOLS, any>({
    ...settings,
    instructions:
      Array.isArray(instructions)
        ? instructions.join("\n")
        : instructions ?? settings.instructions,
    tools: settings.tools as unknown as TOOLS,
    prepareStep: async (prepareOptions) => {
      const stepNodeName = `${resolveCurrentPrefix(name)}.iter_${prepareOptions.stepNumber}.step`;
      const prepareResult = await settings.prepareStep?.(prepareOptions);
      const activeToolNames = Array.isArray(prepareResult?.activeTools)
        ? prepareResult.activeTools.map((toolName) => String(toolName))
        : undefined;
      setStepContext(
        stepNodeName,
        resolveCurrentPrefix(name),
        allowedToolSets,
        activeToolNames,
      );
      return prepareResult;
    },
    onStepFinish: async (event) => {
      await settings.onStepFinish?.(event);
    },
  });

  return createWrappedToolLoopAgent({
    kind: "tool-loop",
    name,
    modelId,
    maxIterations,
    allowedToolSets,
    instructions: Array.isArray(instructions) ? instructions : instructions ? [instructions] : undefined,
    tools: settings.tools,
    agent,
  });
}

async function executeManualIterationTools(
  tools: Record<string, AnyAgentIRToolDefinition>,
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
) {
  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      const tool = tools[toolCall.toolName];
      if (!tool?.execute) {
        throw new Error(`Tool '${toolCall.toolName}' is not executable.`);
      }
      const output = await tool.execute(toolCall.input, {
        toolCallId: toolCall.toolCallId,
        messages: [],
      });
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output,
      };
    }),
  );

  return results;
}

function createManualDefinition(metadata: ManualAgentMetadata): AgentIRManualDefinition {
  return {
    __agentir_agent__: metadata,
    async generate(input): Promise<AgentIRGeneratedResult> {
      return await withAgentIRRun(async () => {
        const prefix = resolveCurrentPrefix(metadata.name);
        const messages = input.messages
          ? [...input.messages]
          : input.prompt
            ? [createUserMessage(input.prompt)]
            : [];

        for (let iteration = 0; iteration < metadata.maxIterations; iteration += 1) {
          setStepContext(
            `${prefix}.iter_${iteration}.step`,
            prefix,
            metadata.allowedToolSets,
          );
          const decision = await metadata.runStep({
            stepNumber: iteration,
            prompt: input.prompt,
            messages,
            tools: metadata.tools,
          } satisfies ManualStepInvocation);

          if (decision.toolCalls.length === 0) {
            messages.push(createAssistantTextMessage(decision.text));
            return {
              text: decision.text,
              messages,
            };
          }

          const toolCalls = decision.toolCalls.map((toolCall, toolIndex) => ({
            toolCallId: `${prefix}-iter-${iteration}-tool-${toolIndex}`,
            toolName: toolCall.toolName,
            input: toolCall.input,
          }));

          registerManualToolBindings(prefix, iteration, metadata.allowedToolSets, toolCalls);

          messages.push(createAssistantToolCallMessage(toolCalls));
          const toolResults = await executeManualIterationTools(metadata.tools, toolCalls);
          messages.push(createToolResultMessage(toolResults));
        }

        return {
          text: "",
          messages,
        };
      });
    },
    async stream(input) {
      const generated = await this.generate(input);
      return createSimpleTextStream(generated.text);
    },
  };
}

export function defineManualAgent(options: {
  name: string;
  modelId: string;
  maxIterations: number;
  allowedToolSets: string[][];
  instructions?: string | string[];
  tools: Record<string, AnyAgentIRToolDefinition>;
  runStep: (invocation: ManualStepInvocation) => Promise<ManualStepDecision>;
}): AgentIRManualDefinition {
  const metadata: ManualAgentMetadata = {
    kind: "manual",
    name: options.name,
    modelId: options.modelId,
    maxIterations: options.maxIterations,
    allowedToolSets: options.allowedToolSets,
    instructions: Array.isArray(options.instructions)
      ? options.instructions
      : options.instructions
        ? [options.instructions]
        : undefined,
    tools: options.tools,
    runStep: options.runStep,
  };

  return createManualDefinition(metadata);
}
