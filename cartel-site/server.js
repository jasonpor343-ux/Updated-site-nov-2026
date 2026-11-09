require("dotenv").config();
const express = require("express");
const session = require("express-session");
const E = process.env;
const API = "https://discord.com/api/v10";
const H = { Authorization: "Bot " + E.DISCORD_BOT_TOKEN };
const app = express();
app.set("trust proxy", 1);
// Block the browser's Picture-in-Picture mini player everywhere (including inside embedded video players),
// so a video cannot be popped out of the page and away from the watermark.
app.use((req, res, next) => { res.set("Permissions-Policy", "picture-in-picture=()"); next(); });
const jsonSmall = express.json();
app.use((req, res, next) => (req.path === "/api/submit" ? next() : jsonSmall(req, res, next))); // /api/submit takes a larger body (files)
app.use(session({
  secret: E.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: (E.BASE_URL || "").startsWith("https") }
}));

// Phones and tablets are not supported: show the "computer required" page instead of anything else.
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile|webOS|Windows Phone/i;
app.use((req, res, next) => {
  if (!MOBILE_UA.test(req.get("user-agent") || "")) return next();
  if (req.path.startsWith("/api/")) return res.status(403).json({ ok: false, error: "Please use a computer or laptop." });
  res.status(403).set("Cache-Control", "no-store").sendFile(path.join(__dirname, "public", "device.html"));
});

// A sign-in ends only when the member closes the tab or refreshes the page (the page reports this as it unloads).
// Nothing else, such as sitting idle or switching tabs, signs them out.
app.post("/api/leaving", (req, res) => { delete req.session.user; res.sendStatus(204); });

const cache = new Map();
const hasRole = m => (m.roles || []).includes(E.REQUIRED_ROLE_ID);
const isOwner = id => (E.OWNER_IDS || "").split(",").map(s => s.trim()).includes(id);
const me = u => ({ id: u.id, name: u.name, username: u.username, avatar: u.avatar, member: true, owner: isOwner(u.id) });

// Step 1: the visitor connects their Discord account. Discord proves who they are.
app.get("/auth/discord", (req, res) => {
  const state = require("crypto").randomBytes(16).toString("hex");
  req.session.state = state;
  res.redirect("https://discord.com/oauth2/authorize?" + new URLSearchParams({
    client_id: E.DISCORD_CLIENT_ID, redirect_uri: E.BASE_URL + "/auth/callback",
    response_type: "code", scope: "identify", state, prompt: "consent"
  }));
});

