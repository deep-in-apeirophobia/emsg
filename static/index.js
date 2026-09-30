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

const msgcnt = document.getElementById("messages"); // scroll container
const transcript = document.getElementById("transcript"); // message column
const connStat = document.getElementById("conn-stat");
const msgbox = document.getElementById("msgbox");
const keyState = document.getElementById("key-state");

const encModal = document.getElementById("encKeyDia");
const encInput = encModal.querySelector("#enckey");
const encMessage = encModal.querySelector("#message");
const encConfirmBtn = encModal.querySelector("#confirmBtn");
const encOpenBtn = document.querySelector('[commandfor="encKeyDia"]');

const DEFAULT_ENC_MESSAGE =
	"Messages you send will be enciphered with this key. Everyone in the room must use the same key to read them.";

var encryptionKey = "";
var encryptionLoaded = false;
var encryptionPromise = null;

const go = new Go();

/* ---------- small helpers ---------- */

// The server HTML-escapes usernames; decode entities for display (safe: DOMParser
// documents never run scripts, and the result is only ever assigned via textContent).
function decodeEntities(str) {
	if (!str || str.indexOf("&") === -1) return str || "";
	try {
		return new DOMParser().parseFromString(str, "text/html").documentElement.textContent;
	} catch (e) {
		return str;
	}
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function nowTime() {
	const d = new Date();
	return {
		short: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
		iso: d.toISOString(),
		full: d.toLocaleString(),
	};
}

function isNearBottom() {
	return msgcnt.scrollHeight - msgcnt.scrollTop - msgcnt.clientHeight < 160;
}

function scrollToNewest(force) {
	if (!force && !isNearBottom()) return;
	msgcnt.scrollTo({ top: msgcnt.scrollHeight, behavior: "smooth" });
}

function notify(text) {
	try {
		new Notification(text);
	} catch (e) {
		console.log("Failed to create notification");
	}
}

document.querySelectorAll("[data-entities]").forEach((node) => {
	node.textContent = decodeEntities(node.textContent);
});

try {
	document.getElementById("dateline-date").textContent = new Date().toLocaleDateString(undefined, {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	});
} catch (e) {}

/* ---------- encryption ---------- */

function loadEncryptionModule() {
	if (!encryptionPromise) {
		encryptionPromise = WebAssembly.instantiateStreaming(fetch("/static/kasenc.wasm"), go.importObject)
			.then((result) => {
				go.run(result.instance);
				encryptionLoaded = true;
				return true;
			})
			.catch((err) => {
				encryptionPromise = null;
				throw err;
			});
	}
	return encryptionPromise;
}

function setKeyIndicator() {
	const on = !!encryptionKey;
	document.body.classList.toggle("is-enciphered", on);
	keyState.textContent = on ? "Cipher: on" : "Cipher: off";
	encOpenBtn.setAttribute("aria-pressed", on ? "true" : "false");
	msgbox.placeholder = on ? "Write an enciphered letter…" : "Write to the room…";
}

function renderDecryption(msgtext, res) {
	msgtext.classList.remove("is-failed");
	if (res.error) {
		msgtext.textContent = "Could not decipher this letter — " + res.error;
		msgtext.classList.add("is-failed");
		msgtext.dataset.encfailed = "true";
	} else {
		delete msgtext.dataset.encfailed;
		msgtext.textContent = res.result;
	}
}

async function updateEncryptionKey(newkey) {
	encryptionKey = newkey;
	setKeyIndicator();

	const failedmessages = transcript.querySelectorAll("[data-encfailed]");
	if (!failedmessages.length) return;
	try {
		await loadEncryptionModule();
	} catch (e) {
		console.error("Failed to load encryption module", e);
		return;
	}
	for (let msg of failedmessages) {
		renderDecryption(msg, AESDecrypt(msg.dataset.encval, encryptionKey));
	}
}

function openKeyDialog(message, isError) {
	encMessage.textContent = message || DEFAULT_ENC_MESSAGE;
	encMessage.classList.toggle("is-error", !!isError);
	if (!encModal.open) {
		try {
			encModal.showModal();
		} catch (e) {
			console.log("Could not open key dialog", e);
		}
	}
}

// The button uses HTML invoker commands (command="show-modal"). For browsers that
// don't support them, fall back to opening the dialog from JS — guarded so it never
// double-opens where the native command already did.
encOpenBtn.addEventListener("click", () => {
	encMessage.textContent = DEFAULT_ENC_MESSAGE;
	encMessage.classList.remove("is-error");
	setTimeout(() => {
		openKeyDialog(DEFAULT_ENC_MESSAGE, false);
	}, 0);
});

encModal.addEventListener("close", () => {
	const value = encModal.returnValue;
	encModal.returnValue = "";
	if (value === "confirm") updateEncryptionKey(encInput.value);
	else encInput.value = encryptionKey;
	msgbox.focus();
});

// Enter inside the key field confirms (implicit submission would pick "Cancel").
encInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		encModal.close("confirm");
	}
});

/* ---------- colours ---------- */

const USER_INK_COUNT = 10;

function getUserColor(id) {
	let val = 0;
	id = String(id || "");
	for (let i = 0; i < id.length; i++) {
		val = (val * 713 + id.charCodeAt(i)) % 1000003;
	}
	return "ink-" + (val % USER_INK_COUNT);
}

/* ---------- rendering ---------- */

let lastAuthor = null;

