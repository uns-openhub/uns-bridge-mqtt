import { ZodError } from "zod";
export class BridgeConfigConflictError extends Error {
  constructor() { super("Configuration changed. Review the device again before saving."); }
}
export class BridgeValidationError extends Error {
  constructor(readonly issues: Array<{ path: Array<string | number>; message: string }>) {
    super("Bridge configuration validation failed.");
  }
}
export function withValidationErrors<T extends { req: unknown; res: any }>(handler: (event: T) => Promise<void>): (event: T) => Promise<void> {
  return async event => {
    try { await handler(event); } catch (error) {
      if (error instanceof BridgeConfigConflictError) { event.res.status(409).json({ error: "CONFIG_CONFLICT", message: error.message }); return; }
      if (error instanceof ZodError || error instanceof BridgeValidationError) {
        const issues = error.issues.slice(0, 20).map(issue => ({ path: issue.path.map(String), message: issue.message }));
        event.res.status(400).json({ error: "VALIDATION_ERROR", message: "Check the device configuration.", issues }); return;
      }
      throw error;
    }
  };
}
