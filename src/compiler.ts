import ts from "typescript";

import type { Contract, Edge, LLMCall, NodeMeta } from "./contract.js";
import type {
  AgentIRAgentDefinition,
  AgentIRToolDefinition,
  ManualAgentMetadata,
  MarkerOperation,
  ToolLoopAgentMetadata,
} from "./internal-types.js";
import { getAgentMetadata, getToolMetadata } from "./runtime-metadata.js";

function sanitizeName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Names used in AgentIR markers cannot be empty.");
  }
  return trimmed.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function resultVar(nodeName: string) {
  return `result::${nodeName}`;
}

function conditionalLabel(src: string, branch: string) {
  return `conditional::${src}::${branch}`;
}

function allOrNothingLabel(src: string, branch: string) {
  return `all_or_nothing::${src}::${branch}`;
}

class ContractBuilder {
  readonly nodes = new Map<string, NodeMeta>();
  readonly edges = new Map<string, Edge>();
  readonly entry: string;
  readonly end: string;

  constructor(entry: string, end: string) {
    this.entry = entry;
    this.end = end;
  }

  addNode(name: string, options: { llm?: LLMCall; writes?: string[] } = {}) {
    const existing = this.nodes.get(name);
    const writes = Array.from(
      new Set([...(existing?.writes ?? []), ...(options.writes ?? [])]),
    );
    const llmCalls = [...(existing?.llm_calls ?? [])];
    if (options.llm) {
      llmCalls.push(options.llm);
    }
    this.nodes.set(name, {
      name,
      writes,
      llm_calls: llmCalls,
    });
  }

  addEdge(src: string, dst: string, label: string | null = null) {
    this.edges.set(`${src}::${dst}::${label ?? ""}`, { src, dst, label });
  }

  addStructuralNode(name: string, writes: string[] = []) {
    this.addNode(name, { writes });
  }

  addExecutableNode(
    name: string,
    model: string,
    parents: string[],
    staticVars: string[],
    extraReads: string[] = [],
  ) {
    parents.forEach((parent) => this.addEdge(parent, name));
    this.addNode(name, {
      writes: [resultVar(name)],
      llm: {
        model,
        reads: [...new Set([...parents.map((parent) => resultVar(parent)), ...extraReads])],
        static_vars: [...staticVars],
      },
    });
  }

  build(): Contract {
    return {
      entry: this.entry,
      end: this.end,
      nodes: Object.fromEntries(this.nodes.entries()),
      edges: Array.from(this.edges.values()),
    };
  }
}

function parseObjectLiteralStringArray(
  literal: ts.ObjectLiteralExpression,
  propertyName: string,
) {
  const property = literal.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === propertyName) ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === propertyName)),
  );
  if (!property || !ts.isArrayLiteralExpression(property.initializer)) {
    return undefined;
  }
  return property.initializer.elements.map((element) => {
    if (!ts.isStringLiteralLike(element)) {
      throw new Error(`${propertyName} must contain only string literals.`);
    }
    return element.text;
  });
}

function markerCalleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return markerCalleeName(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return markerCalleeName(expression.right);
  }
  return undefined;
}

