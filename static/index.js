"use strict";

var sock,
	isAlive = false;

if ("Notification" in window) {
	try {
		const p = Notification.requestPermission();
		if (p && p.then) p.then((permission) => console.log("Notification permission", permission));
	} catch (e) {
		console.log("Notification permission request failed");
	}
}

const me = window.chatdata;
const msgcnt = document.getElementById("messages");
const msgform = document.getElementById("msgform");
const msgbox = document.getElementById("msgbox");
const connStat = document.getElementById("conn-stat");
const statusText = document.getElementById("status-text");

const encModal = document.getElementById("encKeyDia");
const encInput = encModal.querySelector("#enckey");
const encMessage = encModal.querySelector("#message");
const keyBtn = document.querySelector('[commandfor="encKeyDia"]');

var encryptionKey = "";
var encryptionLoaded = false;
var encryptionLoading = null;

const go = new Go();

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

// The server HTML-escapes usernames and plain-text messages
// (html.EscapeString). We render with textContent, so undo that escaping
// here to show the original characters without ever parsing HTML.
const ENTITIES = { lt: "<", gt: ">", quot: '"', "#34": '"', "#39": "'", amp: "&" };
function decodeEntities(s) {
	return String(s == null ? "" : s).replace(/&(lt|gt|quot|#34|#39|amp);/g, (_, e) => ENTITIES[e]);
}

// Deterministic per-user colour: FNV-1a hash of the user id picks a hue
// from a palette of well-separated, high-contrast tones.
const USER_HUES = [268, 190, 330, 150, 38, 212, 8, 290, 95, 172, 245, 50];
function getUserHue(id) {
	let val = 0x811c9dc5;
	id = String(id || "");
	for (let i = 0; i < id.length; i++) {
		val ^= id.charCodeAt(i);
		val = Math.imul(val, 0x01000193) >>> 0;
	}
	return USER_HUES[val % USER_HUES.length];
}

function getUserColor(id) {
	return `hsl(${getUserHue(id)} 85% 70%)`;
}

function initial(name) {
	const ch = Array.from(String(name || "").trim())[0];
	return ch ? ch.toUpperCase() : "?";
}

function timeNow() {
	return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text != null) node.textContent = text;
	return node;
}

function scrollToNewest(smooth = true) {
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

const LOCK_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/* ------------------------------------------------------------------ */
/* Header identity                                                      */
/* ------------------------------------------------------------------ */

(function setupIdentity() {
	const name = decodeEntities(me.username);
	const nameEl = document.getElementById("me-name");
	const avatar = document.getElementById("me-avatar");
	if (nameEl) nameEl.textContent = name || "Anonymous";
	if (avatar) {
		avatar.textContent = initial(name);
		avatar.title = name;
		avatar.style.setProperty("--u", getUserColor(me.user_id));
	}
})();

/* ------------------------------------------------------------------ */
/* Encryption                                                           */
/* ------------------------------------------------------------------ */

function loadEncryptionModule() {
	if (encryptionLoaded) return Promise.resolve(true);
	if (encryptionLoading) return encryptionLoading;
	encryptionLoading = WebAssembly.instantiateStreaming(fetch("/static/kasenc.wasm"), go.importObject)
		.then((result) => {
			go.run(result.instance);
			encryptionLoaded = true;
			return true;
		})
		.catch((e) => {
			encryptionLoading = null;
			console.error("Failed to load encryption module", e);
			return false;
		});
	return encryptionLoading;
}

function setBubbleState(textEl, failed) {
	const bubble = textEl.closest(".msg__bubble");
	if (bubble) bubble.classList.toggle("is-failed", failed);
}

function decryptInto(textEl, cipher) {
	if (typeof AESDecrypt !== "function") {
		textEl.textContent = "Encryption module not loaded";
		textEl.dataset.encfailed = "true";
		setBubbleState(textEl, true);
		return "Encryption module not loaded";
	}
	const res = AESDecrypt(cipher, encryptionKey);
	if (res.error) {
		textEl.textContent = res.error;
		textEl.dataset.encfailed = "true";
		setBubbleState(textEl, true);
		return res.error;
	}
	delete textEl.dataset.encfailed;
	textEl.textContent = res.result;
	setBubbleState(textEl, false);
	return null;
}

function updateEncryptionKey(newkey) {
	encryptionKey = newkey;
	document.body.classList.toggle("has-key", !!encryptionKey);
	msgbox.placeholder = encryptionKey
		? `Encrypted message to #${me.room_id}`
		: `Message #${me.room_id}`;

	const failedmessages = msgcnt.querySelectorAll("[data-encfailed]");
	for (const msg of failedmessages) {
		decryptInto(msg, msg.dataset.encval);
	}
}

function openKeyDialog(errorText) {
	encMessage.textContent = errorText || "";
	encModal.returnValue = "";
	if (!encModal.open) {
		try {
			encModal.showModal();
		} catch (e) {
			console.log("Could not open key dialog", e);
		}
	}
}

// Apply the key as soon as the dialog form is submitted with "confirm"
// (the dialog's close event is dispatched asynchronously, so relying on it
// alone could let a message slip out unencrypted right after confirming).
encModal.querySelector("form").addEventListener("submit", (e) => {
	const action = e.submitter ? e.submitter.value : "confirm";
	if (action === "confirm") updateEncryptionKey(encInput.value);
});

encModal.addEventListener("close", () => {
	if (encModal.returnValue !== "confirm") encInput.value = encryptionKey; // cancelled: restore the active key
	encModal.returnValue = "";
	msgbox.focus();
});

// The button uses HTML invoker commands (command="show-modal"). For browsers
// without invoker support, open it ourselves once the click has settled —
// by then a supporting browser has already opened the dialog, so no
// double-open happens.
keyBtn.addEventListener("click", () => {
	encMessage.textContent = "";
	encModal.returnValue = "";
	setTimeout(() => {
		if (!encModal.open) openKeyDialog("");
	}, 0);
});

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

var lastSender = null;
var lastSenderAt = 0;

function appendEvent(text, kind) {
	const chip = el("div", `event event--${kind}`);
	chip.setAttribute("role", "status");
	chip.appendChild(el("span", "dot"));
	chip.appendChild(el("span", "event__text", text));
	chip.appendChild(el("time", "", timeNow()));
	msgcnt.appendChild(chip);
	lastSender = null;
	scrollToNewest();
}

function handleJoinMessage(msg) {
	const text = decodeEntities(msg.message);
	appendEvent(text, / left the chat!?$/.test(text) ? "leave" : "join");

	if (msg.user_id && msg.user_id !== me.user_id) {
		notify(`${decodeEntities(msg.username)} (${msg.user_id.slice(0, 5)}) joined the room`);
	}
}

function handleLeaveMessage(msg) {
	appendEvent(decodeEntities(msg.message), "leave");

	if (msg.user_id && msg.user_id !== me.user_id) {
		notify(`${decodeEntities(msg.username)} (${msg.user_id.slice(0, 5)}) left the room`);
	}
}

async function handleUserMessage(msg) {
	const own = msg.user_id === me.user_id;
	const name = decodeEntities(msg.username);
	const now = Date.now();
	const continued = lastSender === msg.user_id && now - lastSenderAt < 5 * 60 * 1000;
	lastSender = msg.user_id;
	lastSenderAt = now;

	const row = el("article", "msg" + (own ? " msg--own" : "") + (continued ? " msg--cont" : ""));
	row.style.setProperty("--u", getUserColor(msg.user_id));

	if (!own) {
		const avatar = el("span", "avatar avatar--sm msg__avatar", initial(name));
		avatar.setAttribute("aria-hidden", "true");
		row.appendChild(avatar);
	}

	const body = el("div", "msg__body");
	const meta = el("div", "msg__meta");
	if (own) {
		meta.appendChild(el("span", "", "You"));
	} else {
		meta.appendChild(el("span", "msg__name", name || "Anonymous"));
		meta.appendChild(el("span", "msg__id", (msg.user_id || "").slice(0, 5)));
	}
	const lock = el("span", "msg__lock");
	if (msg.type === "ENCRYPTED_MESSAGE") {
		lock.innerHTML = LOCK_SVG; // static trusted markup only
		lock.appendChild(document.createTextNode("encrypted"));
		meta.appendChild(lock);
	}
	meta.appendChild(el("time", "", timeNow()));
	body.appendChild(meta);

	const bubble = el("div", "msg__bubble");
	const msgtext = el("span", "message");
	bubble.appendChild(msgtext);
	body.appendChild(bubble);
	row.appendChild(body);
	if (continued) row.title = timeNow();

	// Insert first so the conversation order is kept even while the
	// encryption module is still loading.
	msgcnt.appendChild(row);

	if (msg.type === "ENCRYPTED_MESSAGE") {
		msgtext.dataset.encval = msg.message;
		msgtext.textContent = "Decrypting…";
		if (!encryptionLoaded || typeof AESDecrypt !== "function") {
			await loadEncryptionModule();
		}
		const err = decryptInto(msgtext, msg.message);
		if (err) openKeyDialog("Decryption failed: " + err);
	} else {
		msgtext.textContent = decodeEntities(msg.message);
	}

	scrollToNewest();

	if (!own) {
		notify(`New message from ${name} (${(msg.user_id || "").slice(0, 5)})`);
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
		return;
	} else if (msg.type === "JOINED") {
		return handleJoinMessage(msg);
	} else if (msg.type === "LEFT") {
		return handleLeaveMessage(msg);
	} else if (msg.type === "TEXT_MESSAGE") {
		return handleUserMessage(msg);
	} else if (msg.type === "ENCRYPTED_MESSAGE") {
		return handleUserMessage(msg);
	}
}

/* ------------------------------------------------------------------ */
/* Connection                                                           */
/* ------------------------------------------------------------------ */

function setConnected(connected) {
	connStat.hidden = connected;
	document.body.classList.toggle("is-offline", !connected);
	statusText.textContent = connected ? "Connected" : "Reconnecting…";
}

function waitForConnection(callback, interval) {
	if (sock.readyState === 1) {
		callback();
	} else {
		setTimeout(() => waitForConnection(callback, interval), interval);
	}
}

function pingInterval(ws, interval = 5000) {
	if (ws !== sock) return; // a newer socket has taken over
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
	// Absolute ws(s) URL for older browsers that reject relative WebSocket URLs.
	const proto = location.protocol.endsWith("s:") ? "wss:" : "ws:";
	const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(me.room_id)}`);
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

/* ------------------------------------------------------------------ */
/* Composer                                                             */
/* ------------------------------------------------------------------ */

function autoGrow() {
	msgbox.style.height = "auto";
	msgbox.style.height = Math.min(msgbox.scrollHeight, 180) + "px";
}

function handleSubmit(e) {
	e.preventDefault();
	const text = msgbox.value;
	if (!text.trim()) return;
	if (!sock || sock.readyState !== WebSocket.OPEN) {
		connStat.animate(
			[{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }],
			{ duration: 280 },
		);
		return;
	}

	if (encryptionKey) {
		if (typeof AESEncrypt !== "function") {
			openKeyDialog("Encryption module is still loading, try again in a moment.");
			return;
		}
		const result = AESEncrypt(text, encryptionKey);
		if (result.result) {
			sock.send(
				JSON.stringify({
					...me,
					message: result.result,
					type: "ENCRYPTED_MESSAGE",
				}),
			);
		} else {
			console.error(result.error);
			return;
		}
	} else {
		sock.send(
			JSON.stringify({
				...me,
				message: text,
				type: "TEXT_MESSAGE",
			}),
		);
	}

	msgbox.value = "";
	autoGrow();
}

function handleKeyPressEvent(e) {
	if (e.key !== "Enter" || e.isComposing) return;
	if (e.metaKey || e.ctrlKey) {
		e.preventDefault();
		const start = msgbox.selectionStart;
		const end = msgbox.selectionEnd;
		msgbox.value = msgbox.value.substring(0, start) + "\n" + msgbox.value.substring(end);
		msgbox.selectionStart = msgbox.selectionEnd = start + 1;
		autoGrow();
	} else if (!e.shiftKey) {
		e.preventDefault();
		msgform.requestSubmit();
	}
}

// Keep the message list's bottom padding in sync with the floating dock
// (composer grows with its content and the status chip comes and goes).
const dock = document.querySelector(".dock");
const app = document.querySelector(".app");
if (dock && app && "ResizeObserver" in window) {
	new ResizeObserver(() => {
		const nearBottom = msgcnt.scrollHeight - msgcnt.scrollTop - msgcnt.clientHeight < 200;
		app.style.setProperty("--composer-h", dock.offsetHeight + "px");
		if (nearBottom) scrollToNewest(false);
	}).observe(dock);
}

msgform.addEventListener("submit", handleSubmit);
msgbox.addEventListener("keydown", handleKeyPressEvent);
msgbox.addEventListener("input", autoGrow);

setConnected(false);
statusText.textContent = "Connecting…";
loadEncryptionModule();
init();
msgbox.focus();
