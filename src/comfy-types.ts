export interface ComfyNode {
  class_type: string;
  inputs: Record<string, string | number | boolean | [string, number]>;
}
export type ComfyWorkflow = Record<string, ComfyNode>;
export interface ComfyBinding { nodeId: string; input: string }
export interface ComfyParameters {
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  shift: number;
  sampler: string;
  scheduler: string;
}
export type ComfyInputName = 'positive' | 'negative' | keyof ComfyParameters;
export type ComfyBindings = { positive: ComfyBinding; outputNodeIds: string[] }
  & Partial<Record<Exclude<ComfyInputName, 'positive'>, ComfyBinding>>;
export interface ComfySettings {
  url: string;
  workflow: ComfyWorkflow;
  bindings: ComfyBindings;
  parameters: ComfyParameters;
}
