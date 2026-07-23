# UNS Bridge MQTT

UNS DataHub add-on for browsing MQTT brokers, inspecting payloads, and mapping
source topics into canonical UNS attributes.

Requires Node.js 22+, pnpm 10, UNS DataHub, and an accessible MQTT broker.

## Scripts

```bash
pnpm install
cp config-example.json config.json
export UNS_PASSWORD='your-controller-password'
pnpm run dev
pnpm run verify
```

## Configuration

Update `config.json` with UNS endpoints and credentials. The management API
requires the configured controller JWKS endpoints.

Runtime bridge state is loaded from `runtime-config.json` when present. A sample snapshot is provided in `runtime-config.json.example`.
This runtime snapshot is separate from the original `uns-kit` `config.json` structure (`uns`, `infra`, `input`, `output`, ...).
If needed, override the snapshot path with `UNS_BRIDGE_RUNTIME_CONFIG_PATH`.

Sub-assets use the existing target identity fields. Set `topic` to the full
parent asset path and `asset` to the leaf sub-asset. For example, a mapping with
`topic: "enterprise/site/area/line/line-1/"` and `asset: "drive-1"` publishes
under `enterprise/site/area/line/line-1/drive-1/...`; `dataGroup` remains
storage/routing metadata.

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

`UnsClient` provides a minimal REST client for the UNS Datahub API, including the batch last-value endpoint. Prefer a long-lived service token if available; you can pass it directly and skip username/password auth.

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

## Releases

The package version is the source of truth. Release tags must match it exactly
as `v<version>`. No package is published automatically.

## License

[MIT](./LICENSE) © Aljoša Vister.
