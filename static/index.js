"use strict";

var sock,
	isAlive = false,
	wasConnected = false;

if ("Notification" in window) {
	try {
		Notification.requestPermission().then((permission) => {
			console.log("Notification permission", permission);
		});
	} catch (e) {
		console.log("Notification permission request failed");
	}
}

const msgcnt = document.getElementById("messages");
const msgbox = document.getElementById("msgbox");
const msgform = document.getElementById("msgform");

const encModal = document.getElementById("encKeyDia");
const encInput = encModal.querySelector("#enckey");
const encMessage = encModal.querySelector("#message");
const encState = document.getElementById("enc-state");
const encOpenBtn = document.querySelector('[commandfor="encKeyDia"]');
const nsEnc = document.getElementById("ns-enc");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

var encryptionKey = "";

/* ------------------------------------------------------------------
 * Encryption module (Go wasm). Loaded exactly once; callers await it.
 * ------------------------------------------------------------------ */

const go = new Go();
var encryptionReady = null;

function loadEncryptionModule() {
	if (!encryptionReady) {
		const source = fetch("/static/kasenc.wasm");
		const inst = WebAssembly.instantiateStreaming
			? WebAssembly.instantiateStreaming(source, go.importObject)
			: source
				.then((r) => r.arrayBuffer())
				.then((buf) => WebAssembly.instantiate(buf, go.importObject));
		encryptionReady = inst
			.then((result) => {
				go.run(result.instance);
				return true;
			})
			.catch((err) => {
				encryptionReady = null;
				throw err;
			});
	}
	return encryptionReady;
}

function decryptInto(el) {
	const res = AESDecrypt(el.dataset.encval, encryptionKey);
	if (res.error) {
		el.textContent = "[unable to decrypt: " + res.error + "]";
		el.dataset.encfailed = "true";
		return res.error;
	}
	delete el.dataset.encfailed;
	el.textContent = res.result;
	return null;
}

function updateEncryptionKey(newkey) {
	encryptionKey = newkey;
	document.body.dataset.enc = encryptionKey ? "on" : "off";
	encState.textContent = encryptionKey ? "on" : "off";
	nsEnc.textContent = encryptionKey ? "aes" : "off";

	const failed = msgcnt.querySelectorAll(".msg[data-encfailed]");
	if (failed.length === 0) return;
	loadEncryptionModule().then(() => {
		for (const el of failed) decryptInto(el);
	});
}

/* ------------------------------------------------------------------
 * Key dialog
 * ------------------------------------------------------------------ */

function openKeyDialog(message) {
	if (typeof message === "string") encMessage.textContent = message;
	if (!encModal.open) {
		encModal.returnValue = "";
		encModal.showModal();
	}
}

// Fallback for browsers without invoker commands (command/commandfor).
// Deferred so a native invoker gets the first chance; never double-opens.
encOpenBtn.addEventListener("click", () => {
	encMessage.textContent = "";
	encInput.value = encryptionKey;
	setTimeout(() => {
		if (!encModal.open) openKeyDialog();
	}, 0);
});

encModal.addEventListener("close", () => {
	const rv = encModal.returnValue;
	encModal.returnValue = "";
	if (rv === "confirm") updateEncryptionKey(encInput.value);
	else encInput.value = encryptionKey;
	// Chromium restores focus to the composer without a live caret, which
	// swallows the next keystroke; re-seat the caret explicitly.
	setTimeout(() => {
		if (document.activeElement === msgbox) {
			const n = msgbox.value.length;
			msgbox.blur();
			msgbox.focus();
			msgbox.setSelectionRange(n, n);
		}
	}, 0);
});

/* ------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------ */

const USER_COLORS = 10; // .c0 … .c9 in terminal-tmux.css

function shortId(id) {
	return String(id || "").slice(0, 7);
}

// Hash only the 7-char id prefix: presence lines carry just that prefix, so
// nicks get the same colour in join/leave lines, messages and the nicklist.
function getUserColor(id) {
	let val = 0;
	const s = shortId(id);
	for (let i = 0; i < s.length; i++) {
		val = (val * 31 + s.charCodeAt(i)) >>> 0;
	}
	return "c" + (val % USER_COLORS);
}

function pad(n) {
	return n < 10 ? "0" + n : "" + n;
}

function nowStamp() {
	const d = new Date();
	return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// The server HTML-escapes usernames and plain-text messages before relaying
// them. We render with textContent (never innerHTML), so decode the entities
// once. A detached <textarea> parses its content as RCDATA: tags stay inert
// text, only character references are decoded.
const entityDecoder = document.createElement("textarea");
function decodeEntities(str) {
	if (str == null) return "";
	str = String(str);
	if (str.indexOf("&") === -1) return str;
	entityDecoder.innerHTML = str;
	return entityDecoder.value;
}

function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}

