export interface LLMCall {
  model: string;
  reads: string[];
  static_vars: string[];
}

export interface NodeMeta {
  name: string;
  writes: string[];
  llm_calls: LLMCall[];
}

export interface Edge {
  src: string;
  dst: string;
  label: string | null;
}

export interface Contract {
  entry: string;
  end: string;
  nodes: Record<string, NodeMeta>;
  edges: Edge[];
}

export function contractToJson(contract: Contract) {
  return {
    entry: contract.entry,
    end: contract.end,
    nodes: Object.fromEntries(
      Object.entries(contract.nodes).map(([name, node]) => [
        name,
        {
          writes: [...node.writes],
          llm_calls: node.llm_calls.map((call) => ({
            model: call.model,
            reads: [...call.reads],
            static_vars: [...call.static_vars],
          })),
        },
      ]),
    ),
    edges: contract.edges.map((edge) => ({
      src: edge.src,
      dst: edge.dst,
      label: edge.label,
    })),
  };
}
