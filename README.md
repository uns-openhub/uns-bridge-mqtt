# UNS Bridge MQTT

UNS OpenHub add-on for browsing MQTT brokers, inspecting payloads, and mapping
source topics into canonical UNS attributes.

Requires Node.js 22+, pnpm 10, UNS OpenHub, and an accessible MQTT broker.

## Scripts

```bash
pnpm install
cp config-development-host.json config.json
pnpm run dev
pnpm run verify
```

## Configuration

Choose one tracked startup profile, then copy it to the ignored `config.json`:

| Profile                          | Use it when                                                 | MQTT                    | Controller authentication                                                   |
| -------------------------------- | ----------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `config-development-host.json`   | Running the bridge directly with `pnpm run dev` on the host | `localhost`             | None; the bridge validates caller JWTs through the controller JWKS endpoint |
| `config-development-podman.json` | Deploying through a local Podman OpenHub controller         | Compose DNS `mosquitto` | None; the controller supplies the reachable JWKS endpoint                   |
| `config-production.json`         | Creating a production controller instance                   | Runtime DNS `mosquitto` | None; use the controller's reachable JWKS endpoint                          |

The Podman and production profiles use the internal network name because the
RTT process runs alongside the controller. The production profile is a safe
starting point only; supply real external endpoints through the controller's
deployment configuration. The bridge does not log in with an email/password or
service token: its management API verifies the operator's JWT using the
configured controller JWKS endpoints.

Runtime bridge state is loaded from `runtime-config.json` when present. A sample snapshot is provided in `runtime-config.json.example`.
This runtime snapshot is separate from the original `uns-kit` `config.json` structure (`uns`, `infra`, `input`, `output`, ...).
If needed, override the snapshot path with `UNS_BRIDGE_RUNTIME_CONFIG_PATH`.

Sub-assets use the existing target identity fields. Set `topic` to the full
parent asset path and `asset` to the leaf sub-asset. For example, a mapping with
`topic: "enterprise/site/area/line/line-1/"` and `asset: "drive-1"` publishes
under `enterprise/site/area/line/line-1/drive-1/...`; `dataGroup` remains
storage/routing metadata.

## Runtime credentials and controller Infisical bindings

Runtime connection `username` and `password` accept strict local references:

```json
{
  "username": { "provider": "env", "key": "UNS_RUNTIME_SECRET_MQTT_USER" },
  "password": { "provider": "env", "key": "UNS_RUNTIME_SECRET_MQTT_PASSWORD" }
}
```

The bridge resolves these names from its environment only when connecting or
browsing. A stopped connection can be saved before provisioning. Missing values
block start; a full configuration apply preflights all started connections before
changing the existing registry. Error messages redact credentials.

For managed RTT instances, the controller provisions the requested variables
from its local environment or its existing UNS Kit Infisical resolver. Configure
`runtimeSecretBindings` in the controller-owned instance startup metadata:

```json
{
  "runtimeSecretBindings": {
    "UNS_RUNTIME_SECRET_MQTT_USER": {
      "provider": "infisical", "path": "/factory/mqtt", "key": "MQTT_USER"
    },
    "UNS_RUNTIME_SECRET_MQTT_PASSWORD": {
      "provider": "infisical", "path": "/factory/mqtt", "key": "MQTT_PASSWORD"
    }
  }
}
```

Each controller needs authorized Infisical bootstrap credentials. The bridge has
no separate vault client. A binding is resolved freshly at managed start and has
no fallback to cached or environment values when the vault denies access or is
unavailable. Readiness exposes names and states, never resolved values.

The installed `runtime-state.manifest.json` declares the runtime snapshot and its
binary-owned `runtime-config.schema.json`, generated from Zod during build. The
controller can inspect local requirements and synchronize portable configuration.
Inline username/password and TLS material (`ca`, `cert`, `key`) remain compatible
for local legacy configurations but are blocked from automatic public transfer.
Reviewed device setup accepts both username and password references together and
always creates the connection stopped. Recipe exports retain authentication
intent and opaque references while omitting inline values and source endpoints.

