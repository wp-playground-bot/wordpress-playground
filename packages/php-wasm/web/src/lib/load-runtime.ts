import type {
	SupportedPHPVersion,
	EmscriptenOptions,
	PHPLoaderModule,
} from '@php-wasm/universal';
import { loadPHPRuntime } from '@php-wasm/universal';
import { getPHPLoaderModule } from './get-php-loader-module';
import type { TCPOverFetchOptions } from './tcp-over-fetch-websocket';
import { tcpOverFetchWebsocket } from './tcp-over-fetch-websocket';
import { withIntl } from './extensions/intl/with-intl';
import {
	needsJspiPolyfill,
	installJspiPolyfill,
	PolyfillProxyWebSocket,
} from './jspi-polyfill';
import { sendSyncXhr } from './jspi-polyfill/sync-xhr-channel';

export interface LoaderOptions {
	emscriptenOptions?: EmscriptenOptions;
	onPhpLoaderModuleLoaded?: (module: PHPLoaderModule) => void;
	tcpOverFetch?: TCPOverFetchOptions;
	withIntl?: boolean;
}

/**
 * Fake a websocket connection to prevent errors in the web app
 * from cascading and breaking the Playground.
 */
const fakeWebsocket = () => {
	return {
		websocket: {
			decorator: (WebSocketConstructor: any) => {
				return class FakeWebsocketConstructor extends WebSocketConstructor {
					constructor() {
						try {
							super();
						} catch {
							// pass
						}
					}

					send() {
						return null;
					}
				};
			},
		},
	};
};

interface PHPWorkerGlobalScope extends WorkerGlobalScope {
	setImmediate: (fn: () => void) => void;
}

export async function loadWebRuntime(
	phpVersion: SupportedPHPVersion,
	loaderOptions: LoaderOptions = {}
) {
	/*
	 * Provide `setImmediate` so Emscripten doesn't install its message-based
	 * polyfill, which retains references to the Wasm HEAP and prevents the
	 * PHP instance from being garbage-collected.
	 *
	 * https://github.com/emscripten-core/emscripten/blob/6d61ffd7076309cb08af37aba496f25c23cdb5a4/src/lib/libeventloop.js#L57
	 */
	if (!('setImmediate' in globalThis)) {
		(globalThis as unknown as PHPWorkerGlobalScope).setImmediate = (
			fn: () => void
		) => setTimeout(fn, 0);
	}

	const polyfillNeeded = await needsJspiPolyfill();

	let emscriptenOptions: EmscriptenOptions | Promise<EmscriptenOptions> = {
		...fakeWebsocket(),
		...(loaderOptions.emscriptenOptions || {}),
	};

	// When the polyfill is active, socket I/O is routed
	// through PolyfillProxyWebSocket → sync XHR → service
	// worker, so we skip the normal tcpOverFetchWebsocket()
	// decorator (it would be overwritten anyway).
	if (loaderOptions.tcpOverFetch && !polyfillNeeded) {
		emscriptenOptions = tcpOverFetchWebsocket(
			emscriptenOptions,
			loaderOptions.tcpOverFetch
		);
	}

	if (loaderOptions.withIntl) {
		emscriptenOptions = withIntl(phpVersion, emscriptenOptions);
	}

	const [phpLoaderModule, options] = await Promise.all([
		getPHPLoaderModule(phpVersion),
		emscriptenOptions,
	]);

	let finalOptions = options;
	if (polyfillNeeded) {
		// eslint-disable-next-line no-console
		console.info('This browser does not support JSPI. Using a polyfill.');
		installJspiPolyfill();

		if (loaderOptions.tcpOverFetch) {
			// Forward tcpOverFetchOptions to main thread so it
			// can relay them to the service worker. CryptoKey
			// objects are only structured-clonable via postMessage.
			self.postMessage({
				type: 'jspi-polyfill-options',
				tcpOverFetchOptions: loaderOptions.tcpOverFetch,
			});

			// Replace websocket decorator to use the sync XHR
			// proxy instead of a real TCPOverFetchWebSocket on
			// the worker (where the event loop is blocked).
			finalOptions = {
				...finalOptions,
				websocket: {
					url: (_: unknown, host: string, port: string) =>
						`ws://playground.internal/?host=${host}&port=${port}`,
					subprotocol: 'binary',
					decorator: () =>
						PolyfillProxyWebSocket as unknown as typeof WebSocket,
				},
			};
		}

		finalOptions = wrapInstantiateWasmForPolyfill(finalOptions);
	}

	loaderOptions.onPhpLoaderModuleLoaded?.(phpLoaderModule);

	return await loadPHPRuntime(phpLoaderModule, finalOptions);
}