function isNearBottom() {
	return msgcnt.scrollHeight - msgcnt.scrollTop - msgcnt.clientHeight < 120;
}

function scrollToNewest(force) {
	if (!force && !isNearBottom()) return;
	msgcnt.scrollTo({
		top: msgcnt.scrollHeight,
		behavior: reduceMotion.matches ? "auto" : "smooth",
	});
}

function appendLine(line, forceScroll) {
	const stick = forceScroll || isNearBottom();
	msgcnt.appendChild(line);
	if (stick) scrollToNewest(true);
}

const SYS_PREFIX = { join: "-->", leave: "<--", warn: "!!", good: "--", info: "--" };

function systemLine(kind, build) {
	const line = el("div", "line sys " + kind);
	line.appendChild(el("span", "ts", nowStamp()));
	const nick = el("span", "nick");
	nick.appendChild(el("span", "pfx", SYS_PREFIX[kind] || "--"));
	line.appendChild(nick);
	const text = el("span", "text");
	build(text);
	line.appendChild(text);
	appendLine(line);
	return line;
}

function notify(text) {
	if (!("Notification" in window) || Notification.permission !== "granted") return;
	if (document.hasFocus()) return;
	try {
		new Notification(text);
	} catch (e) {
		console.log("Failed to create notification");
	}
}

// Server presence text looks like "alice (abc1234) joined the chat!".
const PRESENCE_RE = /^(.*) \(([^)]*)\) (joined|left) the chat!?$/;

function handlePresence(msg, forceLeave) {
	// presence text contains the (already escaped) username, escaped again
	const raw = decodeEntities(decodeEntities(msg.message));
	const m = raw.match(PRESENCE_RE);
	const left = forceLeave || (m && m[3] === "left");
	const isSelf = msg.user_id
		? msg.user_id === window.chatdata.user_id
		: !!(m && m[2] && window.chatdata.user_id.slice(0, m[2].length) === m[2]);

	systemLine(left ? "leave" : "join", (text) => {
		if (!m) {
			text.textContent = raw;
			return;
		}
		const who = el("span", "who " + (isSelf ? "me" : getUserColor(m[2])), m[1]);
		text.appendChild(who);
		text.appendChild(el("span", "faint", " (" + m[2] + ")"));
		text.appendChild(
			document.createTextNode(
				left
					? " has quit #" + window.chatdata.room_id
					: " has joined #" + window.chatdata.room_id,
			),
		);
	});

	if (m) seeUser(isSelf ? window.chatdata.user_id : m[2], m[1], !left);

	if (!isSelf && raw) notify(raw);
}

function handleUserMessage(msg) {
	const isSelf = msg.user_id === window.chatdata.user_id;
	const username = decodeEntities(msg.username) || "?";
	const line = el("div", "line " + (isSelf ? "self" : "other"));
	line.appendChild(el("span", "ts", nowStamp()));

	const nick = el("span", "nick " + (isSelf ? "me" : getUserColor(msg.user_id)));
	nick.title = username + " (" + shortId(msg.user_id) + ")";
	nick.appendChild(el("span", "name", username));
	line.appendChild(nick);
	seeUser(msg.user_id, username, true);

	const body = el("span", "text");
	const text = el("span", "msg");
	if (msg.type === "ENCRYPTED_MESSAGE") {
		const tag = el("span", "enc-tag", "e2e");
		tag.title = "End-to-end encrypted";
		body.appendChild(tag);
		text.dataset.encval = msg.message;
		text.textContent = "decrypting…";
		loadEncryptionModule().then(
			() => {
				const err = decryptInto(text);
				if (err) openKeyDialog("Decryption failed: " + err);
			},
			() => {
				text.textContent = "[encryption module failed to load]";
				text.dataset.encfailed = "true";
			},
		);
	} else {
		text.textContent = decodeEntities(msg.message);
	}
	body.appendChild(text);
	line.appendChild(body);

	appendLine(line, isSelf);

	if (!isSelf) {
		notify(
			`New message from ${username} (${String(msg.user_id || "").slice(0, 5)})`,
		);
	}
}

function handleMessage(e) {
	let msg;
	try {
		msg = JSON.parse(e.data);
	} catch (err) {
		return;
	}

	if (msg.type === "PONG") {
		isAlive = true;
	} else if (msg.type === "JOINED") {
		handlePresence(msg, false);
	} else if (msg.type === "LEFT") {
		handlePresence(msg, true);
	} else if (msg.type === "TEXT_MESSAGE" || msg.type === "ENCRYPTED_MESSAGE") {
		handleUserMessage(msg);
	}
}

