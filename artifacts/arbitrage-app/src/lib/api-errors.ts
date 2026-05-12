/**
 * Returns true when an error object carries a specific HTTP status code.
 * Works with ApiError from @workspace/api-client-react (which has a `.status`
 * field) without needing to import the class as a value (the generated orval
 * file imports it as `import type`, so instanceof checks aren't possible).
 */
export function isHttpStatus(error: unknown, status: number): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status: number }).status === status
  );
}
