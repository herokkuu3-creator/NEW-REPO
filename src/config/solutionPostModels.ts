/** Keep AI solution posts on the explicitly supported economical model families. */
export function validateSolutionPostModels(raw: string): string[] {
  const models = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  const allowed = /^(?:gpt-5\.6-(?:terra|luna)|gemini-3\.(?:7|8)-flash|qwen(?:\/[\w.-]+)?(?::[\w.-]+)?)$/i;
  if (models.some(model => !allowed.test(model))) {
    throw new Error('SOLUTION_POST_MODELS only supports gpt-5.6-terra, gpt-5.6-luna, gemini-3.7/3.8-flash, or Qwen models');
  }
  return models;
}
