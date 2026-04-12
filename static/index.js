var sock,
	pingTimeout,
	isAlive = false;

if ("Notification" in window) {
	Notification.requestPermission().then((permission) => {
		console.log("Notification permission", permission);
	});
}

const msgcnt = document.getElementById("messages");

const encModal = document.getElementById("encKeyDia");
const encInput = encModal.querySelector("input")
const encMessage = encModal.querySelector("#message")
const encConfirmBtn = encModal.querySelector("#confirmBtn")

var encryptionKey = ""
var encryptionLoaded = false

const go = new Go()

function updateEncryptionKey(newkey) {
	encryptionKey = newkey;

	const failedmessages = msgcnt.querySelectorAll("span[data-encfailed]")

	for (let msg of failedmessages) {
		const res = AESDecrypt(msg.dataset.encval, encryptionKey)
		if (res.error) {
			msg.innerText = res.error;
			msg.dataset.encfailed = true;
		} else
			msg.innerText = res.result;
	}

}

encModal.addEventListener("close", (e) => {
	if (encModal.returnValue == "cancel")
		return
	if (encModal.returnValue)
		updateEncryptionKey(encInput.value)
})

const userColors = [
	"text-blue-400",
	"text-gray-400",
	"text-sky-400",
	"text-rose-400",
	"text-yellow-400",
	"text-violet-400",
	"text-pink-400",
	"text-purple-400",
	"text-green-400",
	"text-lime-400",
	"text-brown-400",
];

function getUserColor(id) {
	let val = 0;

	for (let ch in id) {
		val = val * 713 + Number(id.charCodeAt(ch));
	}
	return userColors[val % userColors.length];
}

function handleJoinMessage(msg) {
	const newmsg = document.createElement("div");
	newmsg.classList.add("text-center", "text-gray-400", "text-sm", "p-1");
	newmsg.innerText = msg.message;
	msgcnt.appendChild(newmsg);

	if (msg.user_id !== window.chatdata.user_id) {
		try {
			const notif = new Notification(
				`${msg.username} (${msg.user_id.slice(0, 5)}) joined the room`,
			);
		} catch (e) {
			console.log("Failed to create notification");
		}
	}
}
function handleLeaveMessage(msg) {
	const newmsg = document.createElement("div");
	newmsg.classList.add("text-center", "text-red-400", "text-sm", "p-1");
	newmsg.innerText = msg.message;
	msgcnt.appendChild(newmsg);

	if (msg.user_id !== window.chatdata.user_id) {
		try {
			const notif = new Notification(
				`${msg.username} (${msg.user_id.slice(0, 5)}) left the room`,
			);
		} catch (e) {
			console.log("Failed to create notification");
		}
	}
}

async function handleUserMessage(msg) {
	const newmsg = document.createElement("div");
	newmsg.classList.add("text-base", "text-white", "p-1");

	if (msg.user_id === window.chatdata.user_id) {
		newmsg.classList.add(
			"hover:bg-blue-600/20",
			"bg-blue-600/10",
			"rounded-md",
			"bg-clip-padding",
			"backdrop-filter",
			"backdrop-blur-2xl",
			"bg-opacity-10",
		);
	} else {
		newmsg.classList.add("hover:bg-slate-800");
	}

	const color = getUserColor(msg.user_id);
	const username = document.createElement("span");
	username.classList.add("text-base", "font-semibold", color);
	username.innerText = msg.username;
	newmsg.appendChild(username);

	const userid = document.createElement("span");
	userid.classList.add("text-base", color);
	userid.innerText = ` (${msg.user_id.slice(0, 5)}): `;
	newmsg.appendChild(userid);

	const msgtext = document.createElement("span");
	msgtext.classList.add("message")
	if (msg.type === "ENCRYPTED_MESSAGE") {
		msgtext.dataset.encval = msg.message;
		if (!encryptionLoaded || !AESDecrypt) {
			await loadEncryptionModule()

		}
		const res = AESDecrypt(msg.message, encryptionKey)
		if (res.error) {
			msgtext.innerText = res.error;
			msgtext.dataset.encfailed = true;
			encMessage.innerText = "Decryption failed: " + res.error
			encModal.showModal()
		} else
			msgtext.innerText = res.result;
	} else {
		msgtext.innerHTML = msg.message;
	}
	newmsg.appendChild(msgtext);

	msgcnt.appendChild(newmsg);
	newmsg.scrollIntoView({
		behavior: "smooth",
	});

	if (msg.user_id !== window.chatdata.user_id) {
		try {
			const notif = new Notification(
				`New message from ${msg.username} (${msg.user_id.slice(0, 5)})`,
			);
		} catch (e) {
			console.log("Failed to create notification");
		}
	}
}

function handleMessage(e) {
	const msg = JSON.parse(e.data);

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
	setTimeout(() => pingInterval(interval), interval);
}

function init() {
	sock = new WebSocket(`/ws/${window.chatdata.room_id}`);

	sock.addEventListener("open", function() {
		document.getElementById("conn-stat").classList.add("hidden");
		waitForConnection(function() {
			isAlive = true;
			pingInterval();
		}, 300);
	});

	sock.addEventListener("close", function() {
		sock.removeEventListener("message", handleMessage);
		document.getElementById("conn-stat").classList.remove("hidden");
		setTimeout(() => {
			init();
		}, 300);
	});
	sock.addEventListener("message", handleMessage);
}

function handleSubmit(e) {
	e.preventDefault();
	if (!sock) return;
	const input = document.getElementById("msgbox");
	const text = input.value;

	if (encryptionKey) {
		const result = AESEncrypt(text, encryptionKey)
		if (result.result) {
			sock.send(
				JSON.stringify({
					...window.chatdata,
					message: result.result,
					type: "ENCRYPTED_MESSAGE",
				}),
			);
		} else {
			console.error(result.error)
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
}

function handleKeyPressEvent(e) {
	const input = document.getElementById("msgbox");
	if (e.key === "Enter") {
		if (e.metaKey || e.ctrlKey) {
			e.preventDefault();
			const start = input.selectionStart;
			const end = input.selectionEnd;

			input.value =
				input.value.substring(0, start) + "\n" + input.value.substring(end);

			input.selectionStart = input.selectionEnd = start + 1;
		} else {
			// handleSubmit(e);
			document.getElementById("msgform").requestSubmit();
			e.preventDefault();
		}
	}
}


function loadEncryptionModule() {
	return WebAssembly.instantiateStreaming(fetch("/static/kasenc.wasm"), go.importObject)
		.then(result => {
			go.run(result.instance);
			encryptionLoaded = true
			return true
		});

}
loadEncryptionModule()

init();
