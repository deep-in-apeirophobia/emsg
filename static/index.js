"use strict";

/* ==========================================================================
   emsg chat client (vanilla JS, no dependencies)
   ========================================================================== */

var sock,
	isAlive = false;

const chatdata = window.chatdata;

const msgcnt = document.getElementById("messages");
const thread = document.getElementById("thread");
const connStat = document.getElementById("conn-stat");
const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");

const msgForm = document.getElementById("msgform");
const msgBox = document.getElementById("msgbox");
const sendBtn = document.getElementById("send-btn");

const encModal = document.getElementById("encKeyDia");
const encForm = document.getElementById("encForm");
const encInput = document.getElementById("enckey");
const encMessage = document.getElementById("enc-message");
const encCancelBtn = document.getElementById("cancelBtn");
const lockPill = document.getElementById("lock-pill");
const lockLabel = document.getElementById("lock-label");

var encryptionKey = "";

/* ---------- helpers ---------- */

// The server HTML-escapes usernames before storing them; decode entities for
// display (DOMParser never executes scripts, and we only read textContent).
function decodeEntities(str) {
	if (!str || str.indexOf("&") === -1) return str || "";
	const doc = new DOMParser().parseFromString("<!doctype html><body>" + str, "text/html");
	return doc.body.textContent || "";
}

// Deterministic hue per user id, used for avatar + name colours.
const userHues = [4, 24, 42, 145, 174, 199, 222, 262, 292, 330];

function getUserHue(id) {
	let val = 0;
	id = String(id || "");
	for (let i = 0; i < id.length; i++) {
		val = (val * 31 + id.charCodeAt(i)) >>> 0;
	}
	return userHues[val % userHues.length];
}

function initials(name) {
	const words = String(name || "").trim().split(/\s+/).filter(Boolean);
	if (!words.length) return "?";
	const first = Array.from(words[0])[0] || "";
	const last = words.length > 1 ? Array.from(words[words.length - 1])[0] || "" : "";
	return (first + last).toUpperCase();
}

