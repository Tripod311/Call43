import 'dotenv/config';
import { resolve } from "node:path"
import { WebSocketServer, WebSocket } from "ws"
import { Currents, Context, JsonBody } from "@tripod311/currents";
import { ServeStatic, NodeAdapter } from "@tripod311/currents/node";

let shuttingDown = false;
const PINGTIMEOUT = 5000;
const POLL_INTERVAL = 1000;

const adapter = NodeAdapter.fromOptions({
	forceHTTPVersion: 1,
	// certificates: {
	// 	cert: "./certificates/fullchain.crt",
	// 	key: "./certificates/server.key",
	// }
});
const app = new Currents(adapter);

app.get("/*", [
	ServeStatic({
		basePath: '/',
		rootDir: resolve(process.cwd(), "client_dist"),
		cacheControl: ["public", "max-age=0"],
		fallback: 'index.html'
	})
]);

// WS handling

const wsServer = new WebSocketServer({ noServer: true });
const webSockets: Record<number, { socket: WebSocket, timeout?: ReturnType<typeof setTimeout>; }> = Object.create(null);
let counter = 0;

function newConnection(ws: WebSocket) {
	const id = counter++;

	webSockets[id] = { socket: ws };

	console.info(`[ws ${id}] connected; total=${Object.keys(webSockets).length}`);

	ws.on("close", (code, reason) => {
		console.info(`[ws ${id}] closed code=${code} reason=${reason.toString()}`);
		connectionClosed(id);
	});

	ws.on("error", error => {
		console.error(`[ws ${id}] error`, error);
		connectionClosed(id);
	});

	ws.on("message", data => handleMessage(id, data));

	ws.send(JSON.stringify({ command: "register", id }));
	console.info(`[ws ${id}] sent register`);
}

function connectionClosed(id: number) {
	const connection = webSockets[id];
	if (!connection) return;

	clearTimeout(connection.timeout);
	delete webSockets[id];
}

function handleMessage(id: number, data: WebSocket.RawData) {
	try {
		const message = JSON.parse(data.toString()) as {
			command: string;
			id?: number;
			dstId?: number;
			data?: unknown;
		};

		if (!webSockets[id]) return;

		const dstId = message.dstId;
		console.info(`[ws ${id}] received ${message.command} dst=${dstId ?? "-"}`);

		switch (message.command) {
			case "ack":
				clearTimeout(webSockets[id].timeout);
				webSockets[id].timeout = undefined;
				console.info(`[ws ${id}] heartbeat acknowledged`);
				break;

			case "offer":
			case "answer":
			case "iceCandidate": {
				if (dstId === undefined || !webSockets[dstId]) {
					console.warn(`[ws ${id}] ${message.command}: destination ${dstId} absent`);
					return;
				}

				// ID отправителя задаёт сервер, а не клиентский JSON.
				const forwarded = JSON.stringify({
					command: message.command,
					id,
					dstId,
					data: message.data
				});

				webSockets[dstId].socket.send(forwarded);
				console.info(`[ws ${id}] forwarded ${message.command} -> ${dstId}`);
				break;
			}

			default:
				console.warn(`[ws ${id}] unknown command=${message.command}`);
		}
	} catch (error) {
		console.error(`[ws ${id}] invalid message`, error);
	}
}

function poll() {
	const connections = Object.keys(webSockets).map(Number);

	for (const connId of connections) {
		const client = webSockets[connId];
		if (!client || client.socket.readyState !== WebSocket.OPEN) continue;

		// Не создаём второй timeout, пока ждём ответ на предыдущий poll.
		if (client.timeout) continue;

		client.socket.send(JSON.stringify({
			command: "pool",
			id: -1,
			dstId: connId,
			data: connections
		}));

		console.info(`[ws ${connId}] sent pool=${connections.join(",")}`);

		client.timeout = setTimeout(() => {
			console.warn(`[ws ${connId}] heartbeat timeout`);
			client.socket.terminate();
		}, PINGTIMEOUT);
	}
}

function cutConnection (id: number) {
	webSockets[id]?.socket.close();
}

function handleUpgrade(request: any, socket: any, head: any) {
	const url = new URL(request.url ?? "/", "http://localhost");

	console.info(`[upgrade] path=${url.pathname} from=${request.socket.remoteAddress}`);

	if (
		shuttingDown ||
		url.pathname !== "/ws" ||
		url.searchParams.get("password") !== process.env.CALL43_PASSWORD
	) {
		console.warn(`[upgrade] rejected path=${url.pathname}`);
		socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}

	console.info("[upgrade] accepted");
	wsServer.handleUpgrade(request, socket, head, newConnection);
}

adapter.server.on("error", error => {
	console.error("[server] error", error);
});

adapter.server.on("upgrade", handleUpgrade);

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;

	clearInterval(pollInterval);

	for (const [id, connection] of Object.entries(webSockets)) {
		if (connection.timeout !== null) clearTimeout(connection.timeout);
		connection.socket.close(1001, "Server shutting down");
		delete webSockets[Number(id)];
	}

	const forceClose = setTimeout(() => {
		for (const socket of wsServer.clients) socket.terminate();
	}, 2000);

	await Promise.all([
		new Promise<void>((resolve) => wsServer.close(() => resolve())),
		new Promise<void>((resolve) => adapter.server.close(() => resolve())),
	]);

	clearTimeout(forceClose);
}

process.once("SIGINT", () => {
	void shutdown().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
});

process.once("SIGTERM", () => {
	void shutdown().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
});

const pollInterval = setInterval(poll, POLL_INTERVAL);

adapter.server.listen(
	{ port: parseInt(process.env.CALL43_PORT ?? "8080") },
	() => console.info("[server] listening")
);