interface WasmRefs {
	memory: WebAssembly.Memory | null;
	malloc: ((size: number) => number) | null;
	// Late-bound reference to the Emscripten module. Set via
	// onRuntimeInitialized, used by polyfillJsModuleOnMessage
	// to forward non-request messages to onMessage listeners.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	module: any;
}

function wrapInstantiateWasmForPolyfill(
	options: EmscriptenOptions
): EmscriptenOptions {
	const wasmRefs: WasmRefs = { memory: null, malloc: null, module: null };
	const originalInstantiateWasm =
		options.instantiateWasm ?? defaultInstantiateWasm;
	const originalOnRuntimeInitialized = options.onRuntimeInitialized;
	return {
		...options,
		onRuntimeInitialized(phpRuntime: unknown) {
			wasmRefs.module = phpRuntime;
			originalOnRuntimeInitialized?.call(this, phpRuntime);
		},
		instantiateWasm(
			info: WebAssembly.Imports,
			receiveInstance: (
				instance: WebAssembly.Instance,
				module: WebAssembly.Module
			) => void
		) {
			patchAsyncImports(info, wasmRefs);
			return originalInstantiateWasm.call(
				this,
				info,
				(
					instance: WebAssembly.Instance,
					module: WebAssembly.Module
				) => {
					wasmRefs.memory = instance.exports[
						'memory'
					] as WebAssembly.Memory;
					wasmRefs.malloc = instance.exports['malloc'] as (
						n: number
					) => number;
					receiveInstance(instance, module);
				}
			);
		},
	};
}

/**
 * Default instantiateWasm for when no custom hook is provided.
 * Uses the Emscripten Module's wasmBinary (set internally before
 * this callback is invoked) to instantiate the WASM module.
 */
function defaultInstantiateWasm(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	this: any,
	info: WebAssembly.Imports,
	receiveInstance: (
		instance: WebAssembly.Instance,
		module: WebAssembly.Module
	) => void
): Record<string, never> {
	WebAssembly.instantiate(this.wasmBinary, info).then(
		({ instance, module }) => receiveInstance(instance, module)
	);
	return {};
}

function patchAsyncImports(
	info: WebAssembly.Imports,
	wasmRefs: WasmRefs
): void {
	const env = info['env'] as Record<string, unknown> | undefined;
	if (!env) return;

	// eslint-disable-next-line no-console
	console.log('[JSPI polyfill] patchAsyncImports called', {
		hasRecvFrom: typeof env['__syscall_recvfrom'] === 'function',
		hasConnect: typeof env['__syscall_connect'] === 'function',
		hasPollSocket: typeof env['__asyncjs__wasm_poll_socket'] === 'function',
		hasOnMessage:
			typeof env['__asyncjs__js_module_onMessage'] === 'function',
		hasSleep: typeof env['emscripten_sleep'] === 'function',
	});

	// Remove the Suspending polyfill now that
	// instrumentWasmImports has already used it. Functions
	// like _wasm_connect check 'Suspending' in WebAssembly
	// to choose between sync/async paths. With the polyfill
	// the async path breaks (handleAsync's await creates a
	// real async gap WASM can't handle), so we need them to
	// take their synchronous fallback instead.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	delete (WebAssembly as any).Suspending;

	if (typeof env['emscripten_sleep'] === 'function') {
		env['emscripten_sleep'] = (ms: number) => {
			sendSyncXhr('sleep', { ms });
		};
	}

	if (typeof env['emscripten_wget_data'] === 'function') {
		env['emscripten_wget_data'] = (
			urlPtr: number,
			pbuffer: number,
			pnum: number,
			perror: number
		) => {
			polyfillEmscriptenWgetData(wasmRefs, urlPtr, pbuffer, pnum, perror);
		};
	}

	// __syscall_recvfrom: Emscripten syscall backing libc
	// recv()/recvfrom(). Curl calls recv() which goes here.
	// The original reads from sock.recv_queue (populated by
	// WebSocket onmessage), which is always empty for our
	// PolyfillProxyWebSocket. Patch to use sync XHR instead.
	// Handles MSG_PEEK via local buffering.
	if (typeof env['__syscall_recvfrom'] === 'function') {
		const originalRecvFrom = env['__syscall_recvfrom'] as (
			...args: number[]
		) => number;
		env['__syscall_recvfrom'] = (
			fd: number,
			buf: number,
			len: number,
			flags: number,
			addr: number,
			addrlen: number
		): number => {
			return polyfillRecvFrom(
				wasmRefs,
				originalRecvFrom,
				fd,
				buf,
				len,
				flags,
				addr,
				addrlen
			);
		};
	}

	// wasm_recv / recv: PHP's socket layer calls wasm_recv
	// (defined in phpwasm-emscripten-library.js) which
	// internally polls __syscall_recvfrom. Replace with
	// direct sync XHR recv via the same shared buffer.
	const recvReplacement = (
		sockfd: number,
		buffer: number,
		size: number
	): number => {
		return polyfillRecv(wasmRefs, sockfd, buffer, size);
	};
	if (typeof env['wasm_recv'] === 'function') {
		env['wasm_recv'] = recvReplacement;
	}
	if (typeof env['recv'] === 'function') {
		env['recv'] = recvReplacement;
	}

	// __syscall_connect: wrap to capture sockfd → socketId
	// mapping after each connect call.
	if (typeof env['__syscall_connect'] === 'function') {
		const original = env['__syscall_connect'] as (
			sockfd: number,
			addr: number,
			addrlen: number
		) => number;
		env['__syscall_connect'] = (
			sockfd: number,
			addr: number,
			addrlen: number
		) => {
			const result = original(sockfd, addr, addrlen);
			if (PolyfillProxyWebSocket.lastCreatedSocketId > 0) {
				PolyfillProxyWebSocket.sockfdToSocketId.set(
					sockfd,
					PolyfillProxyWebSocket.lastCreatedSocketId
				);
				PolyfillProxyWebSocket.lastCreatedSocketId = 0;
			}
			return result;
		};
	}

	// fd_sync: no-op — the in-memory FS is already
	// up-to-date; only IDB persistence is skipped.
	if (typeof env['fd_sync'] === 'function') {
		env['fd_sync'] = () => 0;
	}
	const wasi = info['wasi_snapshot_preview1'] as
		| Record<string, unknown>
		| undefined;
	if (wasi && typeof wasi['fd_sync'] === 'function') {
		wasi['fd_sync'] = () => 0;
	}

	// wasm_poll_socket: EM_ASYNC_JS function used by
	// __wrap_select and php_pollfd_for to wait for socket
	// events. Return 1 immediately — the actual blocking
	// happens in polyfillRecvFrom when curl calls recv().
	if (typeof env['__asyncjs__wasm_poll_socket'] === 'function') {
		env['__asyncjs__wasm_poll_socket'] = () => 1;
	}

	// js_module_onMessage: EM_ASYNC_JS function called by
	// post_message_to_js(). Replace with synchronous sync
	// XHR version that routes the message to the service
	// worker for processing.
	if (typeof env['__asyncjs__js_module_onMessage'] === 'function') {
		env['__asyncjs__js_module_onMessage'] = (
			dataPtr: number,
			responseBufferPtr: number
		): number => {
			return polyfillJsModuleOnMessage(
				wasmRefs,
				dataPtr,
				responseBufferPtr
			);
		};
	}
}

