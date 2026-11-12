import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { Agent } from "undici";
import { SocksClient } from "socks";

const CONNECT_TIMEOUT_MS = 10_000;
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);

let proxyUrl: string | undefined;
let proxy: URL | undefined;
let dispatcher: Agent | undefined;

/** Validate without putting potentially secret proxy credentials in errors. */
export function validateProxyUrl(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("proxy-url must be a URL string");
  }
  const normalized = value.trim();
  if (!normalized) return undefined;

  try {
    const parsed = new URL(normalized);
    if (
      !SUPPORTED_PROTOCOLS.has(parsed.protocol) ||
      !parsed.hostname ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash ||
      /[\r\n\t]/.test(normalized)
    ) {
      throw new Error("invalid proxy URL");
    }
    if (
      parsed.port &&
      (!Number.isInteger(Number(parsed.port)) ||
        Number(parsed.port) < 1 ||
        Number(parsed.port) > 65535)
    ) {
      throw new Error("invalid proxy port");
    }
    // Fail early on malformed percent escapes instead of failing on a request.
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    if (
      parsed.protocol.startsWith("socks") &&
      (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255)
    ) {
      throw new Error("invalid SOCKS credentials");
    }
    return parsed.toString();
  } catch {
    throw new Error(
      "Invalid proxy-url: expected http://, https://, socks5://, or socks5h://host:port (optional username and password)",
    );
  }
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

interface Target {
  hostname: string;
  port: number;
  secure: boolean;
  alpn: string[];
}

interface ConnectionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Proxy connection aborted");
}

/** Wait for the HTTP/2 preface/ALPN handshake before handing a session to callers. */
function awaitHttp2Connect(
  session: http2.ClientHttp2Session,
  options: ConnectionOptions,
): Promise<http2.ClientHttp2Session> {
  // A caller-supplied timeout covers the complete HTTP/2 handshake. The
  // proxy CONNECT itself remains capped separately so a dead proxy fails fast.
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => fail(new Error("Upstream HTTP/2 connection timed out")),
      timeoutMs,
    );
    const onAbort = () => fail(abortError(options.signal!));
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      session.removeListener("connect", onConnect);
      session.removeListener("error", onError);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      session.destroy();
      reject(
        error instanceof Error ? error : new Error("HTTP/2 connection failed"),
      );
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(session);
    };
    const onError = (error: Error) => fail(error);

    if (session.closed || session.destroyed) {
      fail(new Error("Upstream HTTP/2 connection closed"));
      return;
    }
    session.once("connect", onConnect);
    session.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Open a tunnel, then negotiate target TLS separately from proxy TLS. */
