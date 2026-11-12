import { createServer, request } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { origin } from "./mobile-fixture";

/** Isolated loopback stand-in for the gateway's HTTPS termination. */
export async function desktopBrowserProxy(upstream: string) {
  const server = createServer((req, res) => {
    const remote = request(
      upstream + req.url,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: new URL(origin).host,
          ...(req.headers.origin ? { origin } : {}),
        },
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    remote.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(remote);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) =>
    sockets.handleUpgrade(req, socket, head, (client) => {
      const remote = new WebSocket(upstream.replace("http:", "ws:") + req.url, {
        headers: {
          host: new URL(origin).host,
          origin,
          cookie: req.headers.cookie || "",
        },
      });
      const pending: string[] = [];
      client.on("message", (data) => {
        if (remote.readyState === WebSocket.OPEN) remote.send(String(data));
        else pending.push(String(data));
      });
      remote.on("open", () => {
        for (const data of pending) remote.send(data);
      });
      remote.on("message", (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(String(data));
      });
      remote.on("close", (code) => client.close(code === 1006 ? 1011 : code));
      remote.on("error", () => client.close());
      client.on("close", () => remote.close());
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/desktop/`,
    async close() {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}
