const express   = require('express');
const cors      = require('cors');
const cron      = require('node-cron');
const fetch     = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const nacl      = require('tweetnacl');

const app = express();
app.use(cors());

// Raw body needed for Discord signature verification
app.use('/discord', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── DISCORD SIGNATURE VERIFICATION ───────────────────────────────────────────
function verifyDiscordRequest(req) {
  const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
  if (!PUBLIC_KEY) return true; // skip if not set
  const sig       = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (!sig || !timestamp) return false;
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + body.toString()),
      Buffer.from(sig,        'hex'),
      Buffer.from(PUBLIC_KEY, 'hex')
    );
  } catch(e) { return false; }
}

// ── ENV ───────────────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.BOT_TOKEN;        // Telegram (backup)
const TG_CHAT_ID      = process.env.CHAT_ID;          // Telegram chat ID
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;    // Discord bot token
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL;  // Discord channel ID
const DISCORD_APP_ID  = process.env.DISCORD_APP_ID;   // Discord application ID
const PORT            = process.env.PORT || 3000;

let tasks      = [];
let pendingAdd = null; // Telegram pending session

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
      {after:4, msg:n=>`😡 **"${n}"** IS URGENT AND YOU KEEP IGNORING IT. SORT IT OUT.`},
      {after:7, msg:n=>`🔥🔥🔥 **"${n}"** — at what point does urgent mean urgent to you??`},
    ]
  },
  defcon: {
    label:'🔴 DROP EVERYTHING', color:15158332,
    escalation:[
      {after:0, msg:n=>`🚨🚨 **DROP EVERYTHING: "${n}"** — stop what you're doing. Right now.`},
      {after:1, msg:n=>`💀 **"${n}"** — whatever you're doing is less important. STOP. DO THIS.`},
      {after:2, msg:n=>`☢️ **DEFCON 1: "${n}"** is on fire. You are on fire. Everything is on fire. FIX IT.`},
      {after:3, msg:n=>`🆘🆘🆘 **"${n}"** — I have run out of ways to tell you how important this is. PLEASE.`},
    ]
  }
};

const DUE_WARNINGS = {
  week:    (n,d) => `📅 **1 week to go:** **"${n}"** is due ${d}. You've got time — but not that much.`,
  days3:   (n,d) => `📅 **3 days left:** **"${n}"** is due ${d}. Start wrapping this up.`,
  day1:    (n,d) => `⚠️ **Due TOMORROW:** **"${n}"** is due ${d}. Get it done.`,
  today:   (n)   => `🚨 **DUE TODAY: "${n}"** — this needs to be done before end of day. No excuses.`,
  overdue: (n,d) => `🔥 **OVERDUE: "${n}"** was due ${d}. It's late. Get it done NOW.`,
};

// ── FORMAT HELPERS ────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((new Date(iso+'T00:00:00')-today)/86400000);
}
function urgencyEmoji(u){ return u==='defcon'?'🔴':u==='urgent'?'🟡':'🟢'; }
function taskSummaryLine(t,i){
  const done   = t.done?'✅':'⬜';
  const urg    = urgencyEmoji(t.urgency||'normal');
  const client = t.client?` [${t.client}]`:'';
  const due    = t.due?` · due ${fmtDate(t.due)}`:'';
  const num    = i!==undefined?`${i+1}. `:'';
  return `${num}${done} ${urg} **${t.name}**${client}${due}`;
}

// ── DISCORD API ───────────────────────────────────────────────────────────────
async function discordRequest(method, path, body) {
  if (!DISCORD_TOKEN) return null;
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers:{ 'Authorization':`Bot ${DISCORD_TOKEN}`, 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : undefined
  }).catch(console.error);
  return r ? r.json().catch(()=>null) : null;
}

async function sendDiscord(content, embeds, components) {
  if (!DISCORD_CHANNEL) return null;
  const body = {};
  if (content)    body.content    = content;
  if (embeds)     body.embeds     = embeds;
  if (components) body.components = components;
  return discordRequest('POST', `/channels/${DISCORD_CHANNEL}/messages`, body);
}

