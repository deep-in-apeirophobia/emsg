var sock,
  pingTimeout,
  isAlive = false;

const msgcnt = document.getElementById("messages");

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
}
function handleLeaveMessage(msg) {
  const newmsg = document.createElement("div");
  newmsg.classList.add("text-center", "text-red-400", "text-sm", "p-1");
  newmsg.innerText = msg.message;
  msgcnt.appendChild(newmsg);
}

function handleUserMessage(msg) {
  const newmsg = document.createElement("div");
  newmsg.classList.add("text-base", "text-white", "p-1");

  if (msg.user_id === window.chatdata.user_id) {
    newmsg.classList.add("bg-slate-700", "hover:bg-slate-600");
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
  msgtext.innerText = msg.message;
  newmsg.appendChild(msgtext);

  msgcnt.appendChild(newmsg);
  newmsg.scrollIntoView({
    behavior: "smooth",
  });
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

  sock.addEventListener("open", function () {
    document.getElementById("conn-stat").classList.add("hidden");
    waitForConnection(function () {
      isAlive = true;
      pingInterval();
    }, 300);
  });

  sock.addEventListener("close", function () {
    sock.removeEventListener("message", handleMessage);
    document.getElementById("conn-stat").classList.remove("hidden");
    setTimeout(() => {
      init();
    }, 300);
  });
  sock.addEventListener("message", handleMessage);
}

function handleSubmit(e) {
  console.log("e");
  e.preventDefault();
  if (!sock) return;
  const input = document.getElementById("msgbox");
  const text = input.value;

  sock.send(
    JSON.stringify({
      ...window.chatdata,
      message: text,
      type: "TEXT_MESSAGE",
    }),
  );

  input.value = "";
}

init();
