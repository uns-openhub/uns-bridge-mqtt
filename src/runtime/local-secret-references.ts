import { z } from "zod";
import { BridgeValidationError } from "../api/validation-error.js";

export const runtimeSecretReferenceSchema = z.object({
  provider: z.literal("env"),
  key: z.string().regex(/^UNS_RUNTIME_SECRET_[A-Z][A-Z0-9_]{0,95}$/),
}).strict();
export type RuntimeSecretReference = z.infer<typeof runtimeSecretReferenceSchema>;
export type RuntimeCredential = string | RuntimeSecretReference;
export type MqttCredentials = { username?: RuntimeCredential | undefined; password?: RuntimeCredential | undefined };
function credential(value: RuntimeCredential, field: string, environment: NodeJS.ProcessEnv): string {
  if (typeof value === "string" && value.length) return value;
  const reference = runtimeSecretReferenceSchema.safeParse(value);
  if (!reference.success) throw new BridgeValidationError([{ path: [field], message: "Use a credential or strict local environment reference." }]);
  const resolved = environment[reference.data.key];
  if (!resolved) throw new BridgeValidationError([{ path: [field], message: `Provision local runtime secret ${reference.data.key} on this controller before starting.` }]);
  return resolved;
}
/** Protocol boundary only: resolved values must never be used as persisted config. */
export function resolveMqttCredentials(config: MqttCredentials, environment: NodeJS.ProcessEnv = process.env): { username?: string; password?: string } {
  return {
    ...(config.username !== undefined ? { username: credential(config.username, "username", environment) } : {}),
    ...(config.password !== undefined ? { password: credential(config.password, "password", environment) } : {}),
  };
}
export function redactMqttError(error: unknown, config: MqttCredentials & {brokerUrl?: string; ca?: string; cert?: string; key?: string}, environment: NodeJS.ProcessEnv = process.env): string {
  let message = error instanceof Error ? error.message : String(error);
  const values = [config.username, config.password, config.ca, config.cert, config.key];
  if (config.brokerUrl) {
    try { const u = new URL(config.brokerUrl); values.push(decodeURIComponent(u.username), decodeURIComponent(u.password)); } catch { /* Invalid URLs are validated elsewhere. */ }
  }
  const secrets = values.map(v => typeof v === "string" ? v : v?.provider === "env" ? environment[v.key] : undefined).filter((v): v is string => !!v).sort((a,b) => b.length-a.length);
  for (const value of secrets) message = message.split(value).join("[redacted]");
  return message.replace(/(?:mqtts?|wss?|tcp|ssl):\/\/[^/\s@]+@/gi, "mqtt://[redacted]@").slice(0, 300);
}
