"use strict";

var sock,
	isAlive = false,
	wasConnected = false,
	everConnected = false;

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
const bottomMarker = document.getElementById("bod");
const msgbox = document.getElementById("msgbox");
const msgform = document.getElementById("msgform");
const cmdform = document.getElementById("cmdform");
const cmdInput = document.getElementById("cmd");

const encModal = document.getElementById("encKeyDia");
const encInput = encModal.querySelector("#enckey");
const encMessage = encModal.querySelector("#message");
const encState = document.getElementById("enc-state");
const encOpenBtn = document.querySelector('[commandfor="encKeyDia"]');

const connStat = document.getElementById("conn-stat");
const connText = connStat.querySelector(".xt");
const connSr = document.getElementById("conn-sr");
const rowInfo = document.getElementById("rowinfo");
const shortMsg = document.getElementById("smsg");
const oiaPos = document.getElementById("oia-pos");

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
		el.textContent = "*** UNABLE TO DECRYPT - " + res.error + " ***";
		el.dataset.encfailed = "true";
		return res.error;
	}
	delete el.dataset.encfailed;
	el.textContent = res.result;
	return null;
}

function updateEncryptionKey(newkey) {
	const changed = newkey !== encryptionKey;
	const hadKey = !!encryptionKey;
	encryptionKey = newkey;
	document.body.dataset.enc = encryptionKey ? "on" : "off";
	encState.textContent = encryptionKey ? "ON" : "OFF";

	if (changed) {
		if (encryptionKey) {
			systemLine("note", "EMS010I", (t) =>
				t.appendChild(
					document.createTextNode(
						(hadKey ? "ENCRYPTION KEY CHANGED." : "ENCRYPTION KEY SET.") +
							" OUTGOING MESSAGES WILL BE ENCRYPTED.",
					),
				),
			);
		} else {
			systemLine("warn", "EMS011W", (t) =>
				t.appendChild(
					document.createTextNode("ENCRYPTION KEY CLEARED. MESSAGES WILL BE SENT IN CLEAR TEXT."),
				),
			);
		}
	}

	const failed = msgcnt.querySelectorAll(".msg[data-encfailed]");
	if (failed.length === 0) return;
	loadEncryptionModule().then(() => {
		for (const el of failed) decryptInto(el);
	});
}

/* ------------------------------------------------------------------
 * Key dialog (ISPF pop-up)
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

const USER_COLORS = 10; // .c0 … .c9 in terminal-mainframe.css

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

// Mainframe-style timestamp: HH.MM.SS (seconds hidden on narrow screens).
function stampInto(ts) {
	const d = new Date();
	ts.textContent = pad(d.getHours()) + "." + pad(d.getMinutes());
	const sec = document.createElement("span");
	sec.className = "sec";
	sec.textContent = "." + pad(d.getSeconds());
	ts.appendChild(sec);
	return ts;
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
	msgcnt.insertBefore(line, bottomMarker);
	if (stick) scrollToNewest(true);
	scheduleRowInfo();
}

function systemLine(kind, code, build) {
	const line = el("div", "line sys " + kind);
	line.appendChild(stampInto(el("span", "ts")));
	const text = el("span", "text");
	text.appendChild(el("span", "code", code));
	text.appendChild(document.createTextNode(" "));
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

	systemLine(left ? "leave" : "join", left ? "EMS002I" : "EMS001I", (text) => {
		if (!m) {
			text.appendChild(el("span", "raw", raw));
			return;
		}
		text.appendChild(el("span", "who", m[1]));
		text.appendChild(
			document.createTextNode(
				left ? " LOGGED OFF FROM ROOM " : " LOGGED ON TO ROOM ",
			),
		);
		text.appendChild(el("span", "who", window.chatdata.room_id));
		text.appendChild(el("span", "sid", " (" + m[2] + ")"));
	});

	if (!isSelf && raw) notify(raw);
}

function handleUserMessage(msg) {
	const isSelf = msg.user_id === window.chatdata.user_id;
	const username = decodeEntities(msg.username) || "?";
	const line = el("div", "line " + (isSelf ? "self" : "other"));
	line.appendChild(stampInto(el("span", "ts")));

	const uid = el("span", "uid " + (isSelf ? "me" : getUserColor(msg.user_id)));
	uid.title = username + " (" + String(msg.user_id || "").slice(0, 7) + ")";
	uid.appendChild(el("span", "name", username));
	uid.appendChild(el("span", "lead"));
	line.appendChild(uid);

	const body = el("span", "text");
	const text = el("span", "msg");
	if (msg.type === "ENCRYPTED_MESSAGE") {
		const tag = el("span", "enc-tag", "ENC");
		tag.title = "End-to-end encrypted";
		body.appendChild(tag);
		text.dataset.encval = msg.message;
		text.textContent = "DECRYPTING...";
		loadEncryptionModule().then(
			() => {
				const err = decryptInto(text);
				if (err) openKeyDialog("EMS020E DECRYPTION FAILED - " + err);
			},
			() => {
				text.textContent = "*** ENCRYPTION MODULE FAILED TO LOAD ***";
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
 * ISPF chrome: ROW x TO y OF n, short messages, OIA cursor position
 * ------------------------------------------------------------------ */

