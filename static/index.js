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
});

/* ------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------ */

const USER_COLORS = 10; // .c0 … .c9 in terminal.css

function getUserColor(id) {
	let val = 0;
	const s = String(id || "");
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

function systemLine(kind, build) {
	const line = el("div", "line sys " + kind);
	line.appendChild(el("span", "ts", nowStamp()));
	const nick = el("span", "nick");
	nick.appendChild(el("span", "bang", "-!-"));
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
		text.appendChild(el("span", "who", m[1]));
		text.appendChild(el("span", "faint", " [" + m[2] + "]"));
		text.appendChild(
			document.createTextNode(
				left
					? " has quit #" + window.chatdata.room_id
					: " has joined #" + window.chatdata.room_id,
			),
		);
	});

	if (!isSelf && raw) notify(raw);
}

function handleUserMessage(msg) {
	const isSelf = msg.user_id === window.chatdata.user_id;
	const username = decodeEntities(msg.username) || "?";
	const line = el("div", "line " + (isSelf ? "self" : "other"));
	line.appendChild(el("span", "ts", nowStamp()));

	const nick = el("span", "nick " + (isSelf ? "" : getUserColor(msg.user_id)));
	nick.title = username + " (" + String(msg.user_id || "").slice(0, 7) + ")";
	nick.appendChild(el("span", "br", "<"));
	nick.appendChild(el("span", "name", username));
	nick.appendChild(el("span", "br", ">"));
	line.appendChild(nick);

	const body = el("span", "text");
	const text = el("span", "msg");
	if (msg.type === "ENCRYPTED_MESSAGE") {
		const tag = el("span", "enc-tag", "[e2e]");
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
			systemLine("good", (t) => (t.textContent = "Reconnected to relay."));
		}
	} else if (!up && wasConnected) {
		systemLine("warn", (t) => (t.textContent = "Connection lost. Reconnecting…"));
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
	} else {
		msgform.requestSubmit();
	}
}

msgform.addEventListener("submit", handleSubmit);
msgbox.addEventListener("keydown", handleKeyPressEvent);
msgbox.addEventListener("input", autoGrow);

/* the stored username is HTML-escaped by the server; show it decoded */
for (const n of document.querySelectorAll("[data-uname]")) {
	n.textContent = decodeEntities(window.chatdata.username);
}

/* status-line clock */
const clock = document.getElementById("clock");
function tick() {
	clock.textContent = nowStamp();
	setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
}
tick();

loadEncryptionModule().catch((err) => console.error("kasenc load failed", err));
init();
