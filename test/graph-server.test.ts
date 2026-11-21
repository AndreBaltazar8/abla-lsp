import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import type { CompletionItem, Hover, SignatureHelp } from "vscode-languageserver/node";
import { PositionMap } from "../src/positions.js";
import { CompilerClient } from "../src/compiler-client.js";
type Message = { id?:number; method?:string; result?:unknown; error?:{message:string}; params?:unknown };
class Server {
 readonly child=spawn(process.execPath,['dist/src/main.js','--stdio'],{stdio:['pipe','pipe','pipe']});
 readonly messages:Message[]=[];readonly pending=new Map<number,{resolve:(m:Message)=>void;reject:(e:Error)=>void}>();
 stderr='';buffer=Buffer.alloc(0);id=0;
 constructor(){
  this.child.stderr.on('data',b=>{this.stderr+=String(b);});
  this.child.stdout.on('data',(chunk:Buffer)=>{this.buffer=Buffer.concat([this.buffer,chunk]);this.drain();});
  this.child.on('exit',()=>{for(const p of this.pending.values())p.reject(new Error('server exited '+this.stderr));this.pending.clear();});
 }
 drain():void {
  while(true){const end=this.buffer.indexOf('\r\n\r\n');if(end<0)return;const length=Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0,end).toString())?.[1]);assert.ok(Number.isFinite(length));if(this.buffer.length<end+4+length)return;
   const value=JSON.parse(this.buffer.subarray(end+4,end+4+length).toString()) as Message;this.buffer=this.buffer.subarray(end+4+length);this.messages.push(value);
   if(value.id!==undefined){this.pending.get(value.id)?.resolve(value);this.pending.delete(value.id);}
  }
 }
 send(message:object):void {const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',...message}));this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);this.child.stdin.write(body);}
 request(method:string,params:unknown):Promise<Message>{const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`timeout ${method}: ${this.stderr}`));},15000);this.pending.set(id,{resolve:m=>{clearTimeout(timer);resolve(m);},reject:e=>{clearTimeout(timer);reject(e);}});this.send({id,method,params});});}
 notify(method:string,params:unknown):void{this.send({method,params});}
 async wait(predicate:(m:Message)=>boolean):Promise<Message>{const deadline=Date.now()+15000;while(Date.now()<deadline){const found=this.messages.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('notification timeout: '+this.stderr);}
 async start(root:string,compiler:{path:string;arguments?:string[]}):Promise<void>{const reply=await this.request('initialize',{processId:null,rootUri:pathToFileURL(root).href,capabilities:{},initializationOptions:{compiler}});assert.equal(reply.error,undefined);this.notify('initialized',{});await this.wait(m=>m.method==='window/logMessage'&&String((m.params as {message?:string})?.message).includes('connected to ablac'));}
 async stop():Promise<void>{if(this.child.exitCode!==null)return;await this.request('shutdown',null);const exited=new Promise<void>(resolve=>this.child.once('exit',()=>resolve()));this.notify('exit',null);await exited;}
}
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'abla-lsp-server-'));const file=path.join(root,'main.ab');const text='// café 😀\nfun target(): int = 42\nfun main: int = target()\n';await fs.writeFile(path.join(root,'abla.toml'),'name = "lsp-test"\nentry = "main.ab"\n');await fs.writeFile(file,text);return{root,file,uri:pathToFileURL(file).href,text};}
async function trace(file:string):Promise<Array<{method:string;params:Record<string,unknown>;pid:number}>> {return (await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
for(const mode of ['ignore','graph-no-queries','graph'])test(`LSP compiler negotiation and navigation: ${mode}`,{timeout:30000},async context=>{
 const f=await fixture();const log=path.join(f.root,'trace');const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);await fs.rm(f.root,{recursive:true,force:true});});
 await server.start(f.root,{path:process.execPath,arguments:[path.resolve('test/fixtures/fake-graph-ablac.mjs'),mode,log]});
 server.notify('textDocument/didOpen',{textDocument:{uri:f.uri,languageId:'abla',version:1,text:f.text}});
 const params={textDocument:{uri:f.uri},position:{line:2,character:18}};
 const definition=await server.request('textDocument/definition',params);assert.equal(definition.error,undefined);assert.equal((definition.result as unknown[]).length,1);
 const hover=await server.request('textDocument/hover',params);assert.equal(hover.error,undefined);assert.match(JSON.stringify(hover.result),/compiler/);if(mode==='graph')assert.match(JSON.stringify(hover.result),/The answer to everything\./,'hover shows the declaration\'s documentation');
 const references=await server.request('textDocument/references',{...params,context:{includeDeclaration:false}});assert.equal(references.error,undefined);assert.equal((references.result as unknown[]).length,1);
 const before=await trace(log);
 if(mode==='graph'){
  assert.ok(before.some(m=>m.method==='query/definition'));assert.ok(before.some(m=>m.method==='query/hover'));assert.ok(before.some(m=>m.method==='query/references'));
  assert.ok(before.filter(m=>m.method==='analyze').every(m=>Array.isArray(m.params.fields)),'navigation forced an occurrence dump');
 }else assert.ok(!before.some(m=>m.method.startsWith('query/')));
 const rename=await server.request('textDocument/rename',{textDocument:{uri:f.uri},position:{line:1,character:5},newName:'renamed'});assert.equal(rename.error,undefined,JSON.stringify(rename.error));
 if(mode==='graph')assert.ok((await trace(log)).some(m=>m.method==='analyze'&&m.params.fields===undefined),'rename did not fetch complete occurrences');
 if(mode==='graph'){
  const pending='// café 😀\nval waiting = #42\nfun main: int = waiting\n';await fs.writeFile(f.file,pending);
  server.notify('textDocument/didChange',{textDocument:{uri:f.uri,version:2},contentChanges:[{text:pending}]});
  const rejected=await server.request('textDocument/rename',{textDocument:{uri:f.uri},position:{line:1,character:5},newName:'next'});assert.match(rejected.error?.message??'',/incomplete/);
 }
});
test('a compiler without graph analysis (the non-graph mode is gone, #832) is not used: graph-v2, then graph-v1, then syntax mode',{timeout:30000},async context=>{
 const f=await fixture();const log=path.join(f.root,'trace');const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);await fs.rm(f.root,{recursive:true,force:true});});
 const waiting=server.wait(m=>m.method==='window/logMessage'&&String((m.params as {message?:string})?.message).includes('continuing in syntax mode'));
 const reply=await server.request('initialize',{processId:null,rootUri:pathToFileURL(f.root).href,capabilities:{},initializationOptions:{compiler:{path:process.execPath,arguments:[path.resolve('test/fixtures/fake-graph-ablac.mjs'),'reject',log]}}});assert.equal(reply.error,undefined);server.notify('initialized',{});
 await waiting;
 const init=(await trace(log)).filter(m=>m.method==='initialize');assert.deepEqual(init.map(m=>m.params.analysisMode),['graph-v2','graph-v1']);
});
test('unrelated initialization errors are visible and never silently downgrade',{timeout:30000},async context=>{
 const f=await fixture();const log=path.join(f.root,'trace');const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);await fs.rm(f.root,{recursive:true,force:true});});
 const reply=await server.request('initialize',{rootUri:pathToFileURL(f.root).href,capabilities:{},initializationOptions:{compiler:{path:process.execPath,arguments:[path.resolve('test/fixtures/fake-graph-ablac.mjs'),'broken',log]}}});assert.equal(reply.error,undefined);server.notify('initialized',{});
 await server.wait(m=>m.method==='window/logMessage'&&String((m.params as {message?:string})?.message).includes('startup failure stays visible'));
 assert.deepEqual((await trace(log)).filter(m=>m.method==='initialize').map(m=>m.params.analysisMode),['graph-v2']);
});
const real=process.env.ABLA_COMPILER_GRAPH;

