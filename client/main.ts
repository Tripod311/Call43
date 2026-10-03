import { TemplateCache, Component } from "@tripod311/splash"
import Template from "./application.html?raw"

import VideoDrop from "./drops/video.html?raw"
import MessageDrop from "./drops/message.html?raw"
import VideoGridDrop from "./drops/videoGrid.html?raw"

TemplateCache.registerDrop("VideoDrop", VideoDrop);
TemplateCache.registerDrop("MessageDrop", MessageDrop);
TemplateCache.registerDrop("VideoGridDrop", VideoGridDrop);

import MicImage from "./images/microphone.svg"
import CamImage from "./images/camera.svg"
import MicCrossImage from "./images/microphone-cross.svg"
import CamCrossImage from "./images/camera-cross.svg"

const ICEServers = [
	{
        "urls": [
            "stun:stun.cloudflare.com:3478"
        ]
    },
    {
        "urls": [
            "stun:stun.l.google.com:19302"
        ]
    }
];

type MessageData = {
	command: string;
	id: number;
	dstId?: number;
	data?: any;
};

type Peer = {
	connection: RTCPeerConnection;
	drop: { node: HTMLElement; refs: { video: HTMLVideoElement } };
	pendingCandidates: RTCIceCandidateInit[];
};

class Application extends Component {
	protected static componentName = "Application";
	protected static template = Template;

	private socket?: WebSocket;
	private localStream?: MediaStream;
	private connections: Record<number, Peer> = {};
	private grid?: HTMLElement;
	private pendingConnection = false;
	private selfId = -1;

	mounted() {
		super.mounted();

		this.state.setProp("selfVideo", {
			display: "none"
		});
		this.state.setProp("micButton", MicCrossImage);
		this.state.setProp("camButton", CamCrossImage);
		this.refs.button.onclick = this.connect.bind(this);
		this.refs.microphoneButton.onclick = this.toggleSound.bind(this);
		this.refs.cameraButton.onclick = this.toggleVideo.bind(this);
		this.showMessage("Чтобы начать звонок, введи пароль и подключись к комнате");
	}

	async connect() {
		if (this.pendingConnection || this.socket) return;

		this.pendingConnection = true;
		this.refs.button.setAttribute("disabled", "");
		this.showMessage("Подключаюсь");

		try {
			await this.captureStream();

			const password = encodeURIComponent(this.refs.input.value);
			const protocol = location.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(
				`${protocol}//${location.host}/ws?password=${password}`
			);

			this.socket = socket;
			socket.addEventListener("open", () => this.socketOpen());
			socket.addEventListener("message", (event) => {
				void this.socketMessage(event);
			});
			socket.addEventListener("close", () => this.socketDown());
		} catch (err) {
			this.pendingConnection = false;
			this.refs.button.removeAttribute("disabled");
			this.localStream?.getTracks().forEach(track => track.stop());
			this.localStream = undefined;
			this.showMessage(`Не удалось подключиться: ${String(err)}`);
		}
	}

	async captureStream () {
		try {
			this.localStream = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: true
			});