/* ------------------------------------------------------------------
 * Connection: keepalive + auto-reconnect
 * ------------------------------------------------------------------ */

function setConnected(up) {
	document.body.dataset.conn = up ? "up" : "down";
	if (up && !wasConnected) {
		if (msgcnt.querySelector(".line.warn")) {
			systemLine("good", (t) => (t.textContent = "reconnected to relay, buffer resumed"));
		}
	} else if (!up && wasConnected) {
		systemLine("warn", (t) => (t.textContent = "connection to relay lost — reconnecting…"));
	}
	wasConnected = up;
}

function waitForConnection(callback, interval) {
	if (sock.readyState === 1) {
		callback();
	} else {
		setTimeout(() => waitForConnection(callback, interval), interval);
	}
}

function pingInterval(ws, interval = 5000) {
	if (ws !== sock) return; // a newer socket took over
	if (!isAlive) {
		ws.close();
		return;
	}
	isAlive = false;
	try {
		ws.send(JSON.stringify({ type: "PING" }));
	} catch (e) {
		ws.close();
		return;
	}
	setTimeout(() => pingInterval(ws, interval), interval);
}

function init() {
	const ws = new WebSocket(`/ws/${encodeURIComponent(window.chatdata.room_id)}`);
	sock = ws;

	ws.addEventListener("open", function () {
		setConnected(true);
		waitForConnection(function () {
			isAlive = true;
			pingInterval(ws);
		}, 300);
	});

	ws.addEventListener("close", function () {
		ws.removeEventListener("message", handleMessage);
		if (ws !== sock) return;
		setConnected(false);
		setTimeout(() => {
			init();
		}, 300);
	});
	ws.addEventListener("message", handleMessage);
}

/* ------------------------------------------------------------------
 * Composer
 * ------------------------------------------------------------------ */

function autoGrow() {
	msgbox.style.height = "auto";
	const max = parseFloat(getComputedStyle(msgbox).maxHeight) || 240;
	const h = Math.min(msgbox.scrollHeight, max);
	msgbox.style.height = h + "px";
	msgbox.style.overflowY = msgbox.scrollHeight > max ? "auto" : "hidden";
}

async function handleSubmit(e) {
	e.preventDefault();
	if (!sock || sock.readyState !== 1) return;
	const text = msgbox.value;
	if (!text.trim()) return;

	let payload;
	if (encryptionKey) {
		try {
			await loadEncryptionModule();
		} catch (err) {
			openKeyDialog("Encryption module failed to load.");
			return;
		}
		const result = AESEncrypt(text, encryptionKey);
		if (!result.result) {
			console.error(result.error);
			openKeyDialog("Encryption failed: " + result.error);
			return;
		}
		payload = { ...window.chatdata, message: result.result, type: "ENCRYPTED_MESSAGE" };
	} else {
		payload = { ...window.chatdata, message: text, type: "TEXT_MESSAGE" };
	}

	sock.send(JSON.stringify(payload));
	msgbox.value = "";
	autoGrow();
	updateCaret();
}

function handleKeyPressEvent(e) {
	if (e.key !== "Enter" || e.isComposing) return;
	e.preventDefault();
	if (e.metaKey || e.ctrlKey) {
		const start = msgbox.selectionStart;
		const end = msgbox.selectionEnd;
		msgbox.value = msgbox.value.substring(0, start) + "\n" + msgbox.value.substring(end);
		msgbox.selectionStart = msgbox.selectionEnd = start + 1;
		autoGrow();
		updateCaret();
	} else {
		msgform.requestSubmit();
	}
}

msgform.addEventListener("submit", handleSubmit);
msgbox.addEventListener("keydown", handleKeyPressEvent);
msgbox.addEventListener("input", autoGrow);

/* ------------------------------------------------------------------
 * Nicklist: everyone seen in this session (join/leave + messages)
 * ------------------------------------------------------------------ */

const nicklist = document.getElementById("nicklist");
const usersCount = [document.getElementById("users-count"), document.getElementById("users-count-sb")];
const users = new Map(); // short id -> { name, here, self }

function seeUser(id, name, here) {
	const key = shortId(id);
	if (!key) return;
	const self = key === shortId(window.chatdata.user_id);
	const u = users.get(key) || { name: name, here: here, self: self };
	if (name) u.name = name;
	u.here = here;
	users.set(key, u);
	renderUsers();
}

