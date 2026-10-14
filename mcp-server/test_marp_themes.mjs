// create_marp lets the user choose the deck's theme. Stands up a fake mdnest
// backend with a central theme catalog and drives the real MCP server over
// HTTP: list_marp_themes offers the catalog with each theme's classes,
// create_marp without a theme asks for one (and creates nothing), an unknown
// theme is refused, a chosen one lands in the note. Without a catalog the
// theme still defaults to `default`.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const BACKEND_PORT = 8293;
const MCP_PORT = 3192;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

let catalogOn = true;
const created = []; // {path, body}
const backend = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authMode: "single", marp: true }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/marp/themes") {
    if (!catalogOn) { res.writeHead(404); res.end("404 page not found"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([
      { name: "brand", css: "/* @theme brand */\n@import 'gaia';\nsection.cover { color: red; }\nsection.dark {}" },
      { name: "minimal", css: "/* @theme minimal */\nsection { padding: 0; }" },
    ]));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/note") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      created.push({ path: url.searchParams.get("path"), body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "created" }));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end("{}");
});

let id = 0;
async function rpc(method, params) {
  const r = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await r.text();
  const jsonStr = text.includes("data:") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : text;
  return JSON.parse(jsonStr).result;
}
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { isError: !!r?.isError, text: (r?.content || []).map((c) => c.text).join("\n") };
};

async function run() {
  const tools = (await rpc("tools/list", {})).tools;
  const create = tools.find((t) => t.name === "create_marp");
  ok("list_marp_themes is offered", tools.some((t) => t.name === "list_marp_themes"));
  ok("create_marp tells the agent to ask the user", /ASK THE USER/.test(create?.description || ""));

  const list = await call("list_marp_themes", {});
  ok("list shows the central themes first", !list.isError && /^Central themes .*brand.*minimal/m.test(list.text), list.text.split("\n")[0]);
  ok("a central theme lists its own and its imported classes", /brand \(classes: invert, gaia, lead, cover, dark\)/.test(list.text));
  ok("built-in themes are listed too", /Built-in themes: default \(classes: invert\); gaia/.test(list.text));

  const noTheme = await call("create_marp", { namespace: "ns", path: "deck" });
  ok("no theme with a catalog: asks to choose", noTheme.isError && /Ask the user which theme/.test(noTheme.text) && /brand/.test(noTheme.text), noTheme.text.split("\n")[0]);
  ok("no theme with a catalog: nothing created", created.length === 0);

  const unknown = await call("create_marp", { namespace: "ns", path: "deck", theme: "brnad" });
  ok("unknown theme is refused", unknown.isError && /Unknown theme "brnad"/.test(unknown.text));
  ok("unknown theme: nothing created", created.length === 0);

  const chosen = await call("create_marp", { namespace: "ns", path: "deck", theme: "brand", class: "dark" });
  ok("chosen central theme creates the deck", !chosen.isError && /theme: brand/.test(chosen.text), chosen.text.split("\n")[0]);
  ok("the note carries the chosen theme", created.length === 1 && created[0].path === "deck.md" && created[0].body.includes("theme: brand\nclass: dark\n"));

  const builtin = await call("create_marp", { namespace: "ns", path: "plain", theme: "default" });
  ok("a built-in theme can still be chosen", !builtin.isError && created[1]?.body.includes("theme: default\n"));

  catalogOn = false;
  const noCatalog = await call("create_marp", { namespace: "ns", path: "legacy" });
  ok("no catalog: theme still defaults to default", !noCatalog.isError && created[2]?.body.includes("theme: default\n"), noCatalog.text.split("\n")[0]);
}

backend.listen(BACKEND_PORT, "127.0.0.1", () => {
  const child = spawn("node", ["index.js"], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_HTTP_PORT: String(MCP_PORT),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_AUTH_MODE: "bearer",
      MDNEST_TOKEN: TOKEN,
      MDNEST_URL: `http://127.0.0.1:${BACKEND_PORT}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const done = async () => {
    try { await run(); } catch (e) { console.log("FAIL  harness error ->", e.message); failed++; }
    child.kill("SIGKILL");
    backend.close();
    console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  };
  setTimeout(done, 900);
});
