import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { once } from "node:events";

import {
  closeProxyConnections,
  configureProxy,
  connectUpstreamHttp2,
  upstreamFetch,
  validateProxyUrl,
} from "../src/utils/proxy";

async function listen(server: net.Server, t: TestContext): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await closeProxyConnections();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as net.AddressInfo).port;
}

function tunnel(
  client: net.Socket,
  head: Buffer,
  destinationPort: number,
  connected: () => void,
): void {
  const upstream = net.connect(destinationPort, "127.0.0.1", () => {
    connected();
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  upstream.on("close", () => client.destroy());
}

function connectProxy(destinationPort: number) {
  const requests: { authority: string | undefined; authorization: unknown }[] =
    [];
  const server = http.createServer((_request, response) => {
    response.writeHead(500).end("Expected CONNECT");
  });
  server.on("connect", (request, socket, head) => {
    requests.push({
      authority: request.url,
      authorization: request.headers["proxy-authorization"],
    });
    tunnel(socket as net.Socket, head, destinationPort, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
  });
  return { server, requests };
}

function socksProxy(destinationPort: number) {
  const requests: {
    hostname: string;
    port: number;
    username: string;
    password: string;
  }[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    let username = "";
    let password = "";
    const consume = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          assert.equal(buffer[0], 5);
          assert.ok(buffer.subarray(2, 2 + buffer[1]).includes(2));
          buffer = buffer.subarray(2 + buffer[1]);
          stage = "auth";
          socket.write(Buffer.from([5, 2]));
        } else if (stage === "auth") {
          if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
          const usernameEnd = 2 + buffer[1];
          const passwordEnd = usernameEnd + 1 + buffer[usernameEnd];
          if (buffer.length < passwordEnd) return;
          assert.equal(buffer[0], 1);
          username = buffer.subarray(2, usernameEnd).toString();
          password = buffer.subarray(usernameEnd + 1, passwordEnd).toString();
          buffer = buffer.subarray(passwordEnd);
          stage = "connect";
          socket.write(Buffer.from([1, 0]));
        } else if (stage === "connect") {
          if (buffer.length < 5) return;
          assert.equal(buffer[0], 5);
          assert.equal(buffer[1], 1);
          assert.equal(
            buffer[3],
            3,
            "SOCKS proxy should resolve the destination hostname",
          );
          const hostnameEnd = 5 + buffer[4];
          if (buffer.length < hostnameEnd + 2) return;
          requests.push({
            hostname: buffer.subarray(5, hostnameEnd).toString(),
            port: buffer.readUInt16BE(hostnameEnd),
            username,
            password,
          });
          buffer = buffer.subarray(hostnameEnd + 2);
          stage = "tunnel";
          socket.removeListener("data", consume);
          tunnel(socket, buffer, destinationPort, () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          });
          return;
        } else {
          return;
        }
      }
    };
    socket.on("data", consume);
    socket.on("error", () => {});
  });
  return { server, requests };
}

test("proxy configuration accepts supported URLs and rejects invalid input without leaking credentials", () => {
  assert.equal(validateProxyUrl(undefined), undefined);
  assert.equal(validateProxyUrl(null), undefined);
  assert.equal(validateProxyUrl("  "), undefined);
  for (const scheme of ["http", "https", "socks5", "socks5h"]) {
    assert.ok(validateProxyUrl(`${scheme}://127.0.0.1:1080`));
  }
  for (const value of [
    42,
    "127.0.0.1:8080",
    "ftp://alice:secret@127.0.0.1:80",
    "http://alice:secret@127.0.0.1:99999",
  ]) {
    assert.throws(
      () => validateProxyUrl(value),
      (error: Error) => {
        assert.doesNotMatch(error.message, /alice|secret/);
        return true;
      },
    );
  }
});

test("upstreamFetch works directly when no proxy is configured", async (t) => {
  configureProxy();
  const origin = http.createServer((_request, response) =>
    response.end("direct"),
  );
  const port = await listen(origin, t);
  const response = await upstreamFetch(`http://127.0.0.1:${port}/direct`);
  assert.equal(await response.text(), "direct");
});

