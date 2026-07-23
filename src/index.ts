import { ConfigFile, UnsProxyProcess, getLogger, type IApiProxyOptions, type IMqttPublishRequest } from '@uns-kit/core';
import '@uns-kit/api';
import './config/app-config.js';
import { buildUnsRoutePath } from '@uns-kit/core/uns/uns-path.js';
import { registerApiCatalog, type UnsApiProxy, type UnsProxyProcessWithApi } from '@uns-kit/api';
import { bridgeSettingsSchema, BridgeEngine } from '@uns-kit/bridge-core';
import { createServiceApis } from './api/routes.js';
import { toConnectionConfig } from './config/mqtt-config-mappers.js';
import { MqttAdapter } from './mqtt/mqtt-adapter.js';
import { mqttNormalizer } from './mqtt/mqtt-normalizer.js';
import { checkMqttSourceConnection } from './mqtt/mqtt-topic-browser.js';
import type { MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent } from './mqtt/mqtt-types.js';
import type { RuntimeConfigSnapshot } from './config/runtime-config.js';
import { RuntimeConfigManager } from './runtime/runtime-config-manager.js';
import { RuntimeConfigStore } from './runtime/runtime-config-store.js';

const runtimeConfigPath = process.env['UNS_BRIDGE_RUNTIME_CONFIG_PATH'] ?? 'runtime-config.json';
const sourceHealthCheckIntervalMs = 30_000;
const healthPath = buildUnsRoutePath('system/bridge/mqtt/', 'runtime', 'service', 'bridge', 'health').slice(1);

type SourceDependencyHealth = {
  id: string;
  label: string;
  state: 'healthy' | 'degraded' | 'unknown';
  healthy: boolean | null;
  checkedAt: string;
  message: string;
};

type SourceHealthResult = {
  id: string;
  ok: boolean;
  message?: string;
};

const logger = getLogger(import.meta.url);
const config = await ConfigFile.loadConfig();
const bridgeSettings = bridgeSettingsSchema.parse(config.bridge);
const instanceMode = config.uns.instanceMode ?? 'wait';
const handover = config.uns.handover ?? true;

const processHost = config.infra.host ?? config.output?.host;
if (!processHost) {
  throw new Error('infra.host or output.host must be configured');
}

const unsProxyProcess = new UnsProxyProcess(processHost, {
  processName: config.uns.processName,
}) as UnsProxyProcessWithApi;

const publisherProxy = await unsProxyProcess.createUnsMqttProxy(
  config.output?.host ?? processHost,
  bridgeSettings.publisher.instanceName,
  instanceMode,
  handover,
);

const adapter = new MqttAdapter(bridgeSettings.retry);

function validatePublishRequest(request: IMqttPublishRequest): void {
  const attributes = Array.isArray(request.attributes) ? request.attributes : [request.attributes];
  if (attributes.length === 0) {
    throw new Error("Publish request has no attributes");
  }

  for (const attribute of attributes) {
    if (!attribute || typeof attribute.attribute !== 'string' || attribute.attribute.trim().length === 0) {
      throw new Error("Publish request contains an invalid attribute entry");
    }
  }
}

const engine = new BridgeEngine<MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent>(
  adapter,
  {
    publish: async (request: IMqttPublishRequest): Promise<void> => {
      validatePublishRequest(request);
      await publisherProxy.publishMqttMessage(request);
    },
  },
  mqttNormalizer,
);

const runtimeConfigStore = new RuntimeConfigStore(runtimeConfigPath);
const runtimeConfigManager = new RuntimeConfigManager(engine, runtimeConfigStore);

if (!config.uns.jwksWellKnownUrl) {
  throw new Error('config.uns.jwksWellKnownUrl is required');
}

const apiOptions: IApiProxyOptions = {
  jwks: {
    wellKnownJwksUrl: config.uns.jwksWellKnownUrl,
    ...(config.uns.kidWellKnownUrl ? { activeKidUrl: config.uns.kidWellKnownUrl } : {}),
  },
};

const apiProxy = (await unsProxyProcess.createApiProxy(bridgeSettings.api.instanceName, apiOptions)) as UnsApiProxy;