async function editDiscordMsg(msgId, content, embeds, components) {
  if (!DISCORD_CHANNEL) return;
  const body = {};
  if (content!==undefined)    body.content    = content;
  if (embeds!==undefined)     body.embeds     = embeds;
  if (components!==undefined) body.components = components;
  return discordRequest('PATCH', `/channels/${DISCORD_CHANNEL}/messages/${msgId}`, body);
}

async function respondInteraction(id, token, data) {
  return fetch(`https://discord.com/api/v10/interactions/${id}/${token}/callback`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type:4, data })
  }).catch(console.error);
}

async function editInteractionReply(token, data) {
  return fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`, {
    method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(data)
  }).catch(console.error);
}

// Register slash commands on startup
async function registerCommands() {
  if (!DISCORD_TOKEN||!DISCORD_APP_ID) return;
  const commands = [
    { name:'add',     description:'Add a new task',        options:[{name:'task',type:3,description:'Task name',required:true}] },
    { name:'list',    description:'Show all tasks' },
    { name:'pending', description:'Show pending tasks only' },
    { name:'done',    description:'Mark a task as done',   options:[{name:'number',type:4,description:'Task number from /pending',required:true}] },
    { name:'delete',  description:'Delete a task',         options:[{name:'number',type:4,description:'Task number from /list',required:true}] },
    { name:'snooze',  description:'Snooze a task 30 min',  options:[{name:'number',type:4,description:'Task number from /pending',required:true}] },
    { name:'summary', description:'Get your task summary' },
  ];
  await discordRequest('PUT', `/applications/${DISCORD_APP_ID}/commands`, commands);
  console.log('Discord slash commands registered');
}

// ── DISCORD COMPONENT BUILDERS ────────────────────────────────────────────────
function urgencyRow() {
  return [{
    type:1, components:[
      {type:2, style:3, label:'🟢 Normal',          custom_id:'urg_normal'},
      {type:2, style:1, label:'🟡 Urgent',          custom_id:'urg_urgent'},
      {type:2, style:4, label:'🔴 DROP EVERYTHING', custom_id:'urg_defcon'},
    ]
  }];
}

function nagRow() {
  return [
    {type:1, components:[
      {type:2, style:2, label:'Every 15 min', custom_id:'nag_15'},
      {type:2, style:2, label:'Every 30 min', custom_id:'nag_30'},
      {type:2, style:2, label:'Every hour',   custom_id:'nag_60'},
      {type:2, style:2, label:'Every 2 hrs',  custom_id:'nag_120'},
    ]},
    {type:1, components:[
      {type:2, style:2, label:'No auto-nag',  custom_id:'nag_0'},
    ]}
  ];
}

function taskActionRow(taskId) {
  return [{
    type:1, components:[
      {type:2, style:3, label:'✅ Done',        custom_id:`act_done_${taskId}`},
      {type:2, style:2, label:'⏸ Snooze 30m',  custom_id:`act_snooze_${taskId}`},
      {type:2, style:4, label:'🗑 Delete',      custom_id:`act_delete_${taskId}`},
    ]
  }];
}

function taskEmbed(t, title) {
  const urg = URGENCY[t.urgency||'normal'];
  const fields = [
    {name:'Urgency',  value:urg.label,                          inline:true},
    {name:'Status',   value:t.done?'✅ Done':'⏳ Pending',      inline:true},
  ];
  if (t.client)      fields.push({name:'Project/Client', value:t.client,        inline:true});
  if (t.due)         fields.push({name:'Due date',       value:fmtDate(t.due),  inline:true});
  if (t.nagInterval) fields.push({name:'Nag interval',   value:t.nagInterval===0?'None':`Every ${t.nagInterval>=60?t.nagInterval/60+' hr':t.nagInterval+' min'}`, inline:true});
  if (t.notes)       fields.push({name:'Notes',          value:t.notes,         inline:false});
  return { title: title||t.name, color: urg.color, fields, timestamp:new Date().toISOString() };
}

// ── TELEGRAM HELPERS (backup) ─────────────────────────────────────────────────
async function tgRequest(method, body) {
  if (!BOT_TOKEN) return null;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  }).catch(console.error);
  return r ? r.json().catch(()=>null) : null;
}
async function sendTelegram(text, extra={}) {
  if (!TG_CHAT_ID) return;
  return tgRequest('sendMessage',{chat_id:TG_CHAT_ID,text,parse_mode:'HTML',...extra});
}
async function tgActionKeyboard(taskId) {
  return {inline_keyboard:[[
    {text:'✅ Done',      callback_data:`act_done_${taskId}`},
    {text:'⏸ Snooze 30m',callback_data:`act_snooze_${taskId}`},
    {text:'🗑 Delete',    callback_data:`act_delete_${taskId}`},
  ]]};
}

// ── NOTIFY BOTH ───────────────────────────────────────────────────────────────
async function notify(discordEmbeds, discordComponents, tgText, tgExtra) {
  if (discordEmbeds || discordComponents) {
    await sendDiscord(null, discordEmbeds, discordComponents);
  }
  if (tgText) await sendTelegram(tgText, tgExtra||{});
}

// ── REST ROUTES ───────────────────────────────────────────────────────────────
app.get('/',             (_,res)=>res.json({status:'Taskmaster running 🔥'}));
app.get('/tasks',        (_,res)=>res.json(tasks));
app.put('/tasks',        (req,res)=>{tasks=req.body||[];res.json({ok:true,count:tasks.length});});
app.post('/tasks',       (req,res)=>{
  const t={id:genId(),done:false,urgency:'normal',nagInterval:60,nagCount:0,snoozedUntil:null,dueFiredDays:[],created:new Date().toISOString(),...req.body};
  tasks.push(t); res.json(t);
});
app.patch('/tasks/:id',  (req,res)=>{
  const i=tasks.findIndex(t=>t.id===req.params.id);
  if(i<0) return res.status(404).json({error:'not found'});
  tasks[i]={...tasks[i],...req.body}; res.json(tasks[i]);
});
app.delete('/tasks/:id', (req,res)=>{tasks=tasks.filter(t=>t.id!==req.params.id);res.json({ok:true});});

// ── DISCORD INTERACTIONS ENDPOINT ─────────────────────────────────────────────
app.post("/discord", async (req,res) => {
  if (!verifyDiscordRequest(req)) return res.status(401).send("Invalid request signature");
  const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  if (!body) return res.sendStatus(400);
  if (body.type===1) return res.json({type:1});

  // Slash commands
  if (body.type===2) {
    res.json({type:5}); // defer reply
    const cmd   = body.data.name;
    const token = body.token;
    const opts  = {};
    (body.data.options||[]).forEach(o=>{ opts[o.name]=o.value; });

    if (cmd==='add') {
      const name = opts.task;
      // store pending keyed by token
      pendingAdd = { name, token };
      await editInteractionReply(token, {
        content: `➕ **Adding:** ${name}\n\n**How urgent is this?**`,
        components: urgencyRow()
      });
      return;
    }

    if (cmd==='list') {
      if (!tasks.length) { await editInteractionReply(token,{content:'No tasks yet! Use `/add` to create one.'}); return; }
      const lines = tasks.map((t,i)=>taskSummaryLine(t,i)).join('\n');
      await editInteractionReply(token,{
        embeds:[{title:`📋 All tasks (${tasks.length})`, description:lines, color:5793266, timestamp:new Date().toISOString()}]
      });
      return;
    }

    if (cmd==='pending') {
      const p = tasks.filter(t=>!t.done);
      if (!p.length) { await editInteractionReply(token,{content:'🎉 No pending tasks! You\'re all clear.'}); return; }
      const lines = p.map((t,i)=>taskSummaryLine(t,i)).join('\n');
      await editInteractionReply(token,{
        embeds:[{title:`📋 Pending tasks (${p.length})`, description:lines, color:16776960, timestamp:new Date().toISOString()}]
      });
      return;
    }

    if (cmd==='done') {
      const n = (opts.number||1)-1;
      const pool = tasks.filter(t=>!t.done);
      if (n<0||n>=pool.length) { await editInteractionReply(token,{content:'Invalid number. Use `/pending` to see the list.'}); return; }
      pool[n].done=true; pool[n].nagCount=0;
      await editInteractionReply(token,{
        embeds:[{title:`✅ Done: ${pool[n].name}`, description:'Nice work! 💪', color:3066993, timestamp:new Date().toISOString()}]
      });
      await sendTelegram(`✅ Marked done from Discord: <b>${pool[n].name}</b> 💪`);
      return;
    }

    if (cmd==='delete') {
      const n = (opts.number||1)-1;
      if (n<0||n>=tasks.length) { await editInteractionReply(token,{content:'Invalid number. Use `/list` to see tasks.'}); return; }
      const removed = tasks.splice(n,1)[0];
      await editInteractionReply(token,{content:`🗑 Removed: **${removed.name}**`});
      return;
    }

    if (cmd==='snooze') {
      const n = (opts.number||1)-1;
      const pool = tasks.filter(t=>!t.done);
      if (n<0||n>=pool.length) { await editInteractionReply(token,{content:'Invalid number. Use `/pending` to see the list.'}); return; }
      pool[n].snoozedUntil=new Date(Date.now()+30*60*1000).toISOString();
      await editInteractionReply(token,{content:`⏸ Snoozed 30 min: **${pool[n].name}**\n\nI'll be back. 😏`});
      return;
    }

    if (cmd==='summary') { await sendSummary('manual', token); return; }
    return;
  }

  // Component interactions (button clicks)
  if (body.type===3) {
    res.json({type:6}); // defer update
    const data    = body.data.custom_id;
    const token   = body.token;
    const msgId   = body.message?.id;

    // Urgency selection (from /add flow)
    if (data.startsWith('urg_') && pendingAdd) {
      const urg = data.replace('urg_','');
      pendingAdd.urgency = urg;
      await editInteractionReply(pendingAdd.token, {
        content:`➕ **Adding:** ${pendingAdd.name}\n✅ Urgency: ${URGENCY[urg].label}\n\n**How often should I nag you?**`,
        components: nagRow()
      });
      return;
    }

    // Nag interval selection
    if (data.startsWith('nag_') && pendingAdd) {
      const interval = parseInt(data.replace('nag_',''));
      const t = {
        id:genId(), done:false, name:pendingAdd.name,
        urgency:pendingAdd.urgency||'normal',
        nagInterval:interval, nagCount:0, snoozedUntil:null,
        dueFiredDays:[], client:'', due:'', notes:'', reminder:null,
        created:new Date().toISOString()
      };
      tasks.push(t);
      const nagLabel = interval===0?'No auto-nag':`Every ${interval>=60?interval/60+' hr':interval+' min'}`;
      await editInteractionReply(pendingAdd.token, {
        content:'',
        embeds:[{
          title:`✅ Task added: ${t.name}`,
          color: URGENCY[t.urgency].color,
          fields:[
            {name:'Urgency',      value:URGENCY[t.urgency].label, inline:true},
            {name:'Nag interval', value:nagLabel,                 inline:true},
          ],
          footer:{text:'Open the web app to set a due date and reminder schedule.'},
          timestamp:new Date().toISOString()
        }],
        components: taskActionRow(t.id)
      });
      await sendTelegram(`✅ New task added from Discord: <b>${t.name}</b> (${URGENCY[t.urgency].label})`);
      pendingAdd = null;
      return;
    }

    // Task actions
    if (data.startsWith('act_done_')) {
      const t = tasks.find(x=>x.id===data.replace('act_done_',''));
      if (t) {
        t.done=true; t.nagCount=0;
        await editDiscordMsg(msgId, '',
          [{title:`✅ Done: ${t.name}`, description:'Nice work! 💪', color:3066993, timestamp:new Date().toISOString()}],
          []
        );
        await sendTelegram(`✅ Marked done from Discord: <b>${t.name}</b> 💪`);
      }
      return;
    }
    if (data.startsWith('act_snooze_')) {
      const t = tasks.find(x=>x.id===data.replace('act_snooze_',''));
      if (t) {
        t.snoozedUntil=new Date(Date.now()+30*60*1000).toISOString();
        await editDiscordMsg(msgId,'',
          [{title:`⏸ Snoozed: ${t.name}`, description:"I'll be back. 😏", color:5793266}],
          []
        );
      }
      return;
    }
    if (data.startsWith('act_delete_')) {
      const id = data.replace('act_delete_','');
      const t  = tasks.find(x=>x.id===id);
      if (t) {
        tasks=tasks.filter(x=>x.id!==id);
        await editDiscordMsg(msgId,`🗑 Removed: **${t.name}**`,[],[]);
      }
      return;
    }
    return;
  }

  res.sendStatus(200);
});

