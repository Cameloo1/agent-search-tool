import {
  DEFAULT_BALANCED_STAGE_MODELS,
  DEFAULT_STAGE_MODELS,
  type IntentObject,
  type LLMProvider,
  type LLMStageKey,
  type PipelineRequest,
  type QualityMode
} from "@agent-search/shared";
import { createModelBoundProvider } from "@agent-search/llm";

export type StageModelConfig = Record<LLMStageKey, string>;

export interface StageModelDecision {
  stage: LLMStageKey;
  provider: LLMProvider;
  providerName: string;
  model: string;
  qualityMode: QualityMode;
  escalated: boolean;
  reason?: string;
  fromModel?: string;
}

export interface ModelRouter {
  qualityMode: QualityMode;
  config: StageModelConfig;
  providerFor(stage: LLMStageKey, context?: StageRoutingContext): StageModelDecision;
}

export interface StageRoutingContext {
  request?: PipelineRequest;
  intent?: IntentObject;
  forceQuality?: boolean;
  reason?: string;
}

export function createStageModelConfig(overrides: Partial<StageModelConfig> = {}): StageModelConfig {
  return {
    ...DEFAULT_STAGE_MODELS,
    ...overrides
  };
}

export function createBalancedStageModelConfig(overrides: Partial<StageModelConfig> = {}): StageModelConfig {
  return {
    ...DEFAULT_BALANCED_STAGE_MODELS,
    ...overrides
  };
}

export function createModelRouter(
  baseProvider: LLMProvider,
  request: PipelineRequest,
  config: StageModelConfig,
  highQualityModel = config.adjudicator || config.synthesis || config.default,
  balancedConfig: StageModelConfig = createBalancedStageModelConfig()
): ModelRouter {
  const qualityMode = request.quality_mode ?? "fast";
  const activeConfig = qualityMode === "balanced" ? balancedConfig : config;
  return {
    qualityMode,
    config: activeConfig,
    providerFor(stage, context = {}) {
      const baseModel =
        request.model_overrides?.[stage] ?? request.model_overrides?.default ?? activeConfig[stage] ?? activeConfig.default;
      const escalation = shouldEscalate(stage, qualityMode, context.intent, context.forceQuality, context.reason);
      const model = escalation.escalate ? highQualityModel : baseModel;
      return {
        stage,
        provider: createModelBoundProvider(baseProvider, model),
        providerName: baseProvider.name,
        model,
        qualityMode,
        escalated: escalation.escalate && model !== baseModel,
        reason: escalation.reason,
        fromModel: escalation.escalate && model !== baseModel ? baseModel : undefined
      };
    }
  };
}

export function shouldEscalate(
  stage: LLMStageKey,
  qualityMode: QualityMode,
  intent?: IntentObject,
  forceQuality = false,
  explicitReason?: string
): { escalate: boolean; reason?: string } {
  if (stage === "synthesis" || stage === "adjudicator") {
    return { escalate: false };
  }

  if (qualityMode === "quality" && ["strategy", "scoring"].includes(stage)) {
    return { escalate: true, reason: explicitReason ?? "quality_mode_requested" };
  }

  if (forceQuality) {
    return { escalate: true, reason: explicitReason ?? "explicit_stage_escalation" };
  }

  return { escalate: false };
}
