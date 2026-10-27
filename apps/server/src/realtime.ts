// WebSocket fan-out for order and kitchen updates.
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerMessage } from '@common-table/contracts';
import { readStaffSessionCookie } from './auth.js';
import { kitchenSnapshot } from './core.js';

const HEARTBEAT_MS=30_000;
export const wss=new WebSocketServer({noServer:true});
// Sessions are checked at upgrade only, so remember each socket's role and expiry
// and drop sockets whose session has lapsed or whose peer stopped answering pings.
const sockets=new WeakMap<WebSocket,{role:string;expiresAt:number;alive:boolean}>();

function expired(client:WebSocket):boolean{
  const state=sockets.get(client);
  if(state&&state.expiresAt>Math.floor(Date.now()/1000))return false;
  client.terminate();
  return true;
}

export function publish(type:ServerMessage['type'],payload:ServerMessage['payload']){
  const message=JSON.stringify({type,payload} satisfies ServerMessage);
  let kitchenMessage:string|undefined;
  for(const client of wss.clients){
    if(client.readyState!==WebSocket.OPEN||expired(client))continue;
    if(sockets.get(client)?.role==='kitchen'){
      kitchenMessage??=JSON.stringify({type:'kitchen.snapshot',payload:kitchenSnapshot()} satisfies ServerMessage);
      client.send(kitchenMessage);
    }else client.send(message);
  }
}

export function attachRealtime(httpServer:Server){
  httpServer.on('upgrade',(request,socket,head)=>{
    const url=new URL(request.url??'/',`http://${request.headers.host??'localhost'}`);
    if(url.pathname!=='/socket'){socket.destroy();return;}
    const origin=request.headers.origin;
    if(origin){try{if(new URL(origin).host!==request.headers.host){socket.destroy();return;}}catch{socket.destroy();return;}}
    const session=readStaffSessionCookie(request.headers.cookie);
    if(!session){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    if(session.role==='viewer'){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(request,socket,head,webSocket=>{
      sockets.set(webSocket,{role:session.role,expiresAt:session.expiresAt,alive:true});
      webSocket.on('pong',()=>{const state=sockets.get(webSocket);if(state)state.alive=true;});
      wss.emit('connection',webSocket,request);
    });
  });
  wss.on('connection',webSocket=>{
    webSocket.send(JSON.stringify({type:'kitchen.snapshot',payload:kitchenSnapshot()} satisfies ServerMessage));
  });
  const heartbeat=setInterval(()=>{
    for(const client of wss.clients){
      const state=sockets.get(client);
      if(!state?.alive||expired(client)){client.terminate();continue;}
      state.alive=false;client.ping();
    }
  },HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close',()=>clearInterval(heartbeat));
}
