/** Repository errors. The API layer (Task 4) maps these onto the response envelope. */
export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "conflict" | "invalid_state" | "invalid_data",
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

export const notFound = (what: string) => new RepositoryError(`${what} not found`, "not_found");
export const conflict = (msg: string) => new RepositoryError(msg, "conflict");
export const invalidState = (msg: string) => new RepositoryError(msg, "invalid_state");
export const invalidData = (msg: string) => new RepositoryError(msg, "invalid_data");

/** Turns a SQLite UNIQUE violation into a conflict error; rethrows anything else. */
export function rethrowConstraint(err: unknown, message: string): never {
  if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message))
    throw conflict(message);
  throw err;
}
