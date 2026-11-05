import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const mode=process.argv[2] ?? 'graph'; const trace=process.argv[3];
const documents=new Map(); let revision=0; let graph=false;
const write=(id,result)=>process.stdout.write(JSON.stringify({schema:1,id,result})+'\n');
const error=(id,code,message)=>process.stdout.write(JSON.stringify({schema:1,id,error:{code,message}})+'\n');
const bytes=(text,at)=>Buffer.byteLength(text.slice(0,at),'utf8');
function document(value) {
 const matches=[...value.text.matchAll(/\btarget\b/g)];const at=matches[0]?.index??-1;
 const id=value.uri+'#target';
 const symbol=at<0?undefined:{id,name:'target',kind:'function',uri:value.uri,range:{start:0,end:Buffer.byteLength(value.text)},selectionRange:{start:bytes(value.text,at),end:bytes(value.text,at+6)},detail:'fun int',topLevel:true};
 return {...value,symbols:symbol?[symbol]:[],occurrences:matches.map(m=>({name:'target',range:{start:bytes(value.text,m.index),end:bytes(value.text,m.index+6)},declarationId:id,type:'i64'})),diagnostics:[]};
}
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(trace)appendFileSync(trace,JSON.stringify({...request,pid:process.pid})+'\n');
 const {id,method,params}=request;if(method==='cancel')return;
 if(method==='initialize') {
  if(params.analysisMode && mode==='reject'){error(id,'unsupported_analysis_mode','old compiler');return;}
  if(params.analysisMode && mode==='broken'){error(id,'internal_error','startup failure stays visible');return;}
  graph=params.analysisMode==='graph-v1' && mode!=='ignore';
  write(id,{compilerVersion:'test',protocolVersion:1,capabilities:graph?['module-graph-analysis-v1','no-eval-ct','analysis-fields-v1',...(mode==='graph-no-queries'?[]:['analysis-queries-v1'])]:['declarations']});return;
 }
 if(method==='document/open'||method==='document/change'){documents.set(params.uri,{uri:params.uri,version:params.version,text:params.text});revision++;write(id,null);return;}
 if(method==='document/close'){documents.delete(params.uri);revision++;write(id,null);return;}
 const docs=[...documents.values()].map(document);
 const pending=docs.flatMap(d=>{const at=d.text.indexOf('#');return at<0?[]:[{code:'E_ANALYSIS_CT_REQUIRED',uri:d.uri,range:{start:bytes(d.text,at),end:bytes(d.text,at+3)},message:'compile-time evaluation was not performed'}];});
 if(method==='analyze') {
  const fields=graph?params.fields:undefined;
  const values=fields===undefined?docs:docs.map(d=>Object.fromEntries(Object.entries(d).filter(([k])=>['uri','version','text',...fields].includes(k))));
  write(id,{revision:String(revision),documents:values,...(graph?{analysisMode:'graph-v1',complete:pending.length===0,pending,entry:'main.ab',...(fields===undefined?{}:{fields})}:{})});return;
 }
 if(method.startsWith('query/')) {
  if(!graph||mode==='graph-no-queries'){error(id,'method_not_found','unsupported query');return;}
  if(params.revision!==String(revision)){error(id,'stale_revision','stale');return;}
  const doc=docs.find(d=>d.uri===params.uri);const occurrence=doc?.occurrences.find(o=>o.range.start<=params.offset&&params.offset<o.range.end);const symbol=occurrence?doc.symbols[0]:null;
  const value=method==='query/definition'?symbol:method==='query/hover'?(occurrence?{range:occurrence.range,type:'i64',symbol}:null):occurrence?doc.occurrences.map(o=>({uri:doc.uri,range:o.range})):[];
  write(id,{revision:String(revision),complete:pending.length===0,pending,value});return;
 }
 if(method==='refactor/validate'){write(id,{valid:true});return;}
 if(method==='shutdown'){write(id,null);process.exitCode=0;process.stdin.destroy();return;}
 error(id,'method_not_found','unsupported method');
});
