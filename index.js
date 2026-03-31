const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;
const PORT      = process.env.PORT || 3000;
const TZ        = process.env.TZ || 'Asia/Colombo';

let tasks = [];

// pending task creation sessions (waiting for button taps)
let pendingAdd = null;

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function pad(n) { return String(n).padStart(2,'0'); }
function nowHHMM() { const n = new Date(); return `${pad(n.getHours())}:${pad(n.getMinutes())}`; }

// ── URGENCY CONFIG ───────────────────────────────────────────────────────────
const URGENCY = {
  normal: {
    label: '🟢 Normal',
    escalation: [
      { after: 0,   style: 'gentle',     msg: n => `🔔 Just a heads up — <b>"${n}"</b> is waiting for you.` },
      { after: 2,   style: 'firm',       msg: n => `🔔 Hey. <b>"${n}"</b> is still sitting there. Untouched.` },
      { after: 5,   style: 'persistent', msg: n => `😤 Still nothing on <b>"${n}"</b>? Come on now.` },
      { after: 10,  style: 'aggressive', msg: n => `🚨 <b>"${n}"</b> has been ignored ${10} times. Do it. NOW.` },
    ]
  },
  urgent: {
    label: '🟡 Urgent',
    escalation: [
      { after: 0,  style: 'firm',       msg: n => `⚡ <b>URGENT:</b> <b>"${n}"</b> needs your attention.` },
      { after: 2,  style: 'aggressive', msg: n => `🚨 <b>STILL URGENT:</b> <b>"${n}"</b> — why is this not done yet?` },
      { after: 4,  style: 'unhinged',   msg: n => `😡 <b>"${n}"</b> IS URGENT AND YOU KEEP IGNORING IT. SORT IT OUT.` },
      { after: 7,  style: 'unhinged',   msg: n => `🔥🔥🔥 <b>"${n}"</b> — this is nag #${7}. At what point does urgent mean urgent to you??` },
    ]
  },
  defcon: {
    label: '🔴 DROP EVERYTHING',
    escalation: [
      { after: 0, style: 'aggressive', msg: n => `🚨🚨 <b>DROP EVERYTHING:</b> <b>"${n}"</b> — stop what you're doing. Right now.` },
      { after: 1, style: 'unhinged',   msg: n => `💀 <b>"${n}"</b> — I don't know what you're doing but it's less important than this. STOP. DO THIS.` },
      { after: 2, style: 'unhinged',   msg: n => `☢️ <b>DEFCON 1:</b> <b>"${n}"</b> is on fire. You are on fire. Everything is on fire. FIX IT.` },
      { after: 3, style: 'unhinged',   msg: n => `🆘🆘🆘 <b>"${n}"</b> — nag #${3}. I have run out of ways to tell you how important this is. PLEASE.` },
    ]
  }
};

// ── TELEGRAM HELPERS ─────────────────────────────────────────────────────────
async function tgRequest(method, body) {
  if (!BOT_TOKEN) return null;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(console.error);
  return r ? r.json().catch(() => null) : null;
}

async function sendTelegram(text, extra = {}) {
  if (!CHAT_ID) return;
  return tgRequest('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML', ...extra });
}

