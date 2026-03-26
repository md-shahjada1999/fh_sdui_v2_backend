const express = require("express");
const cors = require("cors");
const chokidar = require("chokidar");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 5050;
const DATA_DIR = path.join(__dirname, "data");
const SCREENS_DIR = path.join(DATA_DIR, "screens");
const REGISTRY_DIR = path.join(DATA_DIR, "registry");
const TOKENS_DIR = path.join(REGISTRY_DIR, "tokens");
const STYLES_DIR = path.join(REGISTRY_DIR, "styles");
const COMPONENTS_DIR = path.join(REGISTRY_DIR, "components");
const BASE_VERSION = "1.0.0";

app.use(cors());
app.use(express.json());

// ── In-memory OTP store ─────────────────────────────────────────────────────

const otpStore = new Map();
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const MOCK_OTP = "123456";

function generateOtp() {
  return MOCK_OTP;
}

// ── Network host ────────────────────────────────────────────────────────────

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

// ── Manifest (V3 grouped structure) ──────────────────────────────────────────

const manifest = {
  version: BASE_VERSION,
  tokens: {},
  styles: {},
  components: {},
  screens: {},
};

function hashFile(buffer) {
  return "sha256:" + crypto.createHash("sha256").update(buffer).digest("base64");
}

function fileKey(filePath) {
  return path.basename(filePath, ".json");
}

function categoryForFile(filePath) {
  if (filePath.startsWith(TOKENS_DIR)) return "tokens";
  if (filePath.startsWith(STYLES_DIR)) return "styles";
  if (filePath.startsWith(COMPONENTS_DIR)) return "components";
  if (filePath.startsWith(SCREENS_DIR)) return "screens";
  return null;
}

function addEntry(filePath, urlPath, category) {
  const buf = fs.readFileSync(filePath);
  const key = fileKey(filePath);
  manifest[category][key] = {
    path: `http://${HOST}:${PORT}${urlPath}/${key}`,
    hash: hashFile(buf),
  };
}

function removeEntry(filePath, category) {
  delete manifest[category][fileKey(filePath)];
}

function bumpVersion() {
  manifest.version = `${BASE_VERSION}-${Math.floor(Date.now() / 1000)}`;
}

function isRegistryFile(filePath) {
  return filePath.startsWith(REGISTRY_DIR);
}

// ── Scan helpers ────────────────────────────────────────────────────────────

function scanDir(dir, urlPath, category) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    addEntry(path.join(dir, file), urlPath, category);
  }
  return files;
}

// ── Initial scan ────────────────────────────────────────────────────────────

[SCREENS_DIR, TOKENS_DIR, STYLES_DIR, COMPONENTS_DIR].forEach((d) =>
  fs.mkdirSync(d, { recursive: true })
);

const tokenFiles = scanDir(TOKENS_DIR, "/registry/tokens", "tokens");
const styleFiles = scanDir(STYLES_DIR, "/registry/styles", "styles");
const componentFiles = scanDir(COMPONENTS_DIR, "/registry/components", "components");
const screenFiles = scanDir(SCREENS_DIR, "/screens", "screens");

console.log(
  `[manifest] Loaded ${tokenFiles.length} token(s), ${styleFiles.length} style(s), ${componentFiles.length} component(s), ${screenFiles.length} screen(s)`
);

// ── File watcher ────────────────────────────────────────────────────────────

function urlPathForFile(filePath) {
  if (filePath.startsWith(TOKENS_DIR)) return "/registry/tokens";
  if (filePath.startsWith(STYLES_DIR)) return "/registry/styles";
  if (filePath.startsWith(COMPONENTS_DIR)) return "/registry/components";
  if (filePath.startsWith(SCREENS_DIR)) return "/screens";
  return null;
}

const watcher = chokidar.watch([REGISTRY_DIR, SCREENS_DIR], {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
});

