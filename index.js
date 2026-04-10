const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const fetch    = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const nacl     = require('tweetnacl');

const app = express();
app.use(cors());
app.use('/discord', express.raw({ type:'application/json' }));
app.use(express.json());

// ── ENV ───────────────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.BOT_TOKEN;
const TG_CHAT_ID      = process.env.CHAT_ID;
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL;
const DISCORD_APP_ID  = process.env.DISCORD_APP_ID;
const DISCORD_PUB_KEY = process.env.DISCORD_PUBLIC_KEY;
const PORT            = process.env.PORT || 3000;

// ── STATE ─────────────────────────────────────────────────────────────────────
let tasks      = [];
let pendingAdd = null;
// chaos tracking: taskId -> { interval, count }
const chaosMap = {};

function genId() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function pad(n)  { return String(n).padStart(2,'0'); }

// ── URGENCY ───────────────────────────────────────────────────────────────────
const URGENCY = {
  normal: {
    label:'🟢 Normal', color:3066993,
    escalation:[
      {after:0,  msg:n=>`🔔 Just a heads up — **"${n}"** is waiting for you.`},
      {after:2,  msg:n=>`🔔 Hey. **"${n}"** is still sitting there. Untouched.`},
      {after:5,  msg:n=>`😤 Still nothing on **"${n}"**? Come on now.`},
      {after:10, msg:n=>`🚨 **"${n}"** has been ignored too many times. Do it. NOW.`},
    ]
  },
  urgent: {
    label:'🟡 Urgent', color:16776960,
    escalation:[
      {after:0, msg:n=>`⚡ **URGENT: "${n}"** needs your attention NOW.`},
      {after:2, msg:n=>`🚨 **STILL URGENT: "${n}"** — why is this not done yet?`},
      {after:4, msg:n=>`😡 **"${n}"** IS URGENT AND YOU KEEP IGNORING IT.`},
      {after:7, msg:n=>`🔥🔥 **"${n}"** — at what point does urgent mean urgent to you??`},
    ]
  },
  defcon: {
    label:'🔴 DROP EVERYTHING', color:15158332,
    escalation:[
      {after:0, msg:n=>`🚨🚨 **DROP EVERYTHING: "${n}"** — stop what you're doing. Right now.`},
      {after:1, msg:n=>`💀 **"${n}"** — whatever you're doing is less important. STOP. DO THIS.`},
      {after:2, msg:n=>`☢️ **DEFCON 1: "${n}"** is on fire. Everything is on fire. FIX IT.`},
      {after:3, msg:n=>`🆘🆘 **"${n}"** — I have run out of ways to tell you. PLEASE.`},
    ]
  }
};

