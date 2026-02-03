const replacer = (_key: string, value: unknown) => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
};

type LogLevel = "debug" | "info" | "warn" | "error";

const log = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
  const payload = {
    level,
    msg,
    time: new Date().toISOString(),
    ...(meta ?? {})
  };
  const line = JSON.stringify(payload, replacer);
  if (level === "error" || level === "warn") {
    console.error(line);
    return;
  }
  console.log(line);
};

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta)
};
