// ============================================================
// SURVIVE OR DIE - RELAY SERVER
//
// The GameMaker game is the HOST and decides everything.
// Phones are simple controllers: they show whatever "screen"
// the host sends and report which button was pressed.
// This server only creates rooms and passes messages along.
//
// Messages are JSON objects with a "t" (type) field.
//
// HOST -> SERVER
//   {t:"host_create"}                     -> {t:"room", code, key}
//   {t:"host_resume", code, key}          -> {t:"room", code, key, players:[...]}
//   {t:"to", pid, msg}                    send msg to one phone
//   {t:"all", msg}                        send msg to every phone
//   {t:"kick", pid}                       remove a phone player
//   {t:"ping"}                            keep-alive -> {t:"pong"}
//
// SERVER -> HOST
//   {t:"player_join",   pid, name}
//   {t:"player_rejoin", pid, name}
//   {t:"player_left",   pid, name}
//   {t:"from", pid, msg}                  something a phone sent
//
// PHONE -> SERVER
//   {t:"join", code, name, pid?}          -> {t:"joined", pid, name, code}
//   anything else is forwarded to the host as {t:"from", pid, msg}
//
// SERVER -> PHONE
//   {t:"error", text}
//   {t:"host_gone"} / {t:"host_back"} / {t:"kicked"}
//   plus whatever the host sends (e.g. {t:"screen", ...})
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// How long a room survives without its host (ms)
const HOST_GRACE_MS = 15 * 60 * 1000;

const MAX_PLAYERS = 8;
const MAX_NAME = 16;


// ------------------------------------------------------------
// HTTP: phone page + health check
// ------------------------------------------------------------

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"));

const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
    }

    if (url === "/" || url === "/index.html" || url.startsWith("/join")) {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache"
        });
        res.end(INDEX_HTML);
        return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
});


// ------------------------------------------------------------
// ROOMS
// ------------------------------------------------------------

// code -> { code, key, host, hostGoneAt, players: Map(pid -> {pid, name, ws}) }
const rooms = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O

function newCode() {
    for (let tries = 0; tries < 1000; tries++) {
        let c = "";
        for (let i = 0; i < 4; i++) {
            c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        }
        if (!rooms.has(c)) return c;
    }
    throw new Error("no free room codes");
}

function newId() {
    return crypto.randomBytes(8).toString("hex");
}

function send(ws, obj) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
    }
}

function cleanName(name) {
    return String(name || "")
        .replace(/[^\w \-'.!?]/g, "")
        .trim()
        .slice(0, MAX_NAME);
}

function playerList(room) {
    return [...room.players.values()].map(p => ({
        pid: p.pid,
        name: p.name,
        connected: !!(p.ws && p.ws.readyState === 1)
    }));
}

// Drop rooms whose host has been gone too long
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (room.hostGoneAt && now - room.hostGoneAt > HOST_GRACE_MS) {
            for (const p of room.players.values()) {
                send(p.ws, { t: "error", text: "This game has ended." });
                if (p.ws) p.ws.close();
            }
            rooms.delete(code);
        }
    }
}, 60 * 1000);


// ------------------------------------------------------------
// WEBSOCKETS
// ------------------------------------------------------------

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.role = null;   // "host" | "player"
    ws.room = null;
    ws.pid = null;

    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString("utf8"));
        } catch (e) {
            return;
        }
        if (!msg || typeof msg.t !== "string") return;

        if (msg.t === "ping") {
            send(ws, { t: "pong" });
            return;
        }

        if (ws.role === "host") return onHostMessage(ws, msg);
        if (ws.role === "player") return onPlayerMessage(ws, msg);

        // First message decides the role
        if (msg.t === "host_create" || msg.t === "host_resume") return onHostHello(ws, msg);
        if (msg.t === "join") return onJoin(ws, msg);
    });

    ws.on("close", () => onClose(ws));
    ws.on("error", () => {});
});

// Protocol-level ping so idle connections are not dropped
setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (e) {}
    }
}, 25 * 1000);


// ------------------------------------------------------------
// HOST
// ------------------------------------------------------------