// ── TELEGRAM WEBHOOK (backup channel) ────────────────────────────────────────
app.post('/webhook', async (req,res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.callback_query) {
    const cb    = body.callback_query;
    const data  = cb.data;
    const msgId = cb.message?.message_id;
    await tgRequest('answerCallbackQuery',{callback_query_id:cb.id,text:''});

    if (data.startsWith('act_done_')) {
      const t=tasks.find(x=>x.id===data.replace('act_done_',''));
      if(t){t.done=true;t.nagCount=0;await tgRequest('editMessageText',{chat_id:TG_CHAT_ID,message_id:msgId,text:`✅ Done: <b>${t.name}</b>\n\nNice work! 💪`,parse_mode:'HTML'});}
    }
    if (data.startsWith('act_snooze_')) {
      const t=tasks.find(x=>x.id===data.replace('act_snooze_',''));
      if(t){t.snoozedUntil=new Date(Date.now()+30*60*1000).toISOString();await tgRequest('editMessageText',{chat_id:TG_CHAT_ID,message_id:msgId,text:`⏸ Snoozed 30 min: <b>${t.name}</b>`,parse_mode:'HTML'});}
    }
    if (data.startsWith('act_delete_')) {
      const id=data.replace('act_delete_','');const t=tasks.find(x=>x.id===id);
      if(t){tasks=tasks.filter(x=>x.id!==id);await tgRequest('editMessageText',{chat_id:TG_CHAT_ID,message_id:msgId,text:`🗑 Removed: <b>${t.name}</b>`,parse_mode:'HTML'});}
    }
    return;
  }

  const msg = body.message;
  if (!msg) return;
  if (TG_CHAT_ID && String(msg.chat.id)!==TG_CHAT_ID) return;
  const text  = (msg.text||'').trim();
  const lower = text.toLowerCase();

  if (text==='/start'||text==='/help') {
    await sendTelegram(`👋 <b>Taskmaster backup channel</b>\n\nPrimary channel is Discord — use slash commands there.\n\nFor quick actions here:\n/list — all tasks\n/pending — pending only\n/done [number] — mark done\n/summary — task summary\n\nOr just reply <i>"done"</i> to mark the top task complete.`);
    return;
  }
  if (text==='/list'){ const lines=tasks.map((t,i)=>taskSummaryLine(t,i).replace(/\*\*/g,'<b>').replace(/<\/b>/g,'</b>')).join('\n'); await sendTelegram(`📋 <b>All tasks (${tasks.length})</b>\n\n${lines}`); return; }
  if (text==='/pending'){ const p=tasks.filter(t=>!t.done); if(!p.length){await sendTelegram('🎉 All clear!');return;} const lines=p.map((t,i)=>taskSummaryLine(t,i).replace(/\*\*/g,'<b>').replace(/<\/b>/g,'</b>')).join('\n'); await sendTelegram(`📋 <b>Pending (${p.length})</b>\n\n${lines}`); return; }
  if (text==='/summary'){ await sendSummary(); return; }
  if (lower==='done'){ const p=tasks.filter(t=>!t.done); if(p.length){p[0].done=true;await sendTelegram(`✅ Marked done: <b>${p[0].name}</b> 💪`);} return; }
  if (text.startsWith('/done')){ const n=parseInt(text.split(' ')[1])-1; const p=tasks.filter(t=>!t.done); if(n>=0&&n<p.length){p[n].done=true;await sendTelegram(`✅ Done: <b>${p[n].name}</b> 💪`);} return; }

  await sendTelegram("Use Discord for full task management. Type /help for quick Telegram commands.");
});

