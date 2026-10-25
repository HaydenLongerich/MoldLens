import sharp from 'sharp';

// Thresholds are tuned for the 320px greyscale analysis frame, not the full-resolution snapshot.
export const ANALYSIS_WIDTH = 320;
export const LIMITS = {
  darkBelow: 55, brightAbove: 215, blurBelow: 60,
  closerBelowSide: 0.2, backAboveSide: 0.85, edgeMargin: 0.01,
};

const round = (value) => Math.round(value * 100) / 100;

// Brightness is the mean grey level. Sharpness is the variance of a 4-neighbour Laplacian,
// which drops sharply when the image is motion-blurred or out of focus.
export async function frameMetrics(jpeg) {
  const { data, info } = await sharp(jpeg, { failOn: 'error' })
    .resize({ width: ANALYSIS_WIDTH, withoutEnlargement: true })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let sum = 0; let lapSum = 0; let lapSquares = 0; let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value = data[i];
      const laplacian = 4 * value - data[i - 1] - data[i + 1] - data[i - width] - data[i + width];
      sum += value; lapSum += laplacian; lapSquares += laplacian * laplacian; count++;
    }
  }
  if (!count) return { brightness: 0, sharpness: 0, width, height };
  const mean = lapSum / count;
  return { brightness: round(sum / count), sharpness: round(lapSquares / count - mean * mean), width, height };
}

// Rules run in order: lighting first, then focus, then framing. Framing is only
// judged when a detection model is loaded; without one the guidance says so.
export function guidanceFor({ metrics, detections = [], detectorReady = false }) {
  if (metrics.brightness < LIMITS.darkBelow) return { code: 'more_light', message: 'It is quite dark. Turn on a light or move somewhere brighter.' };
  if (metrics.brightness > LIMITS.brightAbove) return { code: 'glare', message: 'The image is very bright. Step out of direct light or angle away from the window.' };
  if (metrics.sharpness < LIMITS.blurBelow) return { code: 'hold_steady', message: 'The image looks blurred. Hold the phone steady for a moment.' };
  if (detectorReady) {
    if (!detections.length) return { code: 'find_area', message: 'Point the camera at the affected area, then move slowly across it.' };
    const main = detections.reduce((best, item) => (Math.max(item.box.width, item.box.height) > Math.max(best.box.width, best.box.height) ? item : best));
    const side = Math.max(main.box.width, main.box.height);
    if (main.clipped || side > LIMITS.backAboveSide) return { code: 'move_back', message: 'Move back a little so the whole stained area fits in the frame.' };
    if (side < LIMITS.closerBelowSide) return { code: 'move_closer', message: 'Move closer so the stained area fills more of the frame.' };
  }
  return { code: 'ready', message: 'Looks good. Hold still.' };
}

// Letterbox keeps the aspect ratio. Padding offsets let detections be mapped
// back to normalized coordinates of the original frame.
export function letterboxFor(width, height, inputSize) {
  const scale = Math.min(inputSize / width, inputSize / height);
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  return { inputSize, newWidth, newHeight, padLeft: Math.floor((inputSize - newWidth) / 2), padTop: Math.floor((inputSize - newHeight) / 2) };
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width); const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
}

// Decodes a YOLOv8/YOLO11 export without built-in NMS: output shape [1, 4 + classes, anchors].
// Each anchor stores centre x, centre y, width and height in letterboxed pixels, followed by class scores.
export function decodeYolo({ data, dims }, { numClasses, confidence = 0.35, iou: iouThreshold = 0.45, letterbox }) {
  const channels = dims[1]; const anchors = dims[2];
  if (channels !== 4 + numClasses) throw new Error(`Model outputs ${channels} channels; expected ${4 + numClasses}.`);
  const candidates = [];
  for (let i = 0; i < anchors; i++) {
    let score = 0; let classId = -1;
    for (let c = 0; c < numClasses; c++) {
      const value = data[(4 + c) * anchors + i];
      if (value > score) { score = value; classId = c; }
    }
    if (score < confidence) continue;
    const cx = data[i]; const cy = data[anchors + i];
    const w = data[2 * anchors + i]; const h = data[3 * anchors + i];
    const left = (cx - w / 2 - letterbox.padLeft) / letterbox.newWidth;
    const top = (cy - h / 2 - letterbox.padTop) / letterbox.newHeight;
    const right = (cx + w / 2 - letterbox.padLeft) / letterbox.newWidth;
    const bottom = (cy + h / 2 - letterbox.padTop) / letterbox.newHeight;
    const clipped = left < -LIMITS.edgeMargin || top < -LIMITS.edgeMargin || right > 1 + LIMITS.edgeMargin || bottom > 1 + LIMITS.edgeMargin;
    const box = {
      x: Math.max(0, left), y: Math.max(0, top),
      width: Math.min(1, right) - Math.max(0, left), height: Math.min(1, bottom) - Math.max(0, top),
    };
    if (box.width <= 0 || box.height <= 0) continue;
    candidates.push({ classId, score: round(score), box: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }, clipped });
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const candidate of candidates) {
    if (kept.every((other) => other.classId !== candidate.classId || iou(other.box, candidate.box) < iouThreshold)) kept.push(candidate);
  }
  return kept;
}

// Returns { ready: false, reason } when no model can be used. Callers then fall back to
// framing-free guidance and never invent detections.
export async function loadDetector({ modelPath, classes = ['visible_staining'], confidence = 0.35, iou: iouThreshold = 0.45, inputSize = 640 } = {}) {
  if (!modelPath) return { ready: false, reason: 'no_model', classes };
  let ort;
  try { ort = await import('onnxruntime-node'); }
  catch { return { ready: false, reason: 'runtime_missing', classes }; }
  let session;
  try { session = await ort.InferenceSession.create(modelPath); }
  catch { return { ready: false, reason: 'model_unreadable', classes }; }
  return {
    ready: true, reason: null, classes,
    async detect(jpeg) {
      const { width, height } = await sharp(jpeg, { failOn: 'error' }).metadata();
      const letterbox = letterboxFor(width, height, inputSize);
      const pixels = await sharp(jpeg, { failOn: 'error' })
        .resize(letterbox.newWidth, letterbox.newHeight, { fit: 'fill' })
        .extend({
          top: letterbox.padTop, left: letterbox.padLeft,
          bottom: inputSize - letterbox.newHeight - letterbox.padTop, right: inputSize - letterbox.newWidth - letterbox.padLeft,
          background: { r: 114, g: 114, b: 114 },
        })
        .removeAlpha().raw().toBuffer();
      const plane = inputSize * inputSize;
      const tensor = new Float32Array(3 * plane);
      for (let i = 0; i < plane; i++) {
        tensor[i] = pixels[i * 3] / 255;
        tensor[plane + i] = pixels[i * 3 + 1] / 255;
        tensor[2 * plane + i] = pixels[i * 3 + 2] / 255;
      }
      const results = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, inputSize, inputSize]) });
      const output = results[session.outputNames[0]];
      return decodeYolo({ data: output.data, dims: output.dims }, { numClasses: classes.length, confidence, iou: iouThreshold, letterbox });
    },
  };
}
