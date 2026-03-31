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

// ── In-memory task store (persists as long as server is running)
// Render free tier spins down after inactivity — tasks survive restarts via
// the JSON backup endpoint the HTML file pings on load.
let tasks = [];

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ── Telegram helper
async function sendTelegram(text, extra) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML', ...extra };
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(console.error);
}

function fmt12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function priorityEmoji(p) { return p === 'high' ? '🔴' : p === 'med' ? '🟡' : '🟢'; }

function taskLine(t) {
  const done = t.done ? '✅' : '⬜';
  const pri  = priorityEmoji(t.priority);
  const client = t.client ? ` [${t.client}]` : '';
  return `${done} ${pri} <b>${t.name}</b>${client}`;
}

function reminderLabel(r) {
  if (!r || r.freq === 'none') return '';
  if (r.freq === 'daily') {
    const times = [...(r.slots||[]), ...(r.customTimes||[])].sort().map(fmt12);
    return `🔔 Daily${times.length ? ' at ' + times.join(', ') : ''}`;
  }
  if (r.freq === 'weekly') return `🔔 Weekly · ${(r.days||[]).join(', ')} at ${fmt12(r.time)}`;
  if (r.freq === 'monthly') return `🔔 Monthly · day ${r.day} at ${fmt12(r.time)}`;
  if (r.freq === 'once') return `🔔 Once · ${r.date} at ${fmt12(r.time)}`;
  return '';
}

// ── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ status: 'Taskmaster running 🔥' }));

// Get all tasks
app.get('/tasks', (req, res) => res.json(tasks));

// Replace all tasks (full sync from HTML)
app.put('/tasks', (req, res) => {
  tasks = req.body || [];
  res.json({ ok: true, count: tasks.length });
});

// Add a task
app.post('/tasks', (req, res) => {
  const t = { id: genId(), done: false, created: new Date().toISOString(), ...req.body };
  tasks.push(t);
  res.json(t);
});

// Update a task
app.patch('/tasks/:id', (req, res) => {
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  tasks[idx] = { ...tasks[idx], ...req.body };
  res.json(tasks[idx]);
});

// Delete a task
app.delete('/tasks/:id', (req, res) => {
  tasks = tasks.filter(t => t.id !== req.params.id);
  res.json({ ok: true });
});

// ── TELEGRAM WEBHOOK ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // always ack immediately
  const msg = req.body?.message;
  if (!msg) return;

  const text = (msg.text || '').trim();
  const chatId = String(msg.chat.id);

  // Only respond to the configured chat
  if (CHAT_ID && chatId !== CHAT_ID) return;

  // ── /start
  if (text === '/start' || text === '/help') {
    await sendTelegram(
`👋 <b>Taskmaster bot ready!</b>

Here's what I can do:

/list — show all your tasks
/pending — show only pending tasks
/add [task] — add a quick task (high priority)
/done [number] — mark task #N as done (use /list to see numbers)
/delete [number] — remove task #N

Or just type naturally:
<i>"Add review client proposal urgent"</i>
<i>"Mark 2 done"</i>
<i>"Show my tasks"</i>

I'll also nag you automatically based on your reminder schedules 🔥`
    );
    return;
  }

  // ── /list or /pending
  if (text === '/list' || text === '/pending') {
    const show = text === '/pending' ? tasks.filter(t => !t.done) : tasks;
    if (!show.length) { await sendTelegram('No tasks yet! Use /add to create one.'); return; }
    const lines = show.map((t, i) => `${i+1}. ${taskLine(t)}`).join('\n');
    const header = text === '/pending'
      ? `📋 <b>Pending tasks (${show.length})</b>\n\n`
      : `📋 <b>All tasks (${show.length})</b>\n\n`;
    await sendTelegram(header + lines + '\n\nUse /done [number] to mark complete.');
    return;
  }

  // ── /add [task name]
  if (text.startsWith('/add ') || text.startsWith('/add@')) {
    const name = text.replace(/^\/add\S*\s*/, '').trim();
    if (!name) { await sendTelegram('Usage: /add [task name]\nExample: /add Review client proposal'); return; }
    const t = { id: genId(), name, priority: 'high', client: '', due: '', notes: '', done: false, reminder: null, created: new Date().toISOString() };
    tasks.push(t);
    await sendTelegram(`✅ Added: <b>${name}</b>\n\nOpen the web app to set priority, due date, and reminders.`);
    return;
  }

  // ── /done [number]
  if (text.startsWith('/done ')) {
    const n = parseInt(text.split(' ')[1]) - 1;
    if (isNaN(n) || n < 0 || n >= tasks.length) { await sendTelegram(`Invalid number. Use /list to see task numbers.`); return; }
    tasks[n].done = true;
    await sendTelegram(`✅ Marked done: <b>${tasks[n].name}</b>\n\nGood work! 💪`);
    return;
  }

  // ── /delete [number]
  if (text.startsWith('/delete ')) {
    const n = parseInt(text.split(' ')[1]) - 1;
    if (isNaN(n) || n < 0 || n >= tasks.length) { await sendTelegram(`Invalid number. Use /list to see task numbers.`); return; }
    const removed = tasks.splice(n, 1)[0];
    await sendTelegram(`🗑 Removed: <b>${removed.name}</b>`);
    return;
  }

  // ── Natural language fallback
  const lower = text.toLowerCase();
  if (lower.includes('add ') || lower.startsWith('add ')) {
    const name = text.replace(/^add\s+/i, '').trim();
    const t = { id: genId(), name, priority: lower.includes('urgent') || lower.includes('high') ? 'high' : 'med', client: '', due: '', notes: '', done: false, reminder: null, created: new Date().toISOString() };
    tasks.push(t);
    await sendTelegram(`✅ Added: <b>${t.name}</b> (${t.priority} priority)`);
    return;
  }
  if (lower.includes('list') || lower.includes('show') || lower.includes('tasks')) {
    const pending = tasks.filter(t => !t.done);
    if (!pending.length) { await sendTelegram('No pending tasks! 🎉'); return; }
    const lines = pending.map((t, i) => `${i+1}. ${taskLine(t)}`).join('\n');
    await sendTelegram(`📋 <b>Pending (${pending.length})</b>\n\n${lines}`);
    return;
  }
  if (lower.match(/^mark\s+\d+\s+done/) || lower.match(/^\d+\s+done/)) {
    const match = lower.match(/(\d+)/);
    if (match) {
      const n = parseInt(match[1]) - 1;
      if (n >= 0 && n < tasks.length) { tasks[n].done = true; await sendTelegram(`✅ Marked done: <b>${tasks[n].name}</b>`); return; }
    }
  }

  await sendTelegram(`I didn't quite get that. Try /help to see what I can do.`);
});

