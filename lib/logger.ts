// Structured JSON logger — consistent across all API routes and Edge Functions.
// In Vercel, these logs are searchable by field in the dashboard.
// Usage: log.info("upload_complete", { tenantId, documentId })

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  tenantId?: string;
  userId?: string;
  route?: string;
  documentId?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info:  (msg: string, fields?: LogFields) => emit("info",  msg, fields),
  warn:  (msg: string, fields?: LogFields) => emit("warn",  msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};
