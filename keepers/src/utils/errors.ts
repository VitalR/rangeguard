export class KeeperError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "KeeperError";
    this.details = details;
  }
}

export const asError = (err: unknown): Error => {
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err));
};

export const formatError = (err: unknown): string => {
  const error = asError(err);
  if (error instanceof KeeperError && error.details) {
    return `${error.message}: ${JSON.stringify(error.details)}`;
  }
  return error.message || String(err);
};

export const invariant = (condition: boolean, message: string, details?: Record<string, unknown>) => {
  if (!condition) {
    throw new KeeperError(message, details);
  }
};
