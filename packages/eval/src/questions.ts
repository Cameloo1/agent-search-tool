import goldArtifact from "../gold/gold-answers.json" with { type: "json" };
import { GoldArtifactSchema, type GoldArtifact, type GoldQuestion } from "@agent-search/shared";

export function loadGoldArtifact(): { ok: true; artifact: GoldArtifact } | { ok: false; reason: string } {
  const parsed = GoldArtifactSchema.safeParse(goldArtifact);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message };
  }
  return { ok: true, artifact: parsed.data };
}

export function getBenchmarkQuestions(): GoldQuestion[] {
  const loaded = loadGoldArtifact();
  return loaded.ok ? loaded.artifact.questions : [];
}
