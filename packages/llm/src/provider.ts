import type { LLMProvider, StructuredLLMInput } from "@agent-search/shared";

export type GenerateStructuredFn = (input: StructuredLLMInput) => Promise<unknown> | unknown;

export function createLLMProvider(name: string, generateStructured: GenerateStructuredFn): LLMProvider {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("LLM provider name is required");
  }

  return {
    name: trimmedName,
    generateStructured(input) {
      return Promise.resolve(generateStructured(input));
    }
  };
}

export function createModelBoundProvider(provider: LLMProvider, model: string): LLMProvider {
  return {
    ...provider,
    model,
    generateStructured(input) {
      return provider.generateStructured({ ...input, model: input.model ?? model });
    }
  };
}

export function isLLMProvider(value: unknown): value is LLMProvider {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<LLMProvider>;
  return typeof candidate.name === "string" && typeof candidate.generateStructured === "function";
}

export function withProviderTimeout(provider: LLMProvider, defaultTimeoutMs: number): LLMProvider {
  return createLLMProvider(provider.name, (input) => {
    const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
    return withTimeout(provider.generateStructured({ ...input, timeoutMs }), timeoutMs, provider.name);
  });
}

export async function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number | undefined,
  label = "operation"
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return operation;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
