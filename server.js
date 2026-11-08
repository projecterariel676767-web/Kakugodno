const express = require("express");
const http = require("node:http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const path = require("node:path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 1e6 });
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const userSockets = new Map();
const onlineUsers = new Set();

const allowedAvatar = (value) => {
  if (value == null || value === "") return "";
  const prefixes = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"];
  const prefix = typeof value === "string" ? prefixes.find(item => value.startsWith(item)) : null;
  const base64 = prefix ? value.slice(prefix.length) : "";
  if (!prefix || value.length > 700000 || !base64 || new RegExp("[^A-Za-z0-9+/=]").test(base64)) {
    throw new Error("Аватар должен быть изображением PNG, JPG, WEBP или GIF размером до 500 КБ.");
  }
  return value;
};
const userSchema = new mongoose.Schema({
  nickname: { type: String, required: true, trim: true, minlength: 3, maxlength: 24 },
  nicknameKey: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true, select: false },
  avatarUrl: { type: String, default: "" },
  about: { type: String, default: "", maxlength: 160 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);
const requestSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  pairKey: { type: String, required: true, unique: true },
  status: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const ContactRequest = mongoose.model("ContactRequest", requestSchema);
const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  text: { type: String, required: true, maxlength: 5000 },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
  forwardedFrom: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reactions: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, emoji: { type: String, maxlength: 12 } }],
  editedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
messageSchema.index({ sender: 1, recipient: 1, createdAt: -1 });
messageSchema.index({ recipient: 1, sender: 1, createdAt: -1 });
const Message = mongoose.model("Message", messageSchema);

const safeUser = u => ({ _id: String(u._id), nickname: u.nickname, avatarUrl: u.avatarUrl || "", about: u.about || "", createdAt: u.createdAt });
const pairKey = (a, b) => [String(a), String(b)].sort().join(":");
const tokenFor = user => jwt.sign({ sub: String(user._id) }, JWT_SECRET, { expiresIn: "30d" });
const isObjectId = id => mongoose.isValidObjectId(id);
const isContact = async (a, b) => Boolean(await ContactRequest.exists({ pairKey: pairKey(a, b), status: "accepted" }));
const emitUser = (userId, event, payload) => {
  for (const socketId of userSockets.get(String(userId)) || []) io.to(socketId).emit(event, payload);
};
const auth = async (req, res, next) => {
  try {
    const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!raw) return res.status(401).json({ error: "Нужно войти в аккаунт." });
    const payload = jwt.verify(raw, JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: "Аккаунт не найден." });
    req.user = user; next();
  } catch { res.status(401).json({ error: "Сессия завершилась. Войдите снова." }); }
};
const populateMessage = q => q.populate("sender", "nickname avatarUrl").populate("recipient", "nickname avatarUrl")
  .populate({ path: "replyTo", populate: { path: "sender", select: "nickname avatarUrl" } })
  .populate("forwardedFrom", "nickname avatarUrl").populate("reactions.user", "nickname");
