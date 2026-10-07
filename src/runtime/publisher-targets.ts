import type { BridgeTarget } from "@uns-kit/bridge-core";
import type { RuntimeConfigSnapshot } from "../config/runtime-config.js";
import { toMappingConfig } from "../config/mqtt-config-mappers.js";
import { resolveMqttTarget } from "../mqtt/mqtt-normalizer.js";

/** Effective output identities, including configured-but-stopped connections. */
export function configuredMqttTargets(snapshot: RuntimeConfigSnapshot): BridgeTarget[] {
  return snapshot.connections.flatMap(connection => connection.mappings.flatMap(mapping => {
    const config = toMappingConfig(mapping.config);
    return config.outputs.map(output => ({
      ...resolveMqttTarget(config, output),
      attribute: output.attribute,
    }));
  }));
}