let documentationFields: Promise<ReadonlySet<string>> | undefined;
async function documentationFixture(context: TestContext, required: 'signature'|'documentation'|'parameters') {
 const f=await fixture();
 const signature='fun decorate(\n    /** The text to display, café 😀. */\n    text: string,\n    /** How many copies to display. */\n    count: int = 1\n): string';
 const text='import "abla/math"\nimport "other.ab" as other\n\n/** Decorate a display label. */\n'+signature+' = text\n\nfun main: int {\n    val label = decorate("comma,(", 2)\n    val otherLabel = other.decorate(3)\n    val rounded = roundEven(2.5)\n    label.size\n}\n';
 await fs.writeFile(f.file,text);
 await fs.writeFile(path.join(f.root,'other.ab'),'/** A different decoration. */\nfun decorate(\n    /** A numeric label. */\n    number: int\n): string = "other"\n');
 context.after(async()=>{await fs.rm(f.root,{recursive:true,force:true});});
 // Probe the compiler independently of the LSP: an LSP regression must not turn an assertion into a skip.
 documentationFields??=(async()=>{
  const compiler=new CompilerClient({executable:real??'ablac'});
  try{
   await compiler.start({workspaceRoots:[f.root],clientName:'documentation-feature-test',clientVersion:'0',analysisMode:'graph-v1',entryPoints:[f.file]});
   const snapshot=await compiler.analyze({fields:['symbols']});
   const symbol=snapshot.documents.find(doc=>doc.uri===f.uri)?.symbols.find(symbol=>symbol.name==='decorate');
   assert.ok(symbol,'compiler did not analyze the documentation fixture');
   return new Set(Object.keys(symbol));
  }finally{await compiler.stop();}
 })();
 if(!(await documentationFields).has(required)){
  context.skip('compiler does not export symbol.'+required);
  return undefined;
 }
 const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);});
 await server.start(f.root,{path:real??'ablac'});
 server.notify('textDocument/didOpen',{textDocument:{uri:f.uri,languageId:'abla',version:1,text}});
 const params=(offset:number)=>({textDocument:{uri:f.uri},position:new PositionMap(text).position(offset)});
 return {...f,text,signature,server,params};
}

