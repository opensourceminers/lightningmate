// A SOCKS5 proxy that answers Tor's RESOLVE extension (command 0xF0) only:
// each name it is asked for, and the IPv4 address (or the refusal code) it
// answers with.
import net, { type AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export async function socksResolver(t: TestContext, answer: (name: string) => string | number): Promise<{ proxy: { host: string; port: number }; asked: string[] }> {
  const asked: string[] = [];
  const server = net.createServer((client) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    client.on("error", () => client.destroy());
    client.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 3) {
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 5 && buf[1] === 0xf0 && buf[3] === 0x03 && buf.length >= 7 + buf[4]) {
        const name = buf.subarray(5, 5 + buf[4]).toString("utf8");
        asked.push(name);
        const a = answer(name);
        if (typeof a === "number") client.end(Buffer.from([0x05, a, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        else client.end(Buffer.from([0x05, 0x00, 0x00, 0x01, ...a.split(".").map(Number), 0, 0]));
        stage = 2;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { proxy: { host: "127.0.0.1", port: (server.address() as AddressInfo).port }, asked };
}