// Step 2: the bot checks that this account is in your server and has the role.
app.get("/auth/callback", async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.state) return res.redirect("/?error=expired");
    const t = await fetch(API + "/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: E.DISCORD_CLIENT_ID, client_secret: E.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code: req.query.code, redirect_uri: E.BASE_URL + "/auth/callback" })
    }).then(r => r.json());
    if (!t.access_token) return res.redirect("/?error=failed");
    const u = await fetch(API + "/users/@me", { headers: { Authorization: "Bearer " + t.access_token } }).then(r => r.json());
    // Do not sign the visitor in yet: they must press the confirm button themselves.
    req.session.pending = { id: u.id, name: u.global_name || u.username, username: u.username, at: Date.now(),
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png` };
    res.redirect("/");
  } catch (e) { res.redirect("/?error=failed"); }
});

// Access is re-checked every minute, so removing the role removes access.
// Step 3: nothing is verified until the visitor presses the Authorise button on our own page.
app.get("/api/pending", (req, res) => {
  const p = req.session.pending;
  if (!p || Date.now() - p.at > 10 * 60 * 1000) return res.status(404).json(null);
  res.json({ name: p.name, avatar: p.avatar });
});
app.post("/auth/confirm", async (req, res) => {
  const p = req.session.pending;
  if (!p || Date.now() - p.at > 10 * 60 * 1000) return res.json({ ok: false, error: "Your sign-in expired. Please connect again." });
  try {
    if (!isOwner(p.id)) {
      const r = await fetch(`${API}/guilds/${E.GUILD_ID}/members/${p.id}`, { headers: H });
      if (r.status !== 200) return res.json({ ok: false, error: "You are not in the Cartel server. Join it, then connect again." });
      if (!hasRole(await r.json())) return res.json({ ok: false, error: "You are in the server but do not have the required role." });
    }
    req.session.user = { id: p.id, name: p.name, username: p.username, avatar: p.avatar };
    delete req.session.pending;
    cache.set(p.id, { ok: true, at: Date.now() });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: "The bot could not check the server. Please try again." }); }
});
app.post("/auth/cancel", (req, res) => { delete req.session.pending; res.json({ ok: true }); });

app.get("/api/me", async (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json(null);
  try {
    let c = cache.get(u.id);
    if (!c || Date.now() - c.at > 60000) {
      const r = await fetch(`${API}/guilds/${E.GUILD_ID}/members/${u.id}`, { headers: H });
      c = { ok: isOwner(u.id) || (r.status === 200 && hasRole(await r.json())), at: Date.now() };
      cache.set(u.id, c);
    }
    if (!c.ok) { req.session.user = null; return res.status(401).json(null); }
    res.json({ ...me(u), ip: (req.ip || "").replace(/^::ffff:/, "") });
  } catch (e) { res.status(502).json(null); }
});

app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
const path = require("path");
async function stillMember(u) {
  let c = cache.get(u.id);
  if (!c || Date.now() - c.at > 60000) {
    const r = await fetch(`${API}/guilds/${E.GUILD_ID}/members/${u.id}`, { headers: H });
    c = { ok: isOwner(u.id) || (r.status === 200 && hasRole(await r.json())), at: Date.now() };
    cache.set(u.id, c);
  }
  return c.ok;
}
// The whole site is private: only verified members are sent the real page, everyone else gets the gate.
app.get(["/", "/index.html"], async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (req.session.user && await stillMember(req.session.user)) return res.sendFile(path.join(__dirname, "private", "index.html"));
  } catch (e) {}
  res.sendFile(path.join(__dirname, "public", "gate.html"));
});

// ---- 1-1 bookings ----
// Bookings are stored as messages in a private Discord channel (BOOKINGS_CHANNEL_ID) so they survive restarts on free hosting.
const fs = require("fs");
const BFILE = path.join(__dirname, "bookings.json");
const SLOTS = ["20:00", "20:30", "21:00", "21:30", "22:00", "22:30"];
let bookings = [];
const persist = () => { try { fs.writeFileSync(BFILE, JSON.stringify(bookings)); } catch (e) {} };
function melNow() {
  const p = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).forEach(x => (p[x.type] = x.value));
  return { d: `${p.year}-${p.month}-${p.day}`, t: `${p.hour}:${p.minute}` };
}
const isPast = (d, t) => { const n = melNow(); return d + " " + t <= n.d + " " + n.t; };
const label = b => { const [h, m] = b.time.split(":").map(Number); return `${b.date} ${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"} Melbourne`; };
const CH = E.BOOKINGS_CHANNEL_ID;

async function scan(ch, fn) {
  let before = "";
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${API}/channels/${ch}/messages?limit=100${before ? "&before=" + before : ""}`, { headers: H });
    if (!r.ok) { console.log("Could not read channel", ch, r.status); return; }
    const msgs = await r.json();
    if (!msgs.length) break;
    msgs.forEach(m => { if (m.author && m.author.bot) fn(m); });
    before = msgs[msgs.length - 1].id;
  }
}
async function loadBookings() {
  if (!CH) { try { bookings = JSON.parse(fs.readFileSync(BFILE, "utf8")); } catch (e) {} console.log("No BOOKINGS_CHANNEL_ID set: bookings are kept in a local file and may be lost on restart."); return; }
  await scan(CH, m => {
    const x = /\|\|BOOK\|(\d{4}-\d{2}-\d{2})\|(\d{2}:\d{2})\|(\d+)\|([^|]*?)(?:\|([\w-]*))?\|\|/.exec(m.content || "");
    if (x) { let note = ""; try { note = x[5] ? Buffer.from(x[5], "base64url").toString() : ""; } catch (e) {} bookings.push({ date: x[1], time: x[2], id: x[3], name: x[4], note, msg: m.id }); }
  });
}
async function saveRemote(b) {
  if (!CH) { persist(); return true; }
  const r = await fetch(`${API}/channels/${CH}/messages`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ content: `📅 **${b.name}** booked a 1-1: ${label(b)}\nTopic: ${b.note.replace(/[|*_`~<>]/g, "")}\n||BOOK|${b.date}|${b.time}|${b.id}|${b.name}|${Buffer.from(b.note).toString("base64url")}||`, allowed_mentions: { parse: [] } }) });
  if (!r.ok) { console.log("Booking save failed:", r.status, await r.text()); return false; }
  b.msg = (await r.json()).id;
  return true;
}
function removeRemote(b) {
  if (!CH) return persist();
  if (b.msg) fetch(`${API}/channels/${CH}/messages/${b.msg}`, { method: "DELETE", headers: H }).catch(() => {});
}
async function auth(req, res, next) {
  try { const u = req.session.user; if (u && await stillMember(u)) return next(); } catch (e) {}
  res.status(401).json({ ok: false, error: "Please connect your Discord again." });
}

app.get("/api/bookings", auth, (req, res) => {
  const u = req.session.user, owner = isOwner(u.id);
  res.json(bookings.filter(b => !isPast(b.date, b.time)).map(b => {
    const mine = b.id === u.id;
    return { date: b.date, time: b.time, mine, ...(owner || mine ? { name: b.name, note: b.note || "" } : {}) };
  }));
});

app.post("/api/book", auth, async (req, res) => {
  const u = req.session.user, { date, time } = req.body || {}, n = melNow();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date || !SLOTS.includes(time))
    return res.json({ ok: false, error: "That slot is not valid." });
  if (![5, 6, 0].includes(new Date(date + "T00:00:00Z").getUTCDay())) return res.json({ ok: false, error: "Sessions are only available Friday to Sunday." });
  if (isPast(date, time)) return res.json({ ok: false, error: "That time has passed." });
  const note = String(req.body.note || "").trim().slice(0, 300);
  if (!note) return res.json({ ok: false, error: "Please say what the 1-1 is for." });
  const lim = new Date(n.d + "T00:00:00Z"); lim.setUTCDate(lim.getUTCDate() + 60);
  if (date > lim.toISOString().slice(0, 10)) return res.json({ ok: false, error: "You can book up to 60 days ahead." });
  if (bookings.some(b => b.date === date && b.time === time)) return res.json({ ok: false, error: "That slot was just taken." });
  if (!isOwner(u.id) && bookings.filter(b => b.id === u.id && !isPast(b.date, b.time)).length >= 3)
    return res.json({ ok: false, error: "You can hold up to 3 upcoming bookings. Cancel one first." });
  const b = { date, time, id: u.id, note, name: (u.name || "member").replace(/[|*_`~<>@\\]/g, "").slice(0, 40) || "member" };
  bookings.push(b); // reserve the slot first so two people can't take it at once
  try { if (!(await saveRemote(b))) throw new Error("save"); }
  catch (e) { console.log("Booking error:", e.message); bookings = bookings.filter(x => x !== b); return res.json({ ok: false, error: "Could not save the booking. Please try again." }); }
  notifyOwner(`📅 New 1-1 booked: **${b.name}** (@${u.username}) on ${prettyDay(date)}, ${slotRange(time)} (Melbourne time).\nTopic: ${note}`).catch(() => {});
  const dmOk = await dm(u.id, `✅ Your 1-1 is booked for **${prettyDay(date)}, ${slotRange(time)}** (Melbourne time).\nTopic: ${note}\nTo cancel it, open Book a 1-1 on the site.`);
  res.json({ ok: true, dm: dmOk });
});

app.post("/api/cancel", auth, (req, res) => {
  const u = req.session.user, { date, time } = req.body || {};
  const i = bookings.findIndex(b => b.date === date && b.time === time && (b.id === u.id || isOwner(u.id)));
  if (i < 0) return res.json({ ok: false, error: "Booking not found." });
  const [b] = bookings.splice(i, 1);
  removeRemote(b);
  if (b.id === u.id) notifyOwner(`❌ 1-1 cancelled by **${b.name}**: ${prettyDay(b.date)}, ${slotRange(b.time)} (Melbourne time).`).catch(() => {});
  else dm(b.id, `❌ Your 1-1 on ${prettyDay(b.date)}, ${slotRange(b.time)} (Melbourne time) was cancelled by Cartel. You can book another time on the site.`).catch(() => {});
  res.json({ ok: true });
});

// ---- PA Recap videos: only the owner can post or delete; members can only view ----
const PCH = E.PA_CHANNEL_ID || E.BOOKINGS_CHANNEL_ID;
const PFILE = path.join(__dirname, "recaps.json");
let recaps = [];
const persistR = () => { try { fs.writeFileSync(PFILE, JSON.stringify(recaps)); } catch (e) {} };
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = s => JSON.parse(Buffer.from(s, "base64url").toString());

app.get("/api/recaps", auth, (req, res) =>
  res.json([...recaps].sort((a, b) => b.at - a.at).map(({ id, title, desc, url, at }) => ({ id, title, desc, url, at }))));

app.post("/api/recaps", auth, async (req, res) => {
  if (!isOwner(req.session.user.id)) return res.status(403).json({ ok: false, error: "Only the owner can post recaps." });
  const clean = (v, n) => String(v || "").trim().slice(0, n);
  const r = { title: clean(req.body.title, 80), desc: clean(req.body.desc, 500), url: clean(req.body.url, 400), at: Date.now() };
  if (!r.title) return res.json({ ok: false, error: "Add a title." });
  if (!/^https:\/\/[^\s"'<>]+$/.test(r.url)) return res.json({ ok: false, error: "The video link must start with https:// and contain no spaces." });
  try {
    if (PCH) {
      const m = await fetch(`${API}/channels/${PCH}/messages`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ content: `🎬 **${r.title.replace(/[*_`~|<>@]/g, "")}** (PA recap)\n||PA|${b64({ t: r.title, d: r.desc, u: r.url, a: r.at })}||`, allowed_mentions: { parse: [] } }) });
      if (!m.ok) { console.log("Discord save failed:", m.status, await m.text()); throw new Error("save"); }
      r.id = (await m.json()).id;
    } else r.id = String(r.at);
  } catch (e) { return res.json({ ok: false, error: "Could not save the recap. Please try again." }); }
  recaps.push(r);
  if (!PCH) persistR();
  res.json({ ok: true });
});