async function sendVoice(text) {
  // Uses Telegram's sendVoice with a TTS workaround via a public TTS API
  // Falls back to sending a strongly-formatted text message if unavailable
  if (!CHAT_ID) return;
  try {
    const ttsUrl = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(text)}`;
    await tgRequest('sendVoice', { chat_id: CHAT_ID, voice: ttsUrl, caption: text, parse_mode: 'HTML' });
  } catch(e) {
    await sendTelegram(`🔊 <b>[VOICE NAG]</b> ${text}`);
  }
}

async function editMessage(messageId, text, extra = {}) {
  if (!CHAT_ID) return;
  return tgRequest('editMessageText', { chat_id: CHAT_ID, message_id: messageId, text, parse_mode: 'HTML', ...extra });
}

async function answerCallback(callbackQueryId, text) {
  return tgRequest('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

function fmt12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

function urgencyEmoji(u) {
  return u === 'defcon' ? '🔴' : u === 'urgent' ? '🟡' : '🟢';
}

function taskLine(t, i) {
  const done   = t.done ? '✅' : '⬜';
  const urg    = urgencyEmoji(t.urgency || 'normal');
  const client = t.client ? ` <i>[${t.client}]</i>` : '';
  const nag    = t.nagInterval ? ` · nag every ${t.nagInterval}m` : '';
  const num    = i !== undefined ? `${i+1}. ` : '';
  return `${num}${done} ${urg} <b>${t.name}</b>${client}${nag}`;
}

// ── INLINE KEYBOARD BUILDERS ─────────────────────────────────────────────────
function urgencyKeyboard() {
  return { inline_keyboard: [[
    { text: '🟢 Normal',          callback_data: 'urg_normal' },
    { text: '🟡 Urgent',          callback_data: 'urg_urgent' },
    { text: '🔴 DROP EVERYTHING', callback_data: 'urg_defcon' },
  ]]};
}

function nagKeyboard() {
  return { inline_keyboard: [[
    { text: 'Every 15 min', callback_data: 'nag_15'  },
    { text: 'Every 30 min', callback_data: 'nag_30'  },
    { text: 'Every hour',   callback_data: 'nag_60'  },
    { text: 'Every 2 hrs',  callback_data: 'nag_120' },
  ], [
    { text: 'No auto-nag', callback_data: 'nag_0' },
  ]]};
}

function taskActionKeyboard(taskId) {
  return { inline_keyboard: [[
    { text: '✅ Done',   callback_data: `act_done_${taskId}`   },
    { text: '🗑 Delete', callback_data: `act_delete_${taskId}` },
    { text: '⏸ Snooze 30m', callback_data: `act_snooze_${taskId}` },
  ]]};
}

// ── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/',              (req, res) => res.json({ status: 'Taskmaster running 🔥' }));
app.get('/tasks',         (req, res) => res.json(tasks));
app.put('/tasks',         (req, res) => { tasks = req.body || []; res.json({ ok: true, count: tasks.length }); });
app.post('/tasks',        (req, res) => { const t = { id: genId(), done: false, urgency: 'normal', nagInterval: 60, nagCount: 0, snoozedUntil: null, created: new Date().toISOString(), ...req.body }; tasks.push(t); res.json(t); });
app.patch('/tasks/:id',   (req, res) => { const i = tasks.findIndex(t => t.id === req.params.id); if (i < 0) return res.status(404).json({ error: 'not found' }); tasks[i] = { ...tasks[i], ...req.body }; res.json(tasks[i]); });
app.delete('/tasks/:id',  (req, res) => { tasks = tasks.filter(t => t.id !== req.params.id); res.json({ ok: true }); });

// ── WEBHOOK ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  // ── Handle button taps (callback queries)
  if (body.callback_query) {
    const cb   = body.callback_query;
    const data = cb.data;
    const msgId = cb.message?.message_id;
    await answerCallback(cb.id, '');

    // Urgency selection
    if (data.startsWith('urg_') && pendingAdd) {
      const urg = data.replace('urg_', '');
      pendingAdd.urgency = urg;
      await editMessage(msgId, `➕ <b>Adding:</b> ${pendingAdd.name}\n✅ Urgency: ${URGENCY[urg].label}\n\n<b>How often should I nag you about this?</b>`, { reply_markup: nagKeyboard() });
      return;
    }

    // Nag interval selection
    if (data.startsWith('nag_') && pendingAdd) {
      const interval = parseInt(data.replace('nag_', ''));
      pendingAdd.nagInterval = interval;
      const t = {
        id: genId(), done: false,
        name: pendingAdd.name,
        urgency: pendingAdd.urgency || 'normal',
        nagInterval: interval,
        nagCount: 0,
        snoozedUntil: null,
        client: '', due: '', notes: '', reminder: null,
        created: new Date().toISOString()
      };
      tasks.push(t);
      pendingAdd = null;
      const nagLabel = interval === 0 ? 'No auto-nag' : `Every ${interval >= 60 ? interval/60 + ' hr' : interval + ' min'}`;
      await editMessage(msgId,
        `✅ <b>Task added!</b>\n\n${taskLine(t)}\n🔔 Nag: ${nagLabel}\n\nUse the buttons below to manage it.`,
        { reply_markup: taskActionKeyboard(t.id) }
      );
      return;
    }

    // Task actions
    if (data.startsWith('act_done_')) {
      const id = data.replace('act_done_', '');
      const t = tasks.find(x => x.id === id);
      if (t) { t.done = true; t.nagCount = 0; await editMessage(msgId, `✅ <b>Done:</b> ${t.name}\n\nNice work! 💪`); }
      return;
    }
    if (data.startsWith('act_delete_')) {
      const id = data.replace('act_delete_', '');
      const t = tasks.find(x => x.id === id);
      if (t) { tasks = tasks.filter(x => x.id !== id); await editMessage(msgId, `🗑 Removed: <b>${t.name}</b>`); }
      return;
    }
    if (data.startsWith('act_snooze_')) {
      const id = data.replace('act_snooze_', '');
      const t = tasks.find(x => x.id === id);
      if (t) {
        t.snoozedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await editMessage(msgId, `⏸ <b>Snoozed 30 minutes:</b> ${t.name}\n\nI'll be back. 😏`);
      }
      return;
    }
    return;
  }

  // ── Handle text messages
  const msg = body.message;
  if (!msg) return;
  const text   = (msg.text || '').trim();
  const chatId = String(msg.chat.id);
  if (CHAT_ID && chatId !== CHAT_ID) return;

  const lower = text.toLowerCase();

  // Quick "done" reply to kill active nag
  if (lower === 'done' || lower === 'yes done' || lower === "i'm done") {
    const pending = tasks.filter(t => !t.done);
    if (!pending.length) { await sendTelegram('No pending tasks to mark done!'); return; }
    if (pending.length === 1) {
      pending[0].done = true;
      await sendTelegram(`✅ Marked done: <b>${pending[0].name}</b>\n\nGood work! 💪`);
    } else {
      const lines = pending.map((t,i) => `${i+1}. ${taskLine(t)}`).join('\n');
      await sendTelegram(`Which one? Reply with the number:\n\n${lines}`);
    }
    return;
  }

  // /start or /help
  if (text === '/start' || text === '/help') {
    await sendTelegram(
`👋 <b>Taskmaster bot — full nag mode 🔥</b>

<b>Commands:</b>
/add [task] — add a task (buttons for priority + nag interval)
/list — all tasks
/pending — pending only
/done [number] — mark done
/delete [number] — remove task
/snooze [number] — snooze 30 min
/summary — your current task summary

<b>Quick replies:</b>
Just type <i>"done"</i> to mark the top pending task done.

<b>Urgency levels:</b>
🟢 Normal — gentle reminders, escalates slowly
🟡 Urgent — firm from the start, gets aggressive fast
🔴 DROP EVERYTHING — immediate, relentless, unhinged

I'll also send you a summary every morning at 7 AM and every evening at 6 PM. 🗓`
    );
    return;
  }

  // /add
  if (text.startsWith('/add') || lower.startsWith('add ')) {
    const name = text.startsWith('/add')
      ? text.replace(/^\/add\s*/,'').trim()
      : text.replace(/^add\s+/i,'').trim();
    if (!name) { await sendTelegram('What\'s the task? Try: /add Review client proposal'); return; }
    pendingAdd = { name };
    await sendTelegram(
      `➕ <b>Adding:</b> ${name}\n\n<b>How urgent is this?</b>`,
      { reply_markup: urgencyKeyboard() }
    );
    return;
  }

  // /list
  if (text === '/list') {
    if (!tasks.length) { await sendTelegram('No tasks yet! Use /add to create one.'); return; }
    const lines = tasks.map((t,i) => taskLine(t,i)).join('\n');
    await sendTelegram(`📋 <b>All tasks (${tasks.length})</b>\n\n${lines}\n\nUse /done [number] or /delete [number].`);
    return;
  }

  // /pending
  if (text === '/pending') {
    const p = tasks.filter(t => !t.done);
    if (!p.length) { await sendTelegram('🎉 No pending tasks! You\'re all clear.'); return; }
    const lines = p.map((t,i) => taskLine(t,i)).join('\n');
    await sendTelegram(`📋 <b>Pending (${p.length})</b>\n\n${lines}\n\nReply "done" to mark the top one complete.`);
    return;
  }

  // /summary
  if (text === '/summary') {
    await sendSummary();
    return;
  }

  // /done [n]
  if (text.startsWith('/done')) {
    const n = parseInt(text.split(' ')[1]) - 1;
    const pool = tasks.filter(t => !t.done);
    if (isNaN(n) || n < 0 || n >= pool.length) { await sendTelegram(`Invalid number. Use /pending to see the list.`); return; }
    pool[n].done = true; pool[n].nagCount = 0;
    await sendTelegram(`✅ Done: <b>${pool[n].name}</b>\n\nNice one! 💪`);
    return;
  }

  // /delete [n]
  if (text.startsWith('/delete')) {
    const n = parseInt(text.split(' ')[1]) - 1;
    if (isNaN(n) || n < 0 || n >= tasks.length) { await sendTelegram(`Invalid number. Use /list to see tasks.`); return; }
    const removed = tasks.splice(n, 1)[0];
    await sendTelegram(`🗑 Removed: <b>${removed.name}</b>`);
    return;
  }

  // /snooze [n]
  if (text.startsWith('/snooze')) {
    const n = parseInt(text.split(' ')[1]) - 1;
    const pool = tasks.filter(t => !t.done);
    if (isNaN(n) || n < 0 || n >= pool.length) { await sendTelegram(`Invalid number. Use /pending to see the list.`); return; }
    pool[n].snoozedUntil = new Date(Date.now() + 30*60*1000).toISOString();
    await sendTelegram(`⏸ Snoozed 30 min: <b>${pool[n].name}</b>\n\nI'll be back. 😏`);
    return;
  }

  // Natural language number + done
  const numDoneMatch = lower.match(/^(\d+)\s+done/);
  if (numDoneMatch) {
    const n = parseInt(numDoneMatch[1]) - 1;
    const pool = tasks.filter(t => !t.done);
    if (n >= 0 && n < pool.length) { pool[n].done = true; await sendTelegram(`✅ Done: <b>${pool[n].name}</b> 💪`); return; }
  }

  await sendTelegram(`Didn't catch that. Try /help to see what I can do.`);
});

