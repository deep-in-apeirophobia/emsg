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

const msgcnt = document.getElementById("messages"); // the scrolling feed
const log = document.getElementById("log"); // printed lines go here
const msgbox = document.getElementById("msgbox");
const msgform = document.getElementById("msgform");
const connStat = document.getElementById("conn-stat");
const pageNo = document.getElementById("pageno");

const encModal = document.getElementById("encKeyDia");
const encInput = encModal.querySelector("#enckey");
const encMessage = encModal.querySelector("#message");
const encState = document.getElementById("enc-state");
const encOpenBtn = document.querySelector('[commandfor="encKeyDia"]');
const cardField = document.getElementById("card-field");

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

function decryptInto(node) {
	const res = AESDecrypt(node.dataset.encval, encryptionKey);
	if (res.error) {
		node.textContent = "[UNABLE TO DECIPHER: " + res.error + "]";
		node.dataset.encfailed = "true";
		return res.error;
	}
	delete node.dataset.encfailed;
	node.textContent = res.result;
	return null;
}

function updateEncryptionKey(newkey) {
	encryptionKey = newkey;
	document.body.dataset.enc = encryptionKey ? "on" : "off";
	encState.textContent = encryptionKey ? "SET" : "NONE";

	const failed = msgcnt.querySelectorAll(".msg[data-encfailed]");
	if (failed.length === 0) return;
	loadEncryptionModule().then(() => {
		for (const node of failed) decryptInto(node);
	});
}

/* ------------------------------------------------------------------
 * Key dialog (a punched card)
 * ------------------------------------------------------------------ */

const CARD_COLS = 80;
const cardHoles = [];

(function buildCard() {
	// rows 12 and 11 (zone rows) are blank; rows 0-9 carry printed digits
	const frag = document.createDocumentFragment();
	for (let r = 0; r < 12; r++) {
		for (let c = 0; c < CARD_COLS; c++) {
			const d = document.createElement("span");
			d.style.gridRow = r + 1;
			d.style.gridColumn = c + 1;
			if (r >= 2) d.textContent = String(r - 2);
			frag.appendChild(d);
		}
	}
	cardField.appendChild(frag);
})();

// Punch one hole per typed character. The row pattern is fixed, so the
// card shows only the key's length, never its content.
function punchCard() {
	const n = Math.min(encInput.value.length, CARD_COLS);
	while (cardHoles.length > n) cardHoles.pop().remove();
	while (cardHoles.length < n) {
		const i = cardHoles.length;
		const h = document.createElement("span");
		h.className = "hole";
		h.style.gridColumn = i + 1;
		h.style.gridRow = ((i * 7 + 3) % 12) + 1;
		cardField.appendChild(h);
		cardHoles.push(h);
	}
}
encInput.addEventListener("input", punchCard);

function openKeyDialog(message) {
	if (typeof message === "string") encMessage.textContent = message;
	if (!encModal.open) {
		encModal.returnValue = "";
		punchCard();
		encModal.showModal();
	}
}

// Fallback for browsers without invoker commands (command/commandfor).
// Deferred so a native invoker gets the first chance; never double-opens.
encOpenBtn.addEventListener("click", () => {
	encMessage.textContent = "";
	encInput.value = encryptionKey;
	punchCard();
	setTimeout(() => {
		if (!encModal.open) openKeyDialog();
	}, 0);
});

encModal.addEventListener("close", () => {
	const rv = encModal.returnValue;
	encModal.returnValue = "";
	if (rv === "confirm") updateEncryptionKey(encInput.value);
	else encInput.value = encryptionKey;
	punchCard();
});

/* ------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------ */

// Two-colour ribbon: every other operator is printed in black or red,
// chosen deterministically from their id.
function getUserInk(id) {
	// FNV-1a; a middle bit picks the ribbon half
	let h = 0x811c9dc5;
	const s = String(id || "");
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return (h >>> 7) & 1 ? "ink-red" : "ink-black";
}

function pad(n) {
	return n < 10 ? "0" + n : "" + n;
}