app.post("/api/recaps/delete", auth, (req, res) => {
  if (!isOwner(req.session.user.id)) return res.status(403).json({ ok: false, error: "Only the owner can delete recaps." });
  const i = recaps.findIndex(r => r.id === req.body.id);
  if (i < 0) return res.json({ ok: false, error: "Recap not found." });
  const [r] = recaps.splice(i, 1);
  if (PCH) fetch(`${API}/channels/${PCH}/messages/${r.id}`, { method: "DELETE", headers: H }).catch(() => {}); else persistR();
  res.json({ ok: true });
});

// ---- Lecture videos: the owner sets a video link per lecture from the site ----
const LFILE = path.join(__dirname, "lectures.json");
let LVmap = {}; // lecture id -> { url, msg }
const persistL = () => { try { fs.writeFileSync(LFILE, JSON.stringify(LVmap)); } catch (e) {} };

app.get("/api/lecture-videos", auth, (req, res) =>
  res.json(Object.fromEntries(Object.entries(LVmap).map(([k, v]) => [k, v.url]))));

app.post("/api/lecture-videos", auth, async (req, res) => {
  if (!isOwner(req.session.user.id)) return res.status(403).json({ ok: false, error: "Only the owner can change lecture videos." });
  const id = String(req.body.id || ""), url = String(req.body.url || "").trim().slice(0, 400);
  if (!/^[a-z0-9-]{1,60}$/.test(id)) return res.json({ ok: false, error: "Unknown lecture." });
  if (url && !/^https:\/\/[^\s"'<>]+$/.test(url)) return res.json({ ok: false, error: "The link must start with https:// and contain no spaces." });
  if (url && !LVmap[id] && Object.keys(LVmap).length >= 60) return res.json({ ok: false, error: "Too many lecture videos." });
  const old = LVmap[id];
  try {
    let msg = null;
    if (url && PCH) {
      const m = await fetch(`${API}/channels/${PCH}/messages`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ content: `🎞️ Lecture video set for \`${id}\`\n||LV|${id}|${b64({ u: url, a: Date.now() })}||`, allowed_mentions: { parse: [] } }) });
      if (!m.ok) { console.log("Discord save failed:", m.status, await m.text()); throw new Error("save"); }
      msg = (await m.json()).id;
    }
    if (old && old.msg && PCH) fetch(`${API}/channels/${PCH}/messages/${old.msg}`, { method: "DELETE", headers: H }).catch(() => {});
    if (url) LVmap[id] = { url, msg }; else delete LVmap[id];
    if (!PCH) persistL();
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: "Could not save the link. Please try again." }); }
});