const DUE_WARNINGS = {
  week:    (n,d)=>`📅 **1 week to go:** **"${n}"** is due ${d}. You've got time — but not that much.`,
  days3:   (n,d)=>`📅 **3 days left:** **"${n}"** is due ${d}. Start wrapping this up.`,
  day1:    (n,d)=>`⚠️ **Due TOMORROW:** **"${n}"** is due ${d}. Get it done.`,
  today:   (n)  =>`🚨 **DUE TODAY: "${n}"** — this needs to be done before end of day.`,
  overdue: (n,d)=>`🔥 **OVERDUE: "${n}"** was due ${d}. It's late. Get it done NOW.`,
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function daysUntil(iso) {
  if (!iso) return null;
  const today=new Date(); today.setHours(0,0,0,0);
  return Math.round((new Date(iso+'T00:00:00')-today)/86400000);
}
function urgencyEmoji(u){ return u==='defcon'?'🔴':u==='urgent'?'🟡':'🟢'; }
function parseDate(input) {
  // Accepts: YYYY-MM-DD, tomorrow, today, +N (days from today)
  const s = input.trim().toLowerCase();
  const base = new Date(); base.setHours(0,0,0,0);
  if (s === 'today')    return base.toISOString().slice(0,10);
  if (s === 'tomorrow') { base.setDate(base.getDate()+1); return base.toISOString().slice(0,10); }
  if (/^\+\d+$/.test(s)) { base.setDate(base.getDate()+parseInt(s.slice(1))); return base.toISOString().slice(0,10); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Try natural parse
  const parsed = new Date(input);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0,10);
  return null;
}
function nextUrgency(current) {
  if (current === 'normal') return 'urgent';
  if (current === 'urgent') return 'defcon';
  return 'defcon';
}
function taskSummaryLine(t,i){
  const done=t.done?'✅':'⬜', urg=urgencyEmoji(t.urgency||'normal');
  const client=t.client?` [${t.client}]`:'', due=t.due?` · due ${fmtDate(t.due)}`:'';
  const assignee=t.assigneeId?` · <@${t.assigneeId}>`:t.assigneeName?` · ${t.assigneeName}`:'';
  const num=i!==undefined?`${i+1}. `:'';
  return `${num}${done} ${urg} **${t.name}**${client}${due}${assignee}`;
}

// ── DISCORD VERIFICATION ──────────────────────────────────────────────────────
function verifyDiscord(req) {
  if (!DISCORD_PUB_KEY) return true;
  const sig=req.headers['x-signature-ed25519'], ts=req.headers['x-signature-timestamp'];
  if (!sig||!ts) return false;
  try {
    const body=Buffer.isBuffer(req.body)?req.body:Buffer.from(JSON.stringify(req.body));
    return nacl.sign.detached.verify(
      Buffer.from(ts+body.toString()),
      Buffer.from(sig,'hex'),
      Buffer.from(DISCORD_PUB_KEY,'hex')
    );
  } catch(e){ return false; }
}

// ── DISCORD API ───────────────────────────────────────────────────────────────
async function dReq(method, path, body) {
  if (!DISCORD_TOKEN) return null;
  const r=await fetch(`https://discord.com/api/v10${path}`,{
    method, headers:{'Authorization':`Bot ${DISCORD_TOKEN}`,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined
  }).catch(console.error);
  return r?r.json().catch(()=>null):null;
}
async function sendDiscord(content, embeds, components) {
  if (!DISCORD_CHANNEL) return null;
  const b={};
  if (content)    b.content=content;
  if (embeds)     b.embeds=embeds;
  if (components) b.components=components;
  return dReq('POST',`/channels/${DISCORD_CHANNEL}/messages`,b);
}
async function editDiscordMsg(msgId, content, embeds, components) {
  if (!DISCORD_CHANNEL) return;
  const b={};
  if (content!==undefined)    b.content=content;
  if (embeds!==undefined)     b.embeds=embeds;
  if (components!==undefined) b.components=components;
  return dReq('PATCH',`/channels/${DISCORD_CHANNEL}/messages/${msgId}`,b);
}
async function sendDM(userId, content, embeds) {
  if (!DISCORD_TOKEN||!userId) return;
  const dm=await dReq('POST','/users/@me/channels',{recipient_id:userId});
  if (!dm?.id) return;
  const b={};
  if (content) b.content=content;
  if (embeds)  b.embeds=embeds;
  return dReq('POST',`/channels/${dm.id}/messages`,b);
}
async function moveToVoice(guildId, userId, channelId) {
  if (!guildId||!userId||!channelId) return;
  return dReq('PATCH',`/guilds/${guildId}/members/${userId}`,{channel_id:channelId});
}
async function getOrCreateVoiceChannel(guildId) {
  // find existing chaos channel or create it
  const channels=await dReq('GET',`/guilds/${guildId}/channels`);
  if (channels) {
    const existing=channels.find(c=>c.name==='🚨-get-in-here'&&c.type===2);
    if (existing) return existing.id;
  }
  const created=await dReq('POST',`/guilds/${guildId}/channels`,{
    name:'🚨-get-in-here', type:2, bitrate:64000
  });
  return created?.id;
}
async function getGuildId() {
  if (!DISCORD_CHANNEL) return null;
  const ch=await dReq('GET',`/channels/${DISCORD_CHANNEL}`);
  return ch?.guild_id;
}
async function respondInteraction(id, token, data) {
  return fetch(`https://discord.com/api/v10/interactions/${id}/${token}/callback`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({type:4,data})
  }).catch(console.error);
}
async function editInteractionReply(token, data) {
  return fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`,{
    method:'PATCH', headers:{'Content-Type':'application/json'},
    body:JSON.stringify(data)
  }).catch(console.error);
}
async function registerCommands() {
  if (!DISCORD_TOKEN||!DISCORD_APP_ID) return;
  const commands=[
    {name:'add',     description:'Add a new task',         options:[{name:'task',type:3,description:'Task name',required:true}]},
    {name:'assign',  description:'Assign a task to someone',options:[
      {name:'task',   type:3,description:'Task name',required:true},
      {name:'member', type:6,description:'Who to assign to',required:true},
    ]},
    {name:'list',    description:'Show all tasks'},
    {name:'pending', description:'Show pending tasks only'},
    {name:'mywork',  description:'Show tasks assigned to you'},
    {name:'done',    description:'Mark a task done',        options:[{name:'number',type:4,description:'Task number',required:true}]},
    {name:'delete',  description:'Delete a task',           options:[{name:'number',type:4,description:'Task number',required:true}]},
    {name:'snooze',  description:'Snooze a task 30 min',    options:[{name:'number',type:4,description:'Task number',required:true}]},
    {name:'summary',  description:'Get your task summary'},
    {name:'setdue',   description:'Change due date of a task', options:[
      {name:'number', type:4, description:'Task number from /list', required:true},
      {name:'date',   type:3, description:'New due date e.g. 2026-05-01 or tomorrow or +3', required:true},
    ]},
    {name:'escalation', description:'Set auto-escalation thresholds for a task', options:[
      {name:'number',       type:4, description:'Task number from /list', required:true},
      {name:'days_urgent',  type:4, description:'Days before due to bump to Urgent (e.g. 5)', required:false},
      {name:'days_defcon',  type:4, description:'Days before due to bump to DROP EVERYTHING (e.g. 1)', required:false},
      {name:'nag_urgent',   type:4, description:'Nag interval in minutes when Urgent (e.g. 30)', required:false},
      {name:'nag_defcon',   type:4, description:'Nag interval in minutes when DROP EVERYTHING (e.g. 15)', required:false},
    ]},
  ];
  await dReq('PUT',`/applications/${DISCORD_APP_ID}/commands`,commands);
  console.log('Discord slash commands registered ✅');
}

// ── KEYBOARDS ─────────────────────────────────────────────────────────────────
function urgencyRow() {
  return [{type:1,components:[
    {type:2,style:3,label:'🟢 Normal',         custom_id:'urg_normal'},
    {type:2,style:1,label:'🟡 Urgent',         custom_id:'urg_urgent'},
    {type:2,style:4,label:'🔴 DROP EVERYTHING',custom_id:'urg_defcon'},
  ]}];
}
function nagRow() {
  return [
    {type:1,components:[
      {type:2,style:2,label:'Every 15 min',custom_id:'nag_15'},
      {type:2,style:2,label:'Every 30 min',custom_id:'nag_30'},
      {type:2,style:2,label:'Every hour',  custom_id:'nag_60'},
      {type:2,style:2,label:'Every 2 hrs', custom_id:'nag_120'},
    ]},
    {type:1,components:[
      {type:2,style:2,label:'No auto-nag', custom_id:'nag_0'},
    ]}
  ];
}
function dueDateRow() {
  return [
    {type:1,components:[
      {type:2,style:2,label:'Today',    custom_id:'due_0'},
      {type:2,style:2,label:'Tomorrow', custom_id:'due_1'},
      {type:2,style:2,label:'3 days',   custom_id:'due_3'},
      {type:2,style:2,label:'1 week',   custom_id:'due_7'},
    ]},
    {type:1,components:[
      {type:2,style:2,label:'2 weeks',     custom_id:'due_14'},
      {type:2,style:2,label:'1 month',     custom_id:'due_30'},
      {type:2,style:1,label:'No due date', custom_id:'due_none'},
    ]}
  ];
}
function changeDueDateRow(taskId) {
  return [
    {type:1,components:[
      {type:2,style:2,label:'Today',    custom_id:`chgdue_${taskId}_0`},
      {type:2,style:2,label:'Tomorrow', custom_id:`chgdue_${taskId}_1`},
      {type:2,style:2,label:'+3 days',  custom_id:`chgdue_${taskId}_3`},
      {type:2,style:2,label:'+1 week',  custom_id:`chgdue_${taskId}_7`},
    ]},
    {type:1,components:[
      {type:2,style:2,label:'+2 weeks',    custom_id:`chgdue_${taskId}_14`},
      {type:2,style:2,label:'+1 month',    custom_id:`chgdue_${taskId}_30`},
      {type:2,style:4,label:'Remove date', custom_id:`chgdue_${taskId}_none`},
    ]}
  ];
}
function taskActionRow(taskId, assigneeId) {
  const row=[
    {type:2,style:3,label:'✅ Done',       custom_id:`act_done_${taskId}`},
    {type:2,style:2,label:'⏸ Snooze 30m', custom_id:`act_snooze_${taskId}`},
    {type:2,style:2,label:'📅 Change due', custom_id:`act_changedue_${taskId}`},
    {type:2,style:4,label:'🗑 Delete',     custom_id:`act_delete_${taskId}`},
  ];
  if (assigneeId) {
    row.push({type:2,style:4,label:'☎️ CALL THEM',custom_id:`act_call_${taskId}`});
  }
  // Discord max 5 buttons per row — split if needed
  if (row.length > 5) {
    return [
      {type:1,components:row.slice(0,4)},
      {type:1,components:row.slice(4)},
    ];
  }
  return [{type:1,components:row}];
}

// ── MAXIMUM CHAOS CALL ────────────────────────────────────────────────────────
async function triggerChaosCall(task, guildId, callerName) {
  const assigneeId = task.assigneeId;
  if (!assigneeId) return;

  const dl       = task.due ? daysUntil(task.due) : null;
  const overdueStr = dl!==null && dl<0 ? ` This was due ${Math.abs(dl)} day${Math.abs(dl)===1?'':'s'} ago.` : '';
  const urgLabel = URGENCY[task.urgency||'normal'].label;

  // 1. DM them
  await sendDM(assigneeId, null, [{
    title: `☎️ INCOMING CALL FROM YOUR LEAD`,
    description: `**${callerName||'Your lead'}** is calling you out on Discord.\n\n> **"${task.name}"** has not been completed.\n>${overdueStr}\n\nGet in the **#🚨-get-in-here** voice channel NOW.`,
    color: 15158332,
    timestamp: new Date().toISOString()
  }]);

  // 2. @mention in channel + public callout
  await sendDiscord(
    `🚨 <@${assigneeId}> 🚨 <@${assigneeId}> 🚨 <@${assigneeId}>`,
    [{
      title: `☎️ INCOMING CALL — GET IN THE VOICE CHANNEL`,
      description: `**<@${assigneeId}>** — **${callerName||'your lead'}** is calling you about:\n\n> **${task.name}**\n>${overdueStr}\n\n**GET. IN. THE. VOICE. CHANNEL. NOW.**`,
      color: 15158332,
      timestamp: new Date().toISOString(),
      footer: {text: `Urgency: ${urgLabel} · Called by ${callerName||'lead'}`}
    }]
  );

  // 3. Try to move them into voice channel
  if (guildId) {
    const vcId = await getOrCreateVoiceChannel(guildId);
    if (vcId) await moveToVoice(guildId, assigneeId, vcId);
  }

  // 4. Repeat ping every 30 seconds up to 3 times if they haven't responded
  let count = 0;
  if (chaosMap[task.id]) clearInterval(chaosMap[task.id].interval);
  chaosMap[task.id] = {
    interval: setInterval(async () => {
      count++;
      // Check if task is now done
      const current = tasks.find(t=>t.id===task.id);
      if (!current || current.done || count >= 3) {
        clearInterval(chaosMap[task.id]?.interval);
        delete chaosMap[task.id];
        if (current?.done) {
          await sendDiscord(`✅ <@${assigneeId}> responded — **${task.name}** is done. Crisis averted. 😤`);
        } else if (count >= 3) {
          await sendDiscord(`🆘 <@${assigneeId}> still hasn't responded after 3 pings. **${task.name}** remains undone. You might need to have a word.`);
        }
        return;
      }
      await sendDiscord(`🔔 <@${assigneeId}> — ping ${count+1}/3. **${task.name}** is still waiting. VOICE CHANNEL. NOW.`);
    }, 30000)
  };
}

