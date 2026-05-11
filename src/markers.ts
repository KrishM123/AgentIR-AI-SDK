import {
  closeParallelTasks,
  getCurrentNodeName,
  getCurrentNestedPrefix,
  withNodeName,
  pushParallelTask,
} from "./context.js";
import { getAgentMetadata, getToolMetadata } from "./runtime-metadata.js";
import type { LlmMarkerOptions } from "./internal-types.js";

type AsyncCallback<T> = () => Promise<T> | T;

function buildNestedNodeName(currentNodeName: string | undefined, kind: "llm" | "subagent", name: string) {
  if (!currentNodeName) {
    return name;
  }
  return `${currentNodeName}.${kind}.${name}`;
}

export async function llmCall<T>(
  name: string,
  optionsOrCallback?: LlmMarkerOptions | AsyncCallback<T>,
  maybeCallback?: AsyncCallback<T>,
) {
  const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
  const callback =
    typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  if (!callback) {
    throw new Error(`llmCall('${name}') requires a callback.`);
  }
  const nestedNodeName = buildNestedNodeName(getCurrentNodeName(), "llm", name);
  return await withNodeName(
    nestedNodeName,
    callback,
    {},
  );
}

export async function parallelLlmCall<T>(
  name: string,
  optionsOrCallback?: LlmMarkerOptions | AsyncCallback<T>,
  maybeCallback?: AsyncCallback<T>,
) {
  const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
  void options;
  const callback =
    typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  if (!callback) {
    throw new Error(`parallelLlmCall('${name}') requires a callback.`);
  }
  const task = llmCall(name, callback);
  pushParallelTask(Promise.resolve(task));
  return await task;
}

export async function toolLoop<T>(name: string, callback: AsyncCallback<T>) {
  const currentNodeName = getCurrentNodeName();
  const nestedPrefix = buildNestedNodeName(currentNodeName, "subagent", name);
  return await withNodeName(currentNodeName ?? name, callback, {
    nestedPrefix,
  });
}

export async function parallelToolLoop<T>(name: string, callback: AsyncCallback<T>) {
  const task = toolLoop(name, callback);
  pushParallelTask(Promise.resolve(task));
  return await task;
}

export async function closeParallel() {
  return await closeParallelTasks();
}

export function assertAgentIRTool(name: string, value: unknown) {
  const metadata = getToolMetadata(value);
  if (!metadata) {
    throw new Error(`Tool '${name}' is not an AgentIR tool.`);
  }
  return metadata;
}

export function assertAgentIRAgent(name: string, value: unknown) {
  const metadata = getAgentMetadata(value);
  if (!metadata) {
    throw new Error(`Agent '${name}' is not an AgentIR agent.`);
  }
  return metadata;
}