const messageView = m => ({
  _id: String(m._id), text: m.text, sender: safeUser(m.sender), recipient: safeUser(m.recipient),
  replyTo: m.replyTo ? { _id: String(m.replyTo._id), text: m.replyTo.text, sender: safeUser(m.replyTo.sender) } : null,
  forwardedFrom: m.forwardedFrom ? safeUser(m.forwardedFrom) : null,
  reactions: (m.reactions || []).map(r => ({ user: String(r.user?._id || r.user), nickname: r.user?.nickname || "", emoji: r.emoji })),
  editedAt: m.editedAt, createdAt: m.createdAt
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "kakugodno", database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" }));
app.post("/api/auth/register", async (req, res) => {
  try {
    const nickname = String(req.body.nickname || "").trim(), password = String(req.body.password || "");
    if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(nickname)) return res.status(400).json({ error: "Никнейм: 3–24 символа, буквы, цифры, точка, _ или -." });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: "Пароль должен содержать от 8 до 72 символов." });
    const nicknameKey = nickname.toLocaleLowerCase("ru");
    if (await User.exists({ nicknameKey })) return res.status(409).json({ error: "Этот никнейм уже занят." });
    const user = await User.create({ nickname, nicknameKey, passwordHash: await bcrypt.hash(password, 12), avatarUrl: allowedAvatar(req.body.avatarUrl) });
    res.status(201).json({ token: tokenFor(user), user: safeUser(user) });
  } catch (e) { res.status(400).json({ error: e.message || "Не удалось создать аккаунт." }); }
});
app.post("/api/auth/login", async (req, res) => {
  try {
    const nicknameKey = String(req.body.nickname || "").trim().toLocaleLowerCase("ru"), password = String(req.body.password || "");
    const user = await User.findOne({ nicknameKey }).select("+passwordHash");
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "Неверный никнейм или пароль." });
    res.json({ token: tokenFor(user), user: safeUser(user) });
  } catch { res.status(400).json({ error: "Не удалось выполнить вход." }); }
});
app.get("/api/me", auth, (req, res) => res.json({ user: safeUser(req.user) }));
app.get("/api/rtc-config", auth, (req, res) => {
  const iceServers = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(",").map(value => value.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.set("Cache-Control", "no-store");
  res.json({ iceServers });
});
app.patch("/api/me", auth, async (req, res) => {
  try {
    if (req.body.avatarUrl !== undefined) req.user.avatarUrl = allowedAvatar(req.body.avatarUrl);
    if (req.body.about !== undefined) req.user.about = String(req.body.about).slice(0, 160);
    await req.user.save(); res.json({ user: safeUser(req.user) });
    io.emit("profile:updated", { user: safeUser(req.user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/users/search", auth, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 24);
  if (q.length < 2) return res.json({ users: [] });
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const users = await User.find({ _id: { $ne: req.user._id }, nickname: { $regex: safe, $options: "i" } }).limit(12);
  res.json({ users: users.map(safeUser) });
});
app.get("/api/users/:id", auth, async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: "Некорректный пользователь." });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден." });
  const relation = await ContactRequest.findOne({ pairKey: pairKey(req.user._id, user._id) }).lean();
  res.json({ user: safeUser(user), relation: relation ? { status: relation.status, requester: String(relation.requester), id: String(relation._id) } : null });
});
app.post("/api/contacts/request/:userId", auth, async (req, res) => {
  if (!isObjectId(req.params.userId) || String(req.user._id) === req.params.userId) return res.status(400).json({ error: "Нельзя отправить запрос этому пользователю." });
  const recipient = await User.findById(req.params.userId);
  if (!recipient) return res.status(404).json({ error: "Пользователь не найден." });
  const key = pairKey(req.user._id, recipient._id);
  let row = await ContactRequest.findOne({ pairKey: key });
  if (row?.status === "accepted") return res.status(409).json({ error: "Вы уже контакты." });
  if (row?.status === "pending") {
    if (String(row.recipient) === String(req.user._id)) {
      row.status = "accepted"; row.updatedAt = new Date(); await row.save();
      emitUser(recipient._id, "contact:accepted", { user: safeUser(req.user) });
      emitUser(req.user._id, "contact:accepted", { user: safeUser(recipient) });
      return res.json({ status: "accepted" });
    }
    return res.status(409).json({ error: "Запрос уже отправлен." });
  }
  if (row) { row.requester = req.user._id; row.recipient = recipient._id; row.status = "pending"; row.updatedAt = new Date(); await row.save(); }
  else row = await ContactRequest.create({ requester: req.user._id, recipient: recipient._id, pairKey: key });
  emitUser(recipient._id, "contact:request", { request: { _id: String(row._id), user: safeUser(req.user), createdAt: row.createdAt } });
  res.status(201).json({ status: "pending" });
});
app.get("/api/contacts/requests", auth, async (req, res) => {
  const rows = await ContactRequest.find({ recipient: req.user._id, status: "pending" }).populate("requester", "nickname avatarUrl about");
  res.json({ requests: rows.map(r => ({ _id: String(r._id), user: safeUser(r.requester), createdAt: r.createdAt })) });
});
app.post("/api/contacts/requests/:id/:action", auth, async (req, res) => {
  if (!["accept", "reject"].includes(req.params.action) || !isObjectId(req.params.id)) return res.status(400).json({ error: "Некорректное действие." });
  const row = await ContactRequest.findOne({ _id: req.params.id, recipient: req.user._id, status: "pending" });
  if (!row) return res.status(404).json({ error: "Запрос уже обработан или не найден." });
  row.status = req.params.action === "accept" ? "accepted" : "rejected"; row.updatedAt = new Date(); await row.save();
  const other = await User.findById(row.requester);
  if (req.params.action === "accept" && other) {
    emitUser(other._id, "contact:accepted", { user: safeUser(req.user) }); emitUser(req.user._id, "contact:accepted", { user: safeUser(other) });
  } else emitUser(row.requester, "contact:rejected", { userId: String(req.user._id) });
  res.json({ status: row.status });
});
app.get("/api/contacts", auth, async (req, res) => {
  const rows = await ContactRequest.find({ $or: [{ requester: req.user._id }, { recipient: req.user._id }], status: "accepted" });
  const ids = rows.map(r => String(r.requester) === String(req.user._id) ? r.recipient : r.requester);
  const users = await User.find({ _id: { $in: ids } });
  res.json({ contacts: users.map(u => ({ ...safeUser(u), online: onlineUsers.has(String(u._id)) })) });
});
app.get("/api/conversations/:userId/messages", auth, async (req, res) => {
  const otherId = req.params.userId;
  if (!isObjectId(otherId) || !(await isContact(req.user._id, otherId))) return res.status(403).json({ error: "Переписка доступна только контактам." });
  const rows = await populateMessage(Message.find({ $or: [{ sender: req.user._id, recipient: otherId }, { sender: otherId, recipient: req.user._id }] }).sort({ createdAt: 1 }).limit(200));
  res.json({ messages: rows.map(messageView) });
});
app.post("/api/messages", auth, async (req, res) => {
  try {
    const recipientId = String(req.body.recipientId || ""), text = String(req.body.text || "").trim();
    if (!isObjectId(recipientId) || text.length < 1 || text.length > 5000) return res.status(400).json({ error: "Сообщение должно содержать от 1 до 5000 символов." });
    if (!(await isContact(req.user._id, recipientId))) return res.status(403).json({ error: "Сначала обменяйтесь контактами." });
    let replyTo = null;
    if (req.body.replyTo) {
      const original = await Message.findById(req.body.replyTo);
      if (!original || ![String(original.sender), String(original.recipient)].includes(String(req.user._id)) || ![String(original.sender), String(original.recipient)].includes(recipientId)) return res.status(400).json({ error: "Сообщение для ответа не найдено." });
      replyTo = original._id;
    }
    const doc = await Message.create({ sender: req.user._id, recipient: recipientId, text, replyTo });
    const view = messageView(await populateMessage(Message.findById(doc._id)));
    emitUser(recipientId, "message:new", view); emitUser(req.user._id, "message:new", view);
    res.status(201).json({ message: view });
  } catch (e) { res.status(400).json({ error: e.message || "Не удалось отправить сообщение." }); }
});
app.patch("/api/messages/:id", auth, async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: "Некорректное сообщение." });
  const text = String(req.body.text || "").trim();
  if (!text || text.length > 5000) return res.status(400).json({ error: "Текст должен содержать от 1 до 5000 символов." });
  const msg = await Message.findOne({ _id: req.params.id, sender: req.user._id });
  if (!msg) return res.status(404).json({ error: "Можно редактировать только своё сообщение." });
  msg.text = text; msg.editedAt = new Date(); await msg.save();
  const view = messageView(await populateMessage(Message.findById(msg._id)));
  emitUser(msg.recipient, "message:updated", view); emitUser(msg.sender, "message:updated", view);
  res.json({ message: view });
});
app.delete("/api/messages/:id", auth, async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: "Некорректное сообщение." });
  const msg = await Message.findOneAndDelete({ _id: req.params.id, sender: req.user._id });
  if (!msg) return res.status(404).json({ error: "Можно удалить только своё сообщение." });
  const payload = { _id: String(msg._id) };
  emitUser(msg.recipient, "message:deleted", payload); emitUser(msg.sender, "message:deleted", payload);
  res.json({ ok: true });
});
app.post("/api/messages/:id/reactions", auth, async (req, res) => {
  const emoji = String(req.body.emoji || "");
  if (!isObjectId(req.params.id) || !["❤️", "😂", "👍", "🔥", "😮", "😢", "🎉", "👎"].includes(emoji)) return res.status(400).json({ error: "Недопустимая реакция." });
  const msg = await Message.findById(req.params.id);
  if (!msg || ![String(msg.sender), String(msg.recipient)].includes(String(req.user._id))) return res.status(404).json({ error: "Сообщение не найдено." });
  const existing = msg.reactions.find(r => String(r.user) === String(req.user._id) && r.emoji === emoji);
  if (existing) msg.reactions = msg.reactions.filter(r => !(String(r.user) === String(req.user._id) && r.emoji === emoji));
  else msg.reactions.push({ user: req.user._id, emoji });
  await msg.save();
  const view = messageView(await populateMessage(Message.findById(msg._id)));
  emitUser(msg.sender, "message:updated", view); emitUser(msg.recipient, "message:updated", view);
  res.json({ message: view });
});
app.post("/api/messages/:id/forward", auth, async (req, res) => {
  const recipientId = String(req.body.recipientId || "");
  if (!isObjectId(req.params.id) || !isObjectId(recipientId)) return res.status(400).json({ error: "Некорректный запрос." });
  const original = await Message.findById(req.params.id);
  if (!original || ![String(original.sender), String(original.recipient)].includes(String(req.user._id))) return res.status(404).json({ error: "Сообщение не найдено." });
  if (!(await isContact(req.user._id, recipientId))) return res.status(403).json({ error: "Получатель не является вашим контактом." });
  const doc = await Message.create({ sender: req.user._id, recipient: recipientId, text: original.text, forwardedFrom: original.sender });
  const view = messageView(await populateMessage(Message.findById(doc._id)));
  emitUser(recipientId, "message:new", view); emitUser(req.user._id, "message:new", view);
  res.status(201).json({ message: view });
});