// ── SUMMARY ───────────────────────────────────────────────────────────────────
async function sendSummary(type='manual', interactionToken) {
  const pending = tasks.filter(t=>!t.done);
  const done    = tasks.filter(t=>t.done);
  const overdue = pending.filter(t=>t.due&&daysUntil(t.due)<0);
  const dueToday= pending.filter(t=>t.due&&daysUntil(t.due)===0);
  const defcon  = pending.filter(t=>t.urgency==='defcon');
  const urgent  = pending.filter(t=>t.urgency==='urgent');
  const normal  = pending.filter(t=>t.urgency==='normal');

  const title   = type==='morning'?'☀️ Good morning — here\'s your day':type==='evening'?'🌙 End of day wrap-up':'📋 Task summary';
  const color   = overdue.length?15158332:pending.length?16776960:3066993;
  const fields  = [];

  if (overdue.length)  fields.push({name:`🔥 Overdue (${overdue.length})`,        value:overdue.map(t=>`• **${t.name}** — was due ${fmtDate(t.due)}`).join('\n'),  inline:false});
  if (dueToday.length) fields.push({name:`🚨 Due today (${dueToday.length})`,      value:dueToday.map(t=>`• **${t.name}**`).join('\n'),                             inline:false});
  if (defcon.length)   fields.push({name:`🔴 Drop everything (${defcon.length})`,  value:defcon.map(t=>`• **${t.name}**${t.due?' · due '+fmtDate(t.due):''}`).join('\n'), inline:false});
  if (urgent.length)   fields.push({name:`🟡 Urgent (${urgent.length})`,           value:urgent.map(t=>`• **${t.name}**${t.due?' · due '+fmtDate(t.due):''}`).join('\n'), inline:false});
  if (normal.length)   fields.push({name:`🟢 Normal (${normal.length})`,           value:normal.map(t=>`• **${t.name}**${t.due?' · due '+fmtDate(t.due):''}`).join('\n'), inline:false});
  if (type==='evening'&&done.length) fields.push({name:`✅ Completed today (${done.length})`, value:done.map(t=>`• ${t.name}`).join('\n'), inline:false});
  if (!fields.length)  fields.push({name:'Status', value:'🎉 All clear — nothing pending!', inline:false});

  const embed = { title, color, fields, timestamp:new Date().toISOString() };

  if (interactionToken) {
    await editInteractionReply(interactionToken, { embeds:[embed] });
  } else {
    await sendDiscord(null, [embed]);
  }

  // Telegram backup summary
  let tgMsg = type==='morning'?'☀️ <b>Good morning!</b>\n\n':type==='evening'?'🌙 <b>End of day:</b>\n\n':'📋 <b>Summary:</b>\n\n';
  if (overdue.length)  tgMsg+=`🔥 <b>Overdue:</b> ${overdue.map(t=>t.name).join(', ')}\n`;
  if (dueToday.length) tgMsg+=`🚨 <b>Due today:</b> ${dueToday.map(t=>t.name).join(', ')}\n`;
  if (pending.length)  tgMsg+=`📌 <b>${pending.length} pending</b> · ${defcon.length} drop everything · ${urgent.length} urgent · ${normal.length} normal`;
  else                 tgMsg+=`🎉 All clear!`;
  await sendTelegram(tgMsg);
}

