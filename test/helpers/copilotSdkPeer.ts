import fs from 'fs';
import path from 'path';
import type { CliProfile } from '../../src/types';

/** Executable RPC peer, reached through the official SDK and real process scope. */
export function writeCopilotSdkPeer(dir: string) {
  const command = path.join(dir, 'peer.js');
  const log = path.join(dir, 'peer.jsonl');
  const release = path.join(dir, 'release');
  fs.writeFileSync(command, `#!${process.execPath}
const fs = require('fs');
const net = require('net');
const rpc = require(${JSON.stringify(require.resolve('vscode-jsonrpc/node'))});
const log = ${JSON.stringify(log)};
const release = ${JSON.stringify(release)};
const record = value => fs.appendFileSync(log, JSON.stringify({pid:process.pid,...value})+'\\n');
record({method:'spawn'});
let serial = 0;
const checkpoint = { totalPremiumRequests:4,accountingSnapshot:{tokenDetails:{input:{tokenCount:110},output:{tokenCount:30},cache_read:{tokenCount:5},cache_write:{tokenCount:2}}}};
net.createServer(socket => {
 const connection = rpc.createMessageConnection(socket,socket);
 const emit = (sessionId,type,data={},agentId) => connection.sendNotification('session.event', {sessionId,event:{type,data,id:'event-'+(++serial),parentId:null,timestamp:new Date().toISOString(),...(agentId?{agentId}:{})}});
 connection.onRequest(async (method,params) => {
  record({method,params:method==='connect'?{tokenMatches:params.token===process.env.COPILOT_CONNECTION_TOKEN}:params});
  if(method==='connect') return {protocolVersion:3};
  if(method==='status.get') return {version:'fixture',protocolVersion:3};
  if(method==='session.create') {
   if(process.env.COPILOT_FIXTURE_OPEN==='hang') return new Promise(()=>{});
   return {sessionId:params.sessionId};
  }
  if(method==='session.resume') {
   if(params.sessionId==='denied') throw new rpc.ResponseError(-32603,'Model not authorized');
   if(process.env.COPILOT_FIXTURE_LEDGER==='resume-only') emit(params.sessionId,'session.usage_checkpoint',checkpoint);
   if(params.sessionId.startsWith('missing')) {
    if(params.sessionId==='missing-after-tool') emit(params.sessionId,'tool.execution_start',{toolCallId:'already-ran',toolName:'bash'},'child');
    emit(params.sessionId,'session.error',{message:'Session not found',errorType:'query'});
    throw new rpc.ResponseError(-32603,'Session not found');
   }
   return {sessionId:params.sessionId};
  }
  if(method==='session.send') {
   const id = params.sessionId;
   const prompt = params.prompt;
   if(prompt.includes('EARLY_IDLE')) emit(id,'session.idle');
   emit(id,'user.message',{content:prompt,messageId:'user-'+id,delivery:'idle'});
   emit(id,'assistant.turn_start',{turnId:'0'});
   if(prompt.includes('FAIL_AFTER_SEND')) {
    emit(id,'tool.execution_start',{toolCallId:'ran',toolName:'bash',arguments:{command:'synthetic'}},'child');
    emit(id,'session.error',{message:'Session not found',errorType:'query'});
    return {messageId:'user-'+id};
   }
   if(prompt.includes('EXIT')) {
    if(prompt.includes('ORPHAN')) {
     const child=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
     record({method:'orphan',child:child.pid});child.unref();
    }
    setImmediate(()=>process.exit(7));return {messageId:'user-'+id};
   }
   const finish = () => {
    emit(id,'assistant.message_delta',{messageId:'answer',deltaContent:'answer:'+prompt});
    emit(id,'assistant.message',{messageId:'answer',content:'answer:'+prompt});
    if(process.env.COPILOT_FIXTURE_LEDGER!=='resume-only') emit(id,'session.usage_checkpoint',process.env.COPILOT_FIXTURE_LEDGER==='new'?{totalNanoAiu:100}:checkpoint);
    emit(id,'assistant.turn_end',{turnId:'1'});
    emit(id,'session.idle');
   };
   if(prompt.includes('DEFERRED')) {
    emit(id,'tool.execution_start',{toolCallId:'shell',toolName:'bash',arguments:{description:'Background checkpoint'}});
    emit(id,'assistant.message',{messageId:'early',content:'before background completion;'});
    emit(id,'assistant.turn_end',{turnId:'0'});
    emit(id,'session.idle',{},'child');
    const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);finish();}},10);
   } else finish();
   if(prompt.includes('HANG_ACK')) return new Promise(()=>{});
   if(prompt.includes('EARLY_IDLE')) await new Promise(resolve=>setTimeout(resolve,100));
   record({method:'ack',sessionId:id});
   return {messageId:'user-'+id};
  }
  return {};
 });
 connection.listen();
}).listen(0,'127.0.0.1',function(){process.stdout.write('Listening on port '+this.address().port+'\\n');});
`, { mode: 0o755 });
  return { command, release, log,
    calls: (): Array<{ pid: number; method: string; params?: Record<string, unknown>; child?: number; sessionId?: string }> =>
      fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    profile: (env: Record<string, string> = {}): CliProfile => ({
      id: 'sdk-peer', name: 'SDK peer', harness: 'copilot', authMode: 'server-configured', command,
      env: { COPILOT_HOME: path.join(dir, 'home'), COPILOT_PROVIDER_BASE_URL: '', COPILOT_PROVIDER_API_KEY: '', COPILOT_MODEL: '', ...env }, createdAt: '', updatedAt: '',
    }),
  };
}

export async function waitForCopilotPeer(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!predicate()) throw new Error('Timed out waiting for Copilot RPC fixture');
}