function renderUsers() {
	const list = [...users.entries()].sort((a, b) => {
		const [, x] = a;
		const [, y] = b;
		if (x.self !== y.self) return x.self ? -1 : 1;
		if (x.here !== y.here) return x.here ? -1 : 1;
		return x.name.localeCompare(y.name);
	});
	nicklist.replaceChildren();
	let here = 0;
	for (const [key, u] of list) {
		if (u.here) here++;
		const li = el("li", "nk " + (u.here ? "here" : "gone") + (u.self ? " self" : ""));
		li.title = u.name + " (" + key + ")" + (u.here ? "" : " — left");
		li.appendChild(el("span", "nk-dot", u.here ? "●" : "○"));
		li.appendChild(el("span", "nk-name " + (u.self ? "me" : getUserColor(key)), u.name));
		if (u.self) li.appendChild(el("span", "nk-tag", "(you)"));
		else if (!u.here) li.appendChild(el("span", "nk-tag", "left"));
		nicklist.appendChild(li);
	}
	const label = here + (users.size !== here ? "/" + users.size : "");
	for (const c of usersCount) c.textContent = label;
}

seeUser(window.chatdata.user_id, decodeEntities(window.chatdata.username), true);

const usersToggle = document.getElementById("users-toggle");
const narrow = window.matchMedia("(max-width: 760px)");

function usersShown() {
	return narrow.matches
		? document.body.classList.contains("users-open")
		: !document.body.classList.contains("users-collapsed");
}

function syncUsersToggle() {
	usersToggle.setAttribute("aria-expanded", usersShown() ? "true" : "false");
}

usersToggle.addEventListener("click", () => {
	if (narrow.matches) document.body.classList.toggle("users-open");
	else document.body.classList.toggle("users-collapsed");
	syncUsersToggle();
});
// on phones the nicklist floats over the buffer; tapping the buffer closes it
msgcnt.addEventListener("click", () => {
	if (narrow.matches && document.body.classList.contains("users-open")) {
		document.body.classList.remove("users-open");
		syncUsersToggle();
	}
});
narrow.addEventListener("change", () => {
	document.body.classList.remove("users-open");
	syncUsersToggle();
});
syncUsersToggle();

/* ------------------------------------------------------------------
 * Vim-ish modes: INSERT while the composer has focus, NORMAL otherwise
 * ------------------------------------------------------------------ */

const modeEl = document.getElementById("mode");
const cmdMode = document.getElementById("cmdmode");
const caretEl = document.getElementById("caret");
const modFlag = document.getElementById("modflag");

function setMode(insert) {
	document.body.dataset.mode = insert ? "insert" : "normal";
	modeEl.textContent = insert ? "INSERT" : "NORMAL";
	cmdMode.textContent = insert ? "-- INSERT --" : "";
}

function updateCaret() {
	const before = msgbox.value.slice(0, msgbox.selectionStart);
	const lines = before.split("\n");
	caretEl.textContent = lines.length + ":" + (lines[lines.length - 1].length + 1);
	modFlag.textContent = msgbox.value ? "[+]" : "";
}

msgbox.addEventListener("focus", () => setMode(true));
msgbox.addEventListener("blur", () => setMode(false));
for (const ev of ["input", "keyup", "click", "select"]) msgbox.addEventListener(ev, updateCaret);
msgbox.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		e.preventDefault();
		msgbox.blur();
	}
});

// NORMAL-mode shortcuts: i/a = insert, e = key dialog, u = users pane
document.addEventListener("keydown", (e) => {
	if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
	if (encModal.open) return;
	const t = e.target;
	if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
	if (e.key === "i" || e.key === "a") {
		e.preventDefault();
		msgbox.focus();
	} else if (e.key === "e") {
		e.preventDefault();
		encOpenBtn.click();
	} else if (e.key === "u") {
		e.preventDefault();
		usersToggle.click();
	}
});

setMode(document.activeElement === msgbox);

/* the stored username is HTML-escaped by the server; show it decoded */
for (const n of document.querySelectorAll("[data-uname]")) {
	n.textContent = decodeEntities(window.chatdata.username);
}

/* status-line clock */
const clock = document.getElementById("clock");
const dateEl = document.getElementById("date");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
for (const ts of msgcnt.querySelectorAll(".line .ts")) ts.textContent = nowStamp();
function tick() {
	const d = new Date();
	clock.textContent = nowStamp();
	dateEl.textContent = DAYS[d.getDay()] + " " + pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
	setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
}
tick();

loadEncryptionModule().catch((err) => console.error("kasenc load failed", err));
init();
