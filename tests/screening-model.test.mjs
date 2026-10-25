import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
let directory;
let ai;
let media;
let domain;
before(async () => {
  directory = await mkdtemp(path.join(root, '.screening-model-test-'));
  const output = path.join(directory, 'models.mjs');
  await build({
    stdin: { contents: 'export * as ai from "./ai/src/index.ts"; export * as media from "./media/src/index.ts"; export * as domain from "./domain/src/index.ts";', resolveDir: path.join(root, 'server/screening/vendor'), loader: 'ts' },
    outfile: output, platform: 'node', target: 'node20', format: 'esm', bundle: true, logLevel: 'silent',
    external: ['openai', '@anthropic-ai/sdk', '@anthropic-ai/sdk/*', 'sharp', 'ffmpeg-static', 'ffprobe-static'],
    alias: {
      '@mb/domain': path.join(root, 'server/screening/vendor/domain/src/index.ts'),
      '@mb/observability': path.join(root, 'server/screening/vendor/observability/src/index.ts'),
    },
  });
  ({ ai, media, domain } = await import(pathToFileURL(output).href));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const observation = (frameId = 'F1') => ({
  frameId, category: 'discoloration', location: 'vent grille', neutralDescription: 'Dark spotting is visible on the grille.',
  visibility: 'good', strength: 'moderate', alternativeExplanations: ['Dust or soot'], limitations: [], region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
});
const result = () => ({ observations: [observation()], frames: [{ frameId: 'F1', usable: true, issue: null, privacyConcern: false }], overallLimitations: [], questionPriority: [] });
const input = () => ({ frames: [{ frameId: 'actual-frame-id', image: Buffer.from('a prepared JPEG fixture'), sourceLabel: 'Photo 1' }], areas: [], concerns: [], budgetUsd: 1, candidateQuestions: [{ id: 'approved', text: 'Have you noticed a musty smell?' }] });
function client(reply = result(), options = {}) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (request, requestOptions) => {
      calls.push({ request, requestOptions });
      if (options.error) throw options.error;
      return {
        model: 'fixture-vision-model',
        choices: [{ finish_reason: options.finish ?? 'stop', message: { refusal: options.refusal ?? null, content: options.raw ?? JSON.stringify(reply) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      };
    } } },
  };
}

test('screening has no implicit fake-AI fallback and rejects unsupported providers', async () => {
  assert.equal(ai.aiStatus({}).configured, false);
  await assert.rejects(ai.getVisionModel({}).observe(input()), { code: 'not_configured', retryable: false });
  await assert.rejects(ai.getVisionModel({ AI_PROVIDER: 'typo', OPENAI_API_KEY: 'unused-test-key' }).observe(input()), { code: 'not_configured' });
  assert.equal(ai.getVisionModel({ AI_PROVIDER: 'mock' }).provider, 'mock');
  assert.equal(ai.getTextModel({ AI_PROVIDER: 'mock' }), null);
});

test('claims policy rejects positive mold assertions while preserving uncertainty and general guidance', () => {
  for (const text of ['There is mold on the ceiling.', 'Mold growth covers the wall.', 'The wall has mold.', 'The mold has spread throughout the home.']) {
    assert.ok(domain.findProhibited(text).length > 0, text);
  }
  for (const text of ['We cannot confirm mold from appearance.', 'It is unclear whether there is mold.', 'Avoid disturbing suspected mold or damaged materials.']) {
    assert.deepEqual(domain.findProhibited(text), [], text);
  }
});

test('vision sends bounded structured evidence, resolves only known frame and question references', async () => {
  const reply = result();
  reply.observations.push(observation('F99'));
  reply.frames.push({ frameId: 'F99', usable: true, issue: null, privacyConcern: false });
  reply.questionPriority = ['approved', 'invented-question'];
  const fake = client(reply);
  const response = await new ai.OpenAIVisionModel('fixture', fake, {}).observe(input());
  assert.equal(response.isMock, false);
  assert.equal(response.result.observations.length, 1);
  assert.equal(response.result.observations[0].frameId, 'actual-frame-id');
  assert.deepEqual(response.result.frames.map(frame => frame.frameId), ['actual-frame-id']);
  assert.deepEqual(response.result.questionPriority, ['approved']);
  assert.equal(fake.calls[0].request.response_format.json_schema.strict, true);
  assert.equal(fake.calls[0].requestOptions.signal instanceof AbortSignal, true);
  assert.ok(!JSON.stringify(fake.calls[0].request).includes('actual-frame-id'));
  assert.equal(response.usage.inputTokens, 100);
  assert.equal(Number.isFinite(response.usage.costUsd), true);
});

test('vision refuses unbounded image requests before contacting the provider', async () => {
  const fake = client();
  const request = input();
  request.frames = Array.from({ length: 25 }, () => input().frames[0]);
  await assert.rejects(new ai.OpenAIVisionModel('fixture', fake, {}).observe(request), { code: 'budget_exceeded', retryable: false });
  request.frames = [{ ...input().frames[0], image: Buffer.alloc(2 * 1024 * 1024 + 1) }];
  await assert.rejects(new ai.OpenAIVisionModel('fixture', fake, {}).observe(request), { code: 'budget_exceeded' });
  assert.equal(fake.calls.length, 0);
});

test('vision handles refusal, truncation and malformed output without manufacturing findings', async () => {
  for (const [options, code] of [[{ refusal: 'Declined' }, 'refusal'], [{ finish: 'length' }, 'truncated'], [{ raw: '{invalid' }, 'invalid_output']]) {
    await assert.rejects(new ai.OpenAIVisionModel('fixture', client(result(), options), {}).observe(input()), { code });
  }
  await assert.rejects(new ai.OpenAIVisionModel('fixture', client({ observations: [{ unsupported: true }] }), {}).observe(input()), { code: 'invalid_output' });
});

test('provider errors are classified and never expose provider credential details', async () => {
  const fake = client(undefined, { error: { status: 401, message: 'credential-sensitive-test-string' } });
  const failure = await new ai.OpenAIVisionModel('fixture', fake, {}).observe(input()).catch(error => error);
  assert.equal(failure.code, 'not_configured');
  assert.equal(failure.retryable, false);
  assert.ok(!failure.message.includes('credential-sensitive-test-string'));
  await assert.rejects(new ai.OpenAIVisionModel('fixture', client(undefined, { error: { status: 429 } }), {}).observe(input()), { code: 'provider_error', retryable: true });
});

test('summary stage returns structured text from the provided facts', async () => {
  const facts = { outcome: 'limited', priority: 'routine', findings: [], reportedConcerns: [], answers: [], unknowns: ['The surface is partly out of view.'] };
  const fake = client({ headline: 'The view is limited.', points: ['Part of the surface is out of view.', 'A clearer photo can help a specialist review it.'] });
  const response = await new ai.OpenAITextModel('fixture', fake, {}).summarize(facts);
  assert.equal(response.summary.points.length, 2);
  assert.ok(fake.calls[0].request.messages[1].content.includes(JSON.stringify(facts, null, 2)));
});

test('Anthropic adapter validates an injected response without making a provider request', async t => {
  try { await import('@anthropic-ai/sdk/helpers/beta/zod'); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') { t.skip('Optional Anthropic SDK is unavailable.'); return; } throw error; }
  const calls = [];
  const fake = { beta: { messages: { create: async (request, options) => {
    calls.push({ request, options });
    return { model: 'fixture-anthropic', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result()) }], usage: { input_tokens: 100, output_tokens: 30 } };
  } } } };
  const response = await new ai.AnthropicVisionModel('fixture-anthropic', fake, {}).observe(input());
  assert.equal(response.provider, 'anthropic');
  assert.equal(response.isMock, false);
  assert.equal(response.result.observations[0].frameId, 'actual-frame-id');
  assert.equal(response.usage.inputTokens, 100);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('media helpers reject disguised files and preserve deterministic usable-frame selection', () => {
  assert.equal(media.sniff(Buffer.from('<html>not an image</html>')), null);
  assert.equal(media.sniff(Buffer.from('%PDF-1.7')), null);
  assert.equal(media.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg');
  const frames = [
    { sharpness: 1, flags: [], sceneIndex: 0, timestampMs: 0 },
    { sharpness: 5, flags: [], sceneIndex: 0, timestampMs: 2000 },
    { sharpness: 9, flags: ['too_dark'], sceneIndex: 1, timestampMs: 4000 },
    { sharpness: 3, flags: [], sceneIndex: 1, timestampMs: 6000 },
  ];
  assert.deepEqual([...media.selectFrames(frames, 2)], [1, 3]);
  assert.deepEqual(media.assignScenes(['0000000000000000', '0000000000000001', 'ffffffffffffffff']), [0, 0, 1]);
});

test('missing media tools are reported as configuration errors without taking down the app', async () => {
  const previous = { FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH };
  process.env.FFMPEG_PATH = path.join(directory, 'missing-ffmpeg');
  process.env.FFPROBE_PATH = path.join(directory, 'missing-ffprobe');
  try {
    const status = await media.mediaDependencyStatus();
    assert.equal(status.available, false);
    assert.ok(status.missing.includes('ffmpeg'));
    assert.ok(status.missing.includes('ffprobe'));
    await assert.rejects(media.probeVideo(path.join(directory, 'unused.mp4')), { code: 'media_not_configured', retryable: false });
    await assert.rejects(media.extractFrames('unused.mp4', path.join(directory, 'frames'), 0, 10_000), { code: 'invalid_video_limits' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('image normalization processes a real fixture and removes metadata', async t => {
  let sharp;
  try { sharp = (await import('sharp')).default; }
  catch { t.skip('Native sharp dependency is unavailable; configuration failure is covered above.'); return; }
  const original = await sharp({ create: { width: 400, height: 350, channels: 3, background: '#aaa' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const normalized = await media.normalizeImage(original);
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 350);
  assert.equal(metadata.height, 400);
  assert.equal(metadata.exif, undefined);
  const quality = await media.analyzeImage(normalized);
  assert.equal(quality.width, 350);
  assert.match(quality.ahash, /^[a-f0-9]{16}$/);
  await assert.rejects(media.normalizeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), { code: 'unreadable_image' });
});

test('local video processing strips audio and private metadata and extracts usable JPEGs', { timeout: 90_000 }, async t => {
  const status = await media.mediaDependencyStatus();
  if (!status.available) { t.skip(`Local video dependencies unavailable: ${status.missing.join(', ')}`); return; }
  const ffmpeg = process.env.FFMPEG_PATH || (await import('ffmpeg-static').catch(() => ({ default: null }))).default || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || (await import('ffprobe-static').catch(() => ({ default: null }))).default?.path || 'ffprobe';
  const original = path.join(directory, 'synthetic-original.mp4');
  const proxy = path.join(directory, 'synthetic-proxy.mp4');
  const corrupt = path.join(directory, 'corrupt-video.mp4');
  await writeFile(corrupt, Buffer.from('not a playable video'));
  await assert.rejects(media.probeVideo(corrupt), { code: 'unreadable_video' });
  // Entirely generated on this machine. No customer media or external provider is used.
  await execute(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    '-metadata', 'title=Private fixture title', '-metadata', 'comment=Private fixture comment',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', original,
  ], { timeout: 30_000, maxBuffer: 200_000 });
  const before = await media.probeVideo(original);
  assert.equal(before.hasAudio, true);
  await media.transcodeProxy(original, proxy);
  const after = await media.probeVideo(proxy);
  assert.equal(after.hasAudio, false);
  assert.equal(after.videoCodec, 'h264');
  assert.ok(after.width <= 1280);
  const { stdout } = await execute(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', proxy], { timeout: 30_000, maxBuffer: 200_000 });
  const tags = JSON.parse(stdout).format?.tags ?? {};
  assert.equal(tags.title, undefined);
  assert.equal(tags.comment, undefined);
  const frames = await media.extractFrames(proxy, path.join(directory, 'synthetic-frames'), 0.5, after.durationMs);
  assert.ok(frames.length >= 3 && frames.length <= 5);
  assert.ok(frames.every((frame, index) => frame.timestampMs === index * 500 && frame.timestampMs < after.durationMs));
  const quality = await media.analyzeImage(frames[0].file);
  assert.ok(quality.width <= 960);
  assert.ok(quality.height > 0);
  assert.match(quality.ahash, /^[a-f0-9]{16}$/);
});