io.use(async (socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return next(new Error("unauthorized"));
    socket.user = user; next();
  } catch { next(new Error("unauthorized")); }
});
io.on("connection", async socket => {
  const uid = String(socket.user._id);
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(socket.id);
  if (!onlineUsers.has(uid)) {
    onlineUsers.add(uid);
    const links = await ContactRequest.find({ $or: [{ requester: uid }, { recipient: uid }], status: "accepted" }).lean();
    for (const link of links) emitUser(String(link.requester) === uid ? link.recipient : link.requester, "presence:update", { userId: uid, online: true });
  }
  socket.emit("presence:snapshot", { online: [...onlineUsers] });
  socket.on("keepalive", () => socket.emit("keepalive:ok"));
  socket.on("typing", async ({ to, active }) => { if (to && isObjectId(to) && await isContact(uid, to)) emitUser(to, "typing", { userId: uid, active: Boolean(active) }); });
  for (const type of ["offer", "answer", "ice", "hangup", "decline"]) {
    socket.on("call:" + type, async ({ to, data, callType } = {}) => {
      if (!to || !isObjectId(to) || !(await isContact(uid, to))) return;
      emitUser(to, "call:" + type, { from: uid, user: safeUser(socket.user), data: data || null, callType: callType === "video" ? "video" : "audio" });
    });
  }
  socket.on("disconnect", async () => {
    const set = userSockets.get(uid); set?.delete(socket.id);
    if (!set?.size) {
      userSockets.delete(uid); onlineUsers.delete(uid);
      const links = await ContactRequest.find({ $or: [{ requester: uid }, { recipient: uid }], status: "accepted" }).lean();
      for (const link of links) emitUser(String(link.requester) === uid ? link.recipient : link.requester, "presence:update", { userId: uid, online: false });
    }
  });
});
app.get("/{*splat}", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use("/api", (_req, res) => res.status(404).json({ error: "Маршрут не найден." }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "Внутренняя ошибка сервера." }); });

async function start() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is required");
  if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");
  await mongoose.connect(MONGODB_URI);
  console.log("MongoDB connected");
  server.listen(PORT, "0.0.0.0", () => console.log("Как угодно listening on " + PORT));
}
start().catch(error => { console.error(error); process.exit(1); });
