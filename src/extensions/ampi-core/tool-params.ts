import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export class MmrToolParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MmrToolParamsError";
  }
}

export function checkMmrToolParams<TParams extends TSchema>(
  toolName: string,
  schema: TParams,
  raw: unknown,
): Static<TParams> {
  if (Value.Check(schema, raw)) return raw as Static<TParams>;
  // TypeBox 1.3 reports a rejected extra property as a `boolean` ("schema is
  // false") error ahead of the `additionalProperties` error; prefer the latter.
  const errors = [...Value.Errors(schema, raw)];
  const first = errors.find((error) => error.keyword !== "boolean") ?? errors[0];
  const path = first?.instancePath && first.instancePath.length > 0 ? first.instancePath : "/";
  const message = first?.message ?? "schema check failed";
  throw new MmrToolParamsError(`${toolName}: invalid parameters: ${message} at ${path}`);
}
