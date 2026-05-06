import { createServer } from "node:net";

export interface PortCheckResult {
  available: boolean;
  error?: string;
}

export async function checkLocalPort(
  port: number,
  host = "127.0.0.1",
): Promise<PortCheckResult> {
  return new Promise((resolve) => {
    const server = createServer();

    const cleanup = () => {
      server.removeAllListeners();
      server.close();
    };

    server.once("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      resolve({ available: false, error: err.code ?? err.message });
    });

    server.once("listening", () => {
      cleanup();
      resolve({ available: true });
    });

    server.listen(port, host);
  });
}

export async function suggestLocalPort(preferred: number): Promise<number> {
  if ((await checkLocalPort(preferred)).available) return preferred;

  for (let offset = 1; offset <= 200; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65535) break;
    if ((await checkLocalPort(candidate)).available) return candidate;
  }

  return preferred;
}
