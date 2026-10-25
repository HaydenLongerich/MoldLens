/** Bounded limits for the video-first screening pipeline. */
export interface PipelineConfig {
  maxUploadBytes: number;
  maxVideoSeconds: number;
  frameIntervalSeconds: number;
  maxFramesPerVideo: number;
  maxFramesPerRun: number;
  budgetUsdPerRun: number;
  appUrl: string;
}
function numberSetting(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number, integer = false) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  return value;
}
export function readPipelineConfig(env: Record<string, string | undefined> = process.env): PipelineConfig {
  const maxFramesPerRun = numberSetting(env, 'AI_MAX_FRAMES_PER_RUN', 12, 1, 24, true);
  return {
    maxUploadBytes: numberSetting(env, 'MEDIA_MAX_UPLOAD_BYTES', 500 * 1024 * 1024, 1, 500 * 1024 * 1024, true),
    maxVideoSeconds: numberSetting(env, 'MEDIA_MAX_VIDEO_SECONDS', 600, 1, 600),
    frameIntervalSeconds: numberSetting(env, 'MEDIA_FRAME_INTERVAL_SECONDS', 2, 0.5, 60),
    maxFramesPerVideo: maxFramesPerRun,
    maxFramesPerRun,
    budgetUsdPerRun: numberSetting(env, 'AI_BUDGET_USD_PER_RUN', 1.5, 0.01, 20),
    appUrl: env.APP_URL ?? 'http://127.0.0.1:5173',
  };
}
