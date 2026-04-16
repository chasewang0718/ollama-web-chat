type GenerationProfile = {
  temperature: number;
  topP: number;
  maxOutputTokens?: number;
};

const OLLAMA_LARGE_MODEL_B_THRESHOLD =
  Number.parseFloat(process.env.OLLAMA_LARGE_MODEL_B_THRESHOLD || "") || 20;
const OLLAMA_LARGE_MODEL_DISABLE_MEMORY = process.env.OLLAMA_LARGE_MODEL_DISABLE_MEMORY !== "false";
const OLLAMA_LARGE_MODEL_MAX_OUTPUT_TOKENS =
  Number.parseInt(process.env.OLLAMA_LARGE_MODEL_MAX_OUTPUT_TOKENS || "", 10) || 480;

export function getModelSizeInBillions(model: string): number | undefined {
  const matched = model.toLowerCase().match(/(\d+(?:\.\d+)?)b(?:\b|[-_:])/);
  if (!matched) return undefined;
  const n = Number.parseFloat(matched[1]);
  return Number.isFinite(n) ? n : undefined;
}

export function isLargeModel(model: string): boolean {
  const sizeB = getModelSizeInBillions(model);
  return typeof sizeB === "number" && sizeB >= OLLAMA_LARGE_MODEL_B_THRESHOLD;
}

export function shouldDisableMemoryForModel(model: string): boolean {
  return isLargeModel(model) && OLLAMA_LARGE_MODEL_DISABLE_MEMORY;
}

export function applyLargeModelGenerationSafety(model: string, profile: GenerationProfile): GenerationProfile {
  if (!isLargeModel(model)) return profile;

  const clamped = Math.max(128, OLLAMA_LARGE_MODEL_MAX_OUTPUT_TOKENS);
  return {
    ...profile,
    maxOutputTokens:
      typeof profile.maxOutputTokens === "number" ? Math.min(profile.maxOutputTokens, clamped) : clamped,
  };
}

