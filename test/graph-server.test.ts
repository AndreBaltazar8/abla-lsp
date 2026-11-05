import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
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
for(const mode of ['ignore','reject','graph-no-queries','graph'])test(`LSP compiler negotiation and navigation: ${mode}`,{timeout:30000},async context=>{
 const f=await fixture();const log=path.join(f.root,'trace');const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);await fs.rm(f.root,{recursive:true,force:true});});
 await server.start(f.root,{path:process.execPath,arguments:[path.resolve('test/fixtures/fake-graph-ablac.mjs'),mode,log]});
 server.notify('textDocument/didOpen',{textDocument:{uri:f.uri,languageId:'abla',version:1,text:f.text}});
 const params={textDocument:{uri:f.uri},position:{line:2,character:18}};
 const definition=await server.request('textDocument/definition',params);assert.equal(definition.error,undefined);assert.equal((definition.result as unknown[]).length,1);
 const hover=await server.request('textDocument/hover',params);assert.equal(hover.error,undefined);assert.match(JSON.stringify(hover.result),/compiler/);
 const references=await server.request('textDocument/references',{...params,context:{includeDeclaration:false}});assert.equal(references.error,undefined);assert.equal((references.result as unknown[]).length,1);
 const before=await trace(log);
 if(mode==='graph'){
  assert.ok(before.some(m=>m.method==='query/definition'));assert.ok(before.some(m=>m.method==='query/hover'));assert.ok(before.some(m=>m.method==='query/references'));
  assert.ok(before.filter(m=>m.method==='analyze').every(m=>Array.isArray(m.params.fields)),'navigation forced an occurrence dump');
 }else assert.ok(!before.some(m=>m.method.startsWith('query/')));
 if(mode==='reject'){
  const init=before.filter(m=>m.method==='initialize');assert.equal(init[0]?.params.analysisMode,'graph-v1');assert.equal(init[1]?.params.analysisMode,undefined);assert.notEqual(init[0]?.pid,init[1]?.pid);
 }
 const rename=await server.request('textDocument/rename',{textDocument:{uri:f.uri},position:{line:1,character:5},newName:'renamed'});assert.equal(rename.error,undefined,JSON.stringify(rename.error));
 if(mode==='graph')assert.ok((await trace(log)).some(m=>m.method==='analyze'&&m.params.fields===undefined),'rename did not fetch complete occurrences');
 if(mode==='graph'){
  const pending='// café 😀\nval waiting = #42\nfun main: int = waiting\n';await fs.writeFile(f.file,pending);
  server.notify('textDocument/didChange',{textDocument:{uri:f.uri,version:2},contentChanges:[{text:pending}]});
  const rejected=await server.request('textDocument/rename',{textDocument:{uri:f.uri},position:{line:1,character:5},newName:'next'});assert.match(rejected.error?.message??'',/incomplete/);
 }
});
test('unrelated initialization errors are visible and never silently downgrade',{timeout:30000},async context=>{
 const f=await fixture();const log=path.join(f.root,'trace');const server=new Server();context.after(async()=>{await server.stop().catch(()=>undefined);await fs.rm(f.root,{recursive:true,force:true});});
 const reply=await server.request('initialize',{rootUri:pathToFileURL(f.root).href,capabilities:{},initializationOptions:{compiler:{path:process.execPath,arguments:[path.resolve('test/fixtures/fake-graph-ablac.mjs'),'broken',log]}}});assert.equal(reply.error,undefined);server.notify('initialized',{});
 await server.wait(m=>m.method==='window/logMessage'&&String((m.params as {message?:string})?.message).includes('startup failure stays visible'));
 assert.ok((await trace(log)).filter(m=>m.method==='initialize').every(m=>m.params.analysisMode==='graph-v1'));
});
const real=process.env.ABLA_COMPILER_GRAPH;
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
