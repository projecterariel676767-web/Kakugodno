const $ = id => document.getElementById(id);
let token = localStorage.getItem("kakugodno_token") || "";
let me = null, socket = null, contacts = [], activeContact = null, messages = [], replyTarget = null;
let authMode = "login", avatarData = "", searchTimer = null, activeCall = null, queuedOffer = null, keepaliveTimer = null;
const reactions = ["❤️","😂","👍","🔥","😮","😢","🎉","👎"];
const api = async (url, options = {}) => {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch("/api" + url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Не удалось выполнить запрос.");
  return data;
};
const esc = value => String(value || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const initials = name => (name || "?").trim().slice(0,2).toUpperCase();
function avatar(user, cls = "avatar") {
  const el = document.createElement("span"); el.className = cls;
  if (user?.avatarUrl) { const img = document.createElement("img"); img.src = user.avatarUrl; img.alt = ""; el.append(img); }
  else el.textContent = initials(user?.nickname);
  return el;
}
function setMode(mode) {
  authMode = mode;
  document.querySelectorAll(".auth-tabs .tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  $("authSubmit").innerHTML = mode === "login" ? 'Войти <span>→</span>' : 'Создать аккаунт <span>→</span>';
  $("avatarField").classList.toggle("hidden", mode !== "register");
  $("authPassword").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authError").textContent = "";
}
document.querySelectorAll(".auth-tabs .tab").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("avatarInput").addEventListener("change", async e => {
  const file = e.target.files?.[0]; if (!file) return;
  if (file.size > 500 * 1024) { $("authError").textContent = "Аватар должен быть меньше 500 КБ."; e.target.value = ""; return; }
  if (!file.type.startsWith("image/")) { $("authError").textContent = "Выбери файл изображения."; return; }
  avatarData = await fileToData(file);
  $("avatarPreview").innerHTML = ""; $("avatarPreview").append(avatar( { nickname: " ", avatarUrl: avatarData }, "avatar" ));
});
function fileToData(file) { return new Promise((resolve,reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); }); }
$("authForm").addEventListener("submit", async e => {
  e.preventDefault(); $("authSubmit").disabled = true; $("authError").textContent = "";
  try {
    const body = { nickname: $("authNickname").value.trim(), password: $("authPassword").value };
    if (authMode === "register" && avatarData) body.avatarUrl = avatarData;
    const data = await api(authMode === "login" ? "/auth/login" : "/auth/register", { method: "POST", body: JSON.stringify(body) });
    token = data.token; localStorage.setItem("kakugodno_token", token); me = data.user; await enterApp();
  } catch (err) { $("authError").textContent = err.message; }
  finally { $("authSubmit").disabled = false; }
});
async function boot() {
  if (!token) return;
  try { me = (await api("/me")).user; await enterApp(); }
  catch { token = ""; localStorage.removeItem("kakugodno_token"); }
}
async function enterApp() {
  $("authScreen").classList.add("hidden"); $("appScreen").classList.remove("hidden");
  $("profileSelfBtn").replaceChildren(avatar(me)); $("selfMini").replaceChildren(avatar(me,"avatar small-avatar"));
  const mini = document.createElement("span"); mini.innerHTML = "<b>" + esc(me.nickname) + "</b><small>Мой профиль</small>"; $("selfMini").append(mini);
  $("profileSelfBtn").onclick = () => showProfile(me._id, true);
  $("logoutBtn").onclick = logout;
  connectSocket();
  await Promise.all([loadContacts(), loadRequests()]);
}
function logout() {
  if (socket) socket.disconnect(); socket = null;
  clearInterval(keepaliveTimer); keepaliveTimer = null;
  if (activeCall) finishCall(false);
  token = ""; me = null; localStorage.removeItem("kakugodno_token");
  $("appScreen").classList.add("hidden"); $("authScreen").classList.remove("hidden");
  closeModal(); setMode("login");
}
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => { if (socket?.connected) socket.emit("keepalive"); }, 5 * 60 * 1000);
  socket.on("connect_error", () => toast("Не удалось подключиться к серверу. Обнови страницу.", "error"));
  socket.on("message:new", msg => {
    if (activeContact && [msg.sender._id,msg.recipient._id].includes(activeContact._id)) {
      if (!messages.some(m => m._id === msg._id)) { messages.push(msg); renderMessages(true); }
    }
  });
  socket.on("message:updated", msg => {
    const i = messages.findIndex(m => m._id === msg._id);
    if (i >= 0) { messages[i] = msg; renderMessages(false); }
  });
  socket.on("message:deleted", ({_id}) => { messages = messages.filter(m => m._id !== _id); renderMessages(false); });
  socket.on("contact:request", ({request}) => { toastRequest(request); });
  socket.on("contact:accepted", ({user}) => { toast(user.nickname + " теперь в твоих контактах", "success"); loadContacts(); });
  socket.on("contact:rejected", () => toast("Запрос контакта отклонён", "info"));
  socket.on("presence:update", ({userId,online}) => {
    const c = contacts.find(x => x._id === userId); if (c) { c.online = online; renderContacts(); }
    if (activeContact?._id === userId) updatePresence(online);
  });
  socket.on("presence:snapshot", ({online}) => { contacts.forEach(c => c.online = online.includes(c._id)); renderContacts(); if(activeContact) updatePresence(activeContact.online); });
  socket.on("typing", ({userId,active}) => { if (activeContact?._id === userId) $("typingIndicator").classList.toggle("hidden", !active); });
  socket.on("profile:updated", ({user}) => {
    const c = contacts.find(x => x._id === user._id); if (c) Object.assign(c,user);
    if (activeContact?._id === user._id) { Object.assign(activeContact,user); setChatHeader(); }
    renderContacts();
  });
  socket.on("call:offer", payload => showIncomingCall(payload));
  socket.on("call:answer", async ({data}) => { if (!activeCall?.pc) return; try { await activeCall.pc.setRemoteDescription(data); await flushIce(); $("callSub").textContent = "Соединение установлено"; } catch(e) { toast("Не удалось подключить звонок", "error"); finishCall(); } });
  socket.on("call:ice", async ({from,data}) => {
    if (!activeCall?.pc) { if (queuedOffer?.from === from) queuedOffer.pendingIce = [...(queuedOffer.pendingIce || []), data]; return; }
    if (activeCall.user?._id !== from) return;
    try { if (activeCall.pc.remoteDescription) await activeCall.pc.addIceCandidate(data); else activeCall.pendingIce.push(data); } catch(e) { console.warn("ICE",e); }
  });
  socket.on("call:hangup", ({from}) => {
    if (activeCall?.user?._id === from) { toast("Звонок завершён"); finishCall(false); }
    else if (queuedOffer?.from === from) { queuedOffer=null; $("incomingCall").classList.add("hidden"); toast("Звонок завершён"); }
  });
  socket.on("call:decline", ({from}) => { if(activeCall?.user?._id === from){toast("Звонок отклонён");finishCall(false);} });
}
async function loadContacts() {
  try { contacts = (await api("/contacts")).contacts; $("contactCount").textContent = contacts.length; renderContacts(); }
  catch(e) { toast(e.message,"error"); }
}
function renderContacts() {
  const list = $("contactList"); list.innerHTML = ""; $("contactCount").textContent = contacts.length;
  if (!contacts.length) { list.innerHTML = '<div class="empty-side">Здесь будут люди,<br>с которыми ты обменялся контактами.</div>'; return; }
  contacts.sort((a,b) => Number(b.online)-Number(a.online));
  contacts.forEach(c => {
    const row = document.createElement("button"); row.className = "contact-row" + (activeContact?._id === c._id ? " selected" : "");
    row.append(avatar(c,"avatar contact-avatar"));
    const info = document.createElement("span"); info.className = "contact-info";
    info.innerHTML = "<b>" + esc(c.nickname) + "</b><small>" + (c.online ? "В сети" : "Не в сети") + "</small>";
    const status = document.createElement("i"); status.className = "presence-dot" + (c.online ? " online" : "");
    row.append(info,status); row.onclick = () => openConversation(c); list.append(row);
  });
}
function updatePresence(online) { $("chatPresence").textContent = online ? "● В сети" : "Не в сети"; $("chatPresence").classList.toggle("online-text",!!online); }
async function openConversation(contact) {
  activeContact = contact; messages = []; replyTarget = null; renderReplyBar(); renderContacts();
  $("emptyChat").classList.add("hidden"); $("conversation").classList.remove("hidden"); $("conversation").classList.add("mobile-active");
  setChatHeader(); $("messages").innerHTML = '<div class="conversation-start"><span>✦</span><p>Это начало вашей истории</p></div>';
  $("messageInput").focus();
  try { messages = (await api("/conversations/" + contact._id + "/messages")).messages; renderMessages(true); }
  catch(e) { toast(e.message,"error"); }
  if (window.innerWidth <= 760) $("sidebar").classList.add("mobile-hidden");
}
function setChatHeader() {
  $("chatAvatar").replaceChildren(avatar(activeContact,"avatar header-avatar"));
  $("chatName").textContent = activeContact.nickname;
  updatePresence(activeContact.online);
}
$("mobileBack").onclick = () => { $("sidebar").classList.remove("mobile-hidden"); $("conversation").classList.remove("mobile-active"); };
$("chatProfileBtn").onclick = () => activeContact && showProfile(activeContact._id);
$("chatMoreBtn").onclick = () => activeContact && showProfile(activeContact._id);
$("audioCallBtn").onclick = () => activeContact && startCall("audio");
$("videoCallBtn").onclick = () => activeContact && startCall("video");
$("addContactBtn").onclick = $("emptyFindBtn").onclick = () => { $("userSearch").focus(); $("userSearch").scrollIntoView({block:"nearest"}); };
$("userSearch").addEventListener("input", () => {
  clearTimeout(searchTimer); const q = $("userSearch").value.trim();
  if (q.length < 2) { $("searchResults").classList.add("hidden"); return; }
  searchTimer = setTimeout(() => searchUsers(q), 250);
});
async function searchUsers(q) {
  try {
    const {users} = await api("/users/search?q=" + encodeURIComponent(q));
    const box = $("searchResults"); box.innerHTML = "";
    if (!users.length) box.innerHTML = '<div class="search-empty">Никого не нашли</div>';
    users.forEach(u => {
      const b = document.createElement("button"); b.className = "search-result"; b.append(avatar(u,"avatar"));
      const s = document.createElement("span"); s.textContent = u.nickname; b.append(s); b.onclick = () => { box.classList.add("hidden"); $("userSearch").value = ""; showProfile(u._id); }; box.append(b);
    });
    box.classList.remove("hidden");
  } catch(e) { toast(e.message,"error"); }
}
document.addEventListener("click", e => { if (!e.target.closest(".sidebar-actions")) $("searchResults").classList.add("hidden"); });