function polyfillEmscriptenWgetData(
	wasmRefs: WasmRefs,
	urlPtr: number,
	pbuffer: number,
	pnum: number,
	perror: number
): void {
	const urlBytes = readCString(wasmRefs, urlPtr);

	// Send to service worker for fetching. No chunking
	// needed — sync XHR returns the full response.
	const response = sendSyncXhr('fetch', {}, urlBytes);

	if (!response.ok) {
		const view = new DataView(wasmRefs.memory!.buffer);
		view.setInt32(pbuffer, 0, true);
		view.setInt32(pnum, 0, true);
		view.setInt32(perror, 1, true);
		return;
	}

	const totalLength = response.data.length;

	// Allocate WASM buffer via malloc.
	const ptr = wasmRefs.malloc!(totalLength);

	// Re-read memory.buffer after malloc — memory growth
	// can detach the old ArrayBuffer.
	const newMem = new Uint8Array(wasmRefs.memory!.buffer);
	newMem.set(response.data, ptr);

	// Write output pointers.
	const view = new DataView(wasmRefs.memory!.buffer);
	view.setInt32(pbuffer, ptr, true);
	view.setInt32(pnum, totalLength, true);
	view.setInt32(perror, 0, true);
}

/**
 * Local recv buffer per socket. Bridges MSG_PEEK (which
 * reads without consuming) and normal recv. When data is
 * fetched from the service worker it's stored here; peek
 * reads leave it in place, normal reads consume it.
 */
const recvBuffers = new Map<number, Uint8Array>();

/**
 * Replacement for Emscripten's __syscall_recvfrom. Called
 * by libc recv()/recvfrom() — this is curl's recv path.
 */
function polyfillRecvFrom(
	wasmRefs: WasmRefs,
	originalRecvFrom: (...args: number[]) => number,
	fd: number,
	buf: number,
	len: number,
	flags: number,
	addr: number,
	addrlen: number
): number {
	const socketId = PolyfillProxyWebSocket.sockfdToSocketId.get(fd);
	if (socketId === undefined) {
		return originalRecvFrom(fd, buf, len, flags, addr, addrlen);
	}

	const data = recvFromBuffer(socketId, len, flags);
	if (data.length === 0) return 0;

	const mem = new Uint8Array(wasmRefs.memory!.buffer);
	mem.set(data, buf);
	return data.length;
}

