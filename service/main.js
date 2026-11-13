// service/main.ts
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

// service/model.ts
var isPort = (value) => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
function parseTunnel(value) {
  if (!value || typeof value !== "object")
    throw new Error("Invalid tunnel.");
  const t = value;
  if (typeof t.name !== "string" || !t.name.trim() || t.name.length > 80 || /[\r\n]/.test(t.name))
    throw new Error("Enter a name (up to 80 characters).");
  if (!["cloudflare-quick", "cloudflare-named", "microsoft"].includes(String(t.provider)))
    throw new Error("Choose a provider.");
  if (!isPort(t.port))
    throw new Error("Enter a port between 1 and 65535.");
  if (t.protocol !== "http" && t.protocol !== "https")
    throw new Error("Choose HTTP or HTTPS for the local service.");
  if (typeof t.public !== "boolean" || typeof t.keepRunning !== "boolean")
    throw new Error("Invalid access or lifecycle setting.");
  if (t.provider === "cloudflare-quick" && !t.public)
    throw new Error("Cloudflare Quick Tunnels require public access.");
  if (t.provider === "cloudflare-named") {
    if (!t.public)
      throw new Error("Cloudflare DNS tunnels require public access. Configure Cloudflare Access separately to restrict access.");
    if (typeof t.hostname !== "string" || !/^(?=.{4,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i.test(t.hostname))
      throw new Error("Enter a valid Cloudflare DNS hostname.");
  }
  if (t.provider === "microsoft" && t.hostname)
    throw new Error("Hostnames are only for Cloudflare named tunnels.");
  return {
    id: typeof t.id === "string" ? t.id : "",
    name: t.name.trim(),
    provider: t.provider,
    port: t.port,
    protocol: t.protocol,
    public: t.public,
    keepRunning: t.keepRunning,
    ...t.provider === "cloudflare-named" ? { hostname: String(t.hostname).toLowerCase() } : {}
  };
}
function commandFor(t) {
  if (t.provider === "cloudflare-quick")
    return ["cloudflared", "tunnel", "--url", `${t.protocol}://127.0.0.1:${t.port}`];
  if (t.provider === "cloudflare-named")
    return ["cloudflared", "tunnel", "--url", `${t.protocol}://127.0.0.1:${t.port}`, "run", t.providerId];
  return ["devtunnel", "host", t.providerId, ...t.public ? ["--allow-anonymous"] : []];
}
function redact(text) {
  return text.replace(/\x1b\[[\d;]*m/g, "").replace(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d+/gi, "[local service]").replace(/(token|secret|authorization|password)\s*[:=]\s*[^\s,]+/gi, "$1: [hidden]").slice(-6000);
}

// service/main.ts
var exec = promisify(execFile);
var dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR || path.join(os.homedir(), ".local", "share", "openchamber-tunnels");
var statePath = path.join(dataDir, "tunnels.json");
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
var processes = new Map;
var logBuffers = new Map;
var logins = new Map;
var tunnels = [];
var queue = Promise.resolve();
function locked(fn) {
  const next = queue.then(fn);
  queue = next.then(() => {
    return;
  }, () => {
    return;
  });
  return next;
}
async function save() {
  await fs.mkdir(dataDir, { recursive: true, mode: 448 });
  await fs.writeFile(statePath + ".tmp", JSON.stringify(tunnels, null, 2), { mode: 384 });
  await fs.rename(statePath + ".tmp", statePath);
}
async function load() {
  try {
    tunnels = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (!Array.isArray(tunnels))
      tunnels = [];
    for (const t of tunnels) {
      if (t.pid && !running(t)) {
        delete t.pid;
        delete t.startedAt;
        if (t.provider !== "cloudflare-named")
          delete t.url;
      }
    }
    await save();
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
  }
}
function alive(pid) {
  if (!pid || !Number.isInteger(pid))
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function running(t) {
  if (!alive(t.pid))
    return false;
  if (process.platform !== "linux")
    return true;
  try {
    const cmdline = readFileSync(`/proc/${t.pid}/cmdline`, "utf8");
    return cmdline.includes(t.provider === "microsoft" ? "devtunnel" : "cloudflared");
  } catch {
    return false;
  }
}
async function run(bin, args, timeout = 15000) {
  try {
    const { stdout, stderr } = await exec(bin, args, { timeout, maxBuffer: 512000, env: process.env });
    return String(stdout || stderr);
  } catch (error) {
    const e = error;
    if (e.code === "ENOENT")
      throw new Error(`${bin} is not installed or not on PATH.`);
    throw new Error(redact(e.stderr || e.message));
  }
}
function outputJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    const start = output.indexOf("{");
    if (start >= 0) {
      try {
        return JSON.parse(output.slice(start));
      } catch {}
    }
    throw new Error("The provider returned an unexpected response. Check the account before retrying: a remote resource may have been created.");
  }
}
async function cliStatus() {
  const binaries = await Promise.all(["cloudflared", "devtunnel"].map(async (bin) => {
    try {
      await run(bin, ["--version"], 4000);
      return true;
    } catch {
      return false;
    }
  }));
  return { cloudflare: binaries[0], microsoft: binaries[1] };
}
async function cloudflareCertPresent() {
  const candidates = [
    process.env.TUNNEL_ORIGIN_CERT,
    path.join(os.homedir(), ".cloudflared", "cert.pem"),
    path.join(os.homedir(), ".cloudflare-warp", "cert.pem"),
    path.join(os.homedir(), "cloudflare-warp", "cert.pem"),
    "/etc/cloudflared/cert.pem",
    "/usr/local/etc/cloudflared/cert.pem"
  ].filter((p) => Boolean(p));
  for (const certPath of candidates) {
    try {
      const info = await fs.stat(certPath);
      if (info.isFile() && info.size > 0)
        return true;
    } catch {}
  }
  return false;
}
async function providerStatus() {
  const cli = await cliStatus();
  const [cfSignedIn, msAuth] = await Promise.all([
    cli.cloudflare ? cloudflareCertPresent() : Promise.resolve(false),
    (async () => {
      if (!cli.microsoft)
        return { cli: false, signedIn: false };
      try {
        const raw = await run("devtunnel", ["user", "show", "--json"], 4000);
        const parsed = outputJson(raw);
        const signedIn = String(parsed.status || "").toLowerCase() === "logged in" || Boolean(parsed.username);
        return {
          cli: true,
          signedIn,
          ...parsed.username ? { account: parsed.username } : {},
          ...parsed.provider ? { provider: parsed.provider } : {}
        };
      } catch {
        return { cli: true, signedIn: false };
      }
    })()
  ]);
  return {
    cli,
    platform: process.platform,
    providers: {
      cloudflare: { cli: cli.cloudflare, signedIn: cfSignedIn, ...cfSignedIn ? { account: "Origin certificate" } : {} },
      microsoft: msAuth
    }
  };
}
async function login(provider, method = "entra") {
  const existing = logins.get(provider);
  if (existing && !existing.finished) {
    if (provider !== "microsoft" || existing.method === method)
      return { started: true };
    try {
      existing.child.kill("SIGTERM");
    } catch {}
  }
  const bin = provider === "cloudflare" ? "cloudflared" : "devtunnel";
  const args = provider === "cloudflare" ? ["tunnel", "login"] : ["user", "login", method === "github" ? "--github" : "--entra", "--use-device-code-auth"];
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const state = {
    child,
    output: "",
    finished: false,
    exitCode: undefined,
    ...provider === "microsoft" ? { method } : {}
  };
  logins.set(provider, state);
  let settled = false;
  let resolvePrompt;
  const promptReady = new Promise((resolve) => {
    resolvePrompt = resolve;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      resolvePrompt();
    }
  }, 1500);
  const donePrompt = () => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timer);
    resolvePrompt();
  };
  const collect = (data) => {
    if (logins.get(provider)?.child !== child)
      return;
    state.output = (state.output + data.toString()).slice(-6000);
    if (/https?:\/\/[^\s"'<>]+/i.test(state.output))
      donePrompt();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => {
    if (logins.get(provider)?.child !== child)
      return;
    state.output = error.message;
    state.finished = true;
    donePrompt();
  });
  child.on("exit", (code) => {
    if (logins.get(provider)?.child !== child)
      return;
    state.finished = true;
    state.exitCode = code ?? undefined;
    donePrompt();
  });
  await promptReady;
  return { started: true };
}
function cancelLogin(provider) {
  const existing = logins.get(provider);
  if (existing) {
    if (!existing.finished) {
      existing.finished = true;
      try {
        existing.child.kill("SIGTERM");
      } catch {}
    }
    logins.delete(provider);
  }
  return { ok: true };
}
async function prepare(t) {
  if (t.provider === "cloudflare-quick")
    return;
  if (t.provider === "cloudflare-named") {
    if (!t.providerId) {
      const output = await run("cloudflared", ["tunnel", "create", "--output", "json", t.name], 30000);
      const parsed = outputJson(output);
      if (!parsed.id)
        throw new Error("Cloudflare did not return a tunnel ID.");
      t.providerId = parsed.id;
      await save();
    }
    if (t.hostname && !t.url) {
      await run("cloudflared", ["tunnel", "route", "dns", t.providerId, t.hostname], 30000);
      t.url = `https://${t.hostname}`;
      await save();
    }
    return;
  }
  if (!t.providerId) {
    const output = await run("devtunnel", ["create", "--json"], 30000);
    const parsed = outputJson(output);
    t.providerId = parsed.tunnelId || parsed.tunnel?.tunnelId;
    if (!t.providerId)
      throw new Error("Dev Tunnels did not return an ID. Check your account for a tunnel that may have been created.");
    await save();
  }
  const listed = outputJson(await run("devtunnel", ["port", "list", t.providerId, "--json"], 15000));
  const ports = Array.isArray(listed.ports) ? listed.ports : [];
  const existing = ports.find((p) => p.portNumber === t.port);
  if (existing && existing.protocol && existing.protocol !== t.protocol) {
    await run("devtunnel", ["port", "delete", t.providerId, "-p", String(t.port), "--json"], 15000);
    await run("devtunnel", ["port", "create", t.providerId, "-p", String(t.port), "--protocol", t.protocol, "--json"], 15000);
  } else if (!existing) {
    await run("devtunnel", ["port", "create", t.providerId, "-p", String(t.port), "--protocol", t.protocol, "--json"], 15000);
  }
}
function record(t, chunk) {
  logBuffers.set(t.id, ((logBuffers.get(t.id) || "") + chunk).slice(-12000));
  const output = logBuffers.get(t.id) || "";
  const url = t.provider === "cloudflare-quick" ? output.match(/https:\/\/[a-z\d-]+\.trycloudflare\.com\b/i)?.[0] : t.provider === "microsoft" ? output.match(/https:\/\/[^\s"']+\.devtunnels\.ms[^\s"']*/i)?.[0] : undefined;
  if (url && t.url !== url) {
    t.url = url;
    locked(save);
  }
}
async function start(t) {
  if (running(t))
    throw new Error("This tunnel is already running.");
  await prepare(t);
  const [bin = "", ...args] = commandFor(t);
  logBuffers.set(t.id, "");
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: t.keepRunning });
  processes.set(t.id, child);
  delete t.error;
  if (t.provider !== "cloudflare-named")
    delete t.url;
  let done = false;
  let resolveStartup;
  let rejectStartup;
  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      resolveStartup();
    }
  }, 1800);
  const finishStartup = (err) => {
    if (done)
      return;
    done = true;
    clearTimeout(timer);
    if (err)
      rejectStartup(err);
    else
      resolveStartup();
  };
  const onChunk = (chunk) => {
    record(t, chunk.toString());
    if (t.url)
      finishStartup();
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("error", (error) => {
    t.error = error.message;
    delete t.pid;
    processes.delete(t.id);
    locked(save);
    finishStartup(error);
  });
  child.on("exit", (code) => {
    if (t.pid === child.pid) {
      delete t.pid;
      delete t.startedAt;
      if (code)
        t.error = `Tunnel exited with code ${code}. ${redact(logBuffers.get(t.id) || "").slice(-500)}`;
      locked(save);
    }
    processes.delete(t.id);
    finishStartup(new Error(t.error || "Tunnel exited right after starting."));
  });
  if (!child.pid) {
    const err = new Error("Could not launch the tunnel CLI.");
    finishStartup(err);
    throw err;
  }
  t.pid = child.pid;
  t.startedAt = new Date().toISOString();
  await save();
  await startup;
  if (t.keepRunning && running(t))
    child.unref();
}
async function stop(t) {
  if (running(t)) {
    try {
      process.kill(t.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH")
        throw error;
    }
  }
  delete t.pid;
  delete t.startedAt;
  if (t.provider === "cloudflare-quick" || t.provider === "microsoft")
    delete t.url;
  await save();
}
function get(id) {
  const t = tunnels.find((item) => item.id === id);
  if (!t)
    throw new Error("Tunnel not found. Refresh the list.");
  return t;
}
async function route(method, pathname, body) {
  if (method === "GET" && pathname === "/health")
    return { ok: true };
  if (method === "GET" && pathname === "/tunnels") {
    const status = await providerStatus();
    return {
      tunnels: tunnels.map((t) => ({ ...t, pid: running(t) ? t.pid : undefined })),
      cli: status.cli,
      platform: status.platform,
      providers: status.providers
    };
  }
  if (method === "GET" && pathname === "/status") {
    const rows = tunnels.slice(0, 15).map((t) => ({ kind: "line", id: t.id, label: t.name, dot: running(t) ? "success" : t.error ? "error" : "muted", value: `${running(t) ? "Running" : "Stopped"} · ${t.port}${t.url ? " · " + t.url : ""}`, actions: [{ kind: "button", id: running(t) ? "stop" : "start", label: running(t) ? "Stop" : "Start", variant: "outline" }] }));
    return { rows: rows.length ? rows : [{ kind: "note", id: "empty", text: "No tunnels yet. Open Tunnels to create one." }] };
  }
  if (method === "POST" && pathname === "/status") {
    const t = get(typeof body.id === "string" ? body.id : typeof body.value === "string" && tunnels.some((item) => item.id === body.value) ? body.value : body.id);
    const action = body.value || body.action || (running(t) ? "stop" : "start");
    if (action === "stop")
      await stop(t);
    else if (action === "start")
      await start(t);
    else
      throw new Error("Unknown action.");
    return { ok: true };
  }
  if (method === "POST" && pathname === "/login") {
    if (body.provider !== "cloudflare" && body.provider !== "microsoft")
      throw new Error("Choose a provider.");
    if (body.method !== undefined && body.method !== "entra" && body.method !== "github")
      throw new Error("Choose Microsoft or GitHub.");
    return login(body.provider, body.method === "github" ? "github" : "entra");
  }
  if (method === "POST" && pathname === "/login/cancel") {
    if (body.provider !== "cloudflare" && body.provider !== "microsoft")
      throw new Error("Choose a provider.");
    return cancelLogin(body.provider);
  }
  if (method === "POST" && pathname === "/logout") {
    if (body.provider !== "microsoft")
      throw new Error("Only Microsoft CLI sign-out is supported here.");
    await run("devtunnel", ["user", "logout"], 1e4);
    logins.delete("microsoft");
    return { ok: true };
  }
  if (method === "GET" && pathname === "/login") {
    return {
      login: Object.fromEntries([...logins].map(([key, value]) => [
        key,
        {
          output: redact(value.output),
          finished: value.finished,
          exitCode: value.exitCode,
          ...value.method ? { method: value.method } : {}
        }
      ]))
    };
  }
  if (method === "POST" && pathname === "/tunnels") {
    const t = parseTunnel(body);
    t.id = randomUUID();
    tunnels.push(t);
    await save();
    return { tunnel: t };
  }
  if (method === "PUT" && pathname === "/tunnels") {
    const old = get(body.id);
    if (running(old))
      throw new Error("Stop the tunnel before editing it.");
    const changed = parseTunnel(body);
    if (old.provider !== changed.provider || old.hostname !== changed.hostname || old.provider === "cloudflare-named" && old.name !== changed.name)
      throw new Error("Create a new tunnel to change provider, Cloudflare name, or hostname.");
    if (old.provider === "microsoft" && old.providerId && old.public && !changed.public) {
      await run("devtunnel", ["access", "reset", old.providerId], 15000);
    }
    Object.assign(old, { name: changed.name, port: changed.port, protocol: changed.protocol, public: changed.public, keepRunning: changed.keepRunning });
    await save();
    return { tunnel: old };
  }
  if (method === "DELETE" && pathname === "/tunnels") {
    const t = get(body.id);
    await stop(t);
    tunnels = tunnels.filter((item) => item.id !== t.id);
    await save();
    return { ok: true, note: "Local entry removed. Provider resources were not deleted." };
  }
  if (method === "POST" && (pathname === "/start" || pathname === "/stop")) {
    const t = get(body.id);
    if (pathname === "/start")
      await start(t);
    else
      await stop(t);
    return { tunnel: t };
  }
  if (method === "POST" && pathname === "/ports") {
    const t = get(body.id);
    if (t.provider !== "microsoft" || !t.providerId)
      throw new Error("Start a Microsoft tunnel before editing its ports.");
    if (running(t))
      throw new Error("Stop the tunnel before changing its ports.");
    if (!isPort(body.port))
      throw new Error("Enter a valid port.");
    if (body.action !== "add" && body.action !== "remove")
      throw new Error("Choose add or remove.");
    await run("devtunnel", ["port", body.action === "add" ? "create" : "delete", t.providerId, "-p", String(body.port), "--json", ...body.action === "add" ? ["--protocol", body.protocol === "https" ? "https" : "http"] : []], 30000);
    return { ok: true };
  }
  if (method === "GET" && pathname === "/ports") {
    const t = get(body.id);
    if (t.provider !== "microsoft" || !t.providerId)
      return { ports: [] };
    const output = await run("devtunnel", ["port", "list", t.providerId, "--json"], 15000);
    return { ports: outputJson(output) };
  }
  if (method === "GET" && pathname === "/logs") {
    const t = get(body.id);
    return { output: redact(logBuffers.get(t.id) || ""), lastError: t.error || "" };
  }
  return null;
}
await load();
http.createServer((req, res) => {
  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  let input = "";
  req.on("data", (chunk) => {
    input += chunk;
    if (input.length > 16384)
      req.destroy();
  });
  req.on("end", () => {
    let body;
    try {
      body = input ? JSON.parse(input) : {};
    } catch {
      res.writeHead(400).end('{"error":"Invalid JSON."}');
      return;
    }
    if (req.method === "GET" && url.searchParams.has("id"))
      body.id = url.searchParams.get("id");
    locked(() => route(req.method || "GET", url.pathname, body)).then((answer) => {
      res.writeHead(answer ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(answer || { error: "Not found." }));
    }, (error) => {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: redact(error.message) }));
    });
  });
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), "127.0.0.1");
process.on("SIGTERM", () => {
  for (const t of tunnels)
    if (!t.keepRunning && running(t)) {
      try {
        process.kill(t.pid, "SIGTERM");
      } catch {}
    }
  process.exit(0);
});