test('real graph LSP documentation: hover preserves exact local and stdlib signatures',{
 skip:real===undefined?'set ABLA_COMPILER_GRAPH':false,timeout:60000,
},async context=>{
 const f=await documentationFixture(context,'signature');if(f===undefined)return;
 const local=await f.server.request('textDocument/hover',f.params(f.text.indexOf('decorate("')+2));
 assert.equal(local.error,undefined);
 const contents=(local.result as Hover).contents as {value:string};
 assert.ok(contents.value.includes('```abla\n'+f.signature+'\n```'),contents.value);
 assert.match(contents.value,/Decorate a display label\./);
 assert.doesNotMatch(contents.value,/A different decoration/);
 const standard=await f.server.request('textDocument/hover',f.params(f.text.indexOf('roundEven(')+2));
 assert.equal(standard.error,undefined);
 const markdown=((standard.result as Hover).contents as {value:string}).value;
 assert.match(markdown,/fun roundEven\(value: f64\): f64/);
 assert.match(markdown,/Round half to even/);
});

test('real graph LSP documentation: completion carries local and stdlib doc comments',{
 skip:real===undefined?'set ABLA_COMPILER_GRAPH':false,timeout:60000,
},async context=>{
 const f=await documentationFixture(context,'documentation');if(f===undefined)return;
 for(const [name,doc] of [['decorate','Decorate a display label.'],['roundEven','Round half to even']] as const){
  const reply=await f.server.request('textDocument/completion',f.params(f.text.indexOf(name+'(')+3));
  assert.equal(reply.error,undefined);
  const item=(reply.result as CompletionItem[]).find(item=>item.label===name);
  assert.ok(item,'missing completion '+name);
  assert.ok((JSON.stringify(item.documentation)??'').includes(doc),JSON.stringify(item));
  assert.ok(item.detail?.startsWith('fun '+name+'('),JSON.stringify(item));
  if(name==='roundEven')assert.equal((reply.result as CompletionItem[]).filter(item=>item.label===name).length,2,'both f32 and f64 overloads remain available');
 }
 const qualified=await f.server.request('textDocument/completion',f.params(f.text.indexOf('other.decorate(')+'other.dec'.length));
 assert.equal(qualified.error,undefined);
 const imported=(qualified.result as CompletionItem[]).find(item=>item.label==='decorate');
 assert.match(JSON.stringify(imported?.documentation)??'',/A different decoration/);
});

