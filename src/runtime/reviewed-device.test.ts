import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeConfigManager } from './runtime-config-manager.js';
import { RuntimeConfigStore } from './runtime-config-store.js';
import { devicePreviewBodySchema, deviceAppendBodySchema, type ReviewedDevice } from './reviewed-device.js';
import { BridgeConfigConflictError } from '../api/validation-error.js';
import { createServiceApis } from '../api/routes.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
const device = (id='device-a', objectId=id): ReviewedDevice => devicePreviewBodySchema.parse({
  connection:{id,config:{brokerUrl:'mqtt://localhost:1883',clientId:'acceptance-local-client',clean:false,reconnectPeriod:0}},
  mappings:[{id:'m1',config:{topicFilter:'factory/device/telemetry',qos:0,topic:'enterprise/site/line/',asset:'machine',objectType:'equipment',objectId,
    publishInitialValue:false,outputs:[{attribute:'temperature',extraction:{mode:'json-path',path:'value'}},{attribute:'status',selector:{matchField:'values.id',matchValue:'state'},extraction:{mode:'json-path',path:'v'}}]}}],
});
class Engine {
  calls: Array<{op:string,id:string,start?:boolean}> = [];
  connections=new Set<string>();
  failMapping=false;
  async addConnection(c: {id:string;start:boolean}) {this.calls.push({op:'add',id:c.id,start:c.start});this.connections.add(c.id);}
  async addMapping(id:string) {this.calls.push({op:'mapping',id});if(this.failMapping)throw new Error('mapping failed');}
  async removeConnection(id:string) {this.calls.push({op:'remove',id});this.connections.delete(id);}
  async startConnection(id:string){this.calls.push({op:'start',id});}
  async stopConnection(id:string){this.calls.push({op:'stop',id});}
  async updateConnection(id:string){this.calls.push({op:'update',id});}
  async updateMapping(id:string){this.calls.push({op:'update-mapping',id});}
  async removeMapping(id:string){this.calls.push({op:'remove-mapping',id});}
}
let dir:string, store:RuntimeConfigStore, engine:Engine, manager:RuntimeConfigManager;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'mqtt-reviewed-'));store=new RuntimeConfigStore(join(dir,'runtime.json'));engine=new Engine();manager=new RuntimeConfigManager(engine as any,store);});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
async function seed() {const input=device('existing');await manager.applyConfig({version:1,connections:[{...input.connection,start:false,mappings:input.mappings}]},'api-apply');engine.calls=[];return manager.getCurrentConfig();}
async function saved() {return JSON.parse(await readFile(store.resolvedPath,'utf8')) as RuntimeConfigSnapshot;}
function apis() {return createServiceApis(engine as any,{} as any,manager);}
async function invoke(key:string,body:unknown) {
  const response={code:200,body:undefined as any,status(code:number){this.code=code;return this;},json(body:unknown){this.body=body;}};
  await apis()[key]!.handler({req:{body},res:response});return response;
}
describe('reviewed MQTT device manager',()=>{
  it('preview is pure, repeatable and exposes mapping and output counts',async()=>{const before=manager.getCurrentConfig();const source=await manager.getSourceStatus();const p=await manager.previewNewDevice(device());assert.deepEqual(await manager.previewNewDevice(device()),p);assert.equal(p.count,1);assert.equal(p.outputCount,2);assert.match(p.revision,/^[a-f0-9]{64}$/);assert.deepEqual(manager.getCurrentConfig(),before);assert.deepEqual(await manager.getSourceStatus(),source);assert.equal(await store.exists(),false);assert.deepEqual(engine.calls,[]);});
  it('creates stopped and changes only the new connection',async()=>{const old=await seed();const input=device();const p=await manager.previewNewDevice(input);assert.deepEqual(await manager.appendReviewedDevice(input,p.revision),{id:'device-a',count:1,start:false});assert.deepEqual(manager.getCurrentConfig().connections[0],old.connections[0]);assert.deepEqual(engine.calls,[{op:'add',id:'device-a',start:false},{op:'mapping',id:'device-a'}]);assert.deepEqual(await saved(),manager.getCurrentConfig());assert.equal(manager.getCurrentConfig().connections[1]!.config.clean,false);assert.equal(manager.getCurrentConfig().connections[1]!.config.reconnectPeriod,0);});
  it('uses atomic private snapshot replacement, with no leftover temporary files',async()=>{const p=await manager.previewNewDevice(device());await manager.appendReviewedDevice(device(),p.revision);assert.equal((await stat(store.resolvedPath)).mode&0o777,0o600);assert.deepEqual(await readdir(dir),['runtime.json']);});
  it('persists the same device across manager restart',async()=>{const p=await manager.previewNewDevice(device());await manager.appendReviewedDevice(device(),p.revision);const restarted=new RuntimeConfigManager(new Engine() as any,store);await restarted.initializeFromSnapshot();assert.deepEqual(restarted.getCurrentConfig().connections,manager.getCurrentConfig().connections);});
  it('stale review has no engine or file effects',async()=>{const p=await manager.previewNewDevice(device());await seed();const before=await saved();await assert.rejects(manager.appendReviewedDevice(device(),p.revision),BridgeConfigConflictError);assert.deepEqual(engine.calls,[]);assert.deepEqual(await saved(),before);});
  it('concurrent reviewed writes admit exactly one',async()=>{const p=await manager.previewNewDevice(device());const results=await Promise.allSettled([manager.appendReviewedDevice(device(),p.revision),manager.appendReviewedDevice(device('device-b'),p.revision)]);assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']);assert.equal(manager.getCurrentConfig().connections.length,1);assert.deepEqual(await saved(),manager.getCurrentConfig());});
  it('legacy CRUD reads inside queue so it cannot discard a concurrent append',async()=>{const p=await manager.previewNewDevice(device());const create=manager.appendReviewedDevice(device(),p.revision);const edit=manager.mutateConfig(s=>{s.connections.push({id:'legacy',start:false,config:{host:'localhost'},mappings:[]});return s;});await Promise.all([create,edit]);assert.deepEqual(manager.getCurrentConfig().connections.map(c=>c.id),['device-a','legacy']);assert.deepEqual(await saved(),manager.getCurrentConfig());});
  it('a queued legacy mutation makes a later reviewed request stale',async()=>{const p=await manager.previewNewDevice(device());const edit=manager.mutateConfig(s=>{s.connections.push({id:'legacy',start:false,config:{host:'localhost'},mappings:[]});return s;});const add=manager.appendReviewedDevice(device(),p.revision);await edit;await assert.rejects(add,BridgeConfigConflictError);assert.deepEqual(manager.getCurrentConfig().connections.map(c=>c.id),['legacy']);});
  it('queued request is isolated from caller edits',async()=>{const p=await manager.previewNewDevice(device());const input=device();const add=manager.appendReviewedDevice(input,p.revision);input.connection.id='mutated';input.mappings[0]!.config.objectId='mutated';await add;assert.equal(manager.getCurrentConfig().connections[0]!.id,'device-a');assert.equal(manager.getCurrentConfig().connections[0]!.mappings[0]!.config.objectId,'device-a');});
  it('mapping failure removes only the new connection and preserves file and source state',async()=>{const before=await seed();const source=await manager.getSourceStatus();const p=await manager.previewNewDevice(device());engine.failMapping=true;await assert.rejects(manager.appendReviewedDevice(device(),p.revision),/mapping failed/);assert.deepEqual(manager.getCurrentConfig(),before);assert.deepEqual(await saved(),before);assert.deepEqual(await manager.getSourceStatus(),source);assert.deepEqual([...engine.connections],['existing']);assert.deepEqual(engine.calls.map(c=>c.op),['add','mapping','remove']);});
  it('snapshot failure compensates and a rejected queue does not stay blocked',async()=>{const before=await seed();const p=await manager.previewNewDevice(device());const original=store.write.bind(store);store.write=async()=>{throw new Error('disk failed');};await assert.rejects(manager.appendReviewedDevice(device(),p.revision),/disk failed/);assert.deepEqual(await saved(),before);assert.deepEqual(manager.getCurrentConfig(),before);assert.deepEqual([...engine.connections],['existing']);store.write=original;await manager.appendReviewedDevice(device(),p.revision);assert.equal(manager.getCurrentConfig().connections.length,2);});
  it('validating a full snapshot does not mutate source status',async()=>{const before=await manager.getSourceStatus();await manager.validateConfig({version:1,connections:[]});assert.deepEqual(await manager.getSourceStatus(),before);});
  it('checks duplicate effective output targets across existing connections',async()=>{await seed();await assert.rejects(manager.previewNewDevice(device('new','existing')),/validation failed/);assert.deepEqual(engine.calls,[]);});
  it('checks existing output overrides rather than only their parent mapping identity',async()=>{const s=await seed();s.connections[0]!.mappings[0]!.config.outputs[0]!.objectId='device-a';await manager.applyConfig(s,'api-apply');engine.calls=[];await assert.rejects(manager.previewNewDevice(device()),/validation failed/);assert.deepEqual(engine.calls,[]);});
  it('rejects duplicate new outputs even within one mapping',async()=>{const d=device();d.mappings[0]!.config.outputs.push({attribute:'TEMPERATURE'});await assert.rejects(manager.previewNewDevice(d),/validation failed/);assert.deepEqual(engine.calls,[]);});
  it('rejects repeated mapping IDs case-insensitively',async()=>{const d=device();const m=structuredClone(d.mappings[0]!);m.id='M1';m.config.outputs=[{attribute:'other'}];d.mappings.push(m);await assert.rejects(manager.previewNewDevice(d),/validation failed/);});
});
describe('reviewed MQTT service routes',()=>{
  it('returns safe validation errors and 409 without falling back to upsert',async()=>{const p=await invoke('previewDevice',device());assert.equal(p.code,200);assert.deepEqual(engine.calls,[]);const a=await invoke('appendReviewedDevice',{...device(),expectedRevision:p.body.revision});assert.equal(a.code,200);const stale=await invoke('appendReviewedDevice',{...device('b'),expectedRevision:p.body.revision});assert.equal(stale.code,409);assert.equal(stale.body.error,'CONFIG_CONFLICT');const invalid=await invoke('previewDevice',{...device(),unexpected:'value'});assert.equal(invalid.code,400);assert.equal(invalid.body.error,'VALIDATION_ERROR');});
  it('repeated creates through legacy route and reviewed route preserve both connections',async()=>{const p=await manager.previewNewDevice(device());await Promise.all([invoke('appendReviewedDevice',{...device(),expectedRevision:p.revision}),invoke('connectionCreate',{id:'legacy',config:{host:'localhost'}})]);assert.deepEqual(manager.getCurrentConfig().connections.map(c=>c.id),['device-a','legacy']);});
  it('retains the namespace, method and current management paths',()=>{const a=apis();assert.equal(a['previewDevice']!.objectId,'devices');assert.equal(a['previewDevice']!.attribute,'preview-add');assert.equal(a['appendReviewedDevice']!.method,'POST');assert.equal(a['connectionCreate']!.attribute,'create');assert.equal(a['connectionCreate']!.topic,'system/bridge/mqtt/');});
  it('bounds returned validation issues',async()=>{const d=device();d.mappings=Array.from({length:25},()=>({id:'',config:{} as any}));const r=await invoke('previewDevice',d);assert.equal(r.code,400);assert.equal(r.body.issues.length,20);});
});
describe('reviewed request validation',()=>{
  for (const field of ['start','password','username','ca','key','unknown']) {
    it('rejects unsupported local config field '+field,()=>{const d=device();if(field==='start')Object.assign(d.connection,{start:true});else Object.assign(d.connection.config,{[field]:'x'});assert.equal(devicePreviewBodySchema.safeParse(d).success,false);});
  }
  for (const filter of ['a+','a/#/b','a//b','$share/g/a/#']) it('rejects invalid or shared filter '+filter,()=>{const d=device();d.mappings[0]!.config.topicFilter=filter;assert.equal(devicePreviewBodySchema.safeParse(d).success,false);});
  it('permits full wildcard levels while keeping explicit UNS targets',()=>{const d=device();d.mappings[0]!.config.topicFilter='a/+/#';assert.equal(devicePreviewBodySchema.safeParse(d).success,true);});
  it('rejects outputs that redirect to another device',()=>{const d=device();d.mappings[0]!.config.outputs[0]!.asset='other';assert.equal(devicePreviewBodySchema.safeParse(d).success,false);});
  it('rejects destination wildcards and empty identity levels',()=>{const d=device();d.mappings[0]!.config.topic='a//b/';assert.equal(devicePreviewBodySchema.safeParse(d).success,false);d.mappings[0]!.config.topic='a/#/';assert.equal(devicePreviewBodySchema.safeParse(d).success,false);});
  it('requires a local client ID for persistent sessions',()=>{const d=device();delete d.connection.config.clientId;assert.equal(devicePreviewBodySchema.safeParse(d).success,false);});
  it('requires full revision and rejects empty/oversized mapping sets',()=>{assert.equal(deviceAppendBodySchema.safeParse({...device(),expectedRevision:'short'}).success,false);assert.equal(devicePreviewBodySchema.safeParse({...device(),mappings:[]}).success,false);assert.equal(devicePreviewBodySchema.safeParse({...device(),mappings:Array(101).fill(device().mappings[0])}).success,false);});
  it('requires json-path while preserving raw/text extraction modes',()=>{const d=device();d.mappings[0]!.config.outputs[0]!.extraction={mode:'json-path'};assert.equal(devicePreviewBodySchema.safeParse(d).success,false);d.mappings[0]!.config.outputs[0]!.extraction={mode:'text'};assert.equal(devicePreviewBodySchema.safeParse(d).success,true);});
});

describe('real bridge-core and MQTT adapter without starting a broker session',()=>{
  it('creates the persisted stopped device in the real runtime registry',async()=>{
    const {BridgeEngine}=await import('@uns-kit/bridge-core');
    const {MqttAdapter}=await import('../mqtt/mqtt-adapter.js');
    const {mqttNormalizer}=await import('../mqtt/mqtt-normalizer.js');
    const liveEngine=new BridgeEngine(new MqttAdapter({}),{publish:async()=>{throw new Error('Stopped device must never publish.');}},mqttNormalizer);
    const real=new RuntimeConfigManager(liveEngine,store);
    const p=await real.previewNewDevice(device());
    assert.equal((await liveEngine.listConnections()).length,0);
    await real.appendReviewedDevice(device(),p.revision);
    const rows=await liveEngine.listConnections();
    assert.equal(rows.length,1);
    assert.equal((rows[0] as {state:string}).state,'stopped');
    assert.equal((rows[0] as {desiredState:string}).desiredState,'stopped');
    assert.equal((await liveEngine.getConnectionMappings('device-a')).length,1);
    assert.deepEqual(await saved(),real.getCurrentConfig());
    await liveEngine.removeConnection('device-a');
  });
  for (const value of [0, false, 'Idle', 23.5]) it('extracts a documented UNS-style JSON value '+String(value),async()=>{
    const {MqttAdapter}=await import('../mqtt/mqtt-adapter.js');
    const adapter=new MqttAdapter({});
    // Synthetic format fixture, not a captured Ignition export or a live gateway proof.
    const payload={name:'Site/Equipment/Temperature',dataType:typeof value==='number'?'Double':typeof value==='boolean'?'Boolean':'String',value,timestamp:1700000000000,qualityCode:192};
    assert.equal(adapter.previewExtraction({payloadText:JSON.stringify(payload),extraction:{mode:'json-path',path:'value'}}).extractedValue,value);
  });
});

import { resolveMqttCredentials, redactMqttError, runtimeSecretReferenceSchema } from './local-secret-references.js';
import { buildMqttClientConfig } from '../mqtt/mqtt-topic-browser.js';
const secretRef = (key:string) => ({provider:'env' as const,key:'UNS_RUNTIME_SECRET_'+key});
describe('MQTT runtime credentials',()=>{
 it('resolves only at the protocol boundary and keeps config opaque',()=>{const c={brokerUrl:'mqtt://broker',username:secretRef('USER'),password:secretRef('PASSWORD')};const before=structuredClone(c);assert.deepEqual(resolveMqttCredentials(c,{UNS_RUNTIME_SECRET_USER:'fixture-user',UNS_RUNTIME_SECRET_PASSWORD:'fixture-password'}),{username:'fixture-user',password:'fixture-password'});assert.deepEqual(c,before);});
 it('retains anonymous and legacy local compatibility',()=>{assert.deepEqual(resolveMqttCredentials({}),{});assert.deepEqual(resolveMqttCredentials({username:'fixture-user',password:'fixture-password'}),{username:'fixture-user',password:'fixture-password'});assert.equal(buildMqttClientConfig({brokerUrl:'mqtt://broker',username:'fixture-user'}).options.username,'fixture-user');});
 it('blocks missing refs with a safe validation error',()=>{assert.throws(()=>resolveMqttCredentials({username:secretRef('MISSING')},{}),/validation failed/);});
 it('rejects malformed refs and non-reserved environment names',()=>{assert.equal(runtimeSecretReferenceSchema.safeParse({provider:'env',key:'PATH'}).success,false);assert.equal(runtimeSecretReferenceSchema.safeParse({...secretRef('USER'),value:'fixture'}).success,false);});
 it('redacts resolved values, URL userinfo and TLS material from errors',()=>{const message=redactMqttError(new Error('fixture-user fixture-password mqtt://url-user:url-password@broker fixture-key'),{username:secretRef('USER'),password:secretRef('PASSWORD'),brokerUrl:'mqtt://url-user:url-password@broker',key:'fixture-key'},{UNS_RUNTIME_SECRET_USER:'fixture-user',UNS_RUNTIME_SECRET_PASSWORD:'fixture-password'});assert.doesNotMatch(message,/fixture-user|fixture-password|url-user|url-password|fixture-key/);assert.ok(message.length<=300);});
 it('accepts both refs in reviewed setup and rejects partial auth',()=>{const d=device();const config={...d.connection.config,username:secretRef('USER'),password:secretRef('PASSWORD')};assert.equal(devicePreviewBodySchema.safeParse({...d,connection:{...d.connection,config}}).success,true);assert.equal(devicePreviewBodySchema.safeParse({...d,connection:{...d.connection,config:{...d.connection.config,username:secretRef('USER')}}}).success,false);});
 it('saves stopped unresolved references but preflights before changing existing connections',async()=>{const before=await seed();const d=device();d.connection.config.username=secretRef('UNPROVISIONED_U2_USER');d.connection.config.password=secretRef('UNPROVISIONED_U2_PASSWORD');const preview=await manager.previewNewDevice(d);await manager.appendReviewedDevice(d,preview.revision);assert.equal(manager.getCurrentConfig().connections[1]!.start,false);const old=await saved();engine.calls=[];const next=structuredClone(old);next.connections=next.connections.filter(c=>c.id==='device-a');next.connections[0]!.start=true;await assert.rejects(manager.applyConfig(next,'api-apply'),/validation failed/);assert.deepEqual(engine.calls,[]);assert.deepEqual(await saved(),old);assert.deepEqual(manager.getCurrentConfig().connections[0],before.connections[0]);});
});
