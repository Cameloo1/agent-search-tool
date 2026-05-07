import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiUrl = "http://localhost:3001";
const webUrl = "http://localhost:3000/compare";
const children = new Set();
let shuttingDown = false;

ensureEnvFile();

console.log("Agent Search dev bootstrap");
console.log(`Root: ${root}`);
console.log("");
await printPortHints();
console.log("Starting API and web dev servers...");
console.log(`API: ${apiUrl}/health`);
console.log(`Web: ${webUrl}`);
console.log("");
console.log("Press Ctrl+C to stop both servers.");
console.log("");

const api = start("api", ["pnpm", "--filter", "@agent-search/api", "dev"]);
const web = start("web", ["pnpm", "--filter", "@agent-search/web", "dev"]);

for (const child of [api, web]) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${child.label} exited (${signal ?? code ?? "unknown"}). Stopping the other server.`);
    shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function start(label, args) {
  const command = "corepack";
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    shell: process.platform === "win32",
    stdio: ["inherit", "pipe", "pipe"]
  });
  child.label = label;
  children.add(child);
  prefixStream(label, child.stdout);
  prefixStream(label, child.stderr);
  child.on("close", () => children.delete(child));
  return child;
}

function prefixStream(label, stream) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) console.log(`[${label}] ${line}`);
    }
  });
  stream.on("end", () => {
    if (pending.trim()) console.log(`[${label}] ${pending}`);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("");
  console.log("[dev] Stopping dev servers...");
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may already be gone.
    }
  }
  setTimeout(() => process.exit(code), 400);
}

function ensureEnvFile() {
  const envPath = resolve(root, ".env");
  const examplePath = resolve(root, ".env.example");
  if (!existsSync(envPath) && existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    console.log("Created .env from .env.example. Add local API keys there when needed.");
  }
}

async function printPortHints() {
  const checks = await Promise.all([
    isPortOpen(3001).then((open) => ({ port: 3001, open })),
    isPortOpen(3000).then((open) => ({ port: 3000, open }))
  ]);
  const occupied = checks.filter((check) => check.open);
  if (occupied.length === 0) return;
  console.log(`Heads up: port(s) ${occupied.map((check) => check.port).join(", ")} already look occupied.`);
  console.log("If startup fails, stop the old dev server first or restart the terminal.");
  console.log("");
}

function isPortOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(400);
    socket.on("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolveOpen(false);
    });
    socket.on("error", () => resolveOpen(false));
  });
}