function formatTime(d) {
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDay(d) {
	const today = new Date();
	if (d.toDateString() === today.toDateString()) return "Today";
	return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function isNearBottom() {
	return msgcnt.scrollHeight - msgcnt.scrollTop - msgcnt.clientHeight < 160;
}

function scrollToBottom(smooth) {
	msgcnt.scrollTo({ top: msgcnt.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function notify(text) {
	if (!("Notification" in window) || Notification.permission !== "granted") return;
	try {
		new Notification(text);
	} catch (e) {
		console.log("Failed to create notification");
	}
}

if ("Notification" in window) {
	try {
		const p = Notification.requestPermission();
		if (p && p.then) {
			p.then((permission) => console.log("Notification permission", permission));
		}
	} catch (e) {
		/* old browsers */
	}
}

/* ---------- header bits ---------- */

(function setupHeader() {
	const roomAvatar = document.getElementById("room-avatar");
	roomAvatar.textContent = initials(chatdata.room_id);
	roomAvatar.style.setProperty("--hue", getUserHue(chatdata.room_id));
	const meName = document.getElementById("me-name");
	meName.textContent = decodeEntities(chatdata.username);
})();

function setConnected(online) {
	connStat.hidden = online;
	connDot.dataset.state = online ? "online" : "offline";
	connDot.setAttribute("aria-label", online ? "Connected" : "Connecting");
	connText.dataset.state = online ? "online" : "offline";
	connText.textContent = online ? "online" : "connecting…";
}

/* ---------- encryption ---------- */

const go = new Go();
var wasmReady = null;

function loadEncryptionModule() {
	if (!wasmReady) {
		const load = WebAssembly.instantiateStreaming
			? WebAssembly.instantiateStreaming(fetch("/static/kasenc.wasm"), go.importObject)
			: fetch("/static/kasenc.wasm")
					.then((r) => r.arrayBuffer())
					.then((buf) => WebAssembly.instantiate(buf, go.importObject));
		wasmReady = load
			.then((result) => {
				go.run(result.instance);
				return true;
			})
			.catch((err) => {
				console.error("Failed to load encryption module", err);
				wasmReady = null;
				throw err;
			});
	}
	return wasmReady;
}

function updateLockPill() {
	const on = !!encryptionKey;
	lockPill.dataset.encrypted = on ? "true" : "false";
	lockLabel.textContent = on ? "Encrypted" : "Not encrypted";
	lockPill.title = on ? "Encryption key is set — change it" : "Set encryption key";
}

function setDecrypted(textEl, res) {
	const bubble = textEl.closest(".bubble");
	if (res.error) {
		textEl.textContent = res.error;
		textEl.dataset.encfailed = "true";
		if (bubble) bubble.classList.add("enc-failed");
	} else {
		delete textEl.dataset.encfailed;
		textEl.textContent = res.result;
		if (bubble) bubble.classList.remove("enc-failed");
	}
}

function updateEncryptionKey(newkey) {
	encryptionKey = newkey;
	updateLockPill();

	const failedmessages = msgcnt.querySelectorAll("[data-encfailed]");
	if (!failedmessages.length) return;

	loadEncryptionModule().then(() => {
		for (const msg of failedmessages) {
			setDecrypted(msg, AESDecrypt(msg.dataset.encval, encryptionKey));
		}
	});
}

function openKeyDialog(errorText) {
	encMessage.textContent = errorText || "";
	encModal.returnValue = "";
	if (!encModal.open) {
		encInput.value = encryptionKey;
		try {
			encModal.showModal();
		} catch (e) {
			console.log("Failed to open key dialog", e);
		}
	}
	encInput.focus();
	encInput.select();
}

// Invoker commands (command="show-modal") open the dialog natively. As a
// fallback for browsers without them, open it ourselves after the click has
// been handled — only if it isn't open already.
lockPill.addEventListener("click", () => {
	encMessage.textContent = "";
	encInput.value = encryptionKey;
	encModal.returnValue = "";
	setTimeout(() => {
		if (!encModal.open) openKeyDialog("");
	}, 0);
});

encCancelBtn.addEventListener("click", () => encModal.close("cancel"));

encForm.addEventListener("submit", (e) => {
	// method="dialog": let the browser close it, but make sure the
	// return value is "confirm" even for implicit (Enter) submission.
	e.preventDefault();
	encModal.close("confirm");
});

encModal.addEventListener("close", () => {
	const rv = encModal.returnValue;
	encModal.returnValue = "";
	if (rv !== "confirm") return;
	updateEncryptionKey(encInput.value);
});

/* ---------- rendering ---------- */

var lastGroup = null; // { userId, el, stack }
var lastDay = null;

function maybeDatePill(now) {
	const day = now.toDateString();
	if (day === lastDay) return;
	lastDay = day;
	const pill = document.createElement("div");
	pill.className = "sys sys-date";
	pill.textContent = formatDay(now);
	thread.appendChild(pill);
	lastGroup = null;
}

function addSystemMessage(text, kind) {
	maybeDatePill(new Date());
	const el = document.createElement("div");
	el.className = "sys" + (kind === "left" ? " sys-left" : "");
	el.setAttribute("role", "status");
	el.textContent = text;
	thread.appendChild(el);
	lastGroup = null;
	scrollToBottom(true);
}

function handleJoinMessage(msg) {
	addSystemMessage(msg.message, "joined");
	if (msg.user_id && msg.user_id !== chatdata.user_id) {
		notify(`${decodeEntities(msg.username)} (${msg.user_id.slice(0, 5)}) joined the room`);
	}
}

function handleLeaveMessage(msg) {
	addSystemMessage(msg.message, "left");
	if (msg.user_id && msg.user_id !== chatdata.user_id) {
		notify(`${decodeEntities(msg.username)} (${msg.user_id.slice(0, 5)}) left the room`);
	}
}

function getGroup(msg, isOwn) {
	if (lastGroup && lastGroup.userId === msg.user_id && lastGroup.el.isConnected && thread.lastElementChild === lastGroup.el) {
		return lastGroup;
	}
	const name = decodeEntities(msg.username);
	const hue = getUserHue(msg.user_id);

	const group = document.createElement("div");
	group.className = "group " + (isOwn ? "own" : "other");
	group.style.setProperty("--hue", hue);

	if (!isOwn) {
		const avatar = document.createElement("div");
		avatar.className = "avatar";
		avatar.textContent = initials(name);
		avatar.title = `${name} (${String(msg.user_id || "").slice(0, 5)})`;
		avatar.setAttribute("aria-hidden", "true");
		group.appendChild(avatar);
	}

	const stack = document.createElement("div");
	stack.className = "stack";
	group.appendChild(stack);

	lastGroup = { userId: msg.user_id, el: group, stack, name, isOwn, first: true };
	return lastGroup;
}

const lockSvg =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="11" width="15" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>';

function handleUserMessage(msg) {
	const now = new Date();
	maybeDatePill(now);

	const isOwn = msg.user_id === chatdata.user_id;
	const group = getGroup(msg, isOwn);

	const bubble = document.createElement("div");
	bubble.className = "bubble";

	if (!isOwn && group.first) {
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = group.name;
		name.title = `${group.name} (${String(msg.user_id || "").slice(0, 5)})`;
		bubble.appendChild(name);
	}
	group.first = false;

	const msgtext = document.createElement("span");
	msgtext.className = "text";
	bubble.appendChild(msgtext);

	const meta = document.createElement("span");
	meta.className = "meta";
	if (msg.type === "ENCRYPTED_MESSAGE") {
		// static markup only (no user data)
		meta.insertAdjacentHTML("beforeend", lockSvg);
		meta.title = "Encrypted";
	}
	const time = document.createElement("time");
	time.dateTime = now.toISOString();
	time.textContent = formatTime(now);
	meta.appendChild(time);
	bubble.appendChild(meta);

	group.stack.appendChild(bubble);
	if (!group.el.isConnected) thread.appendChild(group.el);

	if (msg.type === "ENCRYPTED_MESSAGE") {
		msgtext.dataset.encval = msg.message;
		msgtext.textContent = "Decrypting…";
		loadEncryptionModule()
			.then(() => {
				const res = AESDecrypt(msg.message, encryptionKey);
				setDecrypted(msgtext, res);
				if (res.error) openKeyDialog("Decryption failed: " + res.error);
				scrollToBottom(true);
			})
			.catch(() => {
				setDecrypted(msgtext, { error: "Encryption module failed to load" });
			});
	} else {
		msgtext.textContent = msg.message;
	}

	scrollToBottom(true);

	if (!isOwn) {
		notify(`New message from ${group.name} (${String(msg.user_id || "").slice(0, 5)})`);
	}
}

function handleMessage(e) {
	let msg;
	try {
		msg = JSON.parse(e.data);
	} catch (err) {
		console.error("Bad message", err);
		return;
	}

	if (msg.type === "PONG") {
		isAlive = true;
		return;
	} else if (msg.type === "JOINED") {
		return handleJoinMessage(msg);
	} else if (msg.type === "LEFT") {
		return handleLeaveMessage(msg);
	} else if (msg.type === "TEXT_MESSAGE" || msg.type === "ENCRYPTED_MESSAGE") {
		return handleUserMessage(msg);
	}
}

/* ---------- connection ---------- */

function waitForConnection(callback, interval) {
	if (sock.readyState === 1) {
		callback();
	} else {
		setTimeout(() => waitForConnection(callback, interval), interval);
	}
}

function pingInterval(ws, interval = 5000) {
	if (ws !== sock || ws.readyState !== 1) return;
	if (!isAlive) {
		ws.close();
		return;
	}
	isAlive = false;

	ws.send(JSON.stringify({ type: "PING" }));
	setTimeout(() => pingInterval(ws, interval), interval);
}

function init() {
	const ws = new WebSocket(`/ws/${chatdata.room_id}`);
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

/* ---------- composer ---------- */

function autoGrow() {
	msgBox.style.height = "auto";
	msgBox.style.height = Math.min(msgBox.scrollHeight, 168) + "px";
	sendBtn.disabled = msgBox.value.trim() === "";
}

async function handleSubmit(e) {
	e.preventDefault();
	if (!sock || sock.readyState !== 1) return;
	const text = msgBox.value;
	if (text.trim() === "") return;

	if (encryptionKey) {
		try {
			await loadEncryptionModule();
		} catch (err) {
			openKeyDialog("Encryption module failed to load, message not sent.");
			return;
		}
		const result = AESEncrypt(text, encryptionKey);
		if (result.result) {
			sock.send(
				JSON.stringify({
					...chatdata,
					message: result.result,
					type: "ENCRYPTED_MESSAGE",
				}),
			);
		} else {
			console.error(result.error);
			openKeyDialog("Encryption failed: " + result.error);
			return;
		}
	} else {
		sock.send(
			JSON.stringify({
				...chatdata,
				message: text,
				type: "TEXT_MESSAGE",
			}),
		);
	}

	msgBox.value = "";
	autoGrow();
	msgBox.focus();
}

function handleKeyPressEvent(e) {
	if (e.key !== "Enter" || e.isComposing) return;
	if (e.metaKey || e.ctrlKey) {
		e.preventDefault();
		const start = msgBox.selectionStart;
		const end = msgBox.selectionEnd;
		msgBox.value = msgBox.value.substring(0, start) + "\n" + msgBox.value.substring(end);
		msgBox.selectionStart = msgBox.selectionEnd = start + 1;
		autoGrow();
	} else if (!e.shiftKey) {
		e.preventDefault();
		msgForm.requestSubmit();
	}
}

msgForm.addEventListener("submit", handleSubmit);
msgBox.addEventListener("keydown", handleKeyPressEvent);
msgBox.addEventListener("input", autoGrow);
window.addEventListener("resize", () => {
	if (isNearBottom()) scrollToBottom(false);
});

/* ---------- boot ---------- */

setConnected(false);
updateLockPill();
autoGrow();
loadEncryptionModule().catch(() => {});
init();