test("upstreamFetch sends authenticated CONNECT through the proxy without leaking auth to the origin", async (t) => {
  let originAuthorization: unknown = "not called";
  let receivedBody = "";
  const origin = http.createServer((request, response) => {
    originAuthorization = request.headers["proxy-authorization"];
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => response.end("proxied"));
  });
  const originPort = await listen(origin, t);
  const proxy = connectProxy(originPort);
  const proxyPort = await listen(proxy.server, t);
  configureProxy(`http://alice:p%40ss%3Aword@127.0.0.1:${proxyPort}`);

  const response = await upstreamFetch(
    `http://upstream.invalid:${originPort}/messages`,
    {
      method: "POST",
      body: "request body",
    },
  );

  assert.equal(await response.text(), "proxied");
  assert.equal(receivedBody, "request body");
  assert.equal(originAuthorization, undefined);
  assert.deepEqual(proxy.requests, [
    {
      authority: `upstream.invalid:${originPort}`,
      authorization: `Basic ${Buffer.from("alice:p@ss:word").toString("base64")}`,
    },
  ]);
});

test("a rejected proxy tunnel fails the request without connecting directly", async (t) => {
  let directRequests = 0;
  const origin = http.createServer((_request, response) => {
    directRequests++;
    response.end("must not be reached");
  });
  const originPort = await listen(origin, t);
  const proxy = http.createServer();
  proxy.on("connect", (_request, socket) => {
    socket.end(
      "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
    );
  });
  const proxyPort = await listen(proxy, t);
  configureProxy(`http://127.0.0.1:${proxyPort}`);

  await assert.rejects(upstreamFetch(`http://127.0.0.1:${originPort}/`));
  assert.equal(directRequests, 0);
});

test("SOCKS5h supports credentials and resolves upstream names at the proxy", async (t) => {
  const origin = http.createServer((_request, response) =>
    response.end("socks"),
  );
  const originPort = await listen(origin, t);
  const proxy = socksProxy(originPort);
  const proxyPort = await listen(proxy.server, t);
  configureProxy(`socks5h://alice:p%40ss@127.0.0.1:${proxyPort}`);

  const response = await upstreamFetch(
    `http://upstream.invalid:${originPort}/`,
  );
  assert.equal(await response.text(), "socks");
  assert.deepEqual(proxy.requests, [
    {
      hostname: "upstream.invalid",
      port: originPort,
      username: "alice",
      password: "p@ss",
    },
  ]);
});

test("HTTP/2 requests use the configured CONNECT tunnel", async (t) => {
  const origin = http2.createServer();
  origin.on("stream", (stream, headers) => {
    assert.equal(headers[":path"], "/stream");
    stream.respond({ ":status": 200, "content-type": "text/plain" });
    stream.end("h2 through proxy");
  });
  const originPort = await listen(origin, t);
  const proxy = connectProxy(originPort);
  const proxyPort = await listen(proxy.server, t);
  configureProxy(`http://127.0.0.1:${proxyPort}`);

  const session = await connectUpstreamHttp2(
    `http://upstream.invalid:${originPort}`,
    { timeoutMs: 2000 },
  );
  t.after(() => session.destroy());
  const request = session.request({ ":path": "/stream" });
  request.end();
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  await once(request, "end");
  session.close();
  assert.equal(body, "h2 through proxy");
  assert.equal(proxy.requests[0]?.authority, `upstream.invalid:${originPort}`);
});

test(
  "HTTP/2 tunnel establishment obeys its timeout",
  { timeout: 5000 },
  async (t) => {
    const proxy = http.createServer();
    proxy.on("connect", () => {});
    const proxyPort = await listen(proxy, t);
    configureProxy(`http://127.0.0.1:${proxyPort}`);
    await assert.rejects(
      connectUpstreamHttp2("https://upstream.invalid", { timeoutMs: 50 }),
      /timeout|timed out/i,
    );
  },
);

test(
  "HTTP/2 tunnel establishment aborts while waiting for CONNECT",
  { timeout: 5000 },
  async (t) => {
    const controller = new AbortController();
    const proxy = http.createServer();
    proxy.on("connect", () => controller.abort());
    const proxyPort = await listen(proxy, t);
    configureProxy(`http://127.0.0.1:${proxyPort}`);
    await assert.rejects(
      connectUpstreamHttp2("https://upstream.invalid", {
        timeoutMs: 4000,
        signal: controller.signal,
      }),
      (error: Error) =>
        error.name === "AbortError" || /abort/i.test(error.message),
    );
  },
);
