/**
 * Worker-side WebSocket replacement for the JSPI polyfill.
 *
 * Instead of making real network connections (which require
 * an active event loop), this class routes all socket I/O
 * through synchronous XHR requests to the service worker,
 * where a real TCPOverFetchWebSocket handles the actual
 * connections.
 *
 * Implements the subset of the WebSocket API that
 * Emscripten's SOCKFS needs.
 */

import { sendSyncXhr } from './sync-xhr-channel';

let nextSocketId = 1;

export class PolyfillProxyWebSocket {
	/**
	 * Maps socket file descriptors to socket IDs.
	 * Populated by the __syscall_connect wrapper in
	 * patchAsyncImports after each connect call.
	 */
	static sockfdToSocketId = new Map<number, number>();

	/**
	 * Set in the constructor, read by __syscall_connect
	 * wrapper to associate the sockfd with the socket ID.
	 */
	static lastCreatedSocketId = 0;

	readonly socketId: number;
	readyState = 0; // CONNECTING
	binaryType = 'arraybuffer';

	// Event handler stubs for SOCKFS compatibility.
	onopen: ((event: unknown) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: unknown) => void) | null = null;

	constructor(url: string) {
		this.socketId = nextSocketId++;
		PolyfillProxyWebSocket.lastCreatedSocketId = this.socketId;

		// Parse host/port from the playground.internal URL
		// format: ws://playground.internal/?host=X&port=Y
		const parsed = new URL(url);
		const host = parsed.searchParams.get('host') ?? '';
		const port = parsed.searchParams.get('port') ?? '0';

		const response = sendSyncXhr('sock-open', {
			socketId: this.socketId,
			host,
			port,
		});

		if (!response.ok) {
			this.readyState = 3; // CLOSED
			return;
		}

		this.readyState = 1; // OPEN
	}

	send(data: ArrayBuffer): void {
		if (this.readyState !== 1) return;

		sendSyncXhr(
			'sock-send',
			{ socketId: this.socketId },
			new Uint8Array(data)
		);
	}

	close(): void {
		if (this.readyState >= 2) return;

		sendSyncXhr('sock-close', { socketId: this.socketId });
		this.readyState = 3; // CLOSED
	}

	addEventListener(): void {
		// No-op stub for SOCKFS compatibility.
	}

	removeEventListener(): void {
		// No-op stub for SOCKFS compatibility.
	}
}