## Validity / Liveliness

UNS attributes can declare how the controller decides whether they are live or stale; in most apps this is primarily used to drive UI liveliness/activity indicators. In app-level modeling we use two modes only:

- `interval`: continuously refreshed values (stale after ~2× `expectedIntervalMs`)
- `lifecycle`: event-driven activity that stays active until a defined end value (`lifecycleEndValue`)

Example:

```ts
await proxy.publishMqttMessage({
  topic: 'raw/data/',
  asset: 'line-1',
  objectType: 'motor',
  objectId: 'main',
  attributes: {
    attribute: 'status',
    data: { time: new Date().toISOString(), value: 'RUNNING' },
    validityMode: 'lifecycle',
    lifecycleEndValue: 'STOPPED',
  },
});
```

## Datahub client (last value)

`UnsClient` provides a minimal REST client for the UNS OpenHub API, including the batch last-value endpoint. Prefer a long-lived service token if available; you can pass it directly and skip username/password auth.

```ts
import { UnsClient } from '@uns-kit/core';

const client = new UnsClient('https://datahub.example.com', {
  token: process.env.UNS_SERVICE_TOKEN,
});

const values = await client.lastValue(['raw/data/line-1/motor/main/temperature', 'raw/data/line-1/motor/main/status']);
console.log(values);
```

## MQTT Browse And Mapping API

The bridge exposes two MQTT-specific helper endpoints:

- `POST system/bridge/mqtt/runtime/service/browse/topics`
- `POST system/bridge/mqtt/runtime/service/browse/extract-preview`

Use `browse/topics` to listen for a short time and inspect discovered topics and payload samples.
Use `browse/extract-preview` to test the mapping config before saving it.

### Browse Topics Request

Example request body:

```json
{
  "config": {
    "host": "localhost",
    "port": 1883,
    "protocol": "mqtt"
  },
  "topicFilter": "factory/#",
  "durationMs": 3000,
  "maxTopics": 100,
  "maxPayloadBytes": 2048
}
```

### Browse Topics Response

The response contains:

- discovered MQTT topics
- sample payloads
- inferred child nodes from JSON payloads
- suggested mapping shapes for the UI

Example response fragment:

```json
{
  "topicFilter": "factory/#",
  "durationMs": 3000,
  "maxTopics": 100,
  "topics": [
    {
      "topic": "factory/line1/plc1/data",
      "nodeId": "factory/line1/plc1/data",
      "browseName": "data",
      "displayName": "factory/line1/plc1/data",
      "nodeClass": "Topic",
      "hasChildren": true,
      "payloadText": "{\"value\":10}",
      "children": [
        {
          "nodeId": "factory/line1/plc1/data#value",
          "browseName": "value",
          "displayName": "value",
          "nodeClass": "PayloadField",
          "extraction": {
            "mode": "json-path",
            "path": "value"
          },
          "previewValue": 10
        }
      ]
    }
  ]
}
```

### Mapping Config The API Expects

The bridge supports one structured JSON mapping style:

- optional `selector` to choose the right object
- required `extraction.mode = "json-path"` to extract the final value

Full runtime mapping target example:

```json
{
  "topicFilter": "factory/line1/plc1/data",
  "qos": 0,
  "topic": "enterprise/site/area/line/line-1/",
  "asset": "drive-1",
  "objectType": "motor",
  "objectId": "main",
  "dataGroup": "mqtt-factory-broker",
  "validityMode": "interval",
  "expectedIntervalMs": 1000,
  "outputs": [
    {
      "attribute": "temperature",
      "extraction": {
        "mode": "json-path",
        "path": "value"
      }
    }
  ]
}
```

Notes:

- preferred selector form uses dotted `matchField`, for example `values.id`
- when the selector target resolves to an array, the bridge matches one array element
- when the selector target resolves to an object, the bridge matches that object directly
- when no selector target is provided, selector matching happens on the payload root

