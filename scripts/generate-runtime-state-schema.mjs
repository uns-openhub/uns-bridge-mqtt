import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { runtimeConfigSnapshotSchema } from '../dist/config/runtime-config.js';
const schema = z.toJSONSchema(runtimeConfigSnapshotSchema, { target: 'draft-7', io: 'input' });
await writeFile(new URL('../runtime-config.schema.json', import.meta.url), JSON.stringify(schema, null, 2) + '\n');