/**
 * Replacement for wasm_recv (PHP's socket layer recv).
 * Uses the same shared buffer as polyfillRecvFrom.
 */
function polyfillRecv(
	wasmRefs: WasmRefs,
	sockfd: number,
	buffer: number,
	size: number
): number {
	const socketId = PolyfillProxyWebSocket.sockfdToSocketId.get(sockfd);
	if (socketId === undefined) return 0;

	const data = recvFromBuffer(socketId, size, 0);
	if (data.length === 0) return 0;

	const mem = new Uint8Array(wasmRefs.memory!.buffer);
	mem.set(data, buffer);
	return data.length;
}

/**
 * Shared recv implementation. Checks the local buffer
 * first, fetches from the service worker if empty.
 * Handles MSG_PEEK (flag 2) by not consuming the buffer.
 */
function recvFromBuffer(
	socketId: number,
	maxSize: number,
	flags: number
): Uint8Array {
	const MSG_PEEK = 2;
	const isPeek = (flags & MSG_PEEK) !== 0;

	let buffered = recvBuffers.get(socketId);
	if (!buffered || buffered.length === 0) {
		const response = sendSyncXhr('sock-recv', {
			socketId,
			maxSize,
		});
		if (!response.ok || response.data.length === 0) {
			return new Uint8Array(0);
		}
		buffered = response.data;
	}

	const toRead = Math.min(maxSize, buffered.length);
	const result = buffered.subarray(0, toRead);

	if (isPeek) {
		recvBuffers.set(socketId, buffered);
	} else {
		const remaining = buffered.subarray(toRead);
		if (remaining.length > 0) {
			recvBuffers.set(socketId, remaining);
		} else {
			recvBuffers.delete(socketId);
		}
	}

	return result;
}

/**
 * Synchronous sync XHR replacement for js_module_onMessage
 * (the EM_ASYNC_JS function behind post_message_to_js).
 *
 * Sends the message string to the service worker, receives
 * the raw HTTP response bytes, allocates a WASM buffer via
 * malloc, writes the pointer into response_buffer, and
 * returns the response size (or -1 on error).
 */
function polyfillJsModuleOnMessage(
	wasmRefs: WasmRefs,
	dataPtr: number,
	responseBufferPtr: number
): number {
	const messageBytes = readCString(wasmRefs, dataPtr);

	// Forward non-request messages to Module['onMessage']
	// listeners. Messages like 'parallelize_request' are
	// used by the prefetch optimization to capture update
	// check requests. Without this, those listeners never
	// fire because the polyfill bypasses the normal
	// Module['onMessage'] call chain.
	//
	// 'request' type messages are handled exclusively by
	// the service worker — forwarding them would cause
	// duplicate fetches.
	forwardToOnMessageListeners(wasmRefs, messageBytes);

	// Send to service worker for processing.
	const response = sendSyncXhr('msg', {}, messageBytes);

	if (!response.ok) {
		return -1;
	}

	const totalLength = response.data.length;

	// Allocate WASM buffer via malloc (+1 for null terminator).
	const ptr = wasmRefs.malloc!(totalLength + 1);

	// Re-read memory.buffer after malloc — memory growth
	// can detach the old ArrayBuffer.
	const mem = new Uint8Array(wasmRefs.memory!.buffer);
	mem.set(response.data, ptr);
	mem[ptr + totalLength] = 0;

	// Write pointer to response_buffer (4 bytes LE).
	const view = new DataView(wasmRefs.memory!.buffer);
	view.setInt32(responseBufferPtr, ptr, true);

	return totalLength;
}

function forwardToOnMessageListeners(
	wasmRefs: WasmRefs,
	messageBytes: Uint8Array
): void {
	const onMessage = wasmRefs.module?.onMessage;
	if (typeof onMessage !== 'function') {
		return;
	}

	const messageStr = new TextDecoder().decode(messageBytes);

	let isRequest = false;
	try {
		isRequest = JSON.parse(messageStr).type === 'request';
	} catch {
		// Not JSON — forward to listeners.
	}
	if (isRequest) {
		return;
	}

	// Fire-and-forget. The listeners for non-request
	// messages (like 'parallelize_request') are synchronous
	// capture callbacks that don't return meaningful data.
	onMessage(messageStr).catch(() => {});
}

function readCString(wasmRefs: WasmRefs, ptr: number): Uint8Array {
	const mem = new Uint8Array(wasmRefs.memory!.buffer);
	let end = ptr;
	while (mem[end] !== 0) end++;
	return mem.slice(ptr, end);
}
