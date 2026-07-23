import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { getLogger } from '@uns-kit/core';
import type {
  MqttBrowseDiscoveredChild,
  MqttBrowseTemplateCandidate,
  MqttBrowseTopicNode,
  MqttBrowseTopicSample,
  MqttBrowseTopicsInput,
  MqttBrowseTopicsResult,
  MqttBridgeConnectionConfig,
} from './mqtt-types.js';

const logger = getLogger(import.meta.url);

export function buildMqttClientConfig(config: MqttBridgeConnectionConfig): {
  url: string;
  options: IClientOptions;
  details: Record<string, unknown>;
} {
  const toServer = (
    host: string,
    port: number,
    protocol: NonNullable<IClientOptions['servers']>[number]['protocol'] | undefined,
  ): NonNullable<IClientOptions['servers']>[number] => ({
    host,
    port,
    ...(protocol ? { protocol } : {}),
  });

  const protocol = config.protocol ?? 'mqtt';
  const host = config.host ?? config.hosts?.[0] ?? config.servers?.[0]?.host;

  const url = config.brokerUrl ?? (host ? `${protocol}://${host}${config.port ? `:${String(config.port)}` : ''}` : undefined);

  if (!url) {
    throw new Error('MQTT connection requires brokerUrl, host, hosts, or servers');
  }

  const servers: IClientOptions['servers'] = config.servers
    ? config.servers.map((entry) =>
        toServer(
          entry.host,
          entry.port ?? config.port ?? 1883,
          (entry.protocol ?? config.protocol) as NonNullable<IClientOptions['servers']>[number]['protocol'] | undefined,
        ),
      )
    : config.hosts?.map((entry) =>
        toServer(entry, config.port ?? 1883, config.protocol as NonNullable<IClientOptions['servers']>[number]['protocol'] | undefined),
      );

  const options = {
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
    ...(config.clientId ? { clientId: config.clientId } : {}),
    ...(config.clean !== undefined ? { clean: config.clean } : {}),
    ...(config.keepalive !== undefined ? { keepalive: config.keepalive } : {}),
    ...(config.connectTimeout !== undefined ? { connectTimeout: config.connectTimeout } : {}),
    ...(config.reconnectPeriod !== undefined ? { reconnectPeriod: config.reconnectPeriod } : {}),
    ...(config.reconnectOnConnackError !== undefined ? { reconnectOnConnackError: config.reconnectOnConnackError } : {}),
    ...(config.resubscribe !== undefined ? { resubscribe: config.resubscribe } : {}),
    ...(config.queueQoSZero !== undefined ? { queueQoSZero: config.queueQoSZero } : {}),
    ...(config.rejectUnauthorized !== undefined ? { rejectUnauthorized: config.rejectUnauthorized } : {}),
    ...(config.properties ? { properties: config.properties } : {}),
    ...(config.ca ? { ca: config.ca } : {}),
    ...(config.cert ? { cert: config.cert } : {}),
    ...(config.key ? { key: config.key } : {}),
    ...(config.servername ? { servername: config.servername } : {}),
    ...(servers?.length ? { servers } : {}),
  } as IClientOptions;

  return {
    url,
    options,
    details: {
      url,
      host: config.host,
      hosts: config.hosts,
      servers,
      clientId: config.clientId,
      protocol,
    },
  };
}

export async function checkMqttSourceConnection(config: MqttBridgeConnectionConfig): Promise<void> {
  const { url, options } = buildMqttClientConfig(config);
  const client = mqtt.connect(url, { ...options, reconnectPeriod: 0 });

  try {
    await waitForConnect(client, config.connectTimeout ?? 10000);
  } finally {
    await endClient(client);
  }
}

function toPayloadText(payload: Buffer, maxPayloadBytes: number): string {
  return payload.subarray(0, maxPayloadBytes).toString('utf8');
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function resolveJsonPath(input: unknown, path: string): unknown {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  let current: unknown = input;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }

    return undefined;
  }

  return current;
}

function isPrimitiveValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function buildFieldTemplates(path: string, value: unknown): MqttBrowseTemplateCandidate[] {
  return [
    {
      label: `json-path:${path}`,
      extraction: {
        mode: 'json-path',
        path,
      },
      previewValue: value,
    },
  ];
}

function findMatchField(entries: Record<string, unknown>[]): string | undefined {
  const preferred = ['id', 'name', 'key', 'code', 'tag', 'path', 'topic'];

  for (const field of preferred) {
    if (entries.every((entry) => typeof entry[field] === 'string')) {
      return field;
    }
  }

  const candidateFields = new Set<string>();
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string') {
        candidateFields.add(key);
      }
    }
  }

  for (const field of candidateFields) {
    if (entries.every((entry) => typeof entry[field] === 'string')) {
      return field;
    }
  }

  return undefined;
}

function buildArrayEntryTemplates(
  targetPath: string,
  entry: Record<string, unknown>,
  matchField: string,
  matchValue: string,
): MqttBrowseTemplateCandidate[] {
  const templates: MqttBrowseTemplateCandidate[] = [];

  for (const [key, value] of Object.entries(entry)) {
    if (key === matchField || !isPrimitiveValue(value)) {
      continue;
    }

    templates.push({
      label: `${targetPath}[${matchField}=${matchValue}].${key}`,
      selector: {
        matchField: `${targetPath}.${matchField}`,
        matchValue,
      },
      extraction: {
        mode: 'json-path',
        path: key,
      },
      previewValue: value,
    });
  }

  return templates;
}