// ── SUMMARY HELPER ───────────────────────────────────────────────────────────
async function sendSummary(type = 'manual') {
  const pending = tasks.filter(t => !t.done);
  const done    = tasks.filter(t => t.done);
  const defcon  = pending.filter(t => t.urgency === 'defcon');
  const urgent  = pending.filter(t => t.urgency === 'urgent');
  const normal  = pending.filter(t => t.urgency === 'normal');

  let msg = '';
  if (type === 'morning') {
    msg = `☀️ <b>Good morning! Here's your day:</b>\n\n`;
  } else if (type === 'evening') {
    msg = `🌙 <b>End of day wrap-up:</b>\n\n`;
    if (done.length) msg += `✅ <b>Completed today (${done.length}):</b>\n${done.map(t=>`  · ${t.name}`).join('\n')}\n\n`;
  } else {
    msg = `📋 <b>Task Summary:</b>\n\n`;
  }

  if (!pending.length) {
    msg += `🎉 <b>All clear — nothing pending!</b>`;
  } else {
    msg += `📌 <b>${pending.length} task${pending.length>1?'s':''} pending:</b>\n\n`;
    if (defcon.length) msg += defcon.map(t => `🔴 ${t.name}`).join('\n') + '\n';
    if (urgent.length) msg += urgent.map(t => `🟡 ${t.name}`).join('\n') + '\n';
    if (normal.length) msg += normal.map(t => `🟢 ${t.name}`).join('\n') + '\n';
    if (type === 'evening' && pending.length) {
      msg += `\n😬 These are rolling over to tomorrow. You know what to do.`;
    }
  }

  await sendTelegram(msg);
}

