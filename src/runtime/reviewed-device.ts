import { z } from "zod";
import { runtimeConnectionConfigSchema, runtimeMappingConfigSchema, runtimeMappingOutputSchema } from "../config/runtime-config.js";
const text = z.string().min(1).max(2048).regex(/^[^\u0000-\u001f\u007f]+$/);
const segment = z.string().min(1).max(128).regex(/^[^/+#\u0000-\u001f\u007f]+$/).refine(v => v === v.trim());
const topic = text.refine(v => v.replace(/\/$/, "").split("/").every(p => segment.safeParse(p).success));
export function validTopicFilter(value: string): boolean {
  if (value !== value.trim() || value.startsWith("$share/") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((p, i) => !!p && p === p.trim() && (!p.includes("+") || p === "+") && (!p.includes("#") || (p === "#" && i === parts.length - 1)));
}
export function validBrokerUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return ["mqtt:", "mqtts:", "ws:", "wss:"].includes(u.protocol) && !!u.hostname && !u.username && !u.password && !u.search && !u.hash &&
      (!u.port || (Number(u.port) > 0 && Number(u.port) <= 65535)) &&
      (["ws:", "wss:"].includes(u.protocol) || !u.pathname || u.pathname === "/");
  } catch { return false; }
}
import { runtimeSecretReferenceSchema } from "./local-secret-references.js";
// Reviewed portable devices accept only opaque local credential references.
const connection = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,95}$/),
  config: runtimeConnectionConfigSchema.pick({ brokerUrl: true, clientId: true, clean: true, keepalive: true, connectTimeout: true,
    reconnectPeriod: true, reconnectOnConnackError: true, resubscribe: true, queueQoSZero: true,
    rejectUnauthorized: true, subscribeTimeoutMs: true }).extend({ username: runtimeSecretReferenceSchema.optional(), password: runtimeSecretReferenceSchema.optional(), brokerUrl: text.refine(validBrokerUrl), clientId: text.max(128).refine(v => v === v.trim()).optional() }).strict()
    .refine(c => (c.username === undefined) === (c.password === undefined), {message:"Both username and password references are required.",path:["username"]})
    .refine(c => c.clean !== false || !!c.clientId, {message:"Persistent sessions require a local client ID.",path:["clientId"]}),
}).strict();
const output = runtimeMappingOutputSchema.extend({
  topic: topic.optional(), asset: segment.optional(), objectType: segment.optional(), objectId: segment.optional(), attribute: segment,
  selector: z.object({ matchField: text, matchValue: text }).strict().optional(),
  extraction: z.object({ mode: z.enum(["raw", "text", "json-path"]), path: text.optional() }).strict()
    .refine(v => v.mode !== "json-path" || !!v.path, { message: "JSON path extraction requires a path." }).optional(),
}).strict();
const mapping = z.object({ id: segment,
  config: runtimeMappingConfigSchema.extend({ topicFilter: text.refine(validTopicFilter), topic, asset: segment,
    objectType: segment, objectId: segment, outputs: z.array(output).min(1).max(100) }).strict(),
}).strict();
const base = z.object({ connection, mappings: z.array(mapping).min(1).max(100) }).strict();
const oneDevice = (input: z.infer<typeof base>) => {
    const devices = new Set<string>(); let count = 0;
    for (const {config} of input.mappings) {
      devices.add([config.topic.replace(/\/$/, ""), config.asset, config.objectType, config.objectId].join("/"));
      for (const o of config.outputs) {
        count++;
        devices.add([(o.topic ?? config.topic).replace(/\/$/, ""), o.asset ?? config.asset, o.objectType ?? config.objectType, o.objectId ?? config.objectId].join("/"));
      }
    }
    return devices.size === 1 && count <= 100;
  };
const refinement = { message: "All outputs must belong to one UNS device (maximum 100 attributes).", path: ["mappings"] };
export const devicePreviewBodySchema = base.refine(oneDevice, refinement);
export const deviceAppendBodySchema = base.extend({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).refine(oneDevice, refinement);
export type ReviewedDevice = z.infer<typeof devicePreviewBodySchema>;
