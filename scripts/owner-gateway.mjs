#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The owner argument belongs in a trusted SSH forced-command, never in client input.
export function route(owner,command='chat',tty=false){
  if(!['a','b'].includes(owner))throw new Error('Unknown fixed owner');
  let args;
  if(['chat','status','backup','export'].includes(command))args=[command];
  else if(command==='auth-chatgpt')args=['auth','chatgpt'];
  else if(command==='auth-codex')args=['auth','codex'];
  else if(/^(?:login|logout)(?: [a-z0-9-]{1,80})?$/.test(command))args=command.split(' ');
  else if(command==='auth-gmail')args=['rpc','mail.auth','{}'];
  else if(/^auth-key [a-z0-9-]{1,80}$/.test(command))args=['auth','key',command.slice(9)];
  else if(/^auth-secret (telegram\.token|openai\.mediaKey|openai\.embeddingKey|gmail\.clientSecret|brave\.searchKey|openai\.imageKey)$/.test(command))args=['auth','secret',command.slice(12)];
  else if(/^rpc [a-z][a-z0-9.-]{0,79}$/.test(command))args=['rpc',command.slice(4),'-'];
  else if(command==='restart')return ['restart',`pikobot-owner-${owner}`];
  else if(/^backup-fetch [0-9TZ.-]{20,40}-[a-f0-9-]{36}$/.test(command))return ['exec','-i',`pikobot-owner-${owner}`,'tar','-C',`/data/backups/${command.slice(13)}`,'-cf','-','.'];
  else throw new Error('Allowed: chat, status, rpc operation (JSON stdin), login provider, logout provider, auth-chatgpt, auth-codex, auth-gmail, auth-key provider, auth-secret name, backup, backup-fetch id, export, restart');
  return ['exec','-i',...(command==='chat'||tty&&/^(?:login(?: |$)|auth-(?:chatgpt|codex)$|auth-(?:key|secret) )/.test(command)?['-t']:[]),`pikobot-owner-${owner}`,'node','/app/dist/cli.js','--instance','/data',...args];
}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
  try{
    const command=process.env.SSH_ORIGINAL_COMMAND||'chat';
    if(command==='chat'&&!process.stdin.isTTY)throw new Error('Request a terminal with ssh -tt');
    const child=spawn('docker',route(process.argv[2],command,process.stdin.isTTY),{stdio:'inherit',env:{PATH:process.env.PATH,HOME:process.env.HOME,...(process.env.DOCKER_HOST?{DOCKER_HOST:process.env.DOCKER_HOST}:{})}});
    child.on('error',()=>{process.stderr.write('Owner gateway could not reach Docker\n');process.exitCode=1;});
    child.on('exit',(code)=>{process.exitCode=code??1;});
  }catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