function connectViaProxy(
  proxy: URL,
  target: Target,
  options: ConnectionOptions = {},
): Promise<net.Socket> {
  const timeoutMs = Math.min(
    options.timeoutMs ?? CONNECT_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
  );
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    let settled = false;
    let request: http.ClientRequest | undefined;
    const sockets = new Set<net.Socket>();
    const timer = setTimeout(
      () => fail(new Error("Proxy connection timed out")),
      timeoutMs,
    );
    const onAbort = () => fail(abortError(signal!));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const socket of sockets) socket.removeListener("error", fail);
    };
    function fail(error: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      request?.destroy();
      for (const socket of sockets) socket.destroy();
      reject(
        error instanceof Error ? error : new Error("Proxy connection failed"),
      );
    }
    function track(socket: net.Socket): net.Socket {
      if (!sockets.has(socket)) {
        sockets.add(socket);
        socket.once("error", fail);
      }
      if (settled) socket.destroy();
      return socket;
    }
    function succeed(socket: net.Socket) {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      cleanup();
      socket.setNoDelay(true);
      resolve(socket);
    }
    function tunnelReady(socket: net.Socket) {
      if (settled) {
        socket.destroy();
        return;
      }
      if (!target.secure) {
        succeed(socket);
        return;
      }
      const secureSocket = tls.connect({
        socket,
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        host: target.hostname,
        // Explicit verification also protects IP targets (which have no SNI).
        rejectUnauthorized: true,
        ALPNProtocols: target.alpn,
      });
      track(secureSocket);
      secureSocket.once("secureConnect", () => succeed(secureSocket));
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    if (proxy.protocol === "http:" || proxy.protocol === "https:") {
      const authority = `${net.isIP(target.hostname) === 6 ? `[${target.hostname}]` : target.hostname}:${target.port}`;
      const headers: http.OutgoingHttpHeaders = { Host: authority };
      if (proxy.username || proxy.password) {
        headers["Proxy-Authorization"] =
          "Basic " +
          Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString("base64");
      }
      const transport = proxy.protocol === "https:" ? https : http;
      request = transport.request({
        hostname: hostname(proxy),
        port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: authority,
        headers,
        agent: false,
        ...(proxy.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      });
      request.on("socket", track);
      request.once("error", fail);
      request.once("connect", (response, socket, head) => {
        track(socket);
        if (response.statusCode !== 200) {
          fail(
            new Error(
              `Proxy CONNECT failed with status ${response.statusCode}`,
            ),
          );
          return;
        }
        if (head.length) socket.unshift(head);
        tunnelReady(socket);
      });
      request.once("response", (response) => {
        response.resume();
        fail(
          new Error(`Proxy CONNECT failed with status ${response.statusCode}`),
        );
      });
      request.end();
      return;
    }

    // socks5 resolves locally; socks5h delegates DNS to the proxy.
    void (async () => {
      const destinationHost =
        proxy.protocol === "socks5:" && !net.isIP(target.hostname)
          ? (await dns.lookup(target.hostname)).address
          : target.hostname;
      if (settled) return;
      const socket = track(new net.Socket());
      socket.once("connect", () => {
        void SocksClient.createConnection({
          command: "connect",
          proxy: {
            host: hostname(proxy),
            port: Number(proxy.port) || 1080,
            type: 5,
            userId: decodeURIComponent(proxy.username),
            password: decodeURIComponent(proxy.password),
          },
          destination: { host: destinationHost, port: target.port },
          existing_socket: socket,
          timeout: timeoutMs,
        }).then(({ socket }) => tunnelReady(socket), fail);
      });
      socket.connect(Number(proxy.port) || 1080, hostname(proxy));
    })().catch(fail);
  });
}

/** Configure process-wide upstream traffic; local callback/reload traffic stays direct. */
export function configureProxy(value?: string): void {
  const nextUrl = validateProxyUrl(value);
  if (nextUrl === proxyUrl) return;
  const previous = dispatcher;
  proxyUrl = nextUrl;
  proxy = nextUrl ? new URL(nextUrl) : undefined;
  const activeProxy = proxy;
  dispatcher = activeProxy
    ? new Agent({
        connect(options, callback) {
          void connectViaProxy(activeProxy, {
            hostname: options.hostname.replace(/^\[|\]$/g, ""),
            port:
              Number(options.port) ||
              (options.protocol === "https:" ? 443 : 80),
            secure: options.protocol === "https:",
            alpn: ["http/1.1"],
          }).then(
            (socket) => callback(null, socket),
            (error: Error) => callback(error, null),
          );
        },
      })
    : undefined;
  // Configuration is normally set only at startup. Dispose old pools when tests
  // or an embedding application change it, without leaking idle sockets.
  void previous?.destroy().catch(() => {});
}

export function upstreamFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(
    input,
    dispatcher ? ({ ...init, dispatcher } as RequestInit) : init,
  );
}

export async function connectUpstreamHttp2(
  origin: string,
  options: ConnectionOptions = {},
): Promise<http2.ClientHttp2Session> {
  if (options.signal?.aborted) throw abortError(options.signal);
  const target = new URL(origin);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("HTTP/2 upstream must use http:// or https://");
  }
  if (!proxy) return awaitHttp2Connect(http2.connect(target.origin), options);
  const socket = await connectViaProxy(
    proxy,
    {
      hostname: hostname(target),
      port: Number(target.port) || (target.protocol === "https:" ? 443 : 80),
      secure: target.protocol === "https:",
      alpn: ["h2"],
    },
    options,
  );
  if (options.signal?.aborted) {
    socket.destroy();
    throw abortError(options.signal);
  }
  try {
    return await awaitHttp2Connect(
      http2.connect(target.origin, { createConnection: () => socket }),
      options,
    );
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Release pooled fetch connections, primarily for tests and embedded use. */
export async function closeProxyConnections(): Promise<void> {
  const previous = dispatcher;
  dispatcher = undefined;
  proxy = undefined;
  proxyUrl = undefined;
  await previous?.destroy();
}
