"use strict";

var sock,
	pingTimeout,
	isAlive = false;

if ("Notification" in window) {
	try {
		Notification.requestPermission().then((permission) => {
			console.log("Notification permission", permission);
		});
	} catch (e) {
		console.log("Notification permission request failed");
	}
}

const app = document.getElementById("app");
const msgcnt = document.getElementById("messages");
const msgbox = document.getElementById("msgbox");
const msgform = document.getElementById("msgform");
const connStat = document.getElementById("conn-stat");
const keyBtn = document.getElementById("keybtn");
const keyState = document.getElementById("key-state");
const composerLock = document.getElementById("composer-lock");

const encModal = document.getElementById("encKeyDia");
const encInput = encModal.querySelector("#enckey");
const encMessage = encModal.querySelector("#message");
const encConfirmBtn = encModal.querySelector("#confirmBtn");
const encToggle = encModal.querySelector("#enckey-toggle");

var encryptionKey = "";
var encryptionLoaded = false;

const go = new Go();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// The server runs html.EscapeString over usernames and message bodies.
// Undo exactly those five entities so text renders as typed; the result is
// only ever assigned via textContent, never parsed as HTML.
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&#34;": '"', "&quot;": '"' };
function unescapeHTML(str) {
	if (typeof str !== "string") return "";
	return str.replace(/&(?:amp|lt|gt|quot|#39|#34);/g, (m) => ENTITIES[m]);
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const userColors = [
	"#FFD23F", // yellow
	"#FF6B9D", // pink
	"#3BCEAC", // cyan
	"#B794F6", // violet
	"#FF9F43", // orange
	"#A3E635", // lime
	"#5EB8FF", // blue
	"#FF7A6B", // coral
	"#F9A8D4", // rose
	"#67E8F9", // aqua
];

function getUserColor(id) {
	let val = 0;
	id = String(id || "");
	for (let i = 0; i < id.length; i++) {
		val = (val * 713 + id.charCodeAt(i)) % 1000003;
	}
	return userColors[val % userColors.length];
}

function nowLabel() {
	try {
		return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	} catch (e) {
		return "";
	}
}

function scrollToNewest(node) {
	requestAnimationFrame(() => {
		node.scrollIntoView({ behavior: "smooth", block: "end" });
	});
}

function notify(text) {
	if (!("Notification" in window) || Notification.permission !== "granted") return;
	try {
		new Notification(text);
	} catch (e) {
		console.log("Failed to create notification");
	}
}

/* ------------------------------------------------------------------ *
 * Current user chip
 * ------------------------------------------------------------------ */

(function renderMe() {
	const meName = document.getElementById("me-name");
	if (!meName) return;
	meName.textContent = unescapeHTML(window.chatdata.username) || "anonymous";
	meName.style.setProperty("--tag", getUserColor(window.chatdata.user_id));
})();

/* ------------------------------------------------------------------ *
 * Encryption
 * ------------------------------------------------------------------ */

function reflectKeyState() {
	const on = !!encryptionKey;
	keyState.textContent = on ? "Encrypted" : "No key";
	keyBtn.classList.toggle("keybtn--on", on);
	keyBtn.title = on ? "Encryption key set — click to change" : "Set encryption key";
	composerLock.hidden = !on;
	msgbox.placeholder = on ? "Type an encrypted message..." : "Type a message...";
}

function setDecrypted(node, res) {
	if (res.error) {
		node.textContent = res.error;
		node.dataset.encfailed = true;
	} else {
		delete node.dataset.encfailed;
		node.textContent = res.result;
	}
}

function updateEncryptionKey(newkey) {
	encryptionKey = newkey;
	reflectKeyState();

	if (typeof AESDecrypt !== "function") return;
	const failedmessages = msgcnt.querySelectorAll(".msg__text[data-encfailed]");
	for (let msg of failedmessages) {
		setDecrypted(msg, AESDecrypt(msg.dataset.encval, encryptionKey));
	}
}

function openKeyDialog(errorText) {
	if (errorText) {
		encMessage.textContent = errorText;
		encMessage.hidden = false;
	} else {
		encMessage.textContent = "";
		encMessage.hidden = true;
	}
	if (!encModal.open) {
		encModal.returnValue = "";
		encInput.value = encryptionKey;
		try {
			encModal.showModal();
		} catch (e) {
			console.log("Could not open key dialog", e);
		}
	}
}

// The key button uses HTML invoker commands (command="show-modal"). For
// browsers without invoker support, open the dialog ourselves. We defer to
// after the invoker's own activation so we never double-open.
keyBtn.addEventListener("click", () => {
	if (!encModal.open) {
		encMessage.textContent = "";
		encMessage.hidden = true;
		encModal.returnValue = "";
		encInput.value = encryptionKey;
	}
	setTimeout(() => {
		if (!encModal.open) openKeyDialog();
	}, 0);
});

encModal.addEventListener("close", () => {
	encInput.type = "password";
	encToggle.setAttribute("aria-label", "Show key");
	if (encModal.returnValue === "confirm") updateEncryptionKey(encInput.value);
	msgbox.focus();
});

encModal.querySelector("#enc-cancel").addEventListener("click", () => encModal.close("cancel"));
encModal.querySelector("#enc-close").addEventListener("click", () => encModal.close("cancel"));
// Clicking the backdrop closes the dialog.
encModal.addEventListener("click", (e) => {
	if (e.target === encModal) encModal.close("cancel");
});

encToggle.addEventListener("click", () => {
	const show = encInput.type === "password";
	encInput.type = show ? "text" : "password";
	encToggle.setAttribute("aria-label", show ? "Hide key" : "Show key");
	encToggle.title = show ? "Hide key" : "Show key";
	encInput.focus();
});

var encReady = null;
function loadEncryptionModule() {
	if (encReady) return encReady;
	encReady = WebAssembly.instantiateStreaming(fetch("/static/kasenc.wasm"), go.importObject)
		.then((result) => {
			go.run(result.instance);
			encryptionLoaded = true;
			return true;
		})
		.catch((e) => {
			console.error("Failed to load encryption module", e);
			encReady = null;
			return false;
		});
	return encReady;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

var eventCount = 0;

function appendEvent(text, kind) {
	const row = el("div", "event event--" + kind);
	const stamp = el("span", "stamp");
	stamp.style.setProperty("--tilt", (eventCount++ % 2 ? 1.6 : -1.8) + "deg");
	stamp.appendChild(el("span", "stamp__sign", kind === "leave" ? "−" : "+"));
	stamp.appendChild(el("span", "stamp__text", text));
	row.appendChild(stamp);
	row.appendChild(el("time", "event__time", nowLabel()));
	msgcnt.appendChild(row);
	scrollToNewest(row);
}

function handleJoinMessage(msg) {
	const text = unescapeHTML(msg.message);
	// The server reports departures as LEFT; also catch "left the chat" text.
	const leaving = msg.type === "LEFT" || /\bleft the chat\b/i.test(text);
	appendEvent(text, leaving ? "leave" : "join");

	if (msg.user_id && msg.user_id !== window.chatdata.user_id) {
		notify(`${unescapeHTML(msg.username)} (${msg.user_id.slice(0, 5)}) ${leaving ? "left" : "joined"} the room`);
	}
}

function handleLeaveMessage(msg) {
	return handleJoinMessage({ ...msg, type: "LEFT" });
}

async function handleUserMessage(msg) {
	const own = msg.user_id === window.chatdata.user_id;
	const username = unescapeHTML(msg.username) || "anonymous";
	const encrypted = msg.type === "ENCRYPTED_MESSAGE";

	const prev = msgcnt.lastElementChild;
	const continued = prev && prev.classList.contains("msg") && prev.dataset.uid === msg.user_id;

	const newmsg = el("article", "msg" + (own ? " msg--own" : "") + (continued ? " msg--cont" : ""));
	newmsg.dataset.uid = msg.user_id;
	newmsg.style.setProperty("--tag", getUserColor(msg.user_id));

	const head = el("header", "msg__head");
	head.appendChild(el("span", "nametag", username));
	head.appendChild(el("span", "msg__uid", String(msg.user_id || "").slice(0, 5)));
	if (own) head.appendChild(el("span", "msg__you", "you"));
	head.appendChild(el("time", "msg__time", nowLabel()));
	newmsg.appendChild(head);

	const bubble = el("div", "msg__card");
	const msgtext = el("p", "msg__text");
	bubble.appendChild(msgtext);
	if (encrypted) {
		const lock = el("span", "msg__lock");
		lock.title = "End-to-end encrypted";
		lock.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
		bubble.appendChild(lock);
	}
	newmsg.appendChild(bubble);

	// Append synchronously so ordering is preserved even while decrypting.
	msgcnt.appendChild(newmsg);

	if (encrypted) {
		const cipher = unescapeHTML(msg.message);
		msgtext.dataset.encval = cipher;
		msgtext.textContent = "Decrypting…";
		if (!encryptionLoaded || typeof AESDecrypt !== "function") {
			await loadEncryptionModule();
		}
		if (typeof AESDecrypt !== "function") {
			setDecrypted(msgtext, { error: "Encryption module unavailable" });
		} else {
			const res = AESDecrypt(cipher, encryptionKey);
			setDecrypted(msgtext, res);
			if (res.error) openKeyDialog("Decryption failed: " + res.error);
		}
	} else {
		msgtext.textContent = unescapeHTML(msg.message);
	}

	scrollToNewest(newmsg);

	if (!own) {
		notify(`New message from ${username} (${String(msg.user_id).slice(0, 5)})`);
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

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

function setOnline(online) {
	connStat.hidden = online;
	app.classList.toggle("is-offline", !online);
}

function waitForConnection(callback, interval) {
	if (sock.readyState === 1) {
		callback();
	} else {
		setTimeout(() => waitForConnection(callback, interval), interval);
	}
}

function pingInterval(interval = 5000) {
	if (!isAlive) {
		sock.close();
		return;
	}
	isAlive = false;

	if (sock.readyState === 1) {
		sock.send(JSON.stringify({ type: "PING" }));
	}
	pingTimeout = setTimeout(() => pingInterval(interval), interval);
}

function init() {
	sock = new WebSocket(`/ws/${window.chatdata.room_id}`);

	sock.addEventListener("open", function () {
		setOnline(true);
		waitForConnection(function () {
			isAlive = true;
			clearTimeout(pingTimeout);
			pingInterval();
		}, 300);
	});

	sock.addEventListener("close", function () {
		sock.removeEventListener("message", handleMessage);
		clearTimeout(pingTimeout);
		setOnline(false);
		setTimeout(() => {
			init();
		}, 300);
	});
	sock.addEventListener("message", handleMessage);
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */

function autoGrow() {
	msgbox.style.height = "auto";
	const max = parseFloat(getComputedStyle(msgbox).maxHeight) || 200;
	const h = Math.min(msgbox.scrollHeight + 2, max);
	msgbox.style.height = h + "px";
	msgbox.style.overflowY = msgbox.scrollHeight + 2 > max ? "auto" : "hidden";
}

function flashConnStat() {
	connStat.classList.remove("connstat--shake");
	void connStat.offsetWidth;
	connStat.classList.add("connstat--shake");
}

function handleSubmit(e) {
	e.preventDefault();
	const text = msgbox.value;
	if (!text.trim()) return;
	if (!sock || sock.readyState !== 1) {
		flashConnStat();
		return;
	}

	if (encryptionKey) {
		if (typeof AESEncrypt !== "function") {
			openKeyDialog("Encryption module is still loading — try again in a moment.");
			return;
		}
		const result = AESEncrypt(text, encryptionKey);
		if (result.result) {
			sock.send(
				JSON.stringify({
					...window.chatdata,
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
				...window.chatdata,
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
	} else if (e.shiftKey) {
		// Shift+Enter: let the browser insert a newline.
		return;
	} else {
		e.preventDefault();
		msgform.requestSubmit();
	}
}

msgform.addEventListener("submit", handleSubmit);
msgbox.addEventListener("keydown", handleKeyPressEvent);
msgbox.addEventListener("input", autoGrow);

reflectKeyState();
autoGrow();
loadEncryptionModule();
init();
