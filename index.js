const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const fetch    = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const nacl     = require('tweetnacl');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use('/discord', express.raw({ type:'application/json' }));
app.use(express.json());

const BOT_TOKEN       = process.env.BOT_TOKEN;
const TG_CHAT_ID      = process.env.CHAT_ID;
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL;
const DISCORD_APP_ID  = process.env.DISCORD_APP_ID;
const DISCORD_PUB_KEY = process.env.DISCORD_PUBLIC_KEY;
const DATABASE_URL    = process.env.DATABASE_URL;
const PORT            = process.env.PORT || 3000;

const db = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

async function dbInit() {
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS member_channels (
      user_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
      username TEXT, registered_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database ready ✅');
}

let tasks = [];
let memberChannels = {};
let pendingAdd = null;
const chaosMap = {};

async function loadTasks() {
  if (!db) return;
  const r = await db.query('SELECT data FROM tasks ORDER BY created_at ASC');
  tasks = r.rows.map(row => row.data);
  console.log(`Loaded ${tasks.length} tasks`);
}
async function saveTask(t) {
  if (!db) return;
  await db.query(`INSERT INTO tasks (id,data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=$2,updated_at=NOW()`, [t.id, JSON.stringify(t)]);
}
async function deleteTaskDb(id) {
  if (!db) return;
  await db.query('DELETE FROM tasks WHERE id=$1', [id]);
}
async function loadMemberChannels() {
  if (!db) return;
  const r = await db.query('SELECT * FROM member_channels');
  memberChannels = {};
  for (const row of r.rows) memberChannels[row.user_id] = { channelId: row.channel_id, username: row.username };
  console.log(`Loaded ${Object.keys(memberChannels).length} member channels`);
}
async function saveMemberChannel(userId, channelId, username) {
  memberChannels[userId] = { channelId, username };
  if (!db) return;
  await db.query(`INSERT INTO member_channels (user_id,channel_id,username) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET channel_id=$2,username=$3`, [userId, channelId, username]);
}
async function deleteMemberChannel(userId) {
  delete memberChannels[userId];
  if (!db) return;
  await db.query('DELETE FROM member_channels WHERE user_id=$1', [userId]);
}

function genId() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function pad(n)  { return String(n).padStart(2,'0'); }
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function daysUntil(iso) {
  if (!iso) return null;
  const today=new Date(); today.setHours(0,0,0,0);
  return Math.round((new Date(iso+'T00:00:00')-today)/86400000);
}
function urgencyEmoji(u) { return u==='defcon'?'🔴':u==='urgent'?'🟡':'🟢'; }
function parseDate(input) {
  const s=input.trim().toLowerCase();
  const base=new Date(); base.setHours(0,0,0,0);
  if(s==='today') return base.toISOString().slice(0,10);
  if(s==='tomorrow'){base.setDate(base.getDate()+1);return base.toISOString().slice(0,10);}
  if(/^\+\d+$/.test(s)){base.setDate(base.getDate()+parseInt(s.slice(1)));return base.toISOString().slice(0,10);}
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p=new Date(input); if(!isNaN(p)) return p.toISOString().slice(0,10);
  return null;
}
function isBlocked(t) {
  if (!t.dependsOn?.length) return false;
  return t.dependsOn.some(id => { const d=tasks.find(x=>x.id===id); return d&&!d.done; });
}
function taskLine(t, i) {
  const done=t.done?'✅':'⬜', urg=urgencyEmoji(t.urgency||'normal');
  const due=t.due?` · due ${fmtDate(t.due)}`:'';
  const who=t.assigneeName?` · ${t.assigneeName}`:'';
  const blk=isBlocked(t)?' · 🔒':'';
  const st=t.status&&t.status!=='todo'?` · _${t.status}_`:'';
  return `${i!==undefined?i+1+'. ':''}${done} ${urg} **${t.name}**${due}${who}${blk}${st}`;
}

const URGENCY = {
  normal: { label:'🟢 Normal', color:3066993, escalation:[
    {after:0,  msg:n=>`🔔 Just a heads up — **"${n}"** is waiting for you.`},
    {after:2,  msg:n=>`🔔 Hey. **"${n}"** is still sitting there. Untouched.`},
    {after:5,  msg:n=>`😤 Still nothing on **"${n}"**? Come on now.`},
    {after:10, msg:n=>`🚨 **"${n}"** has been ignored too many times. Do it. NOW.`},
  ]},
  urgent: { label:'🟡 Urgent', color:16776960, escalation:[
    {after:0, msg:n=>`⚡ **URGENT: "${n}"** needs your attention NOW.`},
    {after:2, msg:n=>`🚨 **STILL URGENT: "${n}"** — why is this not done yet?`},
    {after:4, msg:n=>`😡 **"${n}"** IS URGENT AND YOU KEEP IGNORING IT.`},
    {after:7, msg:n=>`🔥🔥 **"${n}"** — at what point does urgent mean urgent to you??`},
  ]},
  defcon: { label:'🔴 DROP EVERYTHING', color:15158332, escalation:[
    {after:0, msg:n=>`🚨🚨 **DROP EVERYTHING: "${n}"** — stop what you're doing. Right now.`},
    {after:1, msg:n=>`💀 **"${n}"** — whatever you're doing is less important. STOP. DO THIS.`},
    {after:2, msg:n=>`☢️ **DEFCON 1: "${n}"** is on fire. Everything is on fire. FIX IT.`},
    {after:3, msg:n=>`🆘🆘 **"${n}"** — I have run out of ways to tell you. PLEASE.`},
  ]}
};

const DUE_WARNINGS = {
  week:    (n,d)=>`📅 **1 week to go:** **"${n}"** is due ${d}.`,
  days3:   (n,d)=>`📅 **3 days left:** **"${n}"** is due ${d}. Start wrapping up.`,
  day1:    (n,d)=>`⚠️ **Due TOMORROW:** **"${n}"** is due ${d}. Get it done.`,
  today:   (n)  =>`🚨 **DUE TODAY: "${n}"** — needs to be done before end of day.`,
  overdue: (n,d)=>`🔥 **OVERDUE: "${n}"** was due ${d}. Get it done NOW.`,
};

const TEMPLATES = {
  onboarding:     { name:'Client Onboarding',      tasks:[{name:'Kickoff call scheduled',urgency:'urgent',nagInterval:60},{name:'Requirements document shared',urgency:'urgent',nagInterval:60},{name:'Access credentials provided',urgency:'normal',nagInterval:120},{name:'Initial setup completed',urgency:'urgent',nagInterval:60},{name:'UAT sign-off obtained',urgency:'defcon',nagInterval:30},{name:'Go-live checklist reviewed',urgency:'defcon',nagInterval:30},{name:'Post go-live support scheduled',urgency:'normal',nagInterval:120}]},
  implementation: { name:'Implementation Sprint',  tasks:[{name:'Sprint planning complete',urgency:'urgent',nagInterval:60},{name:'Dev environment set up',urgency:'normal',nagInterval:120},{name:'Core feature development',urgency:'urgent',nagInterval:60},{name:'Integration testing done',urgency:'urgent',nagInterval:30},{name:'Client review session',urgency:'defcon',nagInterval:30},{name:'Bug fixes resolved',urgency:'urgent',nagInterval:30},{name:'Deployment approved',urgency:'defcon',nagInterval:15}]},
  weekly_review:  { name:'Weekly Review',           tasks:[{name:'Team status updates collected',urgency:'normal',nagInterval:120},{name:'Blockers identified and logged',urgency:'urgent',nagInterval:60},{name:'Next week priorities set',urgency:'normal',nagInterval:120},{name:'Client update sent',urgency:'urgent',nagInterval:60}]},
};

// ── DISCORD HELPERS ───────────────────────────────────────────────────────────
function verifyDiscord(req) {
  if (!DISCORD_PUB_KEY) return true;
  const sig=req.headers['x-signature-ed25519'], ts=req.headers['x-signature-timestamp'];
  if (!sig||!ts) return false;
  try {
    const body=Buffer.isBuffer(req.body)?req.body:Buffer.from(JSON.stringify(req.body));
    return nacl.sign.detached.verify(Buffer.from(ts+body.toString()),Buffer.from(sig,'hex'),Buffer.from(DISCORD_PUB_KEY,'hex'));
  } catch(e){ return false; }
}
async function dReq(method, path, body) {
  if (!DISCORD_TOKEN) return null;
  const r=await fetch(`https://discord.com/api/v10${path}`,{method,headers:{'Authorization':`Bot ${DISCORD_TOKEN}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).catch(console.error);
  return r?r.json().catch(()=>null):null;
}
async function sendDiscord(content, embeds, components) {
  if (!DISCORD_CHANNEL) return null;
  const b={};
  if(content) b.content=content;
  if(embeds)  b.embeds=embeds;
  if(components) b.components=components;
  return dReq('POST',`/channels/${DISCORD_CHANNEL}/messages`,b);
}
async function editDiscordMsg(msgId, content, embeds, components) {
  if (!DISCORD_CHANNEL) return;
  const b={};
  if(content!==undefined)    b.content=content;
  if(embeds!==undefined)     b.embeds=embeds;
  if(components!==undefined) b.components=components;
  return dReq('PATCH',`/channels/${DISCORD_CHANNEL}/messages/${msgId}`,b);
}
async function sendDM(userId, content, embeds) {
  if (!DISCORD_TOKEN||!userId) return;
  const dm=await dReq('POST','/users/@me/channels',{recipient_id:userId});
  if (!dm?.id) return;
  const b={};
  if(content) b.content=content;
  if(embeds)  b.embeds=embeds;
  return dReq('POST',`/channels/${dm.id}/messages`,b);
}
async function sendToMember(userId, content, embeds, components) {
  const mc=memberChannels[userId];
  if (mc?.channelId) {
    const b={};
    if(content)    b.content=content;
    if(embeds)     b.embeds=embeds;
    if(components) b.components=components;
    return dReq('POST',`/channels/${mc.channelId}/messages`,b);
  }
  return sendDM(userId, content, embeds);
}
async function broadcast(content, embeds) {
  await sendDiscord(content, embeds);
  const seen=new Set([DISCORD_CHANNEL]);
  for (const {channelId} of Object.values(memberChannels)) {
    if (!seen.has(channelId)) {
      seen.add(channelId);
      const b={};
      if(content) b.content=content;
      if(embeds)  b.embeds=embeds;
      await dReq('POST',`/channels/${channelId}/messages`,b).catch(()=>{});
    }
  }
}
async function editInteractionReply(token, data) {
  return fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).catch(console.error);
}
async function moveToVoice(guildId, userId, channelId) {
  return dReq('PATCH',`/guilds/${guildId}/members/${userId}`,{channel_id:channelId});
}
async function getOrCreateVoiceChannel(guildId) {
  const channels=await dReq('GET',`/guilds/${guildId}/channels`);
  if (channels) { const ex=channels.find(c=>c.name==='🚨-get-in-here'&&c.type===2); if(ex) return ex.id; }
  const c=await dReq('POST',`/guilds/${guildId}/channels`,{name:'🚨-get-in-here',type:2,bitrate:64000});
  return c?.id;
}

async function registerCommands() {
  if (!DISCORD_TOKEN||!DISCORD_APP_ID) return;
  const commands=[
    {name:'add',        description:'Add a new task',                  options:[{name:'task',type:3,description:'Task name',required:true}]},
    {name:'assign',     description:'Assign a task to someone',         options:[{name:'task',type:3,description:'Task name',required:true},{name:'member',type:6,description:'Who to assign',required:true}]},
    {name:'list',       description:'Show all tasks'},
    {name:'pending',    description:'Show pending tasks only'},
    {name:'mywork',     description:'Show tasks assigned to you'},
    {name:'done',       description:'Mark a task done',                 options:[{name:'number',type:4,description:'Task number',required:true}]},
    {name:'delete',     description:'Delete a task',                    options:[{name:'number',type:4,description:'Task number',required:true}]},
    {name:'snooze',     description:'Snooze a task',                    options:[{name:'number',type:4,description:'Task number',required:true},{name:'reason',type:3,description:'Why?',required:false}]},
    {name:'progress',   description:'Update task progress',             options:[{name:'number',type:4,description:'Task number',required:true},{name:'update',type:3,description:'Status update',required:true}]},
    {name:'comment',    description:'Add a comment to a task',          options:[{name:'number',type:4,description:'Task number',required:true},{name:'message',type:3,description:'Comment',required:true}]},
    {name:'setdue',     description:'Change a task due date',           options:[{name:'number',type:4,description:'Task number',required:true},{name:'date',type:3,description:'e.g. tomorrow, +7, 2026-05-01',required:true}]},
    {name:'escalation', description:'Set auto-escalation thresholds',   options:[{name:'number',type:4,description:'Task number',required:true},{name:'days_urgent',type:4,description:'Days before due → Urgent',required:false},{name:'days_defcon',type:4,description:'Days before due → DROP EVERYTHING',required:false},{name:'nag_urgent',type:4,description:'Nag interval (min) when Urgent',required:false},{name:'nag_defcon',type:4,description:'Nag interval (min) when DROP EVERYTHING',required:false}]},
    {name:'depend',     description:'Set task dependency',              options:[{name:'task',type:4,description:'Blocked task number',required:true},{name:'blocks',type:4,description:'Depends on task number',required:true}]},
    {name:'recurring',  description:'Set task recurrence',              options:[{name:'number',type:4,description:'Task number',required:true},{name:'frequency',type:3,description:'daily/weekly/monthly',required:true,choices:[{name:'Daily',value:'daily'},{name:'Weekly',value:'weekly'},{name:'Monthly',value:'monthly'}]}]},
    {name:'template',   description:'Create tasks from template',       options:[{name:'type',type:3,description:'Template',required:true,choices:[{name:'Client Onboarding',value:'onboarding'},{name:'Implementation Sprint',value:'implementation'},{name:'Weekly Review',value:'weekly_review'}]}]},
    {name:'leaderboard',description:'See team stats'},
    {name:'summary',    description:'Get task summary'},
    {name:'register',   description:'Register this as your personal task channel'},
    {name:'unregister', description:'Remove your channel registration'},
    {name:'team',       description:'Show registered team members'},
  ];
  await dReq('PUT',`/applications/${DISCORD_APP_ID}/commands`,commands);
  console.log('Commands registered ✅');
}

// ── KEYBOARDS ─────────────────────────────────────────────────────────────────
function urgencyRow()  { return [{type:1,components:[{type:2,style:3,label:'🟢 Normal',custom_id:'urg_normal'},{type:2,style:1,label:'🟡 Urgent',custom_id:'urg_urgent'},{type:2,style:4,label:'🔴 DROP EVERYTHING',custom_id:'urg_defcon'}]}]; }
function nagRow()      { return [{type:1,components:[{type:2,style:2,label:'Every 15 min',custom_id:'nag_15'},{type:2,style:2,label:'Every 30 min',custom_id:'nag_30'},{type:2,style:2,label:'Every hour',custom_id:'nag_60'},{type:2,style:2,label:'Every 2 hrs',custom_id:'nag_120'}]},{type:1,components:[{type:2,style:2,label:'No auto-nag',custom_id:'nag_0'}]}]; }
function dueDateRow()  { return [{type:1,components:[{type:2,style:2,label:'Today',custom_id:'due_0'},{type:2,style:2,label:'Tomorrow',custom_id:'due_1'},{type:2,style:2,label:'3 days',custom_id:'due_3'},{type:2,style:2,label:'1 week',custom_id:'due_7'}]},{type:1,components:[{type:2,style:2,label:'2 weeks',custom_id:'due_14'},{type:2,style:2,label:'1 month',custom_id:'due_30'},{type:2,style:1,label:'No due date',custom_id:'due_none'}]}]; }
function moveTaskRow(tid) { return [{type:1,components:[{type:2,style:2,label:'Move to tomorrow',custom_id:`mv_${tid}_1`},{type:2,style:2,label:'Move to next week',custom_id:`mv_${tid}_7`},{type:2,style:2,label:'+2 weeks',custom_id:`mv_${tid}_14`},{type:2,style:2,label:'+1 month',custom_id:`mv_${tid}_30`}]},{type:1,components:[{type:2,style:1,label:'🌙 Stop today — resume 9AM tomorrow',custom_id:`mv_${tid}_pause`},{type:2,style:4,label:'Remove due date',custom_id:`mv_${tid}_none`}]}]; }
function statusRow(tid)   { return [{type:1,components:[{type:2,style:2,label:'⏳ Waiting for client',custom_id:`st_${tid}_client`},{type:2,style:2,label:'🔒 Blocked internally',custom_id:`st_${tid}_blocked`},{type:2,style:1,label:'🔄 In progress',custom_id:`st_${tid}_wip`},{type:2,style:4,label:'⬆️ Escalate',custom_id:`st_${tid}_escalate`}]}]; }
function recurringRow(tid){ return [{type:1,components:[{type:2,style:2,label:'🔁 Daily',custom_id:`rec_${tid}_daily`},{type:2,style:2,label:'🔁 Weekly',custom_id:`rec_${tid}_weekly`},{type:2,style:2,label:'🔁 Monthly',custom_id:`rec_${tid}_monthly`},{type:2,style:4,label:'✖ One-time',custom_id:`rec_${tid}_none`}]}]; }
function afterDoneRow(tid){ return [{type:1,components:[{type:2,style:2,label:'🔁 Daily',custom_id:`afd_${tid}_daily`},{type:2,style:2,label:'🔁 Weekly',custom_id:`afd_${tid}_weekly`},{type:2,style:2,label:'🔁 Monthly',custom_id:`afd_${tid}_monthly`},{type:2,style:1,label:'✖ No, one-time',custom_id:`afd_${tid}_none`}]}]; }
function taskActionRow(tid, assigneeId) {
  const rows=[{type:1,components:[
    {type:2,style:3,label:'✅ Done',       custom_id:`act_done_${tid}`},
    {type:2,style:2,label:'📅 Move task',  custom_id:`act_move_${tid}`},
    {type:2,style:2,label:'💬 Status',     custom_id:`act_status_${tid}`},
    {type:2,style:2,label:'🔄 Recurring',  custom_id:`act_recur_${tid}`},
    {type:2,style:4,label:'🗑 Delete',     custom_id:`act_delete_${tid}`},
  ]}];
  if (assigneeId) rows.push({type:1,components:[{type:2,style:4,label:'☎️ CALL THEM',custom_id:`act_call_${tid}`}]});
  return rows;
}

// ── CHAOS CALL ────────────────────────────────────────────────────────────────
async function triggerChaosCall(task, guildId, callerName) {
  const aid=task.assigneeId; if(!aid) return;
  const dl=task.due?daysUntil(task.due):null;
  const ovr=dl!==null&&dl<0?` This was due ${Math.abs(dl)} day${Math.abs(dl)===1?'':'s'} ago.`:'';
  await sendToMember(aid,null,[{title:'☎️ INCOMING CALL FROM YOUR LEAD',description:`**${callerName||'Your lead'}** is calling you out.\n\n> **"${task.name}"** has not been completed.${ovr}\n\nGet in the **#🚨-get-in-here** voice channel NOW.`,color:15158332,timestamp:new Date().toISOString()}]);
  await sendDiscord(`🚨 <@${aid}> 🚨 <@${aid}> 🚨 <@${aid}>`, [{title:'☎️ INCOMING CALL — GET IN THE VOICE CHANNEL',description:`**<@${aid}>** — **${callerName}** is calling you about:\n\n> **${task.name}**${ovr}\n\n**GET. IN. THE. VOICE. CHANNEL. NOW.**`,color:15158332,timestamp:new Date().toISOString()}]);
  if (guildId) { const vcId=await getOrCreateVoiceChannel(guildId); if(vcId) await moveToVoice(guildId,aid,vcId); }
  let count=0;
  if (chaosMap[task.id]) clearInterval(chaosMap[task.id].interval);
  chaosMap[task.id]={interval:setInterval(async()=>{
    count++;
    const cur=tasks.find(t=>t.id===task.id);
    if(!cur||cur.done||count>=3){
      clearInterval(chaosMap[task.id]?.interval); delete chaosMap[task.id];
      if(cur?.done) await sendDiscord(`✅ <@${aid}> responded — **${task.name}** is done. Crisis averted. 😤`);
      else if(count>=3) await sendDiscord(`🆘 <@${aid}> still hasn't responded. **${task.name}** remains undone.`);
      return;
    }
    await sendDiscord(`🔔 <@${aid}> — ping ${count+1}/3. **${task.name}** is still waiting.`);
  },30000)};
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function tgReq(method, body) {
  if (!BOT_TOKEN) return null;
  const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(console.error);
  return r?r.json().catch(()=>null):null;
}
async function sendTelegram(text, extra={}) {
  if (!TG_CHAT_ID) return;
  return tgReq('sendMessage',{chat_id:TG_CHAT_ID,text,parse_mode:'HTML',...extra});
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/',            (_,res)=>res.json({status:'Taskmaster running 🔥'}));
app.get('/tasks',       (_,res)=>res.json(tasks));
app.put('/tasks',       async(req,res)=>{tasks=req.body||[];if(db){for(const t of tasks)await saveTask(t);}res.json({ok:true,count:tasks.length});});
app.post('/tasks',      async(req,res)=>{const t={id:genId(),done:false,urgency:'normal',nagInterval:60,nagCount:0,snoozedUntil:null,dueFiredDays:[],assigneeId:null,assigneeName:null,status:'todo',comments:[],dependsOn:[],recurring:null,escalationRules:null,escalationFired:{},completedAt:null,created:new Date().toISOString(),...req.body};tasks.push(t);await saveTask(t);res.json(t);});
app.patch('/tasks/:id', async(req,res)=>{const i=tasks.findIndex(t=>t.id===req.params.id);if(i<0)return res.status(404).json({error:'not found'});tasks[i]={...tasks[i],...req.body};await saveTask(tasks[i]);res.json(tasks[i]);});
app.delete('/tasks/:id',async(req,res)=>{tasks=tasks.filter(t=>t.id!==req.params.id);await deleteTaskDb(req.params.id);res.json({ok:true});});

// ── DISCORD ───────────────────────────────────────────────────────────────────
app.post('/discord', async(req,res)=>{
  if (!verifyDiscord(req)) return res.status(401).send('Invalid signature');
  const body=Buffer.isBuffer(req.body)?JSON.parse(req.body.toString()):req.body;
  if (!body) return res.sendStatus(400);
  if (body.type===1) return res.json({type:1});

  // Slash commands
  if (body.type===2) {
    res.json({type:5});
    const cmd=body.data.name, token=body.token;
    const opts={}; (body.data.options||[]).forEach(o=>{opts[o.name]=o.value;});
    const invoker=body.member?.user?.username||'Someone';
    const invokerId=body.member?.user?.id;
    const guildId=body.guild_id;

    if (cmd==='add') { pendingAdd={name:opts.task,token,guildId}; await editInteractionReply(token,{content:`➕ **Adding:** ${opts.task}\n\n**How urgent is this?**`,components:urgencyRow()}); return; }
    if (cmd==='assign') {
      const member=body.data.resolved?.users?.[opts.member];
      pendingAdd={name:opts.task,token,guildId,assigneeId:opts.member,assigneeName:member?.username||'Someone'};
      await editInteractionReply(token,{content:`➕ **Assigning to ${pendingAdd.assigneeName}:** ${opts.task}\n\n**How urgent is this?**`,components:urgencyRow()});
      return;
    }
    if (cmd==='list') {
      if(!tasks.length){await editInteractionReply(token,{content:'No tasks yet!'});return;}
      await editInteractionReply(token,{embeds:[{title:`📋 All tasks (${tasks.length})`,description:tasks.map((t,i)=>taskLine(t,i)).join('\n'),color:5793266,timestamp:new Date().toISOString()}]});
      return;
    }
    if (cmd==='pending') {
      const p=tasks.filter(t=>!t.done);
      if(!p.length){await editInteractionReply(token,{content:'🎉 No pending tasks!'});return;}
      await editInteractionReply(token,{embeds:[{title:`📋 Pending (${p.length})`,description:p.map((t,i)=>taskLine(t,i)).join('\n'),color:16776960,timestamp:new Date().toISOString()}]});
      return;
    }
    if (cmd==='mywork') {
      const mine=tasks.filter(t=>!t.done&&t.assigneeId===invokerId);
      if(!mine.length){await editInteractionReply(token,{content:'🎉 No tasks assigned to you!'});return;}
      await editInteractionReply(token,{embeds:[{title:`📋 Your tasks (${mine.length})`,description:mine.map((t,i)=>taskLine(t,i)).join('\n'),color:5793266,timestamp:new Date().toISOString()}]});
      return;
    }
    if (cmd==='done') {
      const n=(opts.number||1)-1, pool=tasks.filter(t=>!t.done);
      if(n<0||n>=pool.length){await editInteractionReply(token,{content:'Invalid number. Use /pending to see the list.'});return;}
      pool[n].done=true; pool[n].nagCount=0; pool[n].status='done'; pool[n].completedAt=new Date().toISOString();
      if(chaosMap[pool[n].id]){clearInterval(chaosMap[pool[n].id].interval);delete chaosMap[pool[n].id];}
      const unblocked=tasks.filter(x=>!x.done&&x.dependsOn?.includes(pool[n].id)&&!isBlocked(x));
      await saveTask(pool[n]);
      await editInteractionReply(token,{embeds:[{title:`✅ Done: ${pool[n].name}`,description:'Nice work! 💪',color:3066993,timestamp:new Date().toISOString()}]});
      if(unblocked.length) await sendDiscord(null,[{title:'🔓 Tasks unblocked!',description:unblocked.map(x=>`• **${x.name}**`).join('\n'),color:3066993,timestamp:new Date().toISOString()}]);
      await sendTelegram(`✅ Done: <b>${pool[n].name}</b> 💪`);
      return;
    }
    if (cmd==='delete') {
      const n=(opts.number||1)-1;
      if(n<0||n>=tasks.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      const removed=tasks.splice(n,1)[0];
      removed.recurring=null;
      await deleteTaskDb(removed.id);
      await editInteractionReply(token,{content:`🗑 Removed: **${removed.name}**`});
      return;
    }
    if (cmd==='snooze') {
      const n=(opts.number||1)-1, pool=tasks.filter(t=>!t.done);
      if(n<0||n>=pool.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      const reason=opts.reason||'No reason given';
      pool[n].snoozedUntil=new Date(Date.now()+30*60*1000).toISOString();
      pool[n].snoozeReason=reason;
      pool[n].comments=pool[n].comments||[];
      pool[n].comments.push({by:invoker,text:`Snoozed: ${reason}`,at:new Date().toISOString()});
      await saveTask(pool[n]);
      await editInteractionReply(token,{content:`⏸ Snoozed 30 min: **${pool[n].name}**\nReason: ${reason}`});
      return;
    }
    if (cmd==='progress') {
      const n=(opts.number||1)-1, pool=tasks.filter(t=>!t.done);
      if(n<0||n>=pool.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      pool[n].status='inprogress';
      pool[n].comments=pool[n].comments||[];
      pool[n].comments.push({by:invoker,text:`📊 ${opts.update}`,at:new Date().toISOString()});
      if(chaosMap[pool[n].id]){clearInterval(chaosMap[pool[n].id].interval);delete chaosMap[pool[n].id];}
      await saveTask(pool[n]);
      await editInteractionReply(token,{embeds:[{title:`📊 Progress: ${pool[n].name}`,description:`**${invoker}:** ${opts.update}`,color:5793266,timestamp:new Date().toISOString()}]});
      await sendDiscord(null,[{title:`📊 Progress: ${pool[n].name}`,description:`**${invoker}:** ${opts.update}`,color:5793266,timestamp:new Date().toISOString()}]);
      await sendTelegram(`📊 Progress on <b>${pool[n].name}</b>: ${opts.update}`);
      return;
    }
    if (cmd==='comment') {
      const n=(opts.number||1)-1;
      if(n<0||n>=tasks.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      tasks[n].comments=tasks[n].comments||[];
      tasks[n].comments.push({by:invoker,text:opts.message,at:new Date().toISOString()});
      await saveTask(tasks[n]);
      await editInteractionReply(token,{embeds:[{title:`💬 Comment on: ${tasks[n].name}`,description:`**${invoker}:** ${opts.message}`,color:5793266,timestamp:new Date().toISOString()}]});
      if(tasks[n].assigneeId&&tasks[n].assigneeId!==invokerId) await sendToMember(tasks[n].assigneeId,null,[{title:`💬 New comment: ${tasks[n].name}`,description:`**${invoker}:** ${opts.message}`,color:5793266,timestamp:new Date().toISOString()}]);
      return;
    }
    if (cmd==='setdue') {
      const n=(opts.number||1)-1;
      if(n<0||n>=tasks.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      const newDate=parseDate(opts.date||'');
      if(!newDate){await editInteractionReply(token,{content:"Couldn't parse that date. Try: `2026-05-01`, `tomorrow`, `+7`"});return;}
      const t=tasks[n]; const old=t.due; t.due=newDate; t.dueFiredDays=[];
      await saveTask(t);
      await editInteractionReply(token,{embeds:[{title:`📅 Due date updated: ${t.name}`,description:`${old?`~~${fmtDate(old)}~~ → `:''}**${fmtDate(newDate)}**`,color:5793266,timestamp:new Date().toISOString()}],components:taskActionRow(t.id,t.assigneeId)});
      if(t.assigneeId) await sendToMember(t.assigneeId,null,[{title:`📅 Due date changed: ${t.name}`,description:`New due date: **${fmtDate(newDate)}**`,color:5793266}]);
      return;
    }
    if (cmd==='escalation') {
      const n=(opts.number||1)-1;
      if(n<0||n>=tasks.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      const t=tasks[n];
      t.escalationRules={daysUrgent:opts.days_urgent??t.escalationRules?.daysUrgent??3,daysDefcon:opts.days_defcon??t.escalationRules?.daysDefcon??1,nagUrgent:opts.nag_urgent??t.escalationRules?.nagUrgent??30,nagDefcon:opts.nag_defcon??t.escalationRules?.nagDefcon??15};
      t.escalationFired={};
      await saveTask(t);
      const r=t.escalationRules;
      await editInteractionReply(token,{embeds:[{title:`⚙️ Escalation set: ${t.name}`,color:5793266,fields:[{name:'→ 🟡 Urgent',value:`${r.daysUrgent} days before due · nag every ${r.nagUrgent}min`,inline:false},{name:'→ 🔴 DROP EVERYTHING',value:`${r.daysDefcon} day before due · nag every ${r.nagDefcon}min`,inline:false}],timestamp:new Date().toISOString()}]});
      return;
    }
    if (cmd==='depend') {
      const tN=(opts.task||1)-1, bN=(opts.blocks||1)-1;
      if(tN<0||tN>=tasks.length||bN<0||bN>=tasks.length){await editInteractionReply(token,{content:'Invalid numbers.'});return;}
      tasks[tN].dependsOn=tasks[tN].dependsOn||[];
      if(!tasks[tN].dependsOn.includes(tasks[bN].id)) tasks[tN].dependsOn.push(tasks[bN].id);
      await saveTask(tasks[tN]);
      await editInteractionReply(token,{embeds:[{title:'🔒 Dependency set',description:`**${tasks[tN].name}** is blocked until **${tasks[bN].name}** is done.`,color:16776960,timestamp:new Date().toISOString()}]});
      return;
    }
    if (cmd==='recurring') {
      const n=(opts.number||1)-1;
      if(n<0||n>=tasks.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      tasks[n].recurring=opts.frequency;
      await saveTask(tasks[n]);
      await editInteractionReply(token,{embeds:[{title:`🔄 Recurring set: ${tasks[n].name}`,description:`Will auto-recreate **${opts.frequency}** when marked done.`,color:5793266,timestamp:new Date().toISOString()}]});
      return;
    }
    if (cmd==='template') {
      const tmpl=TEMPLATES[opts.type];
      if(!tmpl){await editInteractionReply(token,{content:'Template not found.'});return;}
      const created=[];
      for(const td of tmpl.tasks){
        const t={id:genId(),done:false,status:'todo',urgency:td.urgency||'normal',nagInterval:td.nagInterval||60,nagCount:0,snoozedUntil:null,dueFiredDays:[],assigneeId:null,assigneeName:null,comments:[],dependsOn:[],recurring:null,escalationRules:null,escalationFired:{},completedAt:null,client:'',due:'',notes:'',reminder:null,name:td.name,created:new Date().toISOString()};
        tasks.push(t); await saveTask(t); created.push(t);
      }
      await editInteractionReply(token,{embeds:[{title:`📋 Template: ${tmpl.name}`,description:created.map((t,i)=>`${i+1}. ${urgencyEmoji(t.urgency)} **${t.name}**`).join('\n'),color:3066993,footer:{text:`${created.length} tasks created`},timestamp:new Date().toISOString()}]});
      await sendTelegram(`📋 Template applied: <b>${tmpl.name}</b> — ${created.length} tasks`);
      return;
    }
    if (cmd==='leaderboard') {
      const done=tasks.filter(t=>t.done&&t.completedAt);
      const stats={};
      for(const t of done){const k=t.assigneeName||'Unassigned';stats[k]=stats[k]||{done:0};stats[k].done++;}
      const nagStats={};
      for(const t of tasks){const k=t.assigneeName||'Unassigned';nagStats[k]=(nagStats[k]||0)+(t.nagCount||0);}
      const fields=[];
      const sorted=Object.entries(stats).sort((a,b)=>b[1].done-a[1].done);
      const nagSorted=Object.entries(nagStats).sort((a,b)=>b[1]-a[1]);
      if(sorted.length) fields.push({name:'🏆 Most completed',value:sorted.map(([n,s])=>`**${n}**: ${s.done} done`).join('\n'),inline:false});
      if(nagSorted.length) fields.push({name:'📣 Most nagged',value:nagSorted.slice(0,5).map(([n,c])=>`**${n}**: ${c} nags`).join('\n'),inline:false});
      if(!fields.length) fields.push({name:'No data yet',value:'Complete some tasks first!',inline:false});
      await editInteractionReply(token,{embeds:[{title:'🏆 Team Leaderboard',color:16766720,fields,timestamp:new Date().toISOString()}]});
      return;
    }
    if (cmd==='register') {
      const channelId=body.channel_id, userId=invokerId, username=invoker;
      await saveMemberChannel(userId,channelId,username);
      await editInteractionReply(token,{embeds:[{title:'✅ Channel registered!',description:`**${username}** — this is now your personal task channel.\n\nAll tasks assigned to you will appear here only.`,color:3066993,timestamp:new Date().toISOString()}]});
      await sendDiscord(null,[{title:'👋 Team member registered',description:`**${username}** has set up their personal task channel.`,color:5793266,timestamp:new Date().toISOString()}]);
      return;
    }
    if (cmd==='unregister') {
      await deleteMemberChannel(invokerId);
      await editInteractionReply(token,{content:`✅ **${invoker}** — channel registration removed. Tasks will come via DM.`});
      return;
    }
    if (cmd==='team') {
      const members=Object.entries(memberChannels);
      if(!members.length){await editInteractionReply(token,{content:'No team members registered yet. Ask them to run `/register` in their channel.'});return;}
      const lines=members.map(([uid,{channelId,username}])=>`• **${username||uid}** → <#${channelId}>`).join('\n');
      await editInteractionReply(token,{embeds:[{title:`👥 Registered team (${members.length})`,description:lines,color:5793266,timestamp:new Date().toISOString()}]});
      return;
    }
    if (cmd==='summary') { await sendSummary('manual',token); return; }
    return;
  }

  // Button interactions
  if (body.type===3) {
    res.json({type:6});
    const data=body.data.custom_id, token=body.token, msgId=body.message?.id;
    const invoker=body.member?.user?.username||'Someone';
    const invokerId=body.member?.user?.id;
    const guildId=body.guild_id;

    // ── Add flow
    if (data.startsWith('urg_')&&pendingAdd&&!pendingAdd.snoozeTaskId) {
      pendingAdd.urgency=data.replace('urg_','');
      const asTxt=pendingAdd.assigneeId?`\nAssigning to: **${pendingAdd.assigneeName}**`:'';
      await editInteractionReply(pendingAdd.token,{content:`➕ **Adding:** ${pendingAdd.name}${asTxt}\n✅ Urgency: ${URGENCY[pendingAdd.urgency].label}\n\n**How often should I nag?**`,components:nagRow()});
      return;
    }
    if (data.startsWith('nag_')&&pendingAdd) {
      pendingAdd.nagInterval=parseInt(data.replace('nag_',''));
      const nagLbl=pendingAdd.nagInterval===0?'No auto-nag':`Every ${pendingAdd.nagInterval>=60?pendingAdd.nagInterval/60+' hr':pendingAdd.nagInterval+' min'}`;
      const asTxt=pendingAdd.assigneeId?`\nAssigning to: **${pendingAdd.assigneeName}**`:'';
      await editInteractionReply(pendingAdd.token,{content:`➕ **Adding:** ${pendingAdd.name}${asTxt}\n✅ Urgency: ${URGENCY[pendingAdd.urgency||'normal'].label}\n✅ Nag: ${nagLbl}\n\n**Does this have a due date?**`,components:dueDateRow()});
      return;
    }
    if (data.startsWith('due_')&&pendingAdd) {
      const val=data.replace('due_','');
      let due='';
      if(val!=='none'){const d=new Date();d.setDate(d.getDate()+parseInt(val));due=d.toISOString().slice(0,10);}
      const t={id:genId(),done:false,name:pendingAdd.name,urgency:pendingAdd.urgency||'normal',nagInterval:pendingAdd.nagInterval||60,nagCount:0,snoozedUntil:null,dueFiredDays:[],assigneeId:pendingAdd.assigneeId||null,assigneeName:pendingAdd.assigneeName||null,status:'todo',comments:[],dependsOn:[],recurring:null,escalationRules:null,escalationFired:{},completedAt:null,client:'',due,notes:'',reminder:null,created:new Date().toISOString()};
      tasks.push(t); await saveTask(t);
      const nagLbl=t.nagInterval===0?'No auto-nag':`Every ${t.nagInterval>=60?t.nagInterval/60+' hr':t.nagInterval+' min'}`;
      const dueLbl=due?fmtDate(due):'No due date';
      const fields=[{name:'Urgency',value:URGENCY[t.urgency].label,inline:true},{name:'Nag',value:nagLbl,inline:true},{name:'Due',value:dueLbl,inline:true}];
      if(t.assigneeId) fields.push({name:'Assigned to',value:`<@${t.assigneeId}>`,inline:true});
      await editInteractionReply(pendingAdd.token,{content:'',embeds:[{title:`✅ Task added: ${t.name}`,color:URGENCY[t.urgency].color,fields,timestamp:new Date().toISOString()}],components:taskActionRow(t.id,t.assigneeId)});
      if(t.assigneeId){
        await sendToMember(t.assigneeId,`📋 <@${t.assigneeId}> — new task assigned by **${invoker}**`,
          [{title:`📋 ${t.name}`,color:URGENCY[t.urgency].color,fields:[{name:'Urgency',value:URGENCY[t.urgency].label,inline:true},{name:'Due',value:dueLbl,inline:true},{name:'Assigned by',value:invoker,inline:true}],timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        await sendDiscord(null,[{title:'📋 Task assigned',description:`**${t.name}** → **${t.assigneeName}**`,color:URGENCY[t.urgency].color,fields:[{name:'Urgency',value:URGENCY[t.urgency].label,inline:true},{name:'Due',value:dueLbl,inline:true}],timestamp:new Date().toISOString()}]);
      }
      await sendTelegram(`✅ New task: <b>${t.name}</b>${t.assigneeName?' → '+t.assigneeName:''}`);
      pendingAdd=null;
      return;
    }

    // ── Task action buttons
    if (data.startsWith('act_done_')) {
      const t=tasks.find(x=>x.id===data.replace('act_done_',''));
      if(t){
        t.done=true; t.nagCount=0; t.status='done'; t.completedAt=new Date().toISOString();
        if(chaosMap[t.id]){clearInterval(chaosMap[t.id].interval);delete chaosMap[t.id];}
        const unblocked=tasks.filter(x=>!x.done&&x.dependsOn?.includes(t.id)&&!isBlocked(x));
        await saveTask(t);
        if(!t.recurring){
          await editDiscordMsg(msgId,'',
            [{title:`✅ Done: ${t.name}`,description:`Nice work **${invoker}**! 💪\n\nShould this task repeat?`,color:3066993,timestamp:new Date().toISOString()}],
            afterDoneRow(t.id)
          );
        } else {
          await editDiscordMsg(msgId,'',
            [{title:`✅ Done: ${t.name}`,description:`Marked done by **${invoker}**. 💪\n_Will auto-recreate as ${t.recurring} task..._`,color:3066993,timestamp:new Date().toISOString()}],
            []
          );
        }
        if(unblocked.length) await sendDiscord(null,[{title:'🔓 Tasks unblocked!',description:unblocked.map(x=>`• **${x.name}**`).join('\n'),color:3066993,timestamp:new Date().toISOString()}]);
        await sendTelegram(`✅ Done: <b>${t.name}</b> 💪`);
      }
      return;
    }

    if (data.startsWith('act_move_')) {
      const t=tasks.find(x=>x.id===data.replace('act_move_',''));
      if(t) await editDiscordMsg(msgId,`📅 **Move task: ${t.name}**${t.due?`\nCurrent due: **${fmtDate(t.due)}**`:''}`,[], moveTaskRow(t.id));
      return;
    }

    if (data.startsWith('act_status_')) {
      const t=tasks.find(x=>x.id===data.replace('act_status_',''));
      if(t) await editDiscordMsg(msgId,`💬 **What's the status on: ${t.name}?**`,[], statusRow(t.id));
      return;
    }

    if (data.startsWith('act_recur_')) {
      const t=tasks.find(x=>x.id===data.replace('act_recur_',''));
      if(t) await editDiscordMsg(msgId,`🔄 **Set recurring for: ${t.name}**${t.recurring?`\nCurrently: **${t.recurring}**`:''}`,[], recurringRow(t.id));
      return;
    }

    if (data.startsWith('act_delete_')) {
      const id=data.replace('act_delete_',''), t=tasks.find(x=>x.id===id);
      if(t){
        t.recurring=null;
        tasks=tasks.filter(x=>x.id!==id);
        await deleteTaskDb(id);
        if(chaosMap[id]){clearInterval(chaosMap[id].interval);delete chaosMap[id];}
        await editDiscordMsg(msgId,`🗑 Removed: **${t.name}**`,[],[]);
      }
      return;
    }

    // ── Move task sub-buttons
    if (data.startsWith('mv_')) {
      const parts=data.split('_'); parts.shift();
      const val=parts.pop(), taskId=parts.join('_');
      const t=tasks.find(x=>x.id===taskId);
      if(t){
        if(val==='pause'){
          const tom=new Date(); tom.setDate(tom.getDate()+1); tom.setHours(9,0,0,0);
          t.snoozedUntil=tom.toISOString();
          await saveTask(t);
          await editDiscordMsg(msgId,'',
            [{title:`🌙 Follow-up paused: ${t.name}`,description:'All nags stopped for today.\n\nResuming at **9 AM tomorrow**. 😴',color:5793266,timestamp:new Date().toISOString()}],
            taskActionRow(t.id,t.assigneeId)
          );
          if(t.assigneeId) await sendToMember(t.assigneeId,null,[{title:`🌙 Follow-up paused: ${t.name}`,description:'No more nags today. Resumes 9 AM tomorrow.',color:5793266}]);
        } else {
          const old=t.due;
          if(val==='none'){
            t.due='';
          } else {
            const base=t.due?new Date(t.due+'T00:00:00'):new Date();
            base.setDate(base.getDate()+parseInt(val));
            t.due=base.toISOString().slice(0,10);
          }
          t.dueFiredDays=[];
          await saveTask(t);
          const dueLbl=t.due?fmtDate(t.due):'No due date';
          await editDiscordMsg(msgId,'',
            [{title:`📅 Task moved: ${t.name}`,description:`${old?`~~${fmtDate(old)}~~ → `:''}**${dueLbl}**`,color:5793266,timestamp:new Date().toISOString()}],
            taskActionRow(t.id,t.assigneeId)
          );
          if(t.assigneeId) await sendToMember(t.assigneeId,null,[{title:`📅 Due date updated: ${t.name}`,description:`New due date: **${dueLbl}**`,color:5793266}]);
        }
      }
      return;
    }

    // ── Status sub-buttons
    if (data.startsWith('st_')) {
      const parts=data.split('_'); parts.shift();
      const stKey=parts.pop(), taskId=parts.join('_');
      const t=tasks.find(x=>x.id===taskId);
      if(t){
        const labels={client:'⏳ Waiting for client',blocked:'🔒 Blocked internally',wip:'🔄 In progress',escalate:'⬆️ Escalated'};
        const statusLabel=labels[stKey]||stKey;
        t.status=stKey==='wip'?'inprogress':stKey;
        t.comments=t.comments||[];
        t.comments.push({by:invoker,text:statusLabel,at:new Date().toISOString()});
        if(stKey==='client'||stKey==='blocked'){
          const tom=new Date(); tom.setDate(tom.getDate()+1); tom.setHours(9,0,0,0);
          t.snoozedUntil=tom.toISOString();
        }
        await saveTask(t);
        const pauseNote=stKey==='client'||stKey==='blocked'?'\n\n_Nags paused until 9 AM tomorrow._':'';
        await editDiscordMsg(msgId,'',
          [{title:`💬 Status updated: ${t.name}`,description:`**${invoker}** marked: **${statusLabel}**${pauseNote}`,color:stKey==='wip'?3066993:stKey==='escalate'?15158332:16776960,timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        if(t.assigneeId&&invokerId===t.assigneeId){
          await sendDiscord(null,[{title:`💬 Status update: ${t.name}`,description:`<@${t.assigneeId}> updated: **${statusLabel}**`,color:5793266,timestamp:new Date().toISOString()}]);
        }
        if(stKey==='escalate'){
          await broadcast(`🚨 **ESCALATED by ${invoker}:** **${t.name}** needs immediate attention!`,
            [{title:`🚨 Escalated: ${t.name}`,description:`**${invoker}** has flagged this as urgent.\n\nThis is a team-wide announcement.`,color:15158332,timestamp:new Date().toISOString()}]
          );
        }
        await sendTelegram(`💬 Status on <b>${t.name}</b>: ${statusLabel} (by ${invoker})`);
      }
      return;
    }

    // ── Recurring sub-buttons
    if (data.startsWith('rec_')) {
      const parts=data.split('_'); parts.shift();
      const freq=parts.pop(), taskId=parts.join('_');
      const t=tasks.find(x=>x.id===taskId);
      if(t){
        t.recurring=freq==='none'?null:freq;
        await saveTask(t);
        const lbl=freq==='none'?'One-time (recurring removed)':freq==='daily'?'🔁 Daily':freq==='weekly'?'🔁 Weekly':'🔁 Monthly';
        await editDiscordMsg(msgId,'',
          [{title:`🔄 Recurring updated: ${t.name}`,description:`Set to: **${lbl}**`,color:5793266,timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
      }
      return;
    }

    // ── After-done recurring prompt
    if (data.startsWith('afd_')) {
      const parts=data.split('_'); parts.shift();
      const freq=parts.pop(), taskId=parts.join('_');
      const t=tasks.find(x=>x.id===taskId);
      if(freq!=='none'&&t){
        t.recurring=freq; await saveTask(t);
        await editDiscordMsg(msgId,'',
          [{title:`🔁 Set to recurring: ${t?.name||'task'}`,description:`Will auto-recreate **${freq}** from now on.`,color:3066993,timestamp:new Date().toISOString()}],[]
        );
      } else {
        await editDiscordMsg(msgId,'',
          [{title:`✅ Done: ${t?.name||'task'}`,description:'One-time task. All done! 💪',color:3066993}],[]
        );
      }
      return;
    }

    // ── Chaos call
    if (data.startsWith('act_call_')) {
      const t=tasks.find(x=>x.id===data.replace('act_call_',''));
      if(t){
        await editDiscordMsg(msgId,'',
          [{title:`☎️ CALLING: ${t.name}`,description:`Chaos activated by **${invoker}** — <@${t.assigneeId}> is being summoned. 🚨`,color:15158332,timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        await triggerChaosCall(t,guildId,invoker);
      }
      return;
    }
    return;
  }
  res.sendStatus(200);
});

// ── TELEGRAM WEBHOOK ──────────────────────────────────────────────────────────
app.post('/webhook', async(req,res)=>{
  res.sendStatus(200);
  const body=req.body;
  if(body.callback_query){
    const cb=body.callback_query, data=cb.data, msgId=cb.message?.message_id;
    await tgReq('answerCallbackQuery',{callback_query_id:cb.id,text:''});
    if(data.startsWith('act_done_')){
      const t=tasks.find(x=>x.id===data.replace('act_done_',''));
      if(t){t.done=true;t.status='done';t.completedAt=new Date().toISOString();await saveTask(t);await tgReq('editMessageText',{chat_id:TG_CHAT_ID,message_id:msgId,text:`✅ Done: <b>${t.name}</b>`,parse_mode:'HTML'});}
    }
    return;
  }
  const msg=body.message; if(!msg) return;
  if(TG_CHAT_ID&&String(msg.chat.id)!==TG_CHAT_ID) return;
  const text=(msg.text||'').trim(), lower=text.toLowerCase();
  if(text==='/start'||text==='/help'){await sendTelegram('👋 <b>Taskmaster backup</b>\n\nPrimary is Discord. Commands:\n/list, /pending, /done [n], /summary\n\nType <i>"done"</i> to mark top task complete.');return;}
  if(text==='/list'){const lines=tasks.map((t,i)=>`${i+1}. ${t.done?'✅':'⬜'} ${t.name}${t.assigneeName?' → '+t.assigneeName:''}`).join('\n');await sendTelegram(`📋 <b>All tasks (${tasks.length})</b>\n\n${lines||'None yet'}`);return;}
  if(text==='/pending'){const p=tasks.filter(t=>!t.done);if(!p.length){await sendTelegram('🎉 All clear!');return;}await sendTelegram(`📋 <b>Pending (${p.length})</b>\n\n${p.map((t,i)=>`${i+1}. ${t.name}${t.assigneeName?' → '+t.assigneeName:''}`).join('\n')}`);return;}
  if(text==='/summary'){await sendSummary();return;}
  if(lower==='done'){const p=tasks.filter(t=>!t.done);if(p.length){p[0].done=true;p[0].status='done';p[0].completedAt=new Date().toISOString();await saveTask(p[0]);await sendTelegram(`✅ Done: <b>${p[0].name}</b> 💪`);}return;}
  if(text.startsWith('/done')){const n=parseInt(text.split(' ')[1])-1;const p=tasks.filter(t=>!t.done);if(n>=0&&n<p.length){p[n].done=true;p[n].status='done';p[n].completedAt=new Date().toISOString();await saveTask(p[n]);await sendTelegram(`✅ Done: <b>${p[n].name}</b> 💪`);}return;}
  await sendTelegram('Use Discord for full task management.');
});

// ── SUMMARY ───────────────────────────────────────────────────────────────────
async function sendSummary(type='manual', interactionToken) {
  const pending=tasks.filter(t=>!t.done), done=tasks.filter(t=>t.done);
  const overdue=pending.filter(t=>t.due&&daysUntil(t.due)<0);
  const dueToday=pending.filter(t=>t.due&&daysUntil(t.due)===0);
  const defcon=pending.filter(t=>t.urgency==='defcon');
  const urgent=pending.filter(t=>t.urgency==='urgent');
  const normal=pending.filter(t=>t.urgency==='normal');
  const blocked=pending.filter(t=>isBlocked(t));
  const inprog=pending.filter(t=>t.status==='inprogress');
  const title=type==='morning'?'☀️ Good morning — here\'s your day':type==='evening'?'🌙 End of day wrap-up':type==='weekly'?'📊 Weekly team report':'📋 Task summary';
  const color=overdue.length?15158332:pending.length?16776960:3066993;
  const fields=[];
  if(overdue.length)   fields.push({name:`🔥 Overdue (${overdue.length})`,value:overdue.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''} — due ${fmtDate(t.due)}`).join('\n'),inline:false});
  if(dueToday.length)  fields.push({name:`🚨 Due today (${dueToday.length})`,value:dueToday.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(defcon.length)    fields.push({name:`🔴 Drop everything (${defcon.length})`,value:defcon.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(urgent.length)    fields.push({name:`🟡 Urgent (${urgent.length})`,value:urgent.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(normal.length)    fields.push({name:`🟢 Normal (${normal.length})`,value:normal.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(inprog.length)    fields.push({name:`🔄 In progress (${inprog.length})`,value:inprog.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(blocked.length)   fields.push({name:`🔒 Blocked (${blocked.length})`,value:blocked.map(t=>`• **${t.name}**`).join('\n'),inline:false});
  if(type==='evening'&&done.length) fields.push({name:`✅ Done today (${done.length})`,value:done.map(t=>`• ${t.name}${t.assigneeName?' ('+t.assigneeName+')':''}`).join('\n'),inline:false});
  if(type==='weekly'){const wk=done.filter(t=>t.completedAt&&new Date(t.completedAt)>new Date(Date.now()-7*86400000));if(wk.length)fields.push({name:`✅ Done this week (${wk.length})`,value:wk.map(t=>`• ${t.name}${t.assigneeName?' ('+t.assigneeName+')':''}`).join('\n'),inline:false});}
  if(!fields.length) fields.push({name:'Status',value:'🎉 All clear!',inline:false});
  const embed={title,color,fields,timestamp:new Date().toISOString()};
  if(interactionToken) await editInteractionReply(interactionToken,{embeds:[embed]});
  else await sendDiscord(null,[embed]);
  let tg=type==='morning'?'☀️ <b>Good morning!</b>\n\n':type==='evening'?'🌙 <b>End of day:</b>\n\n':type==='weekly'?'📊 <b>Weekly report:</b>\n\n':'📋 <b>Summary:</b>\n\n';
  if(overdue.length) tg+=`🔥 Overdue: ${overdue.map(t=>t.name).join(', ')}\n`;
  if(pending.length) tg+=`📌 ${pending.length} pending`;
  else tg+='🎉 All clear!';
  await sendTelegram(tg);
}

// ── RECURRING TASK CREATION ───────────────────────────────────────────────────
async function createRecurringTask(original) {
  const t={...original,id:genId(),done:false,status:'todo',nagCount:0,snoozedUntil:null,dueFiredDays:[],escalationFired:{},comments:[],completedAt:null,recurringCreated:false,created:new Date().toISOString()};
  if(t.due&&t.recurring){
    const d=new Date(t.due+'T00:00:00');
    if(t.recurring==='daily')   d.setDate(d.getDate()+1);
    if(t.recurring==='weekly')  d.setDate(d.getDate()+7);
    if(t.recurring==='monthly') d.setMonth(d.getMonth()+1);
    t.due=d.toISOString().slice(0,10);
  }
  tasks.push(t); await saveTask(t);
  if(t.assigneeId){
    await sendToMember(t.assigneeId,`📋 <@${t.assigneeId}> — recurring task`,
      [{title:`🔄 Recurring: ${t.name}`,description:`Auto-created.${t.due?` Due: **${fmtDate(t.due)}**`:''}`,color:5793266,timestamp:new Date().toISOString()}],
      taskActionRow(t.id,t.assigneeId)
    );
  } else {
    await sendDiscord(null,[{title:`🔄 Recurring task created: ${t.name}`,description:`Auto-created.${t.due?` Due: **${fmtDate(t.due)}**`:''}`,color:5793266,timestamp:new Date().toISOString()}],taskActionRow(t.id,null));
  }
}

// ── CRON JOBS ─────────────────────────────────────────────────────────────────
cron.schedule('* * * * *', async()=>{
  const now=new Date(), hhmm=`${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const today=days[now.getDay()], date=now.toISOString().slice(0,10), dom=now.getDate(), nowMs=now.getTime();

  for (const t of tasks) {
    if(t.done) continue;
    if(t.snoozedUntil&&new Date(t.snoozedUntil)>now) continue;
    if(t.snoozedUntil&&new Date(t.snoozedUntil)<=now){t.snoozedUntil=null;await saveTask(t);}
    if(isBlocked(t)) continue;

    // Due date warnings at 9 AM
    if(t.due&&hhmm==='09:00'){
      t.dueFiredDays=t.dueFiredDays||[];
      const dl=daysUntil(t.due);
      const checks=[{key:'week',days:7},{key:'days3',days:3},{key:'day1',days:1},{key:'today',days:0},{key:'overdue',days:-99}];
      for(const c of checks){
        const should=c.key==='overdue'?dl<0:dl===c.days;
        const fireKey=`${c.key}_${date}`;
        if(should&&!t.dueFiredDays.includes(fireKey)){
          t.dueFiredDays.push(fireKey);
          if(c.key==='overdue'&&t.nagInterval>0) t.nagInterval=Math.max(15,Math.floor(t.nagInterval/2));
          const msgTxt=c.key==='today'?DUE_WARNINGS.today(t.name):DUE_WARNINGS[c.key](t.name,fmtDate(t.due));
          const color=c.key==='overdue'||c.key==='today'?15158332:c.key==='day1'?16776960:3066993;
          await saveTask(t);
          if(t.assigneeId){
            await sendToMember(t.assigneeId,`<@${t.assigneeId}>`,
              [{title:`📅 Due date alert: ${t.name}`,description:msgTxt,color,fields:[{name:'Due',value:fmtDate(t.due),inline:true},{name:'Urgency',value:URGENCY[t.urgency||'normal'].label,inline:true}],timestamp:new Date().toISOString()}],
              taskActionRow(t.id,t.assigneeId)
            );
            await sendDiscord(null,[{title:`📅 Due alert: ${t.name}`,description:`**${t.assigneeName||'Assignee'}** — ${msgTxt.replace(/\*\*/g,'')}`,color,timestamp:new Date().toISOString()}]);
          } else {
            await sendDiscord(null,
              [{title:`📅 Due date alert: ${t.name}`,description:msgTxt,color,fields:[{name:'Due',value:fmtDate(t.due),inline:true}],timestamp:new Date().toISOString()}],
              taskActionRow(t.id,null)
            );
          }
          await sendTelegram(msgTxt.replace(/\*\*/g,''));
          break;
        }
      }
    }

    // Auto-escalation
    if(t.due&&t.escalationRules){
      const dl=daysUntil(t.due), r=t.escalationRules;
      t.escalationFired=t.escalationFired||{};
      if(dl!==null&&dl<=r.daysDefcon&&t.urgency!=='defcon'&&!t.escalationFired.defcon){
        t.escalationFired.defcon=true; t.urgency='defcon'; t.nagInterval=r.nagDefcon; await saveTask(t);
        if(t.assigneeId) await sendToMember(t.assigneeId,`<@${t.assigneeId}>`,
          [{title:`🚨 AUTO-ESCALATED: ${t.name}`,description:`Now **DROP EVERYTHING**. Due: **${fmtDate(t.due)}** · Nag every **${r.nagDefcon} min**`,color:15158332,timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        await sendDiscord(null,[{title:`🚨 Escalated to DROP EVERYTHING: ${t.name}`,description:t.assigneeName?`Assigned to **${t.assigneeName}**`:'Unassigned',color:15158332,timestamp:new Date().toISOString()}]);
        await sendTelegram(`🚨 AUTO-ESCALATED: <b>${t.name}</b> → DROP EVERYTHING`);
      } else if(dl!==null&&dl<=r.daysUrgent&&t.urgency==='normal'&&!t.escalationFired.urgent){
        t.escalationFired.urgent=true; t.urgency='urgent'; t.nagInterval=r.nagUrgent; await saveTask(t);
        if(t.assigneeId) await sendToMember(t.assigneeId,`<@${t.assigneeId}>`,
          [{title:`⚡ AUTO-ESCALATED: ${t.name}`,description:`Now **Urgent**. Due in **${dl} day${dl===1?'':'s'}** · Nag every **${r.nagUrgent} min**`,color:16776960,timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        await sendDiscord(null,[{title:`⚡ Escalated to Urgent: ${t.name}`,description:t.assigneeName?`Assigned to **${t.assigneeName}**`:'',color:16776960,timestamp:new Date().toISOString()}]);
        await sendTelegram(`⚡ AUTO-ESCALATED: <b>${t.name}</b> → Urgent`);
      }
    }

    // Interval nag
    if(t.nagInterval&&t.nagInterval>0){
      const lastNag=t.lastNagAt?new Date(t.lastNagAt).getTime():0;
      if(nowMs-lastNag>=t.nagInterval*60*1000){
        t.nagCount=(t.nagCount||0)+1; t.lastNagAt=now.toISOString();
        const urg=URGENCY[t.urgency||'normal'];
        let stage=urg.escalation[0]; for(const s of urg.escalation){if(t.nagCount>=s.after)stage=s;}
        const msgTxt=stage.msg(t.name);
        await saveTask(t);
        if(t.assigneeId){
          await sendToMember(t.assigneeId,`<@${t.assigneeId}>`,
            [{title:`🔔 Nag #${t.nagCount}: ${t.name}`,description:msgTxt,color:urg.color,fields:[...(t.due?[{name:'Due',value:fmtDate(t.due),inline:true}]:[]),...(t.snoozeReason?[{name:'Last snooze reason',value:t.snoozeReason,inline:true}]:[])],timestamp:new Date().toISOString()}],
            taskActionRow(t.id,t.assigneeId)
          );
          if(t.nagCount%3===0) await sendDiscord(null,[{title:`🔔 Reminder #${t.nagCount}: ${t.name}`,description:`Still pending — **${t.assigneeName||'assignee'}**`,color:urg.color,timestamp:new Date().toISOString()}]);
        } else {
          await sendDiscord(null,
            [{title:`🔔 Nag #${t.nagCount}: ${t.name}`,description:msgTxt,color:urg.color,fields:t.due?[{name:'Due',value:fmtDate(t.due),inline:true}]:[],timestamp:new Date().toISOString()}],
            taskActionRow(t.id,null)
          );
        }
        await sendTelegram(msgTxt.replace(/\*\*/g,''));
      }
    }

    // Scheduled reminders from web app
    const r=t.reminder;
    if(!r||r.freq==='none') continue;
    let fire=false,key='';
    if(r.freq==='daily'){const aT=[...(r.slots||[]),...(r.customTimes||[])];for(const tm of aT){if(tm===hhmm){fire=true;key=`d_${tm}_${date}`;break;}}}
    else if(r.freq==='weekly'){if((r.days||[]).includes(today)&&r.time===hhmm){fire=true;key=`w_${date}_${hhmm}`;}}
    else if(r.freq==='monthly'){const mD=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();const tgt=Math.min(r.day||1,mD);if(dom===tgt&&r.time===hhmm){fire=true;key=`m_${date}_${hhmm}`;}}
    else if(r.freq==='once'){if(r.date===date&&r.time===hhmm){fire=true;key=`o_${date}_${hhmm}`;}}
    if(fire&&key){r.firedIds=r.firedIds||[];if(!r.firedIds.includes(key)){r.firedIds.push(key);await saveTask(t);if(t.assigneeId){await sendToMember(t.assigneeId,`<@${t.assigneeId}>`,
      [{title:`🔔 Scheduled reminder: ${t.name}`,color:5793266,timestamp:new Date().toISOString()}],taskActionRow(t.id,t.assigneeId));}
    else{await sendDiscord(null,[{title:`🔔 Scheduled reminder: ${t.name}`,color:5793266,timestamp:new Date().toISOString()}],taskActionRow(t.id,null));}}}
  }

  // Recurring auto-create
  for(const t of tasks.filter(t=>t.done&&t.recurring&&!t.recurringCreated)){
    t.recurringCreated=true; await saveTask(t); await createRecurringTask(t);
  }
});

cron.schedule('0 7  * * *', ()=>sendSummary('morning'));
cron.schedule('0 18 * * *', ()=>sendSummary('evening'));
cron.schedule('0 18 * * 5', ()=>sendSummary('weekly'));

app.listen(PORT, async()=>{
  console.log(`Taskmaster running on port ${PORT} 🔥`);
  await dbInit();
  await loadTasks();
  await loadMemberChannels();
  await registerCommands();
});