// ---- Discord notifications: direct messages and channel posts ----
const OWNERS = (E.OWNER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const OUT_CH = E.OUTCOMES_CHANNEL_ID, ALERT_CH = E.ALERTS_CHANNEL_ID;
const dmCache = new Map();
async function post(ch, content, users = []) {
  const r = await fetch(`${API}/channels/${ch}/messages`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [], users } }) });
  if (!r.ok) console.log("Post failed:", r.status, await r.text());
  return r.ok;
}
async function dm(userId, content) {
  try {
    let ch = dmCache.get(userId);
    if (!ch) {
      const c = await fetch(`${API}/users/@me/channels`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ recipient_id: userId }) });
      if (!c.ok) { console.log("DM channel failed:", c.status); return false; }
      ch = (await c.json()).id; dmCache.set(userId, ch);
    }
    return await post(ch, content);
  } catch (e) { return false; }
}
// Tell the owner(s) by DM. If a DM cannot be delivered, ping them in ALERTS_CHANNEL_ID instead (if set).
async function notifyOwner(content) {
  for (const id of OWNERS) {
    const ok = await dm(id, content);
    if (!ok && ALERT_CH) await post(ALERT_CH, `<@${id}> ${content}`, [id]);
  }
}
// Post a homework outcome in OUTCOMES_CHANNEL_ID and ping the member. Falls back to a DM if that is not set or fails.
async function notifyOutcome(s) {
  const text = s.status === "approved"
    ? `✅ <@${s.uid}> your **${s.title}** homework was **approved**. Your next lecture is now unlocked.${s.fb ? `\nNotes from Cartel: ${s.fb}` : ""}`
    : `🔁 <@${s.uid}> your **${s.title}** homework needs changes.\nNotes from Cartel: ${s.fb}\nUpdate it on the site and submit again.`;
  if (OUT_CH && await post(OUT_CH, text, [s.uid])) return;
  await dm(s.uid, text.replace(`<@${s.uid}> `, ""));
}
const prettyDay = d => new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const t12 = t => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`; };
const slotRange = t => { const [h, m] = t.split(":").map(Number), e = h * 60 + m + 30; return `${t12(t)} to ${t12(`${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`)}`; };

// ---- Homework submissions: posted to a private Discord channel and reviewed by the owner ----
const SCH = E.SUBMISSIONS_CHANNEL_ID;
let subs = {}; // `${userId}:${lectureId}` -> { uid, lec, name, username, title, status, fb, at, msg }
const subKey = (uid, lec) => uid + ":" + lec;
const sanitize = (s, n) => String(s || "").replace(/[|*_`~<>@\\]/g, "").slice(0, n);
const EXT_OK = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "doc", "docx", "txt"];
const subContent = s => {
  const meta = Buffer.from(JSON.stringify({ n: s.name, u: s.username, t: s.title, f: s.fb, a: s.at })).toString("base64url");
  return `📥 **${s.name}** (@${s.username}) submitted **${s.title}**\nStatus: ${s.status.toUpperCase()}${s.fb ? "\nFeedback: " + s.fb : ""}\n||SUB|${s.uid}|${s.lec}|${s.status}|${meta}||`;
};