			this.refs.selfVideo.srcObject = this.localStream;
			this.state.setProp("selfVideo", {
				display: "flex"
			});
			this.syncButtons();
		} catch (err) {
			if (err instanceof DOMException && err.name === "NotFoundError") {
				this.localStream = await navigator.mediaDevices.getUserMedia({
					audio: true,
					video: false
				});
			} else {
				throw err;
			}
		}
	}

	showMessage(message: string) {
		this.refs.content.innerHTML = "";
		const drop = TemplateCache.createDrop("MessageDrop", { message });
		this.refs.content.appendChild(drop.node);
	}

	socketDown() {
		this.pendingConnection = false;
		this.refs.button.removeAttribute("disabled");
		this.refs.connectForm.style.display = "flex";
		this.socket = undefined;
		this.selfId = -1;

		for (const id of Object.keys(this.connections).map(Number)) {
			this.removePeer(id);
		}

		this.localStream?.getTracks().forEach(track => track.stop());
		this.localStream = undefined;
		this.grid?.remove();
		this.grid = undefined;

		this.showMessage("Соединение разорвано");
	}

	socketOpen() {
		this.pendingConnection = false;
		this.refs.button.removeAttribute("disabled");
		this.refs.connectForm.style.display = "none";

		this.refs.content.innerHTML = "";
		this.grid = TemplateCache.createDrop("VideoGridDrop", {}).node;
		this.refs.content.appendChild(this.grid);
	}

	private send(command: string, dstId: number, data: unknown) {
		if (this.socket?.readyState !== WebSocket.OPEN) return;

		this.socket.send(JSON.stringify({
			command,
			id: this.selfId,
			dstId,
			data
		}));
	}

	private ensurePeer(id: number): Peer {
		if (this.connections[id]) return this.connections[id];

		if (!this.localStream || !this.grid) {
			throw new Error("Локальное видео ещё не готово");
		}

		const connection = new RTCPeerConnection({
			iceServers: ICEServers
		});
		const drop = TemplateCache.createDrop("VideoDrop") as Peer["drop"];
		const peer: Peer = {
			connection,
			drop,
			pendingCandidates: []
		};

		this.connections[id] = peer;
		this.grid.appendChild(drop.node);

		for (const track of this.localStream.getTracks()) {
			connection.addTrack(track, this.localStream);
		}

		const remoteStream = new MediaStream();
		drop.refs.video.srcObject = remoteStream;
		drop.refs.video.autoplay = true;
		drop.refs.video.playsInline = true;

		connection.ontrack = event => {
			if (event.streams[0]) {
				drop.refs.video.srcObject = event.streams[0];
			} else {
				remoteStream.addTrack(event.track);
			}
		};

		connection.onicecandidate = event => {
			if (event.candidate) {
				this.send("iceCandidate", id, event.candidate.toJSON());
			}
		};

		return peer;
	}

	private removePeer(id: number) {
		const peer = this.connections[id];
		if (!peer) return;

		delete this.connections[id];
		peer.connection.close();
		peer.drop.refs.video.srcObject = null;
		peer.drop.node.remove();
	}

	async syncPool(pool: number[]) {
		if (this.selfId < 0) return;

		const present = new Set(pool);

		for (const id of Object.keys(this.connections).map(Number)) {
			if (!present.has(id)) this.removePeer(id);
		}

		for (const id of pool) {
			if (id === this.selfId || this.connections[id]) continue;

			const peer = this.ensurePeer(id);

			// Меньший ID уже находился в комнате и начинает переговоры.
			if (this.selfId < id) {
				const offer = await peer.connection.createOffer();
				await peer.connection.setLocalDescription(offer);
				this.send("offer", id, peer.connection.localDescription);
			}
		}
	}

	private async flushCandidates(peer: Peer) {
		for (const candidate of peer.pendingCandidates) {
			await peer.connection.addIceCandidate(candidate);
		}
		peer.pendingCandidates.length = 0;
	}

	async processOffer(senderId: number, offer: RTCSessionDescriptionInit) {
		const peer = this.ensurePeer(senderId);

		await peer.connection.setRemoteDescription(offer);
		await this.flushCandidates(peer);

		const answer = await peer.connection.createAnswer();
		await peer.connection.setLocalDescription(answer);
		this.send("answer", senderId, peer.connection.localDescription);
	}

	async processAnswer(senderId: number, answer: RTCSessionDescriptionInit) {
		const peer = this.connections[senderId];
		if (!peer) return;

		await peer.connection.setRemoteDescription(answer);
		await this.flushCandidates(peer);
	}

	async processIceCandidate(
		senderId: number,
		candidate: RTCIceCandidateInit
	) {
		const peer = this.ensurePeer(senderId);

		if (!peer.connection.remoteDescription) {
			peer.pendingCandidates.push(candidate);
			return;
		}

		await peer.connection.addIceCandidate(candidate);
	}

	async socketMessage(ev: MessageEvent) {
		try {
			const msg = JSON.parse(ev.data) as MessageData;

			switch (msg.command) {
				case "register":
					this.selfId = msg.id;
					break;
				case "pool":
					this.send("ack", -1, null);
					await this.syncPool(msg.data as number[]);
					break;
				case "offer":
					await this.processOffer(msg.id, msg.data);
					break;
				case "answer":
					await this.processAnswer(msg.id, msg.data);
					break;
				case "iceCandidate":
					await this.processIceCandidate(msg.id, msg.data);
					break;
			}
		} catch (err) {
			console.error("Message error:", err);
		}
	}

	toggleMute () {
		for (const track of this.localStream.getTracks()) {
			track.enabled = !this.muted;
		}
	}

	syncButtons () {
		for (const track of this.localStream.getTracks()) {
			if (track.kind === 'audio') {
				this.state.setProp("micButton", MicImage);
			}
			if (track.kind === 'video') {
				this.state.setProp("camButton", CamImage);
			}
		}
	}

	toggleSound () {
		for (const track of this.localStream.getTracks()) {
			if (track.kind === 'audio') {
				track.enabled = !track.enabled;

				if (track.enabled) {
					this.state.setProp("micButton", MicImage);
				} else {
					this.state.setProp("micButton", MicCrossImage);
				}
			}
		}
	}

	toggleVideo () {
		for (const track of this.localStream.getTracks()) {
			if (track.kind === 'video') {
				track.enabled = !track.enabled;

				if (track.enabled) {
					this.state.setProp("camButton", CamImage);
				} else {
					this.state.setProp("camButton", CamCrossImage);
				}
			}
		}
	}
}

window.app = new Application({});
app.mount(document.getElementById("root"));