export function inferPayloadTemplates(topic: string, payloadJson: unknown): MqttBrowseDiscoveredChild[] {
  if (typeof payloadJson !== 'object' || payloadJson === null) {
    return [];
  }

  const children: MqttBrowseDiscoveredChild[] = [];
  const rootRecord = payloadJson as Record<string, unknown>;

  for (const [key, value] of Object.entries(rootRecord)) {
    if (Array.isArray(value)) {
      const objectEntries = value
        .filter((entry) => typeof entry === 'object' && entry !== null)
        .map((entry) => entry as Record<string, unknown>);

      const matchField = objectEntries.length > 0 ? findMatchField(objectEntries) : undefined;

      if (objectEntries.length > 0 && matchField) {
        for (const entry of objectEntries) {
          const matchValue = String(entry[matchField]);
          const templates = buildArrayEntryTemplates(key, entry, matchField, matchValue);
          const preferredTemplate = templates[0];
          children.push({
            nodeId: `${topic}#${key}:${matchField}=${matchValue}`,
            browseName: matchValue,
            displayName: matchValue,
            nodeClass: 'PayloadItem',
            typeDefinition: 'array-entry',
            referenceTypeId: key,
            isForward: true,
            hasChildren: false,
            ...(preferredTemplate?.selector ? { selector: preferredTemplate.selector } : {}),
            ...(preferredTemplate?.extraction ? { extraction: preferredTemplate.extraction } : {}),
            previewValue: preferredTemplate?.previewValue,
            templates,
          });
        }
        continue;
      }

      children.push({
        nodeId: `${topic}#${key}`,
        browseName: key,
        displayName: key,
        nodeClass: 'PayloadArray',
        typeDefinition: 'array',
        referenceTypeId: key,
        isForward: true,
        hasChildren: true,
        templates: [
          {
            label: `json-path:${key}`,
            extraction: {
              mode: 'json-path',
              path: key,
            },
            previewValue: value,
          },
        ],
        previewValue: value.length,
      });
      continue;
    }

    const templates = buildFieldTemplates(key, value);
    children.push({
      nodeId: `${topic}#${key}`,
      browseName: key,
      displayName: key,
      nodeClass: 'PayloadField',
      typeDefinition: Array.isArray(value) ? 'array' : typeof value,
      referenceTypeId: key,
      isForward: true,
      hasChildren: typeof value === 'object' && value !== null,
      ...(templates[0]?.extraction ? { extraction: templates[0].extraction } : {}),
      templates,
      previewValue: value,
    });
  }

  return children.sort((left, right) => (left.displayName ?? '').localeCompare(right.displayName ?? ''));
}

function waitForConnect(client: MqttClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MQTT connect after ${timeoutMs}ms`));
    }, timeoutMs);

    const onConnect = (): void => {
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      client.off('connect', onConnect);
      client.off('error', onError);
    };

    client.on('connect', onConnect);
    client.on('error', onError);
  });
}

function endClient(client: MqttClient): Promise<void> {
  return new Promise((resolve) => {
    client.end(false, {}, () => {
      resolve();
    });
  });
}

export async function browseTopics(input: MqttBrowseTopicsInput): Promise<MqttBrowseTopicsResult> {
  const topicFilter = input.topicFilter ?? '#';
  const durationMs = input.durationMs ?? 3000;
  const maxTopics = input.maxTopics ?? 200;
  const maxPayloadBytes = input.maxPayloadBytes ?? 2048;
  const { url, options } = buildMqttClientConfig(input.config);
  const samples = new Map<string, MqttBrowseTopicSample>();
  const client = mqtt.connect(url, { ...options, reconnectPeriod: 0 });

  try {
    await waitForConnect(client, input.config.connectTimeout ?? 10000);

    await new Promise<void>((resolve, reject) => {
      client.subscribe(topicFilter, { qos: 0 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    client.on('message', (topic, payload, packet) => {
      if (!samples.has(topic) && samples.size >= maxTopics) {
        return;
      }

      const now = new Date().toISOString();
      const payloadText = toPayloadText(payload, maxPayloadBytes);
      const payloadJson = tryParseJson(payloadText);
      const existing = samples.get(topic);
      const next: MqttBrowseTopicSample = {
        topic,
        count: (existing?.count ?? 0) + 1,
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
        qos: packet.qos ?? 0,
        retain: packet.retain ?? false,
        payloadText,
        payloadBase64: payload.subarray(0, maxPayloadBytes).toString('base64'),
        ...(payloadJson !== undefined ? { payloadJson } : {}),
      };

      samples.set(topic, next);
    });

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    const topics: MqttBrowseTopicNode[] = [...samples.values()]
      .sort((left, right) => left.topic.localeCompare(right.topic))
      .map((sample) => {
        const children = sample.payloadJson !== undefined ? inferPayloadTemplates(sample.topic, sample.payloadJson) : [];

        return {
          ...sample,
          nodeId: sample.topic,
          browseName: sample.topic.split('/').filter(Boolean).at(-1) ?? sample.topic,
          displayName: sample.topic,
          nodeClass: 'Topic',
          typeDefinition: null,
          referenceTypeId: null,
          isForward: true,
          hasChildren: children.length > 0,
          children,
        };
      });

    return {
      topicFilter,
      durationMs,
      maxTopics,
      topics,
      children: topics,
    };
  } catch (error) {
    logger.error(`MQTT browse failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    await endClient(client);
  }
}
