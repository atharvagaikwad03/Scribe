export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  model: string;
}

/** Minimal provider interface. Implementations must be side-effect free apart from the network call. */
export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
}