// ── SCHEDULED JOBS ────────────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now   = new Date();
  const hhmm  = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const today  = days[now.getDay()];
  const date   = now.toISOString().slice(0,10);
  const dom    = now.getDate();
  const nowMs  = now.getTime();

  for (const t of tasks) {
    if (t.done) continue;
    if (t.snoozedUntil && new Date(t.snoozedUntil)>now) continue;
    if (t.snoozedUntil && new Date(t.snoozedUntil)<=now) t.snoozedUntil=null;

    // ── Due date warnings at 9 AM
    if (t.due && hhmm==='09:00') {
      t.dueFiredDays = t.dueFiredDays||[];
      const dl = daysUntil(t.due);
      const checks = [{key:'week',days:7},{key:'days3',days:3},{key:'day1',days:1},{key:'today',days:0},{key:'overdue',days:-99}];
      for (const c of checks) {
        const should = c.key==='overdue' ? dl<0 : dl===c.days;
        const fireKey = `${c.key}_${date}`;
        if (should && !t.dueFiredDays.includes(fireKey)) {
          t.dueFiredDays.push(fireKey);
          if (c.key==='overdue' && t.nagInterval>0) t.nagInterval=Math.max(15,Math.floor(t.nagInterval/2));
          const msgTxt = c.key==='today' ? DUE_WARNINGS.today(t.name) : DUE_WARNINGS[c.key](t.name,fmtDate(t.due));
          const color  = c.key==='overdue'||c.key==='today' ? 15158332 : c.key==='day1' ? 16776960 : 3066993;
          await sendDiscord(null,
            [{title:`📅 Due date alert: ${t.name}`, description:msgTxt, color, fields:[{name:'Due',value:fmtDate(t.due),inline:true},{name:'Urgency',value:URGENCY[t.urgency||'normal'].label,inline:true}], timestamp:new Date().toISOString()}],
            taskActionRow(t.id)
          );
          await sendTelegram(msgTxt.replace(/\*\*/g,'<b>').replace(/<\/b>/g,'</b>'));
          break;
        }
      }
    }

    // ── Interval nag
    if (t.nagInterval && t.nagInterval>0) {
      const lastNag    = t.lastNagAt ? new Date(t.lastNagAt).getTime() : 0;
      const intervalMs = t.nagInterval*60*1000;
      if (nowMs-lastNag>=intervalMs) {
        t.nagCount  = (t.nagCount||0)+1;
        t.lastNagAt = now.toISOString();
        const urg    = URGENCY[t.urgency||'normal'];
        let stage    = urg.escalation[0];
        for (const s of urg.escalation) { if(t.nagCount>=s.after) stage=s; }
        const msgTxt = stage.msg(t.name);
        await sendDiscord(null,
          [{title:`🔔 Nag #${t.nagCount}: ${t.name}`, description:msgTxt, color:urg.color, fields:t.due?[{name:'Due',value:fmtDate(t.due),inline:true}]:[], timestamp:new Date().toISOString()}],
          taskActionRow(t.id)
        );
        await sendTelegram(msgTxt.replace(/\*\*/g,'<b>').replace(/<\/b>/g,'</b>'));
      }
    }

    // ── Scheduled reminder (from web app)
    const r=t.reminder;
    if(!r||r.freq==='none') continue;
    let fire=false,key='';
    if(r.freq==='daily'){const aT=[...(r.slots||[]),...(r.customTimes||[])];for(const tm of aT){if(tm===hhmm){fire=true;key=`d_${tm}_${date}`;break;}}}
    else if(r.freq==='weekly'){if((r.days||[]).includes(today)&&r.time===hhmm){fire=true;key=`w_${date}_${hhmm}`;}}
    else if(r.freq==='monthly'){const mD=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();const tgt=Math.min(r.day||1,mD);if(dom===tgt&&r.time===hhmm){fire=true;key=`m_${date}_${hhmm}`;}}
    else if(r.freq==='once'){if(r.date===date&&r.time===hhmm){fire=true;key=`o_${date}_${hhmm}`;}}
    if(fire&&key){r.firedIds=r.firedIds||[];if(!r.firedIds.includes(key)){r.firedIds.push(key);await sendDiscord(null,[{title:`🔔 Scheduled reminder: ${t.name}`,color:5793266,timestamp:new Date().toISOString()}],taskActionRow(t.id));await sendTelegram(`🔔 <b>Reminder:</b> ${t.name}`);}}
  }
});

cron.schedule('0 7  * * *', ()=>sendSummary('morning'));
cron.schedule('0 18 * * *', ()=>sendSummary('evening'));

app.listen(PORT, async () => {
  console.log(`Taskmaster running on port ${PORT} 🔥`);
  await registerCommands();
});