async function loadSubs() {
  if (!SCH) { console.log("No SUBMISSIONS_CHANNEL_ID set: homework submissions are switched off."); return; }
  await scan(SCH, m => {
    const x = /\|\|SUB\|(\d+)\|([a-z0-9-]+)\|(pending|approved|rejected)\|([\w-]+)\|\|/.exec(m.content || "");
    if (!x || subs[subKey(x[1], x[2])]) return; // newest message wins
    try {
      const o = JSON.parse(Buffer.from(x[4], "base64url").toString());
      subs[subKey(x[1], x[2])] = { uid: x[1], lec: x[2], name: o.n, username: o.u, title: o.t, status: x[3], fb: o.f || "", at: o.a || 0, msg: m.id };
    } catch (e) {}
  });
}

app.post("/api/submit", auth, express.json({ limit: "12mb" }), async (req, res) => {
  if (!SCH) return res.json({ ok: false, error: "Submissions are not set up yet. Please tell the owner." });
  const u = req.session.user, b = req.body || {};
  const lec = String(b.lecture || "");
  if (!/^[a-z0-9-]{1,60}$/.test(lec)) return res.json({ ok: false, error: "Unknown lecture." });
  const key = subKey(u.id, lec), prev = subs[key];
  if (prev && (prev.status === "pending" || prev.status === "approved")) return res.json({ ok: false, error: "This lecture has already been submitted." });
  const notes = String(b.notes || "").slice(0, 20000), hw = String(b.hw || "").slice(0, 5000);
  if (notes.trim().length < 20) return res.json({ ok: false, error: "Your notes need at least 20 characters." });
  const files = [];
  let total = 0;
  for (const f of (Array.isArray(b.files) ? b.files.slice(0, 6) : [])) {
    const name = String(f.name || "file").replace(/[^\w.\- ]/g, "_").slice(0, 80);
    const ext = name.split(".").pop().toLowerCase();
    const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(String(f.data || ""));
    if (!EXT_OK.includes(ext) || !m) return res.json({ ok: false, error: "That file type is not supported: " + name });
    const buf = Buffer.from(m[1], "base64");
    total += buf.length;
    if (buf.length > 1.6e6 || total > 8e6) return res.json({ ok: false, error: "Your files are too large to send." });
    files.push({ name, buf });
  }
  if (!files.length && !hw.trim()) return res.json({ ok: false, error: "Add your homework before submitting." });
  const s = { uid: u.id, lec, name: sanitize(u.name, 40) || "member", username: sanitize(u.username, 40) || "unknown", title: sanitize(b.title, 60) || lec, status: "pending", fb: "", at: Date.now() };
  subs[key] = s; // reserve first so a double click cannot submit twice
  try {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: subContent(s), allowed_mentions: { parse: [] } }));
    form.append("files[0]", new Blob([`NOTES\n\n${notes}\n\nHOMEWORK\n\n${hw || "(see attached files)"}\n`], { type: "text/plain" }), "notes.txt");
    files.forEach((f, i) => form.append(`files[${i + 1}]`, new Blob([f.buf]), f.name));
    const r = await fetch(`${API}/channels/${SCH}/messages`, { method: "POST", headers: H, body: form });
    if (!r.ok) { console.log("Submission save failed:", r.status, await r.text()); throw new Error("save"); }
    s.msg = (await r.json()).id;
  } catch (e) {
    if (prev) subs[key] = prev; else delete subs[key];
    return res.json({ ok: false, error: "Could not send your work. Please try again." });
  }
  if (prev && prev.msg) fetch(`${API}/channels/${SCH}/messages/${prev.msg}`, { method: "DELETE", headers: H }).catch(() => {}); // replace the earlier, rejected one
  notifyOwner(`📥 New homework to review: **${s.name}** (@${s.username}) submitted **${s.title}**.${E.BASE_URL ? " Open the Review tab: " + E.BASE_URL : ""}`).catch(() => {});
  res.json({ ok: true });
});

