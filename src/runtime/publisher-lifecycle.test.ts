import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedBridgePublisher, bridgeTargetPath } from "@uns-kit/bridge-core";
import type { IMqttPublishRequest } from "@uns-kit/core";
import { RuntimeConfigManager } from "./runtime-config-manager.js";
import type { RuntimeConfigStore } from "./runtime-config-store.js";
import { configuredMqttTargets } from "./publisher-targets.js";
import { mqttNormalizer } from "../mqtt/mqtt-normalizer.js";
import type { RuntimeConfigSnapshot } from "../config/runtime-config.js";
import { toMappingConfig } from "../config/mqtt-config-mappers.js";
import type { MqttBridgeMappingConfig } from "../mqtt/mqtt-types.js";

const mapping = () => ({ id: "telemetry", config: {
  topicFilter: "fixture/telemetry", topic: "enterprise/site/", asset: "device",
  objectType: "equipment", objectId: "main", dataGroup: "fixture",
  outputs: [{ attribute: "temperature", extraction: { mode: "json-path" as const, path: "temperature" } },
    { attribute: "state", extraction: { mode: "json-path" as const, path: "state" } }],
} });
const snapshot = (): RuntimeConfigSnapshot => ({ version: 1, connections: [{
  id: "broker", start: false, config: { brokerUrl: "mqtt://localhost:1883" }, mappings: [mapping()],
}] });
const event = { topic: "fixture/telemetry", payloadText: '{"temperature":23.5,"state":"Idle"}',
  qos: 0, retain: true, payloadJson: { temperature: 23.5, state: "Idle" }, payloadBase64: "", timestamp: new Date().toISOString() };

function fixture() {
  const requests: IMqttPublishRequest[] = [];
  const retained: string[][] = [];
  let failWrite = false;
  const publisher = new ManagedBridgePublisher(async request => { requests.push(request); }, paths => { retained.push([...paths]); });
  const emit = async (config: MqttBridgeMappingConfig) => {
    const normalized = await mqttNormalizer({ connectionId: "broker", mappingId: "telemetry", mapping: config, event });
    for (const request of Array.isArray(normalized) ? normalized : [normalized]) await publisher.publish(request);
  };
  const engine = new Proxy({}, { get: (_target, name) => async (...args: unknown[]) => {
    if (name === "addMapping") await emit((args[1] as { config: MqttBridgeMappingConfig }).config);
    if (name === "updateMapping") await emit(args[2] as MqttBridgeMappingConfig);
  } }) as ConstructorParameters<typeof RuntimeConfigManager>[0];
  const store = { write: async () => { if (failWrite) throw new Error("disk failure"); } } as unknown as RuntimeConfigStore;
  const manager = new RuntimeConfigManager(engine, store,
    value => publisher.reconcile(configuredMqttTargets(value)),
    async value => { publisher.allowTargets(configuredMqttTargets(value)); });
  return { requests, retained, manager, emit, fail: () => { failWrite = true; } };
}

test("effective targets match the normalizer including every per-output override", async () => {
  const config = snapshot();
  config.connections[0]!.mappings[0]!.config.outputs[1] = {
    ...config.connections[0]!.mappings[0]!.config.outputs[1]!,
    topic: "other/site/", asset: "other-device", objectType: "sensor", objectId: "other-id",
  };
  const expected = configuredMqttTargets(config).map(bridgeTargetPath);
  const requests = await mqttNormalizer({ connectionId: "broker", mappingId: "telemetry", mapping: toMappingConfig(config.connections[0]!.mappings[0]!.config), event });
  const actual = (Array.isArray(requests) ? requests : [requests]).flatMap(request => (Array.isArray(request.attributes) ? request.attributes : [request.attributes])
    .map(attribute => bridgeTargetPath({ ...request, attribute: attribute.attribute })));
  assert.deepEqual(actual, expected);
  assert.ok(expected[1]!.endsWith("other-device/sensor/other-id/state"));
});

