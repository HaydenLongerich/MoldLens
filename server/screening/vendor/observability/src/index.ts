import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Minimal structured logging with redaction (PLAN §11). Logs are JSON lines.
 * Never log names, emails, phone numbers, addresses, raw transcripts, image data, or tokens.
 */

interface TraceContext {
  traceId: string;
  assessmentRunId?: string;
}

const als = new AsyncLocalStorage<TraceContext>();

export function newTraceId(): string {
  return randomUUID().replace(/-/g, "");
}

export function withTrace<T>(ctx: Partial<TraceContext>, fn: () => T): T {
  const parent = als.getStore();
  return als.run({ traceId: ctx.traceId ?? parent?.traceId ?? newTraceId(), assessmentRunId: ctx.assessmentRunId ?? parent?.assessmentRunId }, fn);
}

export function currentTrace(): TraceContext | undefined {
  return als.getStore();
}

const SENSITIVE_KEYS = /^(email|phone|name|fullName|firstName|lastName|address|exactAddress|street|postal|postalCode|token|password|secret|authorization|cookie|transcript|text|statement|imageData|data|base64|apiKey)$/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<![\w-])(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    const s = value.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
    return s.length > 500 ? `${s.slice(0, 500)}…[truncated]` : s;
  }
  if (typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = (process.env.LOG_LEVEL as Level | undefined) ?? "info";

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const t = currentTrace();
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    traceId: t?.traceId,
    assessmentRunId: t?.assessmentRunId,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};

/** Measure a stage; logs duration and outcome. Metrics backend can subscribe to these log lines. */
export async function timed<T>(name: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const r = await fn();
    emit("info", `${name}.ok`, { ...fields, durationMs: Math.round(performance.now() - start) });
    return r;
  } catch (e) {
    emit("error", `${name}.error`, { ...fields, durationMs: Math.round(performance.now() - start), error: e });
    throw e;
  }
}