async function checkActiveSourceConnections(snapshot: RuntimeConfigSnapshot): Promise<SourceDependencyHealth[]> {
  const activeConnections = snapshot.connections.filter((connection) => connection.start === true);
  const checkedAt = new Date().toISOString();

  if (activeConnections.length === 0) {
    return [
      {
        id: 'mqtt-source',
        label: 'MQTT source broker',
        state: 'unknown',
        healthy: null,
        checkedAt,
        message: 'No started MQTT source connections are configured.',
      },
    ];
  }

  const results: SourceHealthResult[] = await Promise.all(
    activeConnections.map(async (connection) => {
      try {
        await checkMqttSourceConnection(toConnectionConfig(connection.config));
        return { id: connection.id, ok: true };
      } catch (error) {
        return {
          id: connection.id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    return [
      {
        id: 'mqtt-source',
        label: 'MQTT source broker',
        state: 'healthy',
        healthy: true,
        checkedAt,
        message: `${activeConnections.length} started MQTT source connection${activeConnections.length === 1 ? '' : 's'} reachable.`,
      },
    ];
  }

  const failedSummary = failed.map((result) => `${result.id}${result.message ? ` (${result.message})` : ''}`).join(', ');

  return [
    {
      id: 'mqtt-source',
      label: 'MQTT source broker',
      state: 'degraded',
      healthy: false,
      checkedAt,
      message: `${failed.length}/${activeConnections.length} started MQTT source connection${activeConnections.length === 1 ? '' : 's'} unavailable: ${failedSummary}`,
    },
  ];
}

async function publishBridgeServiceMetadata(dependencies?: SourceDependencyHealth[]): Promise<void> {
  await unsProxyProcess.publishServiceMetadata({
    serviceId: 'uns-bridge-mqtt',
    kind: 'addon',
    addonId: 'uns-bridge-mqtt',
    label: 'UNS Bridge MQTT',
    description: 'Addon runtime for browsing MQTT topics and mapping payloads into UNS.',
    capabilities: ['addon', 'mqtt-source-browser', 'payload-extraction', 'runtime-mappings'],
    apiRoutes: [
      {
        path: `/api/${healthPath}`,
        kind: 'health',
      },
    ],
    healthPath: `/api/${healthPath}`,
    ...(dependencies ? { extra: { dependencies } } : {}),
  });
}

let sourceHealthCheckInFlight: Promise<void> | undefined;
function scheduleSourceHealthCheck(): void {
  if (sourceHealthCheckInFlight) {
    return;
  }

  sourceHealthCheckInFlight = (async () => {
    try {
      const dependencies = await checkActiveSourceConnections(runtimeConfigManager.getCurrentConfig());
      await publishBridgeServiceMetadata(dependencies);
    } catch (error) {
      logger.warn(`Unable to refresh MQTT source dependency health: ${error instanceof Error ? error.message : String(error)}`);
    }
  })().finally(() => {
    sourceHealthCheckInFlight = undefined;
  });
}

await registerApiCatalog(apiProxy, {
  serviceApis: createServiceApis(engine, adapter, runtimeConfigManager),
  context: undefined,
  options: {
    onError: ({ method, reqPath, error }) => {
      logger.error(`Bridge ${method} handler error [${reqPath ?? ''}]: ${error instanceof Error ? error.message : String(error)}`);
    },
  },
});
const runtimeConfig = await runtimeConfigManager.initializeFromSnapshot();
await publishBridgeServiceMetadata(await checkActiveSourceConnections(runtimeConfig));
const sourceHealthCheckTimer = setInterval(scheduleSourceHealthCheck, sourceHealthCheckIntervalMs);

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}, shutting down bridge runtime`);
  clearInterval(sourceHealthCheckTimer);
  await engine.stopAll();
  unsProxyProcess.shutdown();
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

logger.info(
  `uns-bridge-mqtt started with process '${config.uns.processName}' and runtime snapshot '${runtimeConfigStore.resolvedPath}' (${runtimeConfig.connections.length} connections)`,
);