test("stop keeps targets; retarget, remove output and delete connection reconcile the committed configuration", async () => {
  const f = fixture(); const value = snapshot();
  await f.manager.applyConfig(value, "api-apply"); assert.equal(f.retained.at(-1)!.length, 2);
  value.connections[0]!.start = true; await f.manager.applyConfig(value, "api-apply");
  value.connections[0]!.start = false; await f.manager.applyConfig(value, "api-apply"); assert.equal(f.retained.at(-1)!.length, 2);
  value.connections[0]!.mappings[0]!.config.outputs[0]!.attribute = "temperature-2";
  await f.manager.applyConfig(value, "api-apply"); assert.ok(f.retained.at(-1)![0]!.endsWith("/temperature-2"));
  value.connections[0]!.mappings[0]!.config.outputs.splice(0, 1);
  await f.manager.applyConfig(value, "api-apply"); assert.deepEqual(f.retained.at(-1)!.map(p => p.split("/").at(-1)), ["state"]);
  await f.manager.applyConfig({ version: 1, connections: [] }, "api-apply"); assert.deepEqual(f.retained.at(-1), []);
  const count = f.requests.length; await f.emit(mapping().config); assert.equal(f.requests.length, count);
});

test("activation accepts new initial values and failed persistence restores committed publisher eligibility", async () => {
  const f = fixture(); const value = snapshot();
  await f.manager.applyConfig(value, "api-apply"); assert.equal(f.requests.length, 1);
  value.connections[0]!.mappings[0]!.config.outputs[0]!.attribute = "new-temperature";
  await f.manager.applyConfig(value, "api-apply"); assert.equal(f.requests.length, 2);
  f.fail(); value.connections[0]!.mappings[0]!.config.outputs[0]!.attribute = "draft";
  await assert.rejects(f.manager.applyConfig(value, "api-apply"), /disk failure/);
  assert.equal(f.manager.getCurrentConfig().connections[0]!.mappings[0]!.config.outputs[0]!.attribute, "new-temperature");
  assert.ok(f.retained.at(-1)![0]!.endsWith("/new-temperature"));
  const count = f.requests.length; await f.emit(toMappingConfig(value.connections[0]!.mappings[0]!.config)); assert.equal(f.requests.length, count);
});

test("shared configured targets survive removal of one mapping and stopped reviewed additions reconcile", async () => {
  const f = fixture(); const value = snapshot(); value.connections[0]!.mappings.push({ ...mapping(), id: "duplicate" });
  await f.manager.applyConfig(value, "api-apply"); assert.equal(f.retained.at(-1)!.length, 2);
  value.connections[0]!.mappings.splice(0, 1); await f.manager.applyConfig(value, "api-apply"); assert.equal(f.retained.at(-1)!.length, 2);
  const device = { connection: { id: "new-broker", config: { brokerUrl: "mqtt://localhost:1883" } }, mappings: [mapping()] };
  device.mappings[0]!.config.objectId = "new-device";
  const review = await f.manager.previewNewDevice(device); await f.manager.appendReviewedDevice(device, review.revision);
  assert.equal(f.manager.getCurrentConfig().connections[1]!.start, false); assert.equal(f.retained.at(-1)!.length, 4);
});

test("invalid configuration and unresolved credential preflight never alter publisher eligibility", async () => {
  const f = fixture(); const value = snapshot(); await f.manager.applyConfig(value, "api-apply");
  const count = f.retained.length;
  await assert.rejects(f.manager.applyConfig({ connections: [{ id: "invalid" }] }, "api-apply"));
  value.connections[0]!.start = true;
  value.connections[0]!.config.username = { provider: "env", key: "UNS_RUNTIME_SECRET_U205M_MISSING_USER" };
  value.connections[0]!.config.password = { provider: "env", key: "UNS_RUNTIME_SECRET_U205M_MISSING_PASSWORD" };
  await assert.rejects(f.manager.applyConfig(value, "api-apply"), /validation failed/);
  assert.equal(f.retained.length, count);
});