function renderMessages(scroll) {
  const list = $("messages"), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  list.innerHTML = "";
  if (!messages.length) { list.innerHTML = '<div class="conversation-start"><span>✦</span><p>Напиши первое сообщение</p></div>'; return; }
  let previousDay = "";
  messages.forEach(msg => {
    const day = new Date(msg.createdAt).toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"});
    if (day !== previousDay) { const sep = document.createElement("div"); sep.className = "day-separator"; sep.textContent = day; list.append(sep); previousDay = day; }
    const mine = msg.sender._id === me._id;
    const wrap = document.createElement("div"); wrap.className = "message-row " + (mine ? "mine" : "theirs"); wrap.dataset.id = msg._id;
    const av = avatar(msg.sender,"avatar message-avatar"); av.title = "Открыть профиль " + msg.sender.nickname; av.onclick = () => showProfile(msg.sender._id);
    const body = document.createElement("div"); body.className = "message-body";
    if (msg.forwardedFrom) { const f = document.createElement("div"); f.className = "forwarded-label"; f.textContent = "↗ Переслано"; body.append(f); }
    if (msg.replyTo) { const quote = document.createElement("div"); quote.className = "reply-quote"; quote.innerHTML = "<b>" + esc(msg.replyTo.sender.nickname) + "</b><span>" + esc(msg.replyTo.text) + "</span>"; body.append(quote); }
    const bubble = document.createElement("div"); bubble.className = "bubble";
    const text = document.createElement("div"); text.className = "bubble-text"; text.textContent = msg.text; bubble.append(text);
    const meta = document.createElement("div"); meta.className = "bubble-meta";
    if (msg.editedAt) { const edited = document.createElement("span"); edited.textContent = "изменено"; meta.append(edited); }
    const time = document.createElement("time"); time.textContent = new Date(msg.createdAt).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}); meta.append(time); bubble.append(meta);
    const menuBtn = document.createElement("button"); menuBtn.className = "message-menu-btn"; menuBtn.textContent = "···"; menuBtn.title = "Действия"; menuBtn.onclick = e => { e.stopPropagation(); openMessageMenu(msg, menuBtn); };
    body.append(bubble,menuBtn);
    if (msg.reactions?.length) {
      const reactionsEl = document.createElement("div"); reactionsEl.className = "reactions-list";
      const grouped = {}; msg.reactions.forEach(r => grouped[r.emoji] = (grouped[r.emoji] || 0) + 1);
      Object.entries(grouped).forEach(([emoji,count]) => { const b = document.createElement("button"); b.className = "reaction-chip"; b.textContent = emoji + " " + count; b.title = "Поставить или убрать реакцию"; b.onclick = () => react(msg._id,emoji); reactionsEl.append(b); });
      body.append(reactionsEl);
    }
    if (mine) wrap.append(body,av); else wrap.append(av,body);
    list.append(wrap);
  });
  if (scroll || atBottom) list.scrollTop = list.scrollHeight;
}
function renderReplyBar() {
  $("replyBar").classList.toggle("hidden",!replyTarget);
  $("replyText").textContent = replyTarget ? replyTarget.text : "";
}
$("cancelReply").onclick = () => { replyTarget = null; renderReplyBar(); };
$("messageForm").addEventListener("submit", async e => {
  e.preventDefault(); const text = $("messageInput").value.trim(); if (!text || !activeContact) return;
  $("sendBtn").disabled = true;
  try {
    await api("/messages",{method:"POST",body:JSON.stringify({recipientId:activeContact._id,text,replyTo:replyTarget?._id || null})});
    $("messageInput").value = ""; $("messageInput").style.height = "auto"; replyTarget = null; renderReplyBar();
    socket?.emit("typing",{to:activeContact._id,active:false});
  } catch(err) { toast(err.message,"error"); }
  finally { $("sendBtn").disabled = false; $("messageInput").focus(); }
});
$("messageInput").addEventListener("input", () => {
  const el = $("messageInput"); el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight,120) + "px";
  if (activeContact) { socket?.emit("typing",{to:activeContact._id,active:true}); clearTimeout(el._typingTimer); el._typingTimer = setTimeout(() => socket?.emit("typing",{to:activeContact._id,active:false}),900); }
});
$("messageInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("messageForm").requestSubmit(); } });

function openMessageMenu(msg, anchor) {
  document.querySelectorAll(".message-popover").forEach(n => n.remove());
  const pop = document.createElement("div"); pop.className = "message-popover";
  const action = (label,fn) => { const b=document.createElement("button"); b.textContent=label; b.onclick=()=>{pop.remove();fn();}; pop.append(b); };
  action("↩ Ответить",()=>{ replyTarget=msg; renderReplyBar(); $("messageInput").focus(); });
  action("↗ Переслать",()=>forwardMessage(msg));
  action("☺ Реакция",()=>showReactionPicker(msg,anchor));
  if (msg.sender._id === me._id) {
    action("✎ Изменить",()=>editMessage(msg));
    action("⌫ Удалить",()=>deleteMessage(msg));
  }
  anchor.parentElement.append(pop);
  const close = ev => { if (!pop.contains(ev.target) && ev.target !== anchor) { pop.remove(); document.removeEventListener("click",close); } };
  setTimeout(()=>document.addEventListener("click",close),0);
}
function showReactionPicker(msg,anchor) {
  const pop=document.createElement("div"); pop.className="reaction-picker";
  reactions.forEach(emoji=>{const b=document.createElement("button");b.textContent=emoji;b.onclick=()=>{pop.remove();react(msg._id,emoji);};pop.append(b);});
  anchor.parentElement.append(pop); setTimeout(()=>document.addEventListener("click",e=>{if(!pop.contains(e.target))pop.remove();},{once:true}),0);
}
async function react(id,emoji) { try { await api("/messages/"+id+"/reactions",{method:"POST",body:JSON.stringify({emoji})}); } catch(e){toast(e.message,"error");} }
async function editMessage(msg) {
  const text=prompt("Измени сообщение:",msg.text); if(text===null || !text.trim()) return;
  try { await api("/messages/"+msg._id,{method:"PATCH",body:JSON.stringify({text:text.trim()})}); } catch(e){toast(e.message,"error");}
}
async function deleteMessage(msg) {
  if(!confirm("Удалить это сообщение у всех участников?")) return;
  try { await api("/messages/"+msg._id,{method:"DELETE"}); } catch(e){toast(e.message,"error");}
}
function forwardMessage(msg) {
  if(!contacts.length){toast("Сначала добавь контакт","info");return;}
  openModal("Переслать сообщение",'<p class="modal-subtitle">Выбери, кому отправить сообщение.</p><div id="forwardChoices" class="forward-choices"></div>');
  contacts.forEach(c=>{const b=document.createElement("button");b.className="forward-choice";b.append(avatar(c,"avatar"));const s=document.createElement("span");s.textContent=c.nickname;b.append(s);b.onclick=async()=>{try{await api("/messages/"+msg._id+"/forward",{method:"POST",body:JSON.stringify({recipientId:c._id})});closeModal();toast("Сообщение переслано","success");}catch(e){toast(e.message,"error");}};$("forwardChoices").append(b);});
}
async function showProfile(id,self=false) {
  try {
    const user = self ? me : (await api("/users/"+id)).user;
    const relation = self ? null : (await api("/users/"+id)).relation;
    const isContactNow = contacts.some(c=>c._id===id);
    openModal(self ? "Мой профиль" : "Профиль пользователя",'<div class="profile-card"><div id="profileAvatar" class="profile-avatar"></div><h2 id="profileNickname"></h2><p id="profileAbout"></p><div id="profileStatus" class="profile-status"></div><div id="profileButtons" class="profile-buttons"></div></div>');
    $("profileAvatar").replaceChildren(avatar(user,"avatar profile-big-avatar")); $("profileNickname").textContent=user.nickname; $("profileAbout").textContent=user.about || (self?"Добавь пару слов о себе":"Пока ничего не рассказал о себе");
    if(self){
      $("profileStatus").textContent="Твой аккаунт";
      const b=document.createElement("button");b.className="primary-btn";b.textContent="Изменить профиль";b.onclick=editMyProfile;$("profileButtons").append(b);
    } else {
      $("profileStatus").textContent=isContactNow?"● Вы в контактах": "Пользователь Как угодно";
      if(isContactNow){
        const audio=document.createElement("button");audio.className="primary-btn";audio.textContent="⌕ Аудиозвонок";audio.onclick=()=>{closeModal();startCall("audio",user);};$("profileButtons").append(audio);
        const video=document.createElement("button");video.className="secondary-btn";video.textContent="▣ Видеозвонок";video.onclick=()=>{closeModal();startCall("video",user);};$("profileButtons").append(video);
        const chat=document.createElement("button");chat.className="secondary-btn";chat.textContent="Открыть переписку";chat.onclick=()=>{closeModal();openConversation(contacts.find(c=>c._id===id)||user);};$("profileButtons").append(chat);
      } else if(relation?.status==="pending" && relation.requester===me._id) {
        const s=document.createElement("div");s.className="request-pending";s.textContent="Запрос отправлен";$("profileButtons").append(s);
      } else if(relation?.status==="pending") {
        const s=document.createElement("div");s.className="request-pending";s.textContent="Этот пользователь уже отправил тебе запрос";$("profileButtons").append(s);
        const accept=document.createElement("button");accept.className="primary-btn";accept.textContent="Принять запрос";accept.onclick=async()=>{try{await api("/contacts/requests/"+relation.id+"/accept",{method:"POST"});closeModal();await loadContacts();toast("Теперь вы контакты","success");}catch(e){toast(e.message,"error");}};$("profileButtons").append(accept);
      } else {
        const b=document.createElement("button");b.className="primary-btn";b.textContent="♡ Предложить обменяться контактами";b.onclick=async()=>{try{await api("/contacts/request/"+id,{method:"POST"});b.textContent="Запрос отправлен ✓";b.disabled=true;}catch(e){toast(e.message,"error");}};$("profileButtons").append(b);
      }
    }
  } catch(e){toast(e.message,"error");}
}
function editMyProfile() {
  openModal("Настройки профиля",'<label class="field"><span>О себе</span><input id="aboutInput" maxlength="160" placeholder="Пара слов о тебе..."></label><label class="field"><span>Новый аватар (необязательно)</span><input id="profileAvatarInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><button id="saveProfile" class="primary-btn">Сохранить изменения →</button>');
  $("aboutInput").value=me.about||"";
  $("saveProfile").onclick=async()=>{
    try{
      const body={about:$("aboutInput").value};const f=$("profileAvatarInput").files?.[0];
      if(f){if(f.size>500*1024)throw new Error("Аватар должен быть меньше 500 КБ.");body.avatarUrl=await fileToData(f);}
      me=(await api("/me",{method:"PATCH",body:JSON.stringify(body)})).user;
      $("profileSelfBtn").replaceChildren(avatar(me)); $("selfMini").replaceChildren(avatar(me,"avatar small-avatar"));
      const span=document.createElement("span");span.innerHTML="<b>"+esc(me.nickname)+"</b><small>Мой профиль</small>";$("selfMini").append(span);
      closeModal();toast("Профиль обновлён","success");
    }catch(e){toast(e.message,"error");}
  };
}
async function loadRequests() {
  try { const {requests}=await api("/contacts/requests"); requests.forEach(toastRequest); }
  catch(e){console.warn(e);}
}
function toast(message,type="info") {
  const item=document.createElement("div");item.className="toast "+type;
  const dot=document.createElement("i");dot.textContent=type==="success"?"✓":"✦";
  const text=document.createElement("span");text.textContent=message;item.append(dot,text);$("toastStack").append(item);
  setTimeout(()=>{item.classList.add("leaving");setTimeout(()=>item.remove(),300);},5000);
}
function toastRequest(request) {
  const item=document.createElement("div");item.className="request-toast";
  const top=document.createElement("div");top.className="request-toast-top";top.append(avatar(request.user,"avatar"));
  const msg=document.createElement("span");msg.innerHTML="<b>"+esc(request.user.nickname)+"</b><small>предлагает обменяться контактами</small>";top.append(msg);
  const actions=document.createElement("div");actions.className="request-toast-actions";
  const accept=document.createElement("button");accept.textContent="Принять";accept.onclick=async()=>{try{await api("/contacts/requests/"+request._id+"/accept",{method:"POST"});toast("Контакт добавлен","success");await loadContacts();item.remove();}catch(e){toast(e.message,"error");}};
  const reject=document.createElement("button");reject.textContent="Отклонить";reject.onclick=async()=>{try{await api("/contacts/requests/"+request._id+"/reject",{method:"POST"});item.remove();}catch(e){toast(e.message,"error");}};
  actions.append(accept,reject);
  const progress=document.createElement("div");progress.className="toast-progress";
  item.append(top,actions,progress);$("toastStack").append(item);
  setTimeout(()=>{item.classList.add("leaving");setTimeout(()=>item.remove(),300);},5000);
}
function openModal(title,content) {
  $("modalRoot").innerHTML='<div class="modal-backdrop"><section class="modal"><header><h2>'+esc(title)+'</h2><button id="modalClose" class="icon-btn">×</button></header><div class="modal-content">'+content+'</div></section></div>';
  $("modalClose").onclick=closeModal;
  $("modalRoot").querySelector(".modal-backdrop").addEventListener("click",e=>{if(e.target.classList.contains("modal-backdrop"))closeModal();});
}
function closeModal(){ $("modalRoot").innerHTML=""; }

// Peer-to-peer calls use WebRTC media; Socket.IO is only the signaling channel.
const rtcFallback={iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}]};
async function createPeer(user,callType) {
  let rtcConfig=rtcFallback;
  try { rtcConfig=await api("/rtc-config"); } catch(e) { console.warn("Using fallback ICE servers",e); }
  const pc=new RTCPeerConnection(rtcConfig);
  activeCall={pc,user,callType,localStream:null,pendingIce:[],incoming:false};
  pc.onicecandidate=e=>{if(e.candidate)socket?.emit("call:ice",{to:user._id,data:e.candidate.toJSON(),callType});};
  pc.ontrack=e=>{const stream=e.streams[0];$("remoteVideo").srcObject=stream;};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==="connected")$("callSub").textContent="Соединение установлено";if(["failed","disconnected"].includes(pc.connectionState))$("callSub").textContent="Восстанавливаем соединение...";if(pc.connectionState==="closed")finishCall(false);};
  try {
    const constraints={audio:true,video:callType==="video"};
    const stream=await navigator.mediaDevices.getUserMedia(constraints);activeCall.localStream=stream;
    stream.getTracks().forEach(t=>pc.addTrack(t,stream));
    $("localVideo").srcObject=stream;$("localVideo").classList.toggle("hidden",callType!=="video");
    $("remoteVideo").classList.toggle("hidden",callType!=="video");
    return pc;
  } catch(e) { activeCall=null;pc.close();throw new Error("Нет доступа к микрофону или камере. Разреши доступ в браузере."); }
}
async function startCall(type,user=activeContact) {
  if(!user || activeCall)return;
  if(!navigator.mediaDevices?.getUserMedia){toast("Для звонков открой сайт по HTTPS и разреши доступ к микрофону.","error");return;}
  try {
    showCallScreen(user,type,"Вызов...");
    const pc=await createPeer(user,type);const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    socket.emit("call:offer",{to:user._id,data:pc.localDescription.toJSON(),callType:type});
    $("callSub").textContent="Ожидаем ответа...";
  } catch(e){toast(e.message,"error");$("callOverlay").classList.add("hidden");}
}
function showIncomingCall(payload) {
  if(activeCall){socket?.emit("call:decline",{to:payload.from});return;}
  queuedOffer={...payload,pendingIce:[]};
  $("incomingCallName").textContent=payload.user.nickname+" звонит тебе";
  $("incomingCallType").textContent=payload.callType==="video"?"Видеозвонок":"Аудиозвонок";
  $("incomingCall").classList.remove("hidden");
}
$("acceptCall").onclick=async()=>{
  if(!queuedOffer)return;const incoming=queuedOffer;queuedOffer=null;$("incomingCall").classList.add("hidden");
  try{
    showCallScreen(incoming.user,incoming.callType,"Подключаемся...");
    const pc=await createPeer(incoming.user,incoming.callType);activeCall.incoming=true;activeCall.pendingIce.push(...(incoming.pendingIce||[]));
    await pc.setRemoteDescription(incoming.data);await flushIce();
    const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
    socket.emit("call:answer",{to:incoming.from,data:pc.localDescription.toJSON(),callType:incoming.callType});
  }catch(e){toast(e.message,"error");socket?.emit("call:decline",{to:incoming.from});finishCall(false);}
};
$("declineCall").onclick=()=>{if(queuedOffer)socket?.emit("call:decline",{to:queuedOffer.from});queuedOffer=null;$("incomingCall").classList.add("hidden");};
async function flushIce(){if(!activeCall?.pc?.remoteDescription)return;for(const c of activeCall.pendingIce.splice(0)){try{await activeCall.pc.addIceCandidate(c);}catch(e){console.warn(e);}}}
function showCallScreen(user,type,status) {
  $("callName").textContent=user.nickname;$("callSub").textContent=status;$("callStatus").textContent=type==="video"?"ВИДЕОЗВОНОК":"АУДИОЗВОНОК";
  $("callAvatar").replaceChildren(avatar(user,"avatar profile-big-avatar"));$("callOverlay").classList.remove("hidden");
  $("remoteVideo").classList.toggle("hidden",type!=="video");$("localVideo").classList.toggle("hidden",type!=="video");
}
$("endCall").onclick=()=>finishCall(true);
function finishCall(notify=true) {
  if(activeCall){if(notify)socket?.emit("call:hangup",{to:activeCall.user._id});activeCall.localStream?.getTracks().forEach(t=>t.stop());activeCall.pc?.close();}
  activeCall=null;queuedOffer=null;$("callOverlay").classList.add("hidden");$("incomingCall").classList.add("hidden");
  $("remoteVideo").srcObject=null;$("localVideo").srcObject=null;
}
$("muteCall").onclick=()=>{if(!activeCall?.localStream)return;const track=activeCall.localStream.getAudioTracks()[0];if(track){track.enabled=!track.enabled;$("muteCall").classList.toggle("active",!track.enabled);}};
$("toggleVideo").onclick=()=>{if(!activeCall?.localStream)return;const track=activeCall.localStream.getVideoTracks()[0];if(track){track.enabled=!track.enabled;$("toggleVideo").classList.toggle("active",!track.enabled);}};

boot();