// ── SCHEDULED JOBS ────────────────────────────────────────────────────────────

// Every minute: check per-task nag intervals + reminder schedules
cron.schedule('* * * * *', async () => {
  const now  = new Date();
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const today = days[now.getDay()];
  const date  = now.toISOString().slice(0,10);
  const dom   = now.getDate();
  const nowMs = now.getTime();

  for (const t of tasks) {
    if (t.done) continue;

    // Skip if snoozed
    if (t.snoozedUntil && new Date(t.snoozedUntil) > now) continue;
    if (t.snoozedUntil && new Date(t.snoozedUntil) <= now) t.snoozedUntil = null;

    // ── Per-task interval nag
    if (t.nagInterval && t.nagInterval > 0) {
      const lastNag = t.lastNagAt ? new Date(t.lastNagAt).getTime() : 0;
      const intervalMs = t.nagInterval * 60 * 1000;
      if (nowMs - lastNag >= intervalMs) {
        t.nagCount = (t.nagCount || 0) + 1;
        t.lastNagAt = now.toISOString();

        const urgConf  = URGENCY[t.urgency || 'normal'];
        const stages   = urgConf.escalation;
        // pick escalation stage based on nagCount
        let stage = stages[0];
        for (const s of stages) { if (t.nagCount >= s.after) stage = s; }

        const msgText = stage.msg(t.name);
        const isVoice = t.nagCount > 3 && t.urgency !== 'normal';

        if (isVoice) {
          await sendVoice(msgText.replace(/<[^>]+>/g,''));
        } else {
          await sendTelegram(
            `${msgText}\n\n<i>Nag #${t.nagCount} · ${urgConf.label}</i>`,
            { reply_markup: taskActionKeyboard(t.id) }
          );
        }
      }
    }

    // ── Scheduled reminder (from web app)
    const r = t.reminder;
    if (!r || r.freq === 'none') continue;
    let fire = false, key = '';
    if (r.freq === 'daily') {
      const allT = [...(r.slots||[]),...(r.customTimes||[])];
      for (const tm of allT) { if (tm===hhmm){fire=true;key=`d_${tm}_${date}`;break;} }
    } else if (r.freq==='weekly') {
      if ((r.days||[]).includes(today)&&r.time===hhmm){fire=true;key=`w_${date}_${hhmm}`;}
    } else if (r.freq==='monthly') {
      const maxD=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
      const tgt=Math.min(r.day||1,maxD);
      if(dom===tgt&&r.time===hhmm){fire=true;key=`m_${date}_${hhmm}`;}
    } else if (r.freq==='once') {
      if(r.date===date&&r.time===hhmm){fire=true;key=`o_${date}_${hhmm}`;}
    }
    if (fire && key) {
      r.firedIds = r.firedIds||[];
      if (!r.firedIds.includes(key)) {
        r.firedIds.push(key);
        await sendTelegram(
          `🔔 <b>Scheduled reminder:</b> ${t.name}`,
          { reply_markup: taskActionKeyboard(t.id) }
        );
      }
    }
  }
});

// 7 AM — morning summary
cron.schedule('0 7 * * *', () => sendSummary('morning'));

// 6 PM — evening wrap-up
cron.schedule('0 18 * * *', () => sendSummary('evening'));

app.listen(PORT, () => console.log(`Taskmaster server running on port ${PORT} 🔥`));
