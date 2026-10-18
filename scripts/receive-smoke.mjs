// Live, receive-only smoke test. Credentials come from the private bridge config.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { config } from '../dist/config.js';
import { Bridge } from '../dist/bridge.js';

const cfg=config();
const marker=process.env.LARK_BRIDGE_TEST_MARKER ?? 'bridge-test';
const started=Date.now();
const bridge=new Bridge(cfg,{session_id:'receive-smoke-'+started,name:'Receive smoke test',harness:'test'});
let db;
let stopping=false;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stop=()=>{stopping=true;bridge.close();};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
try {
  await bridge.open();
  await bridge.call('token',{kind:'tenant'}); // Validate credentials without displaying the token.
  db=new DatabaseSync(join(cfg.stateDir,'bridge.sqlite'),{readOnly:true});
  let status;
  for(let i=0;i<30 && !stopping;i++) {
    status=await bridge.call('status');
    if(status.connection?.connected)break;
    await pause(1000);
  }
  console.log(JSON.stringify({stage:'ready',marker,tenant_auth:'ok',connection:status?.connection,pid:status?.pid}));
  let found=false;
  while(!stopping && Date.now()-started<600000) {
    const rows=db.prepare("SELECT id,chat,payload FROM events WHERE received>=? AND type='im.message.receive_v1' ORDER BY received").all(started);
    for(const row of rows) {
      const raw=JSON.parse(row.payload);
      let content=raw.event?.message?.content;
      try {content=JSON.parse(content);}catch{}
      const text=typeof content==='string'?content:content?.text;
      if(typeof text!=='string' || !text.includes(marker))continue;
      await bridge.call('route',{chat_id:row.chat,session_id:bridge.session.session_id});
      const events=await bridge.call('fetch',{limit:100});
      const event=events.find(e=>e.id===row.id);
      if(!event)continue;
      await bridge.call('ack',{id:event.id,receipt:event.receipt});
      const saved=db.prepare('SELECT acked FROM events WHERE id=?').get(event.id);
      console.log(JSON.stringify({stage:'received',event_id:event.id,chat_id:row.chat,message_id:raw.event?.message?.message_id,text,acknowledged:saved.acked===1}));
      found=true;break;
    }
    if(found)break;
    await pause(1000);
  }
  if(!found){console.log(JSON.stringify({stage:'timeout',marker}));process.exitCode=2;}
} catch(e) {
  console.error(JSON.stringify({stage:'error',message:e.message}));process.exitCode=1;
} finally {
  db?.close();bridge.close();
}