test('real graph LSP documentation: signature help uses call identity and parameter comments',{
 skip:real===undefined?'set ABLA_COMPILER_GRAPH':false,timeout:60000,
},async context=>{
 const f=await documentationFixture(context,'parameters');if(f===undefined)return;
 const reply=await f.server.request('textDocument/signatureHelp',f.params(f.text.indexOf('decorate("')+'decorate("comma,(", '.length));
 assert.equal(reply.error,undefined);
 const help=reply.result as SignatureHelp;
 assert.equal(help.activeParameter,1);
 assert.equal(help.signatures.length,1);
 const signature=help.signatures[0];
 assert.equal(signature?.label,f.signature);
 assert.match(JSON.stringify(signature?.documentation),/Decorate a display label/);
 assert.deepEqual(signature?.parameters?.map(p=>p.label),['text: string','count: int = 1']);
 assert.match(JSON.stringify(signature?.parameters?.[0]?.documentation),/The text to display, café 😀\./);
 assert.match(JSON.stringify(signature?.parameters?.[1]?.documentation),/How many copies to display\./);
 const other=await f.server.request('textDocument/signatureHelp',f.params(f.text.indexOf('other.decorate(3')+'other.decorate('.length));
 assert.equal(other.error,undefined);
 const imported=(other.result as SignatureHelp).signatures[0];
 assert.match(JSON.stringify(imported?.documentation),/A different decoration/);
 assert.match(JSON.stringify(imported?.parameters?.[0]?.documentation),/A numeric label/);
 assert.deepEqual(imported?.parameters?.map(p=>p.label),['number: int']);
 const standard=await f.server.request('textDocument/signatureHelp',f.params(f.text.indexOf('roundEven(')+'roundEven('.length));
 assert.equal(standard.error,undefined);
 const math=(standard.result as SignatureHelp).signatures[0];
 assert.equal(math?.label,'fun roundEven(value: f64): f64');
 assert.match(JSON.stringify(math?.documentation),/Round half to even/);
 assert.deepEqual(math?.parameters?.map(p=>p.label),['value: f64']);
});

test('real master compiler through LSP: graph queries and incomplete refactor refusal',{skip:real===undefined?'set ABLA_COMPILER_GRAPH':false,timeout:60000},async context=>{
 const f=await fixture();const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);await fs.rm(f.root,{recursive:true,force:true});});
 await server.start(f.root,{path:real??'ablac'});server.notify('textDocument/didOpen',{textDocument:{uri:f.uri,languageId:'abla',version:1,text:f.text}});
 const params={textDocument:{uri:f.uri},position:{line:2,character:18}};
 const definition=await server.request('textDocument/definition',params);assert.equal(definition.error,undefined);assert.equal((definition.result as Array<{uri:string}>)[0]?.uri,f.uri);
 const hover=await server.request('textDocument/hover',params);assert.equal(hover.error,undefined);assert.match(JSON.stringify(hover.result),/i64/);
 const refs=await server.request('textDocument/references',{...params,context:{includeDeclaration:false}});assert.equal(refs.error,undefined);assert.equal((refs.result as unknown[]).length,1);
 const rename=await server.request('textDocument/rename',{textDocument:{uri:f.uri},position:{line:1,character:5},newName:'renamed'});assert.equal(rename.error,undefined,JSON.stringify(rename.error));
 const pending='// café 😀\nval waiting = #42\nfun main: int = waiting\n';server.notify('textDocument/didChange',{textDocument:{uri:f.uri,version:2},contentChanges:[{text:pending}]});
 const rejected=await server.request('textDocument/rename',{textDocument:{uri:f.uri},position:{line:1,character:5},newName:'next'});assert.match(rejected.error?.message??'',/incomplete/);
});