app.get("/api/my-progress", auth, (req, res) => {
  const out = {};
  for (const s of Object.values(subs)) if (s.uid === req.session.user.id) out[s.lec] = { status: s.status, fb: s.fb };
  res.json(out);
});

app.get("/api/reviews", auth, (req, res) => {
  if (!isOwner(req.session.user.id)) return res.status(403).json({ ok: false });
  res.json(Object.values(subs).filter(s => s.status === "pending").sort((a, b) => b.at - a.at).slice(0, 200).map(({ uid, lec, name, username, title, status, fb, at }) => ({ uid, lec, name, username, title, status, fb, at })));
});

app.get("/api/reviews/detail", auth, async (req, res) => {
  if (!isOwner(req.session.user.id)) return res.status(403).json({ ok: false });
  const s = subs[subKey(String(req.query.uid || ""), String(req.query.lec || ""))];
  if (!s || !s.msg) return res.status(404).json({ ok: false });
  try {
    const m = await fetch(`${API}/channels/${SCH}/messages/${s.msg}`, { headers: H }).then(r => r.json());
    const atts = m.attachments || [], first = atts.find(a => a.filename === "notes.txt");
    const notes = first ? (await fetch(first.url).then(r => r.text())).slice(0, 30000) : "";
    res.json({ notes, files: atts.filter(a => a !== first).map(a => ({ name: a.filename, url: a.url, type: a.content_type || "" })) });
  } catch (e) { res.status(502).json({ ok: false }); }
});