function nowStamp() {
	const d = new Date();
	return pad(d.getHours()) + pad(d.getMinutes());
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

function updatePageNo() {
	const lh = parseFloat(getComputedStyle(log).lineHeight) || 24;
	const lines = parseFloat(getComputedStyle(log).getPropertyValue("--page-lines")) || 60;
	const page = Math.max(1, Math.ceil(log.offsetHeight / (lh * lines)));
	pageNo.textContent = String(page).padStart(3, "0");
}

var lastSender = null;

function appendLine(line, forceScroll) {
	const stick = forceScroll || isNearBottom();
	line.classList.add("fresh");
	log.appendChild(line);
	updatePageNo();
	if (stick) scrollToNewest(true);
}

function systemLine(kind, text) {
	const line = el("div", "line sys " + kind);
	line.appendChild(el("span", "mk"));
	line.appendChild(el("span", "ts", nowStamp()));
	line.appendChild(el("span", "text", "*** " + text + " ***"));
	lastSender = null;
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

	if (m) {
		systemLine(left ? "leave" : "join", m[1] + " [" + m[2] + "] " + (left ? "OFFLINE" : "ONLINE"));
	} else {
		systemLine(left ? "leave" : "join", raw);
	}

	if (!isSelf && raw) notify(raw);
}

function handleUserMessage(msg) {
	const isSelf = msg.user_id === window.chatdata.user_id;
	const username = decodeEntities(msg.username) || "?";
	const ink = isSelf ? "ink-black" : getUserInk(msg.user_id);
	const ditto = lastSender === msg.user_id;
	const line = el("div", "line " + (isSelf ? "self " : "other ") + ink + (ditto ? " ditto" : ""));

	const mk = el("span", "mk", isSelf ? "*" : "");
	mk.setAttribute("aria-hidden", "true");
	line.appendChild(mk);
	line.appendChild(el("span", "ts", nowStamp()));

	const tag = el("span", "tag");
	tag.title = username + " (" + String(msg.user_id || "").slice(0, 7) + ")";
	if (ditto) {
		// ditto mark: same operator as the line above
		tag.appendChild(el("span", "sr-only", username));
		const d = el("span", null, '"');
		d.setAttribute("aria-hidden", "true");
		tag.appendChild(d);
	} else {
		tag.textContent = username;
	}
	line.appendChild(tag);

	const body = el("span", "text");
	const text = el("span", "msg");
	if (msg.type === "ENCRYPTED_MESSAGE") {
		const etag = el("span", "enc", "ENC");
		etag.title = "End-to-end encrypted";
		body.appendChild(etag);
		text.dataset.encval = msg.message;
		text.textContent = "deciphering…";
		loadEncryptionModule().then(
			() => {
				const err = decryptInto(text);
				if (err) openKeyDialog("Decryption failed: " + err);
			},
			() => {
				text.textContent = "[ENCRYPTION MODULE FAILED TO LOAD]";
				text.dataset.encfailed = "true";
			},
		);
	} else {
		text.textContent = decodeEntities(msg.message);
	}
	body.appendChild(text);
	line.appendChild(body);

	lastSender = msg.user_id;
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
	if (up) {
		connStat.textContent = "ON LINE";
		if (!wasConnected && log.querySelector(".line.lost")) {
			systemLine("good", "CARRIER DETECT — BACK ON LINE");
		}
	} else if (wasConnected || document.body.classList.contains("was-up")) {
		document.body.classList.add("was-up");
		connStat.textContent = "REDIALING…";
		if (wasConnected) systemLine("lost", "CARRIER LOST — REDIALING");
	} else {
		connStat.textContent = "DIALING…";
	}
	if (up) document.body.classList.remove("was-up");
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
 * Composer (the typing line at the platen)
 * ------------------------------------------------------------------ */

function autoGrow() {
	msgbox.style.height = "auto";
	const max = parseFloat(getComputedStyle(msgbox).maxHeight) || 144;
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
window.addEventListener("resize", updatePageNo);

/* the stored username is HTML-escaped by the server; show it decoded */
for (const n of document.querySelectorAll("[data-uname]")) {
	n.textContent = decodeEntities(window.chatdata.username);
}

/* session-opened stamp, e.g. "30 SEP 2026 0459" */
(function () {
	const d = new Date();
	const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getMonth()];
	document.getElementById("opened").textContent =
		pad(d.getDate()) + " " + mon + " " + d.getFullYear() + " " + nowStamp();
})();

/* typing-line clock */
const clock = document.getElementById("clock");
function tick() {
	clock.textContent = nowStamp();
	setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
}
tick();
updatePageNo();

loadEncryptionModule().catch((err) => console.error("kasenc load failed", err));
init();
