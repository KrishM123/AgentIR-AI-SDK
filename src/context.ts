import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface SchedulerHeaderBound {
  withSchedulerHeaders(headers: Record<string, string>): unknown;
}

interface PendingToolCall {
  nodeName: string;
  nestedPrefix: string;
}

interface StepContext {
  nodeName: string;
  nestedPrefix?: string;
  allowedToolSets: string[][];
  activeToolNames?: string[];
}

interface AgentIRRunState {
  rid: string;
  currentNodeName?: string;
  parallelTasks: Promise<unknown>[];
  pendingToolCalls: Map<string, PendingToolCall>;
  nestedPrefix?: string;
  stepContext?: StepContext;
}

const runStorage = new AsyncLocalStorage<AgentIRRunState>();

function normalizeRid(rid?: string) {
  return rid ?? randomBytes(16).toString("hex");
}

export async function withAgentIRRun<T>(
  fn: () => Promise<T> | T,
  options: { rid?: string } = {},
): Promise<T> {
  const current = runStorage.getStore();
  if (current) {
    return await fn();
  }

  return await runStorage.run(
    {
      rid: normalizeRid(options.rid),
      parallelTasks: [],
      pendingToolCalls: new Map(),
    },
    fn,
  );
}

export function getCurrentRid() {
  return runStorage.getStore()?.rid;
}

export function getCurrentNodeName() {
  return runStorage.getStore()?.currentNodeName;
}

export function getCurrentNestedPrefix() {
  return runStorage.getStore()?.nestedPrefix;
}

export function getCurrentStepContext() {
  return runStorage.getStore()?.stepContext;
}

export function setStepContext(
  nodeName: string,
  nestedPrefix?: string,
  allowedToolSets: string[][] = [],
  activeToolNames?: string[],
) {
  const state = runStorage.getStore();
  if (!state) {
    return;
  }
  state.currentNodeName = nodeName;
  state.nestedPrefix = nestedPrefix;
  state.stepContext = {
    nodeName,
    nestedPrefix,
    allowedToolSets,
    activeToolNames,
  };
}

export function getSchedulerHeaders(): Record<string, string> {
  const state = runStorage.getStore();
  const headers: Record<string, string> = {};
  if (state?.rid) {
    headers.rid = String(Number.parseInt(state.rid.slice(0, 12), 16) % (2 ** 31));
  }
  if (state?.currentNodeName) {
    headers["node-name"] = state.currentNodeName;
  }
  return headers;
}

export function bindSchedulerHeaders<T extends Record<string, string | undefined>>(headers?: T) {
  return {
    ...(headers ?? {}),
    ...getSchedulerHeaders(),
  };
}

export function getBlackboxHeaders<T extends Record<string, string | undefined>>(
  workflowApiKey: string,
  headers?: T,
) {
  return {
    ...getSchedulerHeaders(),
    ...(headers ?? {}),
    Authorization: `Bearer ${workflowApiKey}`,
  };
}

export function bindBlackboxHeaders<T extends Record<string, string | undefined>>(
  workflowApiKey: string,
  headers?: T,
) {
  return getBlackboxHeaders(workflowApiKey, headers);
}

export function bindSchedulerClient<T>(client: T): T {
  if (
    client &&
    typeof client === "object" &&
    "withSchedulerHeaders" in client &&
    typeof (client as SchedulerHeaderBound).withSchedulerHeaders === "function"
  ) {
    return (client as SchedulerHeaderBound).withSchedulerHeaders(getSchedulerHeaders()) as T;
  }
  return client;
}

export async function withNodeName<T>(
  nodeName: string,
  fn: () => Promise<T> | T,
  options: { nestedPrefix?: string } = {},
): Promise<T> {
  const state = runStorage.getStore();
  if (!state) {
    return await fn();
  }

  return await runStorage.run(
    {
      ...state,
      currentNodeName: nodeName,
      nestedPrefix:
        options.nestedPrefix !== undefined
          ? options.nestedPrefix
          : state.nestedPrefix,
    },
    fn,
  );
}

export function registerPendingToolCall(
  toolCallId: string,
  binding: PendingToolCall,
) {
  const state = runStorage.getStore();
  if (!state) {
    return;
  }
  state.pendingToolCalls.set(toolCallId, binding);
}

export function takePendingToolCall(toolCallId: string) {
  const state = runStorage.getStore();
  if (!state) {
    return undefined;
  }
  const binding = state.pendingToolCalls.get(toolCallId);
  state.pendingToolCalls.delete(toolCallId);
  return binding;
}

export function pushParallelTask(task: Promise<unknown>) {
  const state = runStorage.getStore();
  if (!state) {
    return;
  }
  state.parallelTasks.push(task);
}

export async function closeParallelTasks() {
  const state = runStorage.getStore();
  if (!state || state.parallelTasks.length === 0) {
    return [];
  }
  const tasks = [...state.parallelTasks];
  state.parallelTasks.length = 0;
  return await Promise.all(tasks);
}