app.post("/api/review", auth, async (req, res) => {
  if (!isOwner(req.session.user.id)) return res.status(403).json({ ok: false, error: "Only the owner can review work." });
  const s = subs[subKey(String(req.body.uid || ""), String(req.body.lec || ""))];
  if (!s || s.status !== "pending") return res.json({ ok: false, error: "This submission is no longer waiting for review." });
  const approve = req.body.action === "approve", fb = sanitize(req.body.fb, 300);
  if (!approve && !fb.trim()) return res.json({ ok: false, error: "Add feedback so the member knows what to change." });
  const old = { status: s.status, fb: s.fb };
  s.status = approve ? "approved" : "rejected"; s.fb = fb;
  try {
    const r = await fetch(`${API}/channels/${SCH}/messages/${s.msg}`, { method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ content: subContent(s), allowed_mentions: { parse: [] } }) });
    if (!r.ok) { console.log("Review save failed:", r.status, await r.text()); throw new Error("save"); }
  } catch (e) { s.status = old.status; s.fb = old.fb; return res.json({ ok: false, error: "Could not save the review. Please try again." }); }
  notifyOutcome(s).catch(() => {});
  res.json({ ok: true });
});

async function loadAll() {
  await loadBookings();
  await loadSubs();
  if (!PCH) {
    try { recaps = JSON.parse(fs.readFileSync(PFILE, "utf8")); } catch (e) {}
    try { LVmap = JSON.parse(fs.readFileSync(LFILE, "utf8")); } catch (e) {}
    return;
  }
  await scan(PCH, m => {
    const c = m.content || "";
    let x = /\|\|PA\|([\w-]+)\|\|/.exec(c);
    if (x) { try { const o = unb64(x[1]); recaps.push({ id: m.id, title: o.t, desc: o.d, url: o.u, at: o.a }); } catch (e) {} return; }
    x = /\|\|LV\|([a-z0-9-]{1,60})\|([\w-]+)\|\|/.exec(c);
    if (x && !LVmap[x[1]]) { try { LVmap[x[1]] = { url: unb64(x[2]).u, msg: m.id }; } catch (e) {} }
  });
}

app.use(express.static("public"));
loadAll().catch(e => console.log("Bookings load failed:", e.message)).finally(() => app.listen(process.env.PORT || 3000, () => console.log("Cartel running")));