var rowInfoQueued = false;
function scheduleRowInfo() {
	if (rowInfoQueued) return;
	rowInfoQueued = true;
	requestAnimationFrame(() => {
		rowInfoQueued = false;
		updateRowInfo();
	});
}

function updateRowInfo() {
	const rows = msgcnt.querySelectorAll(".line");
	const n = rows.length;
	if (n === 0) {
		rowInfo.textContent = "ROW 0 TO 0 OF 0";
		return;
	}
	const top = msgcnt.scrollTop;
	const bottom = top + msgcnt.clientHeight;
	let first = 0,
		last = 0;
	for (let i = 0; i < n; i++) {
		const r = rows[i];
		const y = r.offsetTop; // #messages is the offsetParent (position: relative)
		const mid = y + r.offsetHeight / 2;
		if (mid >= top && mid <= bottom) {
			if (!first) first = i + 1;
			last = i + 1;
		}
	}
	if (!first) first = last = n;
	rowInfo.textContent = "ROW " + first + " TO " + last + " OF " + n;
}

msgcnt.addEventListener("scroll", scheduleRowInfo, { passive: true });
window.addEventListener("resize", scheduleRowInfo);

var shortMsgTimer = null;
function showShortMessage(text, kind) {
	shortMsg.textContent = text;
	shortMsg.className = kind || "";
	document.body.dataset.smsg = "on";
	clearTimeout(shortMsgTimer);
	shortMsgTimer = setTimeout(() => {
		shortMsg.textContent = "";
		delete document.body.dataset.smsg;
	}, 4000);
}

function pad3(n) {
	return String(n).padStart(3, "0");
}

function updateCursorPos() {
	const before = msgbox.value.slice(0, msgbox.selectionStart || 0);
	const lines = before.split("\n");
	oiaPos.textContent =
		pad3(lines.length) + "/" + pad3(lines[lines.length - 1].length + 14);
}

for (const ev of ["input", "keyup", "click", "focus", "select"]) {
	msgbox.addEventListener(ev, updateCursorPos);
}

/* ------------------------------------------------------------------
 * Connection: keepalive + auto-reconnect
 * ------------------------------------------------------------------ */

function setConnStat(state) {
	// connecting -> "X CLOCK", down -> "X SYSTEM", up -> blank
	connStat.dataset.state = state;
	connText.textContent = state === "down" ? "SYSTEM" : state === "up" ? "" : "CLOCK";
	connSr.textContent =
		state === "down"
			? "Disconnected. Reconnecting..."
			: state === "up"
				? "Connected"
				: "Connecting...";
}

