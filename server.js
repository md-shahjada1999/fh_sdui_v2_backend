const express = require("express");
const cors = require("cors");
const chokidar = require("chokidar");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 5000;
const SCREENS_DIR = path.join(__dirname, "data", "screens");
const BASE_VERSION = "1.0.0";

app.use(cors());

// ── Manifest state ──────────────────────────────────────────────────────────

const manifest = {
  version: BASE_VERSION,
  registry: {},
  screens: {},
  apis: {},
};

function getHost() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

const HOST = getHost();

function hashFile(buffer) {
  return "sha256:" + crypto.createHash("sha256").update(buffer).digest("base64");
}

function screenKey(filename) {
  return path.basename(filename, ".json");
}

function addScreenToManifest(filePath) {
  const buf = fs.readFileSync(filePath);
  const key = screenKey(filePath);
  manifest.screens[key] = {
    path: `http://${HOST}:${PORT}/screens/${key}`,
    hash: hashFile(buf),
    size: buf.length,
  };
}

function removeScreenFromManifest(filePath) {
  delete manifest.screens[screenKey(filePath)];
}

function bumpVersion() {
  manifest.version = `${BASE_VERSION}-${Math.floor(Date.now() / 1000)}`;
}

// ── Initial scan ────────────────────────────────────────────────────────────

fs.mkdirSync(SCREENS_DIR, { recursive: true });

const files = fs.readdirSync(SCREENS_DIR).filter((f) => f.endsWith(".json"));
for (const file of files) {
  addScreenToManifest(path.join(SCREENS_DIR, file));
}

console.log(
  `[manifest] Loaded ${files.length} screen(s): ${files.map(screenKey).join(", ") || "(none yet)"}`
);

// ── File watcher ────────────────────────────────────────────────────────────

const watcher = chokidar.watch(SCREENS_DIR, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
});

watcher
  .on("add", (fp) => {
    addScreenToManifest(fp);
    bumpVersion();
    console.log(`[manifest] ${path.basename(fp)} added — hash updated, version bumped → ${manifest.version}`);
  })
  .on("change", (fp) => {
    addScreenToManifest(fp);
    bumpVersion();
    console.log(`[manifest] ${path.basename(fp)} changed — hash updated, version bumped → ${manifest.version}`);
  })
  .on("unlink", (fp) => {
    removeScreenFromManifest(fp);
    bumpVersion();
    console.log(`[manifest] ${path.basename(fp)} removed — version bumped → ${manifest.version}`);
  });

// ── Routes ──────────────────────────────────────────────────────────────────

app.get("/manifest.json", (_req, res) => {
  res.json(manifest);
});

app.get("/screens/:screenId", (req, res) => {
  const filePath = path.join(SCREENS_DIR, `${req.params.screenId}.json`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Screen "${req.params.screenId}" not found` });
  }

  res.setHeader("Content-Type", "application/json");
  fs.createReadStream(filePath).pipe(res);
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  SDUI Mock Backend running`);
  console.log(`  ─────────────────────────`);
  console.log(`  Manifest : http://${HOST}:${PORT}/manifest.json`);
  console.log(`  Screens  : http://${HOST}:${PORT}/screens/:id`);
  console.log(`  Watching : ${SCREENS_DIR}\n`);
});
