const express = require("express");
const cors = require("cors");
const chokidar = require("chokidar");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 5050;
const SCREENS_DIR = path.join(__dirname, "data", "screens");
const BASE_VERSION = "1.0.0";

app.use(cors());
app.use(express.json());

// ── In-memory OTP store ─────────────────────────────────────────────────────

const otpStore = new Map(); // mobile → { otp, expiresAt }
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MOCK_OTP = "123456";

function generateOtp() {
  return MOCK_OTP; // fixed for easy testing; swap with random if needed
}

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

  // Mock JWT-like token
  const token = Buffer.from(JSON.stringify({ mobile, iat: Date.now() })).toString("base64");

  console.log(`[auth] ${mobile} verified successfully`);
// console.log(token);
console.log(`mock.${token}`);
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
  console.log(`\n  SDUI Mock Backend running`);
  console.log(`  ─────────────────────────`);
  console.log(`  Manifest  : http://${HOST}:${PORT}/manifest.json`);
  console.log(`  Screens   : http://${HOST}:${PORT}/screens/:id`);
  console.log(`  Send OTP  : POST http://${HOST}:${PORT}/api/auth/send-otp`);
  console.log(`  Verify OTP: POST http://${HOST}:${PORT}/api/auth/verify-otp`);
  console.log(`  Mock OTP  : ${MOCK_OTP}`);
  console.log(`  Watching  : ${SCREENS_DIR}\n`);
});
