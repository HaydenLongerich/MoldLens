import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { audit, mediaAssets, mediaFrames, mediaManifests, type Db } from "@mb/db";
import {
  analyzeImage,
  assignScenes,
  extractFrames,
  makeTempDir,
  MediaRejection,
  normalizeImage,
  probeVideo,
  readHead,
  selectFrames,
  sha256File,
  sniff,
  transcodeProxy,
} from "@mb/media";
import { log } from "@mb/observability";
import type { ObjectStore } from "@mb/storage";
import { createHash } from "node:crypto";
import type { PipelineConfig } from "./config";

export const MEDIA_TOOL_VERSION = "media-prep-v1";

/**
 * ValidateMedia + PrepareMedia for one asset. Idempotent: an asset already
 * ready/rejected is left alone; partial frame rows from a crashed attempt are replaced.
 */
export async function processMediaAsset(
  db: Db,
  store: ObjectStore,
  cfg: PipelineConfig,
  assetId: string,
  serialize?: <T>(id: string, work: () => Promise<T>) => Promise<T>,
): Promise<"ready" | "rejected" | "skipped"> {
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  // A customer can remove a draft upload before its queued job is claimed.
  if (!asset) return "skipped";
  const processable = (current: typeof asset | undefined) => !!current
    && ["quarantined", "validated", "processing"].includes(current.status)
    && current.originalObjectKey === asset.originalObjectKey;
  if (!processable(asset)) return "skipped";
  const locked = <T>(work: () => Promise<T>) => serialize ? serialize(asset.assessmentId, work) : work();
  const currentAsset = async () => (await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id)))[0];

  const src = await store.localPath(asset.originalObjectKey);
  const tmp = await makeTempDir();
  try {
    // ---- ValidateMedia -------------------------------------------------------------
    const size = await store.size(asset.originalObjectKey);
    if (size == null || size === 0) throw new MediaRejection("empty_file", "The uploaded file was empty.");
    if (size > cfg.maxUploadBytes) throw new MediaRejection("too_large", "The file is larger than the allowed size.");
    const type = sniff(await readHead(src));
    if (!type) throw new MediaRejection("unsupported_type", "This file type isn't supported. Please upload a JPG, PNG, HEIC, MP4, MOV or WebM file.");
    if (type.kind !== asset.kind) throw new MediaRejection("type_mismatch", "The file contents don't match its type.");
    const sha256 = await sha256File(src);
    const [dup] = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.assessmentId, asset.assessmentId), eq(mediaAssets.sha256, sha256), ne(mediaAssets.id, asset.id), eq(mediaAssets.status, "ready")));
    if (dup) throw new MediaRejection("duplicate", "This file was already uploaded for this assessment.");

    const preparing = await locked(async () => {
      if (!processable(await currentAsset())) return false;
      await db.update(mediaAssets).set({ status: "processing", sha256, mime: type.mime }).where(eq(mediaAssets.id, asset.id));
      return true;
    });
    if (!preparing) return "skipped";

    const base = `assessments/${asset.assessmentId}/derived/${asset.id}`;
    const frameRows: (typeof mediaFrames.$inferInsert)[] = [];
    // Native processing only writes into this attempt's temporary directory.
    // Permanent objects are created after rechecking the asset under the mutation lock.
    const preparedFiles: { key: string; file: string }[] = [];
    let durationMs: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let hasAudio: boolean | null = null;
    let proxyObjectKey: string | null = null;

    if (type.kind === "video") {
      // ---- PrepareMedia: video -----------------------------------------------------
      const probe = await probeVideo(src);
      if (probe.durationMs > cfg.maxVideoSeconds * 1000) throw new MediaRejection("too_long", `Videos can be up to ${Math.round(cfg.maxVideoSeconds / 60)} minutes long.`);
      ({ durationMs, width, height, hasAudio } = probe);
      const proxyPath = path.join(tmp, "proxy.mp4");
      await transcodeProxy(src, proxyPath);
      proxyObjectKey = `${base}/proxy.mp4`;
      preparedFiles.push({ key: proxyObjectKey, file: proxyPath });

      const extracted = await extractFrames(src, path.join(tmp, "frames"), cfg.frameIntervalSeconds, probe.durationMs);
      const analyzed = [];
      for (const f of extracted) analyzed.push({ ...f, q: await analyzeImage(f.file) });
      const scenes = assignScenes(analyzed.map((a) => a.q.ahash));
      const candidates = analyzed.map((a, i) => ({ sharpness: a.q.sharpness, flags: a.q.flags, sceneIndex: scenes[i]!, timestampMs: a.timestampMs }));
      const chosen = selectFrames(candidates, cfg.maxFramesPerVideo);
      for (let i = 0; i < analyzed.length; i++) {
        const a = analyzed[i]!;
        const key = `${base}/frames/${String(i).padStart(5, "0")}.jpg`;
        preparedFiles.push({ key, file: a.file });
        frameRows.push({
          assetId: asset.id,
          assessmentId: asset.assessmentId,
          timestampMs: a.timestampMs,
          objectKey: key,
          sceneIndex: scenes[i]!,
          width: a.q.width,
          height: a.q.height,
          sharpness: a.q.sharpness,
          brightness: a.q.brightness,
          qualityFlags: a.q.flags,
          selected: chosen.has(i),
        });
      }
    } else {
      // ---- PrepareMedia: still image (metadata stripped on re-encode) ----------------
      const normalized = await normalizeImage(src);
      const q = await analyzeImage(normalized);
      ({ width, height } = q);
      const key = `${base}/frames/still.jpg`;
      const normalizedPath = path.join(tmp, "still.jpg");
      await fs.writeFile(normalizedPath, normalized, { mode: 0o600 });
      preparedFiles.push({ key, file: normalizedPath });
      frameRows.push({
        assetId: asset.id,
        assessmentId: asset.assessmentId,
        timestampMs: null,
        objectKey: key,
        sceneIndex: 0,
        width: q.width,
        height: q.height,
        sharpness: q.sharpness,
        brightness: q.brightness,
        qualityFlags: q.flags,
        selected: !q.flags.includes("too_dark") && !q.flags.includes("overexposed"),
      });
    }

    return await locked(async () => {
      if (!processable(await currentAsset())) return "skipped" as const;
      // Another upload may have completed while this one was being prepared.
      const [duplicate] = await db.select({ id: mediaAssets.id }).from(mediaAssets)
        .where(and(eq(mediaAssets.assessmentId, asset.assessmentId), eq(mediaAssets.sha256, sha256), ne(mediaAssets.id, asset.id), eq(mediaAssets.status, "ready")));
      if (duplicate) throw new MediaRejection("duplicate", "This file was already uploaded for this assessment.");
      const written: string[] = [];
      try {
        for (const prepared of preparedFiles) {
          written.push(prepared.key);
          await store.putFile(prepared.key, prepared.file);
        }
        await db.transaction(async tx => {
          await tx.delete(mediaFrames).where(eq(mediaFrames.assetId, asset.id)); // clean a partial attempt
          const inserted = frameRows.length ? await tx.insert(mediaFrames).values(frameRows).returning() : [];
          const poster = inserted.find((f) => f.selected) ?? inserted[0];
          const manifest = {
            tool: MEDIA_TOOL_VERSION,
            assetId: asset.id,
            kind: type.kind,
            mime: type.mime,
            sha256,
            durationMs,
            width,
            height,
            frameIntervalSeconds: type.kind === "video" ? cfg.frameIntervalSeconds : null,
            audio: hasAudio ? "present_not_processed_no_consent" : "none",
            frames: inserted.map((f) => ({ id: f.id, timestampMs: f.timestampMs, sceneIndex: f.sceneIndex, sharpness: Math.round(f.sharpness * 100) / 100, flags: f.qualityFlags, selected: f.selected })),
          };
          await tx.insert(mediaManifests).values({ assetId: asset.id, version: 1, manifest, contentHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") });
          await tx.update(mediaAssets)
            .set({ status: "ready", durationMs, width, height, hasAudio, proxyObjectKey, posterObjectKey: poster?.objectKey ?? null })
            .where(eq(mediaAssets.id, asset.id));
          await audit(tx as unknown as Db, { orgId: asset.orgId, actorType: "system", action: "media.ready", resourceType: "media_asset", resourceId: asset.id, metadata: { frames: inserted.length, selected: inserted.filter((f) => f.selected).length } });
        });
        return "ready" as const;
      } catch (error) {
        for (const key of written) await store.delete(key).catch(() => {});
        throw error;
      }
    });
  } catch (e) {
    return await locked(async () => {
      // Removing an upload can make a native process lose its input file. That is
      // a cancelled attempt, not a failed screening, and must never recreate objects.
      if (!processable(await currentAsset())) return "skipped" as const;
      if (!(e instanceof MediaRejection)) throw e;
      await db.transaction(async tx => {
        await tx.update(mediaAssets).set({ status: "rejected", rejectionReason: e.customerMessage }).where(eq(mediaAssets.id, asset.id));
        await audit(tx as unknown as Db, { orgId: asset.orgId, actorType: "system", action: "media.rejected", resourceType: "media_asset", resourceId: asset.id, metadata: { code: e.code } });
      });
      log.warn("media.rejected", { assetId: asset.id, code: e.code });
      return "rejected" as const;
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
