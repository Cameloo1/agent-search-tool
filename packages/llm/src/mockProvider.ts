import type { LLMProvider, StructuredLLMInput } from "@agent-search/shared";

export type MockLLMOutput = unknown | Error;
export type MockLLMHandler = (input: StructuredLLMInput, callIndex: number) => Promise<unknown> | unknown;

export interface MockLLMProviderOptions {
  name?: string;
  outputs?: MockLLMOutput[];
  handler?: MockLLMHandler;
  defaultOutput?: unknown;
  delayMs?: number;
  failOnExhausted?: boolean;
}

export class MockLLMProvider implements LLMProvider {
  readonly name: string;
  readonly calls: StructuredLLMInput[] = [];

  private readonly handler?: MockLLMHandler;
  private readonly delayMs: number;
  private readonly failOnExhausted: boolean;
  private readonly defaultOutput: unknown;
  private readonly hasDefaultOutput: boolean;
  private outputs: MockLLMOutput[];

  constructor(options: MockLLMProviderOptions = {}) {
    this.name = options.name ?? "mock-llm";
    this.outputs = [...(options.outputs ?? [])];
    this.handler = options.handler;
    this.delayMs = options.delayMs ?? 0;
    this.failOnExhausted = options.failOnExhausted ?? true;
    this.defaultOutput = options.defaultOutput;
    this.hasDefaultOutput = Object.prototype.hasOwnProperty.call(options, "defaultOutput");
  }

  async generateStructured(input: StructuredLLMInput): Promise<unknown> {
    this.calls.push(input);
    const callIndex = this.calls.length;

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const output = this.handler ? await this.handler(input, callIndex) : this.nextOutput();
    if (output instanceof Error) {
      throw output;
    }

    return output;
  }

  remainingOutputs(): number {
    return this.outputs.length;
  }

  reset(outputs: MockLLMOutput[] = []): void {
    this.calls.length = 0;
    this.outputs = [...outputs];
  }

  private nextOutput(): MockLLMOutput {
    const output = this.outputs.shift();
    if (output !== undefined) {
      return output;
    }

    if (this.hasDefaultOutput) {
      return this.defaultOutput;
    }

    if (this.failOnExhausted) {
      return new Error("MockLLMProvider exhausted outputs");
    }

    return {};
  }
}

export function createMockLLMProvider(
  outputsOrOptions: MockLLMOutput[] | MockLLMProviderOptions | MockLLMHandler = []
): MockLLMProvider {
  if (Array.isArray(outputsOrOptions)) {
    return new MockLLMProvider({ outputs: outputsOrOptions });
  }

  if (typeof outputsOrOptions === "function") {
    return new MockLLMProvider({ handler: outputsOrOptions });
  }

  return new MockLLMProvider(outputsOrOptions);
}
