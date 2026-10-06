// Structured JSON logs on stdout. Anything that looks like a credential is redacted
// before it is written, so a careless `logger.info("x", { token })` cannot leak it.

const SENSITIVE = /token|secret|key|authorization|password|code_verifier/i;

type Fields = Record<string, unknown>;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Fields).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1)]),
  );
}

export interface Logger {
  info(scope: string, msg: string, fields?: Fields): void;
  warn(scope: string, msg: string, fields?: Fields): void;
  error(scope: string, msg: string, fields?: Fields): void;
}

export function createLogger(write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const log = (level: string) => (scope: string, msg: string, fields: Fields = {}) =>
    write(JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...(redact(fields) as Fields) }));
  return { info: log("info"), warn: log("warn"), error: log("error") };
}

export const logger = createLogger();