function addAside(msg, kind) {
	const aside = el("div", "aside aside-" + kind);
	aside.setAttribute("role", "note");
	aside.appendChild(el("span", "aside-orn", kind === "left" ? "·" : "❦"));
	aside.appendChild(el("span", "aside-text", decodeEntities(msg.message)));
	aside.appendChild(el("span", "aside-orn", kind === "left" ? "·" : "❦"));
	const t = nowTime();
	aside.title = t.full;
	transcript.appendChild(aside);
	lastAuthor = null;
	scrollToNewest(true);
}

function handleJoinMessage(msg) {
	addAside(msg, /\bleft\b/i.test(msg.message || "") ? "left" : "joined");

	if (msg.user_id !== window.chatdata.user_id) {
		notify(`${decodeEntities(msg.username)} (${String(msg.user_id).slice(0, 5)}) joined the room`);
	}
}

function handleLeaveMessage(msg) {
	addAside(msg, "left");

	if (msg.user_id !== window.chatdata.user_id) {
		notify(`${decodeEntities(msg.username)} (${String(msg.user_id).slice(0, 5)}) left the room`);
	}
}

async function handleUserMessage(msg) {
	const isOwn = msg.user_id === window.chatdata.user_id;
	const t = nowTime();
	const name = decodeEntities(msg.username) || "Anonymous";
	const userId = String(msg.user_id || "");

	const letter = el("article", "letter " + getUserColor(userId));
	if (isOwn) letter.classList.add("is-own");
	if (lastAuthor === userId) letter.classList.add("is-cont");
	lastAuthor = userId;

	const time = el("time", "letter-time", t.short);
	time.dateTime = t.iso;
	time.title = t.full;

	const head = el("header", "letter-head");
	head.appendChild(el("span", "letter-dot"));
	head.appendChild(el("span", "letter-name", name));
	head.appendChild(el("span", "letter-id", userId.slice(0, 5)));
	if (isOwn) head.appendChild(el("span", "letter-you", "you"));
	head.appendChild(time);

	const msgtext = el("p", "letter-text message");

	letter.appendChild(head);
	letter.appendChild(msgtext);
	transcript.appendChild(letter);

	if (msg.type === "ENCRYPTED_MESSAGE") {
		letter.classList.add("is-sealed");
		const seal = el("span", "letter-seal", "enciphered");
		head.insertBefore(seal, time);
		msgtext.dataset.encval = msg.message;
		msgtext.textContent = "Deciphering…";
		try {
			if (!encryptionLoaded || typeof AESDecrypt !== "function") {
				await loadEncryptionModule();
			}
			const res = AESDecrypt(msg.message, encryptionKey);
			renderDecryption(msgtext, res);
			if (res.error) {
				openKeyDialog("Decryption failed: " + res.error, true);
			}
		} catch (e) {
			renderDecryption(msgtext, { error: "the encryption module could not be loaded" });
		}
	} else {
		msgtext.textContent = msg.message;
	}

	scrollToNewest(isOwn);

	if (!isOwn) {
		notify(`New message from ${name} (${userId.slice(0, 5)})`);
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

/* ---------- connection ---------- */

function setConnected(connected) {
	connStat.classList.toggle("hidden", connected);
	document.body.classList.toggle("is-offline", !connected);
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

	sock.send(
		JSON.stringify({
			type: "PING",
		}),
	);
	pingTimeout = setTimeout(() => pingInterval(interval), interval);
}

function init() {
	sock = new WebSocket(`/ws/${window.chatdata.room_id}`);

	sock.addEventListener("open", function () {
		setConnected(true);
		waitForConnection(function () {
			isAlive = true;
			clearTimeout(pingTimeout);
			pingInterval();
		}, 300);
	});

	sock.addEventListener("close", function () {
		sock.removeEventListener("message", handleMessage);
		clearTimeout(pingTimeout);
		setConnected(false);
		setTimeout(() => {
			init();
		}, 300);
	});
	sock.addEventListener("message", handleMessage);
}

/* ---------- composer ---------- */

function autoGrow() {
	msgbox.style.height = "auto";
	const max = parseFloat(getComputedStyle(msgbox).maxHeight) || 200;
	msgbox.style.height = Math.min(msgbox.scrollHeight, max) + "px";
	msgbox.style.overflowY = msgbox.scrollHeight > max ? "auto" : "hidden";
}
msgbox.addEventListener("input", autoGrow);

async function handleSubmit(e) {
	e.preventDefault();
	if (!sock || sock.readyState !== 1) return;
	const input = msgbox;
	const text = input.value;
	if (!text.trim()) return;

	if (encryptionKey) {
		try {
			if (!encryptionLoaded || typeof AESEncrypt !== "function") await loadEncryptionModule();
		} catch (err) {
			console.error("Failed to load encryption module", err);
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

	input.value = "";
	autoGrow();
}

function handleKeyPressEvent(e) {
	const input = msgbox;
	if (e.key === "Enter" && !e.isComposing) {
		if (e.metaKey || e.ctrlKey) {
			e.preventDefault();
			const start = input.selectionStart;
			const end = input.selectionEnd;

			input.value = input.value.substring(0, start) + "\n" + input.value.substring(end);

			input.selectionStart = input.selectionEnd = start + 1;
			autoGrow();
		} else {
			e.preventDefault();
			document.getElementById("msgform").requestSubmit();
		}
	}
}

setKeyIndicator();
setConnected(false);
loadEncryptionModule().catch((e) => console.error("Failed to load encryption module", e));

init();