function parseMarkerOperations(body?: (...args: any[]) => any): MarkerOperation[] {
  if (!body) {
    return [];
  }

  const sourceText = `const __agentir_body__ = ${body.toString()};`;
  const sourceFile = ts.createSourceFile(
    `${body.name || "agentir-body"}.ts`,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let rootFunction: ts.FunctionLikeDeclaration | undefined;
  sourceFile.forEachChild((node) => {
    if (
      ts.isVariableStatement(node) &&
      ts.isVariableDeclarationList(node.declarationList)
    ) {
      const declaration = node.declarationList.declarations[0];
      if (
        declaration &&
        declaration.initializer &&
        (ts.isFunctionExpression(declaration.initializer) ||
          ts.isArrowFunction(declaration.initializer))
      ) {
        rootFunction = declaration.initializer;
      }
    }
  });

  if (!rootFunction?.body) {
    throw new Error(`Could not parse AgentIR body '${body.name || "anonymous"}'.`);
  }

  const operations: MarkerOperation[] = [];
  const visit = (node: ts.Node) => {
    if (node !== rootFunction && ts.isFunctionLike(node)) {
      return;
    }

    if (ts.isCallExpression(node)) {
      const calleeText = markerCalleeName(node.expression);
      if (
        calleeText &&
        ["llmCall", "parallelLlmCall", "toolLoop", "parallelToolLoop", "closeParallel"].includes(
          calleeText,
        )
      ) {
        if (calleeText === "closeParallel") {
          operations.push({ kind: "closeParallel" });
          return;
        }

        const [firstArg, secondArg] = node.arguments;
        if (!firstArg || !ts.isStringLiteralLike(firstArg)) {
          throw new Error(`${calleeText} requires a string literal as its first argument.`);
        }

        let modelId: string | undefined;
        let staticVars: string[] | undefined;
        if (
          secondArg &&
          ts.isObjectLiteralExpression(secondArg) &&
          (calleeText === "llmCall" || calleeText === "parallelLlmCall")
        ) {
          const modelProperty = secondArg.properties.find(
            (candidate): candidate is ts.PropertyAssignment =>
              ts.isPropertyAssignment(candidate) &&
              ts.isIdentifier(candidate.name) &&
              candidate.name.text === "modelId" &&
              ts.isStringLiteralLike(candidate.initializer),
          );
          modelId = modelProperty ? (modelProperty.initializer as ts.StringLiteralLike).text : undefined;
          staticVars = parseObjectLiteralStringArray(secondArg, "staticVars");
        }

        operations.push({
          kind: calleeText as MarkerOperation["kind"],
          name: firstArg.text,
          modelId,
          staticVars,
        });
        return;
      }
    }

    node.forEachChild(visit);
  };

  rootFunction.body.forEachChild(visit);
  return operations;
}

interface ToolCompilationResult {
  terminalNodes: string[];
}

function compileNestedAgent(
  builder: ContractBuilder,
  nestedAgent: AgentIRAgentDefinition,
  prefix: string,
  parents: string[],
) {
  const metadata = getAgentMetadata(nestedAgent);
  if (!metadata) {
    throw new Error(`Nested AgentIR agent '${prefix}' is missing metadata.`);
  }
  const nested = compileAgentInto(builder, metadata, prefix);
  parents.forEach((parent) => builder.addEdge(parent, nested.entryNode));
  return nested.terminalNodes;
}

function compileToolBody(
  builder: ContractBuilder,
  tool: AgentIRToolDefinition,
  wrapperNodeName: string,
  inheritedModelId: string,
): ToolCompilationResult {
  const metadata = getToolMetadata(tool);
  if (!metadata) {
    throw new Error(`Tool '${wrapperNodeName}' is missing AgentIR metadata.`);
  }

  const operations = parseMarkerOperations(metadata.body);
  let frontier = [wrapperNodeName];
  let parallelGroup: MarkerOperation[] = [];
  let parallelIndex = 0;

  const compileSequentialOperation = (operation: MarkerOperation, parents: string[]) => {
    if (!operation.name) {
      throw new Error("Sequential AgentIR operations require a name.");
    }

    if (operation.kind === "llmCall") {
      const llmNodeName = `${wrapperNodeName}.llm.${sanitizeName(operation.name)}`;
      builder.addExecutableNode(
        llmNodeName,
        operation.modelId ?? inheritedModelId,
        parents,
        operation.staticVars ?? [],
      );
      return [llmNodeName];
    }

    if (operation.kind === "toolLoop") {
      const nestedAgent = metadata.nestedAgents[operation.name];
      if (!nestedAgent) {
        throw new Error(
          `Tool '${metadata.name}' references nested agent '${operation.name}' but no matching nested agent was registered.`,
        );
      }
      const nestedPrefix = `${wrapperNodeName}.subagent.${sanitizeName(operation.name)}`;
      const nestedWrapper = nestedPrefix;
      builder.addStructuralNode(nestedWrapper, [resultVar(nestedWrapper)]);
      parents.forEach((parent) => builder.addEdge(parent, nestedWrapper));
      return compileNestedAgent(builder, nestedAgent, nestedPrefix, [nestedWrapper]);
    }

    throw new Error(`Unsupported sequential operation '${operation.kind}'.`);
  };

  const flushParallelGroup = () => {
    if (parallelGroup.length === 0) {
      return;
    }

    const anchorName = `${wrapperNodeName}.parallel_${parallelIndex}`;
    const joinName = `${anchorName}.join`;
    const groupLabel = allOrNothingLabel(anchorName, "group");

    builder.addStructuralNode(anchorName, [resultVar(anchorName)]);
    builder.addStructuralNode(joinName);
    frontier.forEach((parent) => builder.addEdge(parent, anchorName));

    const groupTerminals: string[] = [];
    for (const operation of parallelGroup) {
      if (!operation.name) {
        throw new Error("Parallel AgentIR operations require a name.");
      }

      if (operation.kind === "parallelLlmCall") {
        const llmNodeName = `${anchorName}.llm.${sanitizeName(operation.name)}`;
        builder.addExecutableNode(
          llmNodeName,
          operation.modelId ?? inheritedModelId,
          [],
          operation.staticVars ?? [],
          [resultVar(anchorName)],
        );
        builder.addEdge(anchorName, llmNodeName, groupLabel);
        groupTerminals.push(llmNodeName);
        continue;
      }

      if (operation.kind === "parallelToolLoop") {
        const nestedAgent = metadata.nestedAgents[operation.name];
        if (!nestedAgent) {
          throw new Error(
            `Tool '${metadata.name}' references nested agent '${operation.name}' but no matching nested agent was registered.`,
          );
        }
        const nestedPrefix = `${anchorName}.subagent.${sanitizeName(operation.name)}`;
        const nestedWrapper = nestedPrefix;
        builder.addStructuralNode(nestedWrapper, [resultVar(nestedWrapper)]);
        builder.addEdge(anchorName, nestedWrapper, groupLabel);
        groupTerminals.push(...compileNestedAgent(builder, nestedAgent, nestedPrefix, [nestedWrapper]));
        continue;
      }

      throw new Error(`Unsupported parallel operation '${operation.kind}'.`);
    }

    groupTerminals.forEach((terminal) => builder.addEdge(terminal, joinName));
    frontier = [joinName];
    parallelGroup = [];
    parallelIndex += 1;
  };

  for (const operation of operations) {
    if (operation.kind === "closeParallel") {
      flushParallelGroup();
      continue;
    }

    if (operation.kind === "parallelLlmCall" || operation.kind === "parallelToolLoop") {
      parallelGroup.push(operation);
      continue;
    }

    if (parallelGroup.length > 0) {
      throw new Error(
        `Tool '${metadata.name}' opens a parallel section but never closes it before the next sequential marker.`,
      );
    }

    frontier = compileSequentialOperation(operation, frontier);
  }

  if (parallelGroup.length > 0) {
    throw new Error(`Tool '${metadata.name}' ends with an open parallel section.`);
  }

  return {
    terminalNodes: frontier,
  };
}

interface AgentCompilationResult {
  entryNode: string;
  terminalNodes: string[];
}

function compileAgentInto(
  builder: ContractBuilder,
  metadata: ToolLoopAgentMetadata | ManualAgentMetadata,
  prefix: string,
): AgentCompilationResult {
  const doneNode = `${prefix}.done`;
  builder.addStructuralNode(doneNode, [resultVar(doneNode)]);

  const staticVars = [
    ...(metadata.instructions
      ? Array.isArray(metadata.instructions)
        ? metadata.instructions
        : [metadata.instructions]
      : []),
  ];

  let entryNode = "";
  let previousIterationTerminals: string[] = [];

  for (let iteration = 0; iteration < metadata.maxIterations; iteration += 1) {
    const stepNodeName = `${prefix}.iter_${iteration}.step`;
    builder.addExecutableNode(
      stepNodeName,
      metadata.modelId,
      previousIterationTerminals,
      staticVars,
    );
    if (!entryNode) {
      entryNode = stepNodeName;
    }

    const finishNodeName = `${prefix}.iter_${iteration}.finish`;
    builder.addStructuralNode(finishNodeName, [resultVar(finishNodeName)]);
    builder.addEdge(stepNodeName, finishNodeName, conditionalLabel(stepNodeName, "finish"));
    builder.addEdge(finishNodeName, doneNode);

    const nextFrontier: string[] = [];
    metadata.allowedToolSets.forEach((toolSet, toolSetIndex) => {
      const choiceNodeName = `${prefix}.iter_${iteration}.choice_${toolSetIndex}`;
      const joinNodeName = `${prefix}.iter_${iteration}.join_${toolSetIndex}`;
      const fanoutLabel = allOrNothingLabel(choiceNodeName, "fanout");

      builder.addStructuralNode(choiceNodeName, [resultVar(choiceNodeName)]);
      builder.addStructuralNode(joinNodeName, [resultVar(joinNodeName)]);
      builder.addEdge(
        stepNodeName,
        choiceNodeName,
        conditionalLabel(stepNodeName, `choice_${toolSetIndex}`),
      );

      if (toolSet.length === 0) {
        throw new Error(`Agent '${metadata.name}' contains an empty allowed tool set.`);
      }

      for (const rawToolName of toolSet) {
        const toolName = sanitizeName(rawToolName);
        const tool = metadata.tools[rawToolName];
        if (!tool) {
          throw new Error(
            `Agent '${metadata.name}' references tool '${rawToolName}' in allowedToolSets but no matching tool was registered.`,
          );
        }

        const toolWrapperName = `${prefix}.iter_${iteration}.choice_${toolSetIndex}.tool.${toolName}`;
        builder.addStructuralNode(toolWrapperName, [resultVar(toolWrapperName)]);
        builder.addEdge(choiceNodeName, toolWrapperName, fanoutLabel);

        const toolTerminals = compileToolBody(builder, tool, toolWrapperName, metadata.modelId);
        toolTerminals.terminalNodes.forEach((terminal) => builder.addEdge(terminal, joinNodeName));
      }

      nextFrontier.push(joinNodeName);
    });

    previousIterationTerminals = nextFrontier;

    if (iteration === metadata.maxIterations - 1) {
      previousIterationTerminals.forEach((terminal) => builder.addEdge(terminal, doneNode));
    }
  }

  if (!entryNode) {
    throw new Error(`Agent '${metadata.name}' must have at least one iteration.`);
  }

  return {
    entryNode,
    terminalNodes: [doneNode],
  };
}

export function buildContract(agent: AgentIRAgentDefinition): Contract {
  const metadata = getAgentMetadata(agent);
  if (!metadata) {
    throw new Error("buildContract(...) requires an AgentIR agent definition.");
  }

  const rootPrefix = sanitizeName(metadata.name);
  const entryNode = `${rootPrefix}.iter_0.step`;
  const endNode = `${rootPrefix}.done`;
  const builder = new ContractBuilder(entryNode, endNode);
  compileAgentInto(builder, metadata, rootPrefix);
  return builder.build();
}