test('real graph LSP keeps private identities and contract implementation opaque',{skip:real===undefined?'set ABLA_COMPILER_GRAPH':false,timeout:60000},async context=>{
 const f=await fixture();const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);await fs.rm(f.root,{recursive:true,force:true});});
 const files:Record<string,string>={
  'main.ab':'import "a.ab" as a\nimport "b.ab" as b\nimport contract "api.ab" as api\nfun main: int = a.exposed() + b.exposed()\n',
  'a.ab':'private fun hidden: int = 1\nfun exposed: int = hidden()\n',
  'b.ab':'private fun hidden: int = 2\nfun exposed: int = hidden()\n',
  'api.ab':'private fun implementation: int = missing()\nfun remote(value: int): int = implementation() + value\n',
 };
 await Promise.all(Object.entries(files).map(([name,text])=>fs.writeFile(path.join(f.root,name),text)));
 await fs.writeFile(path.join(f.root,'abla.toml'),'name = "lsp-test"\nentry = "main.ab"\nvisibility = "imports"\n');
 await server.start(f.root,{path:real??'ablac'});
 for(const name of ['a.ab','b.ab']){
  const uri=pathToFileURL(path.join(f.root,name)).href;
  server.notify('textDocument/didOpen',{textDocument:{uri,languageId:'abla',version:1,text:files[name]}});
  const reply=await server.request('textDocument/definition',{textDocument:{uri},position:{line:1,character:21}});
  assert.equal(reply.error,undefined);assert.equal((reply.result as Array<{uri:string}>)[0]?.uri,uri);
 }
 const api=pathToFileURL(path.join(f.root,'api.ab')).href;
 server.notify('textDocument/didOpen',{textDocument:{uri:api,languageId:'abla',version:1,text:files['api.ab']}});
 const hidden=await server.request('textDocument/definition',{textDocument:{uri:api},position:{line:1,character:34}});
 assert.equal(hidden.error,undefined);assert.deepEqual(hidden.result,[],'private contract body acquired guessed semantic identity');
 const invalid=files['main.ab']+'fun forbidden: int = hidden()\n';
 server.notify('textDocument/didOpen',{textDocument:{uri:f.uri,languageId:'abla',version:1,text:invalid}});
 const denied=await server.request('textDocument/definition',{textDocument:{uri:f.uri},position:{line:4,character:23}});
 assert.equal(denied.error,undefined);assert.deepEqual(denied.result,[]);
 await server.wait(m=>m.method==='textDocument/publishDiagnostics'&&JSON.stringify(m.params).includes('E_'));
});

test('real graph LSP switches projects without merging same-name declarations',{skip:real===undefined?'set ABLA_COMPILER_GRAPH':false,timeout:60000},async context=>{
 const a=await fixture();const b=await fixture();const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);await fs.rm(a.root,{recursive:true,force:true});await fs.rm(b.root,{recursive:true,force:true});});
 const init=await server.request('initialize',{workspaceFolders:[a,b].map(f=>({uri:pathToFileURL(f.root).href,name:path.basename(f.root)})),capabilities:{},initializationOptions:{compiler:{path:real}}});assert.equal(init.error,undefined);server.notify('initialized',{});
 await server.wait(m=>m.method==='window/logMessage'&&String((m.params as {message?:string})?.message).includes('connected to ablac'));
 for(const f of [a,b])server.notify('textDocument/didOpen',{textDocument:{uri:f.uri,languageId:'abla',version:1,text:f.text}});
 for(const f of [a,b,a]){
  const reply=await server.request('textDocument/definition',{textDocument:{uri:f.uri},position:{line:2,character:18}});
  assert.equal(reply.error,undefined);assert.equal((reply.result as Array<{uri:string}>)[0]?.uri,f.uri);
  const refs=await server.request('textDocument/references',{textDocument:{uri:f.uri},position:{line:2,character:18},context:{includeDeclaration:true}});
  assert.equal(refs.error,undefined);assert.ok((refs.result as Array<{uri:string}>).every(v=>v.uri===f.uri));
 }
});

test('real graph LSP cannot rename imported sources outside owned workspace, including symlinks', {
  skip: real === undefined ? 'set ABLA_COMPILER_GRAPH' : false, timeout: 60000,
}, async context => {
  const f = await fixture();
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'abla-lsp-external-'));
  const library = path.join(external, 'library.ab');
  await fs.writeFile(library, 'fun externalAnswer: int = 42\n');
  await fs.symlink(external, path.join(f.root, 'linked'));
  const server = new Server();
  context.after(async () => {
    await server.stop().catch(() => undefined);
    await fs.rm(f.root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  await server.start(f.root, { path: real ?? 'ablac' });
  for (const imported of [library, 'linked/library.ab']) {
    const text = `import "${imported}"\nfun main: int = externalAnswer()\n`;
    server.notify('textDocument/didOpen', { textDocument: { uri: f.uri, languageId: 'abla', version: imported === library ? 1 : 2, text } });
    const result = await server.request('textDocument/rename', {
      textDocument: { uri: f.uri }, position: { line: 1, character: 20 }, newName: 'renamed',
    });
    assert.match(result.error?.message ?? '', /read.only|outside.*workspace|symlink/i);
    assert.equal(await fs.readFile(library, 'utf8'), 'fun externalAnswer: int = 42\n');
  }
});