function setConnected(up) {
	document.body.dataset.conn = up ? "up" : "down";
	if (up) everConnected = true;
	setConnStat(up ? "up" : everConnected ? "down" : "connecting");
	if (up && !wasConnected) {
		if (msgcnt.querySelector(".line.warn.lost")) {
			systemLine("good", "EMS901I", (t) =>
				t.appendChild(document.createTextNode("SESSION WITH RELAY RE-ESTABLISHED.")),
			);
		}
	} else if (!up && wasConnected) {
		const l = systemLine("warn", "EMS900E", (t) =>
			t.appendChild(
				document.createTextNode("CONNECTION TO RELAY LOST. RECONNECTING..."),
			),
		);
		l.classList.add("lost");
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
	if (!sock || sock.readyState !== 1) {
		showShortMessage("X SYSTEM - NOT SENT", "err");
		return;
	}
	const text = msgbox.value;
	if (!text.trim()) return;

	let payload;
	if (encryptionKey) {
		try {
			await loadEncryptionModule();
		} catch (err) {
			openKeyDialog("EMS021E ENCRYPTION MODULE FAILED TO LOAD.");
			return;
		}
		const result = AESEncrypt(text, encryptionKey);
		if (!result.result) {
			console.error(result.error);
			openKeyDialog("EMS022E ENCRYPTION FAILED - " + result.error);
			return;
		}
		payload = { ...window.chatdata, message: result.result, type: "ENCRYPTED_MESSAGE" };
	} else {
		payload = { ...window.chatdata, message: text, type: "TEXT_MESSAGE" };
	}

	sock.send(JSON.stringify(payload));
	msgbox.value = "";
	autoGrow();
	updateCursorPos();
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
		updateCursorPos();
	} else {
		msgform.requestSubmit();
	}
}

msgform.addEventListener("submit", handleSubmit);
msgbox.addEventListener("keydown", handleKeyPressEvent);
msgbox.addEventListener("input", autoGrow);

/* ------------------------------------------------------------------
 * PF keys and the COMMAND ===> line (local, client-side only)
 * ------------------------------------------------------------------ */

function pageScroll(dir) {
	msgcnt.scrollBy({
		top: dir * Math.max(40, msgcnt.clientHeight - 40),
		behavior: reduceMotion.matches ? "auto" : "smooth",
	});
}

function showHelp() {
	const rows = [
		["EMS050I", "ENTER SENDS THE MESSAGE FIELD. CTRL+ENTER (CMD+ENTER) STARTS A NEW LINE."],
		["EMS051I", "PF1=HELP  PF3=END (LEAVE ROOM)  PF5=KEY (ENCRYPTION)  PF7=UP  PF8=DOWN"],
		["EMS052I", "COMMANDS: HELP, KEY, TOP, BOTTOM, UP, DOWN, CLEAR (LOCAL SCREEN), END"],
	];
	for (const [code, txt] of rows) {
		systemLine("help", code, (t) => t.appendChild(document.createTextNode(txt)));
	}
	scrollToNewest(true);
}

function clearScreen() {
	for (const l of msgcnt.querySelectorAll(".line")) l.remove();
	scheduleRowInfo();
}

const actions = {
	help: showHelp,
	end: () => {
		window.location.href = "/";
	},
	key: () => {
		encMessage.textContent = "";
		encInput.value = encryptionKey;
		openKeyDialog();
	},
	up: () => pageScroll(-1),
	down: () => pageScroll(1),
	top: () => msgcnt.scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" }),
	bottom: () => scrollToNewest(true),
	clear: clearScreen,
};
const aliases = {
	h: "help", "?": "help", k: "key", enc: "key", u: "up", d: "down",
	bot: "bottom", b: "bottom", t: "top", m: "bottom", max: "bottom",
	x: "end", exit: "end", logoff: "end", quit: "end", cls: "clear",
};

for (const btn of document.querySelectorAll("[data-pf]")) {
	btn.addEventListener("click", () => actions[btn.dataset.pf]());
}

cmdform.addEventListener("submit", (e) => {
	e.preventDefault();
	const raw = cmdInput.value.trim().toLowerCase();
	cmdInput.value = "";
	if (!raw) return;
	const name = actions[raw] ? raw : aliases[raw];
	if (!name) {
		showShortMessage("INVALID COMMAND", "err");
		return;
	}
	actions[name]();
});

/* the stored username is HTML-escaped by the server; show it decoded */
for (const n of document.querySelectorAll("[data-uname]")) {
	n.textContent = decodeEntities(window.chatdata.username);
}

/* stamp the welcome notices and run the panel clock */
for (const ts of msgcnt.querySelectorAll(".line .ts")) stampInto(ts);
const clock = document.getElementById("clock");
function tick() {
	const d = new Date();
	clock.textContent = pad(d.getHours()) + "." + pad(d.getMinutes());
	setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
}
tick();

setConnStat("connecting");
updateRowInfo();
updateCursorPos();
loadEncryptionModule().catch((err) => console.error("kasenc load failed", err));
init();