// ── SCHEDULED REMINDERS ─────────────────────────────────────────────────────
// Runs every minute and checks if any task reminder should fire
cron.schedule('* * * * *', async () => {
  const now   = new Date();
  const hhmm  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const today = days[now.getDay()];
  const date  = now.toISOString().slice(0, 10);
  const dom   = now.getDate();
  const NAGS  = [
    n => `🔔 Hey. <b>"${n}"</b> is still sitting there. Untouched. Judging you.`,
    n => `🔔 Friendly (not friendly) reminder: <b>"${n}"</b> isn't going to finish itself.`,
    n => `🔔 You added <b>"${n}"</b> for a reason. That reason hasn't gone away.`,
    n => `🔔 <b>"${n}"</b> called. It wants to know when you're actually planning to do it.`,
    n => `🔔 Still seeing <b>"${n}"</b> in your list. Still unfinished. I'm not going anywhere.`,
    n => `🔔 Look, I'm just doing my job. <b>"${n}"</b> — still undone. You know what to do.`,
  ];

  for (const t of tasks) {
    if (t.done) continue;
    const r = t.reminder;
    if (!r || r.freq === 'none') continue;

    let fire = false, key = '';
    if (r.freq === 'daily') {
      const allTimes = [...(r.slots||[]), ...(r.customTimes||[])];
      for (const tm of allTimes) { if (tm === hhmm) { fire = true; key = `d_${tm}_${date}`; break; } }
    } else if (r.freq === 'weekly') {
      if ((r.days||[]).includes(today) && r.time === hhmm) { fire = true; key = `w_${date}_${hhmm}`; }
    } else if (r.freq === 'monthly') {
      const maxDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      const tgt = Math.min(r.day||1, maxDay);
      if (dom === tgt && r.time === hhmm) { fire = true; key = `m_${date}_${hhmm}`; }
    } else if (r.freq === 'once') {
      if (r.date === date && r.time === hhmm) { fire = true; key = `o_${date}_${hhmm}`; }
    }

    if (fire && key) {
      r.firedIds = r.firedIds || [];
      if (!r.firedIds.includes(key)) {
        r.firedIds.push(key);
        const nag = NAGS[r.firedIds.length % NAGS.length](t.name);
        const rlbl = reminderLabel(r);
        await sendTelegram(`${nag}\n\n${t.client ? `<i>${t.client}</i>\n` : ''}${rlbl}\n\nReply /done ${tasks.indexOf(t)+1} when finished.`);
      }
    }
  }
});

// ── Hourly general nag for pending high-priority tasks
cron.schedule('0 * * * *', async () => {
  const pending = tasks.filter(t => !t.done && t.priority === 'high');
  if (!pending.length) return;
  const lines = pending.map((t,i) => `${i+1}. 🔴 <b>${t.name}</b>${t.client?' ['+t.client+']':''}`).join('\n');
  await sendTelegram(`⚠️ <b>Hourly check-in</b> — you have ${pending.length} high priority task${pending.length>1?'s':''} pending:\n\n${lines}\n\nUse /done [number] when complete.`);
});

app.listen(PORT, () => console.log(`Taskmaster server running on port ${PORT}`));