// ── TELEGRAM HELPERS ──────────────────────────────────────────────────────────
async function tgReq(method, body) {
  if (!BOT_TOKEN) return null;
  const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  }).catch(console.error);
  return r?r.json().catch(()=>null):null;
}
async function sendTelegram(text, extra={}) {
  if (!TG_CHAT_ID) return;
  return tgReq('sendMessage',{chat_id:TG_CHAT_ID,text,parse_mode:'HTML',...extra});
}

// ── REST ROUTES ───────────────────────────────────────────────────────────────
app.get('/',            (_,res)=>res.json({status:'Taskmaster running 🔥'}));
app.get('/tasks',       (_,res)=>res.json(tasks));
app.put('/tasks',       (req,res)=>{tasks=req.body||[];res.json({ok:true,count:tasks.length});});
app.post('/tasks',      (req,res)=>{
  const t={id:genId(),done:false,urgency:'normal',nagInterval:60,nagCount:0,
    snoozedUntil:null,dueFiredDays:[],assigneeId:null,assigneeName:null,
    created:new Date().toISOString(),...req.body};
  tasks.push(t); res.json(t);
});
app.patch('/tasks/:id', (req,res)=>{
  const i=tasks.findIndex(t=>t.id===req.params.id);
  if(i<0) return res.status(404).json({error:'not found'});
  tasks[i]={...tasks[i],...req.body}; res.json(tasks[i]);
});
app.delete('/tasks/:id',(req,res)=>{tasks=tasks.filter(t=>t.id!==req.params.id);res.json({ok:true});});

