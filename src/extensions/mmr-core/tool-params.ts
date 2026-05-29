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
  const [first] = [...Value.Errors(schema, raw)];
  const path = first?.instancePath && first.instancePath.length > 0 ? first.instancePath : "/";
  const message = first?.message ?? "schema check failed";
  throw new MmrToolParamsError(`${toolName}: invalid parameters: ${message} at ${path}`);
}