function onHostHello(ws, msg) {
    let room = null;

    if (msg.t === "host_resume" && msg.code && msg.key) {
        const r = rooms.get(String(msg.code).toUpperCase());
        if (r && r.key === msg.key) room = r;
    }

    if (!room) {
        const code = newCode();
        room = { code, key: newId(), host: null, hostGoneAt: null, players: new Map() };
        rooms.set(code, room);
    }

    if (room.host && room.host !== ws) {
        try { room.host.close(); } catch (e) {}
    }

    room.host = ws;
    room.hostGoneAt = null;
    ws.role = "host";
    ws.room = room;

    send(ws, { t: "room", code: room.code, key: room.key, players: playerList(room) });

    for (const p of room.players.values()) {
        send(p.ws, { t: "host_back" });
    }
}

function onHostMessage(ws, msg) {
    const room = ws.room;
    if (!room) return;

    switch (msg.t) {
        case "to": {
            const p = room.players.get(msg.pid);
            if (p) send(p.ws, msg.msg);
            break;
        }
        case "all": {
            for (const p of room.players.values()) send(p.ws, msg.msg);
            break;
        }
        case "kick": {
            const p = room.players.get(msg.pid);
            if (p) {
                send(p.ws, { t: "kicked" });
                room.players.delete(msg.pid);
                if (p.ws) {
                    p.ws.room = null;
                    p.ws.close();
                }
            }
            break;
        }
        case "close_room": {
            for (const p of room.players.values()) {
                send(p.ws, { t: "error", text: "The host closed the game." });
                if (p.ws) p.ws.close();
            }
            rooms.delete(room.code);
            ws.room = null;
            break;
        }
    }
}


// ------------------------------------------------------------
// PLAYERS
// ------------------------------------------------------------

function onJoin(ws, msg) {
    const code = String(msg.code || "").toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
        send(ws, { t: "error", text: "No game found with code " + code + "." });
        return;
    }

    // Reconnect with a known player id
    if (msg.pid && room.players.has(msg.pid)) {
        const p = room.players.get(msg.pid);
        if (p.ws && p.ws !== ws) {
            try { p.ws.close(); } catch (e) {}
        }
        p.ws = ws;
        ws.role = "player";
        ws.room = room;
        ws.pid = p.pid;

        send(ws, { t: "joined", pid: p.pid, name: p.name, code: room.code });
        send(room.host, { t: "player_rejoin", pid: p.pid, name: p.name });
        if (!room.host) send(ws, { t: "host_gone" });
        return;
    }

    const name = cleanName(msg.name);

    if (!name) {
        send(ws, { t: "error", text: "Please enter a name." });
        return;
    }

    if (room.players.size >= MAX_PLAYERS) {
        send(ws, { t: "error", text: "This game is full." });
        return;
    }

    for (const p of room.players.values()) {
        if (p.name.toLowerCase() === name.toLowerCase()) {
            send(ws, { t: "error", text: "Someone already has that name." });
            return;
        }
    }

    const p = { pid: newId(), name, ws };
    room.players.set(p.pid, p);

    ws.role = "player";
    ws.room = room;
    ws.pid = p.pid;

    send(ws, { t: "joined", pid: p.pid, name: p.name, code: room.code });
    send(room.host, { t: "player_join", pid: p.pid, name: p.name });
    if (!room.host) send(ws, { t: "host_gone" });
}

function onPlayerMessage(ws, msg) {
    const room = ws.room;
    if (!room || !room.players.has(ws.pid)) return;

    send(room.host, { t: "from", pid: ws.pid, msg });
}


// ------------------------------------------------------------
// DISCONNECTS
// ------------------------------------------------------------

function onClose(ws) {
    const room = ws.room;
    if (!room) return;

    if (ws.role === "host" && room.host === ws) {
        room.host = null;
        room.hostGoneAt = Date.now();
        for (const p of room.players.values()) send(p.ws, { t: "host_gone" });
        return;
    }

    if (ws.role === "player") {
        const p = room.players.get(ws.pid);
        if (p && p.ws === ws) {
            p.ws = null;
            send(room.host, { t: "player_left", pid: p.pid, name: p.name });
        }
    }
}


server.listen(PORT, () => {
    console.log("Survive or Die relay listening on port " + PORT);
});