### Example 1: Simple Key/Value Payload

Payload example:

```json
{
  "value": 10
}
```

Mapping config:

```json
{
  "extraction": {
    "mode": "json-path",
    "path": "value"
  }
}
```

Preview output:

```json
{
  "extractedValue": 10
}
```

Another payload example:

```json
{
  "data": {
    "value": 10
  }
}
```

Mapping config:

```json
{
  "extraction": {
    "mode": "json-path",
    "path": "data.value"
  }
}
```

Preview output:

```json
{
  "extractedValue": 10
}
```

### Example 2: Array Payload With Signal Id

Payload example:

```json
{
  "timestamp": 1777011568734,
  "values": [
    {
      "id": "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
      "v": 27,
      "q": true,
      "t": 1777011567252
    },
    {
      "id": "OPC_UA_JEK_OGR_PONOVC2.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
      "v": 11,
      "q": true,
      "t": 1777011567252
    }
  ]
}
```

Mapping config:

```json
{
  "selector": {
    "matchField": "values.id",
    "matchValue": "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s"
  },
  "extraction": {
    "mode": "json-path",
    "path": "v"
  }
}
```

This extracts:

```json
27
```

Rule:

- if `selector` is present, the bridge first finds the matching object
- then `extraction.path` is applied to that matched object
- if `selector` is omitted, `extraction.path` is applied to the payload root

### Example 3: Object Payload With Key And Value

Payload example:

```json
{
  "key": "temperature",
  "value": 10
}
```

Mapping config:

```json
{
  "selector": {
    "matchField": "key",
    "matchValue": "temperature"
  },
  "extraction": {
    "mode": "json-path",
    "path": "value"
  }
}
```

This extracts:

```json
10
```

Nested object example:

```json
{
  "data": {
    "key": "temperature",
    "value": 10
  }
}
```

Mapping config:

```json
{
  "selector": {
    "matchField": "data.key",
    "matchValue": "temperature"
  },
  "extraction": {
    "mode": "json-path",
    "path": "value"
  }
}
```

### Extract Preview Request

Example request body for preview:

```json
{
  "payloadText": "{\"timestamp\":1777011568734,\"values\":[{\"id\":\"OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s\",\"v\":27,\"q\":true,\"t\":1777011567252}]}",
  "selector": {
    "matchField": "values.id",
    "matchValue": "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s"
  },
  "extraction": {
    "mode": "json-path",
    "path": "v"
  }
}
```

### Extract Preview Response

Example response body:

```json
{
  "extractedValue": 27,
  "payloadJson": {
    "timestamp": 1777011568734,
    "values": [
      {
        "id": "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
        "v": 27,
        "q": true,
        "t": 1777011567252
      }
    ]
  }
}
```

## Publisher target lifecycle

The managed publisher uses `@uns-kit/bridge-core` 3.0.1 and `@uns-kit/core`
3.0.21. Its configured target set includes every mapping output with its effective
UNS topic/asset/ObjectType/ObjectId overrides, including stopped connections.

Retargeting, deleting an output, or deleting a connection reconciles advertised
publisher metadata after the runtime snapshot is saved. Stop preserves configured
metadata. Initial and retained MQTT messages are allowed before activation; late
callbacks cannot re-advertise removed targets. Shared targets stay eligible while
another configured mapping still uses them. Accepted publications drain before
metadata eviction, with a bounded timeout that returns an error rather than false
success.

The bridge does not delete UNS definitions or physical history. Removing definitions
is a separate administrator action; the controller/archiver retain historical sources.
Credential references and Infisical resolution continue to use the existing node-local
protocol boundary.

## Releases

The package version is the source of truth. A change to `package.json` on
`main` creates the immutable `v<version>` tag and matching GitHub Release after
release metadata validation. The release tag then runs the full verification
suite.

## License

[MIT](./LICENSE) © Aljoša Vister.