// ── DISCORD ENDPOINT ──────────────────────────────────────────────────────────
app.post('/discord', async (req,res) => {
  if (!verifyDiscord(req)) return res.status(401).send('Invalid signature');
  const body=Buffer.isBuffer(req.body)?JSON.parse(req.body.toString()):req.body;
  if (!body) return res.sendStatus(400);
  if (body.type===1) return res.json({type:1});

  // ── Slash commands
  if (body.type===2) {
    res.json({type:5});
    const cmd=body.data.name, token=body.token;
    const opts={};
    (body.data.options||[]).forEach(o=>{opts[o.name]=o.value;});
    const invoker=body.member?.user?.username||'Someone';
    const guildId=body.guild_id;

    if (cmd==='add') {
      pendingAdd={name:opts.task, token, guildId};
      await editInteractionReply(token,{content:`➕ **Adding:** ${opts.task}\n\n**How urgent is this?**`,components:urgencyRow()});
      return;
    }

    if (cmd==='assign') {
      const name=opts.task, member=body.data.resolved?.users?.[opts.member];
      const assigneeId=opts.member, assigneeName=member?.username||'Someone';
      pendingAdd={name, token, guildId, assigneeId, assigneeName};
      await editInteractionReply(token,{
        content:`➕ **Assigning to ${assigneeName}:** ${name}\n\n**How urgent is this?**`,
        components:urgencyRow()
      });
      return;
    }

    if (cmd==='setdue') {
      const n=(opts.number||1)-1;
      if(n<0||n>=tasks.length){await editInteractionReply(token,{content:'Invalid number. Use `/list` to see tasks.'});return;}
      const newDate=parseDate(opts.date||'');
      if(!newDate){await editInteractionReply(token,{content:`Couldn't parse that date. Try: \`2026-05-01\`, \`tomorrow\`, \`+7\``});return;}
      const t=tasks[n];
      const oldDate=t.due;
      t.due=newDate;
      t.dueFiredDays=[];  // reset warnings so they fire fresh
      const mention=t.assigneeId?`
<@${t.assigneeId}> — due date updated.`:'';
      await editInteractionReply(token,{
        embeds:[{
          title:`📅 Due date updated: ${t.name}`,
          description:`${oldDate?`~~${fmtDate(oldDate)}~~`:' No previous date'} → **${fmtDate(newDate)}**${mention}`,
          color:5793266, timestamp:new Date().toISOString()
        }],
        components:taskActionRow(t.id,t.assigneeId)
      });
      if(t.assigneeId) await sendDM(t.assigneeId,null,[{title:`📅 Due date changed: ${t.name}`,description:`New due date: **${fmtDate(newDate)}**`,color:5793266,timestamp:new Date().toISOString()}]);
      return;
    }

    if (cmd==='escalation') {
      const n=(opts.number||1)-1;
      if(n<0||n>=tasks.length){await editInteractionReply(token,{content:'Invalid number. Use `/list` to see tasks.'});return;}
      const t=tasks[n];
      t.escalationRules = {
        daysUrgent:  opts.days_urgent  ?? t.escalationRules?.daysUrgent  ?? 3,
        daysDefcon:  opts.days_defcon  ?? t.escalationRules?.daysDefcon  ?? 1,
        nagUrgent:   opts.nag_urgent   ?? t.escalationRules?.nagUrgent   ?? 30,
        nagDefcon:   opts.nag_defcon   ?? t.escalationRules?.nagDefcon   ?? 15,
      };
      const r=t.escalationRules;
      await editInteractionReply(token,{
        embeds:[{
          title:`⚙️ Escalation set: ${t.name}`,
          color:5793266,
          fields:[
            {name:'Bump to 🟡 Urgent',          value:`${r.daysUrgent} days before due`,  inline:true},
            {name:'Bump to 🔴 DROP EVERYTHING',  value:`${r.daysDefcon} day before due`,   inline:true},
            {name:'Nag interval when Urgent',    value:`Every ${r.nagUrgent} min`,         inline:true},
            {name:'Nag interval when Defcon',    value:`Every ${r.nagDefcon} min`,         inline:true},
          ],
          footer:{text:'Auto-escalation will fire at 9 AM on the threshold day.'},
          timestamp:new Date().toISOString()
        }]
      });
      return;
    }

    if (cmd==='list') {
      if (!tasks.length){await editInteractionReply(token,{content:'No tasks yet! Use `/add` or `/assign` to create one.'});return;}
      const lines=tasks.map((t,i)=>taskSummaryLine(t,i)).join('\n');
      await editInteractionReply(token,{embeds:[{title:`📋 All tasks (${tasks.length})`,description:lines,color:5793266,timestamp:new Date().toISOString()}]});
      return;
    }

    if (cmd==='pending') {
      const p=tasks.filter(t=>!t.done);
      if (!p.length){await editInteractionReply(token,{content:'🎉 No pending tasks! All clear.'});return;}
      const lines=p.map((t,i)=>taskSummaryLine(t,i)).join('\n');
      await editInteractionReply(token,{embeds:[{title:`📋 Pending (${p.length})`,description:lines,color:16776960,timestamp:new Date().toISOString()}]});
      return;
    }

    if (cmd==='mywork') {
      const userId=body.member?.user?.id;
      const mine=tasks.filter(t=>!t.done&&t.assigneeId===userId);
      if (!mine.length){await editInteractionReply(token,{content:'🎉 No tasks assigned to you right now!'});return;}
      const lines=mine.map((t,i)=>taskSummaryLine(t,i)).join('\n');
      await editInteractionReply(token,{embeds:[{title:`📋 Your tasks (${mine.length})`,description:lines,color:5793266,timestamp:new Date().toISOString()}]});
      return;
    }

    if (cmd==='done') {
      const n=(opts.number||1)-1;
      const pool=tasks.filter(t=>!t.done);
      if(n<0||n>=pool.length){await editInteractionReply(token,{content:'Invalid number. Use `/pending` to see the list.'});return;}
      pool[n].done=true; pool[n].nagCount=0;
      // stop any active chaos
      if (chaosMap[pool[n].id]){ clearInterval(chaosMap[pool[n].id].interval); delete chaosMap[pool[n].id]; }
      await editInteractionReply(token,{embeds:[{title:`✅ Done: ${pool[n].name}`,description:'Nice work! 💪',color:3066993,timestamp:new Date().toISOString()}]});
      await sendTelegram(`✅ Marked done from Discord: <b>${pool[n].name}</b> 💪`);
      return;
    }

    if (cmd==='delete') {
      const n=(opts.number||1)-1;
      if(n<0||n>=tasks.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      const removed=tasks.splice(n,1)[0];
      await editInteractionReply(token,{content:`🗑 Removed: **${removed.name}**`});
      return;
    }

    if (cmd==='snooze') {
      const n=(opts.number||1)-1;
      const pool=tasks.filter(t=>!t.done);
      if(n<0||n>=pool.length){await editInteractionReply(token,{content:'Invalid number.'});return;}
      pool[n].snoozedUntil=new Date(Date.now()+30*60*1000).toISOString();
      await editInteractionReply(token,{content:`⏸ Snoozed 30 min: **${pool[n].name}**\n\nI'll be back. 😏`});
      return;
    }

    if (cmd==='summary') { await sendSummary('manual',token); return; }
    return;
  }

  // ── Button interactions
  if (body.type===3) {
    res.json({type:6});
    const data=body.data.custom_id, token=body.token, msgId=body.message?.id;
    const invoker=body.member?.user?.username||'Your lead';
    const guildId=body.guild_id;

    // Urgency
    if (data.startsWith('urg_')&&pendingAdd) {
      pendingAdd.urgency=data.replace('urg_','');
      const assignTxt=pendingAdd.assigneeId?`\nAssigning to: **${pendingAdd.assigneeName}**`:'';
      await editInteractionReply(pendingAdd.token,{
        content:`➕ **Adding:** ${pendingAdd.name}${assignTxt}\n✅ Urgency: ${URGENCY[pendingAdd.urgency].label}\n\n**How often should I nag?**`,
        components:nagRow()
      });
      return;
    }

    // Nag interval
    if (data.startsWith('nag_')&&pendingAdd) {
      pendingAdd.nagInterval=parseInt(data.replace('nag_',''));
      const nagLabel=pendingAdd.nagInterval===0?'No auto-nag':`Every ${pendingAdd.nagInterval>=60?pendingAdd.nagInterval/60+' hr':pendingAdd.nagInterval+' min'}`;
      const assignTxt=pendingAdd.assigneeId?`\nAssigning to: **${pendingAdd.assigneeName}**`:'';
      await editInteractionReply(pendingAdd.token,{
        content:`➕ **Adding:** ${pendingAdd.name}${assignTxt}\n✅ Urgency: ${URGENCY[pendingAdd.urgency||'normal'].label}\n✅ Nag: ${nagLabel}\n\n**Does this have a due date?**`,
        components:dueDateRow()
      });
      return;
    }

    // Due date
    if (data.startsWith('due_')&&pendingAdd) {
      const val=data.replace('due_','');
      let due='';
      if (val!=='none'){ const d=new Date(); d.setDate(d.getDate()+parseInt(val)); due=d.toISOString().slice(0,10); }
      const t={
        id:genId(), done:false, name:pendingAdd.name,
        urgency:pendingAdd.urgency||'normal',
        nagInterval:pendingAdd.nagInterval||60,
        nagCount:0, snoozedUntil:null, dueFiredDays:[],
        assigneeId:pendingAdd.assigneeId||null,
        assigneeName:pendingAdd.assigneeName||null,
        client:'', due, notes:'', reminder:null,
        created:new Date().toISOString()
      };
      tasks.push(t);
      const nagLbl=t.nagInterval===0?'No auto-nag':`Every ${t.nagInterval>=60?t.nagInterval/60+' hr':t.nagInterval+' min'}`;
      const dueLbl=due?fmtDate(due):'No due date';
      const fields=[
        {name:'Urgency',      value:URGENCY[t.urgency].label, inline:true},
        {name:'Nag interval', value:nagLbl,                   inline:true},
        {name:'Due date',     value:dueLbl,                   inline:true},
      ];
      if (t.assigneeId) fields.push({name:'Assigned to',value:`<@${t.assigneeId}>`,inline:true});
      await editInteractionReply(pendingAdd.token,{
        content:'',
        embeds:[{title:`✅ Task added: ${t.name}`,color:URGENCY[t.urgency].color,fields,footer:{text:'Open the web app to set custom reminder schedules.'},timestamp:new Date().toISOString()}],
        components:taskActionRow(t.id,t.assigneeId)
      });
      // Notify assignee
      if (t.assigneeId) {
        await sendDM(t.assigneeId,null,[{
          title:`📋 New task assigned to you`,
          description:`**${t.name}**\n\nAssigned by **${invoker}**`,
          color:URGENCY[t.urgency].color,
          fields:[
            {name:'Urgency',  value:URGENCY[t.urgency].label, inline:true},
            {name:'Due date', value:dueLbl,                   inline:true},
          ],
          timestamp:new Date().toISOString()
        }]);
        await sendDiscord(`📋 <@${t.assigneeId}> — you've been assigned a new task: **${t.name}** (${URGENCY[t.urgency].label}${due?' · due '+dueLbl:''})`);
      }
      await sendTelegram(`✅ New task added from Discord: <b>${t.name}</b>${t.assigneeName?' → '+t.assigneeName:''}`);
      pendingAdd=null;
      return;
    }

    // Task actions
    if (data.startsWith('act_done_')) {
      const t=tasks.find(x=>x.id===data.replace('act_done_',''));
      if (t) {
        t.done=true; t.nagCount=0;
        if (chaosMap[t.id]){ clearInterval(chaosMap[t.id].interval); delete chaosMap[t.id]; }
        await editDiscordMsg(msgId,'',
          [{title:`✅ Done: ${t.name}`,description:`Marked done by <@${body.member?.user?.id||'someone'}>. Nice work! 💪`,color:3066993,timestamp:new Date().toISOString()}],
          []
        );
        await sendTelegram(`✅ Done from Discord: <b>${t.name}</b> 💪`);
      }
      return;
    }

    if (data.startsWith('act_snooze_')) {
      const t=tasks.find(x=>x.id===data.replace('act_snooze_',''));
      if (t) {
        t.snoozedUntil=new Date(Date.now()+30*60*1000).toISOString();
        await editDiscordMsg(msgId,'',
          [{title:`⏸ Snoozed: ${t.name}`,description:"I'll be back. 😏",color:5793266}],
          []
        );
      }
      return;
    }

    if (data.startsWith('act_delete_')) {
      const id=data.replace('act_delete_',''), t=tasks.find(x=>x.id===id);
      if (t) {
        tasks=tasks.filter(x=>x.id!==id);
        if (chaosMap[id]){ clearInterval(chaosMap[id].interval); delete chaosMap[id]; }
        await editDiscordMsg(msgId,`🗑 Removed: **${t.name}**`,[],[]);
      }
      return;
    }

    // 📅 Change due date — show picker
    if (data.startsWith('act_changedue_')) {
      const taskId=data.replace('act_changedue_','');
      const t=tasks.find(x=>x.id===taskId);
      if (t) {
        await editDiscordMsg(msgId,
          `📅 **Change due date for: ${t.name}**${t.due?`
Current: **${fmtDate(t.due)}**`:''}`,
          [], changeDueDateRow(taskId)
        );
      }
      return;
    }

    // 📅 Due date change confirmed via picker
    if (data.startsWith('chgdue_')) {
      const parts=data.split('_'); parts.shift(); // remove 'chgdue'
      const val=parts.pop(); // last part is the days offset or 'none'
      const taskId=parts.join('_');
      const t=tasks.find(x=>x.id===taskId);
      if (t) {
        let newDate='';
        if (val!=='none') { const d=new Date(); d.setDate(d.getDate()+parseInt(val)); newDate=d.toISOString().slice(0,10); }
        const oldDate=t.due;
        t.due=newDate;
        t.dueFiredDays=[]; // reset warnings
        const dueLbl=newDate?fmtDate(newDate):'No due date';
        await editDiscordMsg(msgId,'',
          [{title:`📅 Due date updated: ${t.name}`,description:`${oldDate?`~~${fmtDate(oldDate)}~~ → `:' '}**${dueLbl}**`,color:5793266,timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        if(t.assigneeId) await sendDM(t.assigneeId,null,[{title:`📅 Due date changed: ${t.name}`,description:`New due date: **${dueLbl}**`,color:5793266,timestamp:new Date().toISOString()}]);
      }
      return;
    }

    // ☎️ CALL THEM — maximum chaos
    if (data.startsWith('act_call_')) {
      const t=tasks.find(x=>x.id===data.replace('act_call_',''));
      if (t) {
        await editDiscordMsg(msgId,'',
          [{title:`☎️ CALLING: ${t.name}`,description:`Chaos mode activated by **${invoker}** — <@${t.assigneeId}> is being summoned. 🚨`,color:15158332,timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        await triggerChaosCall(t, guildId, invoker);
      }
      return;
    }
    return;
  }
  res.sendStatus(200);
});

// ── TELEGRAM WEBHOOK (backup) ─────────────────────────────────────────────────
app.post('/webhook', async (req,res) => {
  res.sendStatus(200);
  const body=req.body;
  if (body.callback_query) {
    const cb=body.callback_query, data=cb.data, msgId=cb.message?.message_id;
    await tgReq('answerCallbackQuery',{callback_query_id:cb.id,text:''});
    if(data.startsWith('act_done_')){const t=tasks.find(x=>x.id===data.replace('act_done_',''));if(t){t.done=true;t.nagCount=0;if(chaosMap[t.id]){clearInterval(chaosMap[t.id].interval);delete chaosMap[t.id];}await tgReq('editMessageText',{chat_id:TG_CHAT_ID,message_id:msgId,text:`✅ Done: <b>${t.name}</b>`,parse_mode:'HTML'});}}
    if(data.startsWith('act_snooze_')){const t=tasks.find(x=>x.id===data.replace('act_snooze_',''));if(t){t.snoozedUntil=new Date(Date.now()+30*60*1000).toISOString();await tgReq('editMessageText',{chat_id:TG_CHAT_ID,message_id:msgId,text:`⏸ Snoozed: <b>${t.name}</b>`,parse_mode:'HTML'});}}
    if(data.startsWith('act_delete_')){const id=data.replace('act_delete_','');const t=tasks.find(x=>x.id===id);if(t){tasks=tasks.filter(x=>x.id!==id);await tgReq('editMessageText',{chat_id:TG_CHAT_ID,message_id:msgId,text:`🗑 Removed: <b>${t.name}</b>`,parse_mode:'HTML'});}}
    return;
  }
  const msg=body.message;
  if(!msg) return;
  if(TG_CHAT_ID&&String(msg.chat.id)!==TG_CHAT_ID) return;
  const text=(msg.text||'').trim(), lower=text.toLowerCase();
  if(text==='/start'||text==='/help'){await sendTelegram(`👋 <b>Taskmaster backup channel</b>\n\nPrimary is Discord. Quick commands:\n/list — all tasks\n/pending — pending only\n/done [number] — mark done\n/summary — summary\n\nOr reply <i>"done"</i> to mark top task complete.`);return;}
  if(text==='/list'){if(!tasks.length){await sendTelegram('No tasks yet!');return;}const lines=tasks.map((t,i)=>`${i+1}. ${t.done?'✅':'⬜'} ${t.name}${t.assigneeName?' → '+t.assigneeName:''}`).join('\n');await sendTelegram(`📋 <b>All tasks (${tasks.length})</b>\n\n${lines}`);return;}
  if(text==='/pending'){const p=tasks.filter(t=>!t.done);if(!p.length){await sendTelegram('🎉 All clear!');return;}const lines=p.map((t,i)=>`${i+1}. ${t.name}${t.assigneeName?' → '+t.assigneeName:''}`).join('\n');await sendTelegram(`📋 <b>Pending (${p.length})</b>\n\n${lines}`);return;}
  if(text==='/summary'){await sendSummary();return;}
  if(lower==='done'){const p=tasks.filter(t=>!t.done);if(p.length){p[0].done=true;await sendTelegram(`✅ Done: <b>${p[0].name}</b> 💪`);}return;}
  if(text.startsWith('/done')){const n=parseInt(text.split(' ')[1])-1;const p=tasks.filter(t=>!t.done);if(n>=0&&n<p.length){p[n].done=true;await sendTelegram(`✅ Done: <b>${p[n].name}</b> 💪`);}return;}
  await sendTelegram("Use Discord for full task management. Type /help for quick commands.");
});

// ── SUMMARY ───────────────────────────────────────────────────────────────────
async function sendSummary(type='manual', interactionToken) {
  const pending=tasks.filter(t=>!t.done), done=tasks.filter(t=>t.done);
  const overdue=pending.filter(t=>t.due&&daysUntil(t.due)<0);
  const dueToday=pending.filter(t=>t.due&&daysUntil(t.due)===0);
  const defcon=pending.filter(t=>t.urgency==='defcon');
  const urgent=pending.filter(t=>t.urgency==='urgent');
  const normal=pending.filter(t=>t.urgency==='normal');
  const unassigned=pending.filter(t=>!t.assigneeId);
  const assigned=pending.filter(t=>t.assigneeId);

  const title=type==='morning'?'☀️ Good morning — here\'s your day':type==='evening'?'🌙 End of day wrap-up':'📋 Task summary';
  const color=overdue.length?15158332:pending.length?16776960:3066993;
  const fields=[];
  if(overdue.length)   fields.push({name:`🔥 Overdue (${overdue.length})`,        value:overdue.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''} — was due ${fmtDate(t.due)}`).join('\n'),inline:false});
  if(dueToday.length)  fields.push({name:`🚨 Due today (${dueToday.length})`,      value:dueToday.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(defcon.length)    fields.push({name:`🔴 Drop everything (${defcon.length})`,  value:defcon.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(urgent.length)    fields.push({name:`🟡 Urgent (${urgent.length})`,           value:urgent.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(normal.length)    fields.push({name:`🟢 Normal (${normal.length})`,           value:normal.map(t=>`• **${t.name}**${t.assigneeName?' → '+t.assigneeName:''}`).join('\n'),inline:false});
  if(assigned.length)  fields.push({name:`👥 Assigned to team (${assigned.length})`,value:assigned.map(t=>`• **${t.name}** → <@${t.assigneeId}>`).join('\n'),inline:false});
  if(unassigned.length)fields.push({name:`👤 Unassigned (${unassigned.length})`,   value:unassigned.map(t=>`• **${t.name}**`).join('\n'),inline:false});
  if(type==='evening'&&done.length) fields.push({name:`✅ Completed today (${done.length})`,value:done.map(t=>`• ${t.name}`).join('\n'),inline:false});
  if(!fields.length)   fields.push({name:'Status',value:'🎉 All clear!',inline:false});

  const embed={title,color,fields,timestamp:new Date().toISOString()};
  if (interactionToken) await editInteractionReply(interactionToken,{embeds:[embed]});
  else await sendDiscord(null,[embed]);

  let tgMsg=type==='morning'?'☀️ <b>Good morning!</b>\n\n':type==='evening'?'🌙 <b>End of day:</b>\n\n':'📋 <b>Summary:</b>\n\n';
  if(overdue.length)  tgMsg+=`🔥 <b>Overdue:</b> ${overdue.map(t=>t.name).join(', ')}\n`;
  if(dueToday.length) tgMsg+=`🚨 <b>Due today:</b> ${dueToday.map(t=>t.name).join(', ')}\n`;
  if(assigned.length) tgMsg+=`👥 <b>Assigned to team:</b> ${assigned.map(t=>t.name+' → '+(t.assigneeName||'someone')).join(', ')}\n`;
  if(pending.length)  tgMsg+=`📌 <b>${pending.length} pending</b>`;
  else                tgMsg+=`🎉 All clear!`;
  await sendTelegram(tgMsg);
}

// ── SCHEDULED JOBS ─────────────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now=new Date(), hhmm=`${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const today=days[now.getDay()], date=now.toISOString().slice(0,10), dom=now.getDate(), nowMs=now.getTime();

  for (const t of tasks) {
    if (t.done) continue;
    if (t.snoozedUntil&&new Date(t.snoozedUntil)>now) continue;
    if (t.snoozedUntil&&new Date(t.snoozedUntil)<=now) t.snoozedUntil=null;

    // Due date warnings at 9 AM
    if (t.due&&hhmm==='09:00') {
      t.dueFiredDays=t.dueFiredDays||[];
      const dl=daysUntil(t.due);
      const checks=[{key:'week',days:7},{key:'days3',days:3},{key:'day1',days:1},{key:'today',days:0},{key:'overdue',days:-99}];
      for (const c of checks) {
        const should=c.key==='overdue'?dl<0:dl===c.days;
        const fireKey=`${c.key}_${date}`;
        if (should&&!t.dueFiredDays.includes(fireKey)) {
          t.dueFiredDays.push(fireKey);
          if (c.key==='overdue'&&t.nagInterval>0) t.nagInterval=Math.max(15,Math.floor(t.nagInterval/2));
          const msgTxt=c.key==='today'?DUE_WARNINGS.today(t.name):DUE_WARNINGS[c.key](t.name,fmtDate(t.due));
          const color=c.key==='overdue'||c.key==='today'?15158332:c.key==='day1'?16776960:3066993;
          const mention=t.assigneeId?`<@${t.assigneeId}> — `:'';
          await sendDiscord(t.assigneeId?`<@${t.assigneeId}>`:null,
            [{title:`📅 Due date alert: ${t.name}`,description:mention+msgTxt,color,
              fields:[
                {name:'Due',     value:fmtDate(t.due),                        inline:true},
                {name:'Urgency', value:URGENCY[t.urgency||'normal'].label,    inline:true},
                ...(t.assigneeId?[{name:'Assigned to',value:`<@${t.assigneeId}>`,inline:true}]:[])
              ],timestamp:new Date().toISOString()}],
            taskActionRow(t.id,t.assigneeId)
          );
          if (t.assigneeId) await sendDM(t.assigneeId,null,[{title:`📅 Due date alert: ${t.name}`,description:msgTxt,color,timestamp:new Date().toISOString()}]);
          await sendTelegram(msgTxt.replace(/\*\*/g,'').replace(/\*/g,''));
          break;
        }
      }
    }

    // Auto-escalation based on custom thresholds
    if (t.due && t.escalationRules) {
      const dl=daysUntil(t.due);
      const r=t.escalationRules;
      t.escalationFired=t.escalationFired||{};
      // Bump to defcon
      if (dl!==null && dl<=r.daysDefcon && t.urgency!=='defcon' && !t.escalationFired.defcon) {
        t.escalationFired.defcon=true;
        t.urgency='defcon';
        t.nagInterval=r.nagDefcon;
        const mention=t.assigneeId?`<@${t.assigneeId}> `:'' ;
        await sendDiscord(t.assigneeId?`<@${t.assigneeId}>`:null,
          [{title:`🚨 AUTO-ESCALATED: ${t.name}`,
            description:`${mention}This task just hit **DROP EVERYTHING** level.

> Due: **${fmtDate(t.due)}** (${dl===0?'today':`${dl} day${Math.abs(dl)===1?'':'s'} away`})
> Nag interval tightened to **every ${r.nagDefcon} min**`,
            color:15158332, timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        if(t.assigneeId) await sendDM(t.assigneeId,null,[{title:`🚨 Task escalated to DROP EVERYTHING: ${t.name}`,description:`Due: **${fmtDate(t.due)}**. Sort it out NOW.`,color:15158332,timestamp:new Date().toISOString()}]);
        await sendTelegram(`🚨 AUTO-ESCALATED to DROP EVERYTHING: <b>${t.name}</b> — due ${fmtDate(t.due)}`);
      }
      // Bump to urgent (only if not already higher)
      else if (dl!==null && dl<=r.daysUrgent && t.urgency==='normal' && !t.escalationFired.urgent) {
        t.escalationFired.urgent=true;
        t.urgency='urgent';
        t.nagInterval=r.nagUrgent;
        const mention=t.assigneeId?`<@${t.assigneeId}> `:'' ;
        await sendDiscord(t.assigneeId?`<@${t.assigneeId}>`:null,
          [{title:`⚡ AUTO-ESCALATED: ${t.name}`,
            description:`${mention}This task just bumped to **Urgent**.

> Due: **${fmtDate(t.due)}** (${dl} day${Math.abs(dl)===1?'':'s'} away)
> Nag interval tightened to **every ${r.nagUrgent} min**`,
            color:16776960, timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        if(t.assigneeId) await sendDM(t.assigneeId,null,[{title:`⚡ Task escalated to Urgent: ${t.name}`,description:`Due: **${fmtDate(t.due)}** in ${dl} day${Math.abs(dl)===1?'':'s'}. Get moving.`,color:16776960,timestamp:new Date().toISOString()}]);
        await sendTelegram(`⚡ AUTO-ESCALATED to Urgent: <b>${t.name}</b> — due in ${dl} day${Math.abs(dl)===1?'':'s'}`);
      }
    }

    // Interval nag
    if (t.nagInterval&&t.nagInterval>0) {
      const lastNag=t.lastNagAt?new Date(t.lastNagAt).getTime():0;
      if (nowMs-lastNag>=t.nagInterval*60*1000) {
        t.nagCount=(t.nagCount||0)+1;
        t.lastNagAt=now.toISOString();
        const urg=URGENCY[t.urgency||'normal'];
        let stage=urg.escalation[0];
        for (const s of urg.escalation){if(t.nagCount>=s.after)stage=s;}
        const msgTxt=stage.msg(t.name);
        const mention=t.assigneeId?`<@${t.assigneeId}> `:'' ;
        await sendDiscord(t.assigneeId?`<@${t.assigneeId}>`:null,
          [{title:`🔔 Nag #${t.nagCount}: ${t.name}`,description:mention+msgTxt,color:urg.color,
            fields:[
              ...(t.due?[{name:'Due',value:fmtDate(t.due),inline:true}]:[]),
              ...(t.assigneeId?[{name:'Assigned to',value:`<@${t.assigneeId}>`,inline:true}]:[])
            ],timestamp:new Date().toISOString()}],
          taskActionRow(t.id,t.assigneeId)
        );
        if (t.assigneeId) await sendDM(t.assigneeId,null,[{title:`🔔 Reminder: ${t.name}`,description:msgTxt,color:urg.color,timestamp:new Date().toISOString()}]);
        await sendTelegram(msgTxt.replace(/\*\*/g,'').replace(/\*/g,''));
      }
    }

    // Scheduled reminders (from web app)
    const r=t.reminder;
    if(!r||r.freq==='none') continue;
    let fire=false,key='';
    if(r.freq==='daily'){const aT=[...(r.slots||[]),...(r.customTimes||[])];for(const tm of aT){if(tm===hhmm){fire=true;key=`d_${tm}_${date}`;break;}}}
    else if(r.freq==='weekly'){if((r.days||[]).includes(today)&&r.time===hhmm){fire=true;key=`w_${date}_${hhmm}`;}}
    else if(r.freq==='monthly'){const mD=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();const tgt=Math.min(r.day||1,mD);if(dom===tgt&&r.time===hhmm){fire=true;key=`m_${date}_${hhmm}`;}}
    else if(r.freq==='once'){if(r.date===date&&r.time===hhmm){fire=true;key=`o_${date}_${hhmm}`;}}
    if(fire&&key){r.firedIds=r.firedIds||[];if(!r.firedIds.includes(key)){r.firedIds.push(key);const mention=t.assigneeId?`<@${t.assigneeId}>`:null;await sendDiscord(mention,[{title:`🔔 Scheduled reminder: ${t.name}`,color:5793266,timestamp:new Date().toISOString()}],taskActionRow(t.id,t.assigneeId));}}
  }
});

cron.schedule('0 7  * * *', ()=>sendSummary('morning'));
cron.schedule('0 18 * * *', ()=>sendSummary('evening'));

app.listen(PORT, async () => {
  console.log(`Taskmaster running on port ${PORT} 🔥`);
  await registerCommands();
});
