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
}

function wrapInstantiateWasmForPolyfill(
	options: EmscriptenOptions
): EmscriptenOptions {
	const wasmRefs: WasmRefs = { memory: null, malloc: null };
	const originalInstantiateWasm = options.instantiateWasm;
	if (!originalInstantiateWasm) {
		throw new Error(
			'JSPI polyfill requires emscriptenOptions.instantiateWasm. ' +
				'Provide a custom instantiateWasm hook so the polyfill ' +
				'can intercept WASM imports before instantiation.'
		);
	}
	return {
		...options,
		instantiateWasm(
			info: WebAssembly.Imports,
			receiveInstance: (
				instance: WebAssembly.Instance,
				module: WebAssembly.Module
			) => void
		) {
			patchAsyncImports(info, wasmRefs);
			return originalInstantiateWasm(info, (instance, module) => {
				wasmRefs.memory = instance.exports[
					'memory'
				] as WebAssembly.Memory;
				wasmRefs.malloc = instance.exports['malloc'] as (
					n: number
				) => number;
				receiveInstance(instance, module);
			});
		},
	};
}

function patchAsyncImports(
	info: WebAssembly.Imports,
	wasmRefs: WasmRefs
): void {
	const env = info['env'] as Record<string, unknown> | undefined;
	if (!env) return;

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

	// wasm_recv / recv: route through sync XHR to service
	// worker where the real TCPOverFetchWebSocket can read
	// data. Both must be replaced — recv calls the original
	// _wasm_recv JS function, not the WASM import.
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
	// events. Return 1 immediately so curl's select() sees
	// the socket as ready; polyfillRecv handles the actual
	// blocking when curl calls recv().
	if (typeof env['__asyncjs__wasm_poll_socket'] === 'function') {
		env['__asyncjs__wasm_poll_socket'] = (
			_socketd: number,
			_events: number,
			_timeout: number
		) => {
			return 1;
		};
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

function polyfillRecv(
	wasmRefs: WasmRefs,
	sockfd: number,
	buffer: number,
	size: number
): number {
	const socketId = PolyfillProxyWebSocket.sockfdToSocketId.get(sockfd);
	if (socketId === undefined) return 0;

	const response = sendSyncXhr('sock-recv', {
		socketId,
		maxSize: size,
	});
	if (!response.ok || response.data.length === 0) return 0;

	const mem = new Uint8Array(wasmRefs.memory!.buffer);
	mem.set(response.data, buffer);
	return response.data.length;
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

function readCString(wasmRefs: WasmRefs, ptr: number): Uint8Array {
	const mem = new Uint8Array(wasmRefs.memory!.buffer);
	let end = ptr;
	while (mem[end] !== 0) end++;
	return mem.slice(ptr, end);
}