watcher
  .on("add", (fp) => {
    const urlPath = urlPathForFile(fp);
    const category = categoryForFile(fp);
    if (!urlPath || !category) return;
    addEntry(fp, urlPath, category);
    if (isRegistryFile(fp)) bumpVersion();
    console.log(`[manifest] ${category}/${path.basename(fp)} added — hash updated${isRegistryFile(fp) ? ", version bumped → " + manifest.version : ""}`);
  })
  .on("change", (fp) => {
    const urlPath = urlPathForFile(fp);
    const category = categoryForFile(fp);
    if (!urlPath || !category) return;
    addEntry(fp, urlPath, category);
    if (isRegistryFile(fp)) bumpVersion();
    console.log(`[manifest] ${category}/${path.basename(fp)} changed — hash updated${isRegistryFile(fp) ? ", version bumped → " + manifest.version : ""}`);
  })
  .on("unlink", (fp) => {
    const category = categoryForFile(fp);
    if (!category) return;
    removeEntry(fp, category);
    if (isRegistryFile(fp)) bumpVersion();
    console.log(`[manifest] ${category}/${path.basename(fp)} removed${isRegistryFile(fp) ? " — version bumped → " + manifest.version : ""}`);
  });

// ── Routes: Manifest ────────────────────────────────────────────────────────

app.get("/manifest.json", (_req, res) => {
  res.json(manifest);
});

// ── Routes: Registry ────────────────────────────────────────────────────────

function serveJsonFile(dir) {
  return (req, res) => {
    const filePath = path.join(dir, `${req.params.name}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `"${req.params.name}" not found` });
    }
    res.setHeader("Content-Type", "application/json");
    fs.createReadStream(filePath).pipe(res);
  };
}

app.get("/registry/tokens/:name", serveJsonFile(TOKENS_DIR));
app.get("/registry/styles/:name", serveJsonFile(STYLES_DIR));
app.get("/registry/components/:name", serveJsonFile(COMPONENTS_DIR));

// ── Routes: Screens ─────────────────────────────────────────────────────────

app.get("/screens/:screenId", (req, res) => {
  const filePath = path.join(SCREENS_DIR, `${req.params.screenId}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Screen "${req.params.screenId}" not found` });
  }
  res.setHeader("Content-Type", "application/json");
  fs.createReadStream(filePath).pipe(res);
});

// ── Auth APIs ───────────────────────────────────────────────────────────────

app.post("/api/auth/send-otp", (req, res) => {
  const { mobile } = req.body;

  if (!mobile || mobile.length < 10) {
    return res.status(400).json({ success: false, message: "Valid mobile number is required" });
  }

  const otp = generateOtp();
  otpStore.set(mobile, { otp, expiresAt: Date.now() + OTP_EXPIRY_MS });

  console.log(`[auth] OTP for ${mobile}: ${otp}`);

  res.json({
    success: true,
    message: "OTP sent successfully",
    data: { mobile, expiresInSeconds: OTP_EXPIRY_MS / 1000 },
  });
});

app.post("/api/auth/verify-otp", (req, res) => {
  const { mobile, otp } = req.body;

  if (!mobile || !otp) {
    return res.status(400).json({ success: false, message: "mobile and otp are required" });
  }

  const record = otpStore.get(mobile);

  if (!record) {
    return res.status(400).json({ success: false, message: "No OTP requested for this number" });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(mobile);
    return res.status(400).json({ success: false, message: "OTP expired, please resend" });
  }

  if (record.otp !== otp) {
    return res.status(401).json({ success: false, message: "Invalid OTP" });
  }

  otpStore.delete(mobile);

  const token = Buffer.from(JSON.stringify({ mobile, iat: Date.now() })).toString("base64");

  console.log(`[auth] ${mobile} verified successfully`);

  res.json({
    success: true,
    message: "OTP verified",
    data: {
      token: `mock.${token}`,
      user: { mobile, name: "FH User", isNewUser: false },
    },
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  SDUI V3 Mock Backend running`);
  console.log(`  ────────────────────────────`);
  console.log(`  Manifest     : http://${HOST}:${PORT}/manifest.json`);
  console.log(`  Tokens       : http://${HOST}:${PORT}/registry/tokens/:name`);
  console.log(`  Styles       : http://${HOST}:${PORT}/registry/styles/:name`);
  console.log(`  Components   : http://${HOST}:${PORT}/registry/components/:name`);
  console.log(`  Screens      : http://${HOST}:${PORT}/screens/:id`);
  console.log(`  Send OTP     : POST http://${HOST}:${PORT}/api/auth/send-otp`);
  console.log(`  Verify OTP   : POST http://${HOST}:${PORT}/api/auth/verify-otp`);
  console.log(`  Mock OTP     : ${MOCK_OTP}`);
  console.log(`  Watching     : ${DATA_DIR}\n`);
});
