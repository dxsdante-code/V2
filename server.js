const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

// Cookies de YouTube (opcional): Secret File /etc/secrets/cookies.txt o variable YT_COOKIES
const fs_ck = require("fs");
const os_ck = require("os");
const path_ck = require("path");
let COOKIES_FILE = null;
try {
  const src = fs_ck.existsSync("/etc/secrets/cookies.txt") ? "/etc/secrets/cookies.txt" : null;
  const dest = path_ck.join(os_ck.tmpdir(), "yt-cookies.txt");
  if (src) fs_ck.copyFileSync(src, dest);
  else if (process.env.YT_COOKIES) fs_ck.writeFileSync(dest, process.env.YT_COOKIES);
  if (src || process.env.YT_COOKIES) COOKIES_FILE = dest;
} catch (e) { console.error("No se pudieron cargar cookies:", e.message); }
const COOKIE_ARGS = COOKIES_FILE ? ["--cookies", COOKIES_FILE] : [];
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 2));
const JOB_TTL_MS = Math.max(60000, Number(process.env.JOB_TTL_MS || 15 * 60 * 1000));
const MAX_URLS_PER_BATCH = Math.min(25, Math.max(1, Number(process.env.MAX_URLS_PER_BATCH || 10)));

const DOWNLOAD_DIR = process.env.RENDER_FS
  ? path.join(process.env.RENDER_FS, "yt-dlp-downloads-v2")
  : path.join(__dirname, "downloads");

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const jobs = new Map();
const queue = [];
let activeJobs = 0;

const FORMATS = new Set(["mp3", "m4a", "wav", "opus", "vorbis"]);
const QUALITIES = new Set(["0", "9", "5", "2"]);

function isAllowedUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host);
  } catch {
    return false;
  }
}

function cleanError(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-4000);
}

function createJob(data) {
  const id = crypto.randomUUID();
  const job = {
    id,
    url: data.url,
    format: data.format || "mp3",
    quality: data.quality || "0",
    status: "queued",
    progress: 0,
    speed: "",
    eta: "",
    title: "",
    filename: "",
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  jobs.set(id, job);
  queue.push(id);
  pumpQueue();
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

function pumpQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== "queued") continue;
    activeJobs++;
    runDownload(job).finally(() => {
      activeJobs--;
      pumpQueue();
    });
  }
}

function parseProgress(line) {
  const percent = line.match(/(\d+(?:\.\d+)?)%/);
  const speed = line.match(/at\s+([^\s]+\/s)/);
  const eta = line.match(/ETA\s+([0-9:]+)/);
  return {
    progress: percent ? Math.max(0, Math.min(100, Number(percent[1]))) : undefined,
    speed: speed ? speed[1] : undefined,
    eta: eta ? eta[1] : undefined
  };
}

async function runDownload(job) {
  updateJob(job, { status: "downloading", progress: 0 });

  const outputTemplate = path.join(DOWNLOAD_DIR, `${job.id}-%(title)s.%(ext)s`);
  const args = [
    "--no-playlist",
    ...COOKIE_ARGS,
    "--no-warnings",
    "--newline",
    "--progress",
    "--restrict-filenames",
    "-x",
    "--audio-format", job.format,
    "--audio-quality", job.quality,
    "-o", outputTemplate,
    "--print", "after_move:filepath",
    job.url
  ];

  return new Promise((resolve) => {
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let printedPath = "";

    const onLine = (raw) => {
      const line = raw.toString().trim();
      if (!line) return;

      if (line.startsWith("[download]")) {
        const p = parseProgress(line);
        updateJob(job, {
          ...(p.progress !== undefined ? { progress: p.progress } : {}),
          ...(p.speed ? { speed: p.speed } : {}),
          ...(p.eta ? { eta: p.eta } : {})
        });
      }

      if (line.startsWith("[ExtractAudio]") || line.startsWith("[Merger]")) {
        updateJob(job, { progress: Math.max(job.progress, 99) });
      }

      if (line.includes("/") || line.includes("\\")) {
        if (line.endsWith("." + job.format) || line.includes(DOWNLOAD_DIR)) {
          printedPath = line;
        }
      }

      const title = line.match(/^\[youtube\]\s+(.+)$/);
      if (title && !job.title) updateJob(job, { title: title[1] });
    };

    proc.stdout.on("data", onLine);
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      onLine(chunk);
    });

    proc.on("error", (err) => {
      updateJob(job, { status: "error", error: cleanError(err.message) });
      resolve();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        updateJob(job, {
          status: "error",
          error: cleanError(stderr) || "yt-dlp terminó con un error."
        });
        return resolve();
      }

      let filePath = printedPath && fs.existsSync(printedPath) ? printedPath : null;

      if (!filePath) {
        const candidates = fs.readdirSync(DOWNLOAD_DIR)
          .filter(name => name.startsWith(job.id + "-"))
          .map(name => path.join(DOWNLOAD_DIR, name))
          .filter(p => fs.existsSync(p));
        filePath = candidates[0] || null;
      }

      if (!filePath) {
        updateJob(job, { status: "error", error: "No se encontró el archivo generado." });
        return resolve();
      }

      updateJob(job, {
        status: "completed",
        progress: 100,
        filename: path.basename(filePath),
        filePath
      });
      resolve();
    });
  });
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    format: job.format,
    quality: job.quality,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    title: job.title,
    filename: job.filename,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    downloadUrl: job.status === "completed" ? `/api/download/${job.id}` : null
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "2.0.0",
    activeJobs,
    queuedJobs: queue.length
  });
});

app.post("/api/analyze", async (req, res) => {
  const url = String(req.body?.url || "").trim();

  if (!isAllowedUrl(url)) {
    return res.status(400).json({ error: "Introduce una URL válida de YouTube." });
  }

  const args = [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    ...COOKIE_ARGS,
    "--no-warnings",
    url
  ];

  const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";

  proc.stdout.on("data", d => out += d.toString());
  proc.stderr.on("data", d => err += d.toString());

  proc.on("error", e => res.status(500).json({ error: e.message }));
  proc.on("close", code => {
    if (code !== 0) {
      return res.status(422).json({
        error: cleanError(err) || "No se pudo analizar el enlace."
      });
    }

    try {
      const data = JSON.parse(out);
      res.json({
        id: data.id || "",
        title: data.title || "Sin título",
        uploader: data.uploader || data.channel || "",
        duration: data.duration || 0,
        thumbnail: data.thumbnail || "",
        webpageUrl: data.webpage_url || url
      });
    } catch {
      res.status(500).json({ error: "Respuesta inválida de yt-dlp." });
    }
  });
});

app.post("/api/download", (req, res) => {
  const url = String(req.body?.url || "").trim();
  const format = String(req.body?.format || "mp3").toLowerCase();
  const quality = String(req.body?.quality || "0");

  if (!isAllowedUrl(url)) return res.status(400).json({ error: "URL de YouTube no válida." });
  if (!FORMATS.has(format)) return res.status(400).json({ error: "Formato no permitido." });
  if (!QUALITIES.has(quality)) return res.status(400).json({ error: "Calidad no permitida." });

  const job = createJob({ url, format, quality });
  res.status(202).json({ job: publicJob(job) });
});

app.post("/api/download-batch", (req, res) => {
  const urls = Array.isArray(req.body?.urls)
    ? req.body.urls.map(v => String(v).trim()).filter(Boolean)
    : [];

  const format = String(req.body?.format || "mp3").toLowerCase();
  const quality = String(req.body?.quality || "0");

  if (!FORMATS.has(format)) return res.status(400).json({ error: "Formato no permitido." });
  if (!QUALITIES.has(quality)) return res.status(400).json({ error: "Calidad no permitida." });
  if (!urls.length) return res.status(400).json({ error: "No se recibieron URLs." });
  if (urls.length > MAX_URLS_PER_BATCH) {
    return res.status(400).json({ error: `Máximo ${MAX_URLS_PER_BATCH} URLs por lote.` });
  }

  const invalid = urls.filter(url => !isAllowedUrl(url));
  if (invalid.length) return res.status(400).json({ error: "Una o más URLs no son de YouTube." });

  const created = urls.map(url => createJob({ url, format, quality }));
  res.status(202).json({ jobs: created.map(publicJob) });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });
  res.json({ job: publicJob(job) });
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });
  if (job.filePath && fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
  jobs.delete(job.id);
  res.json({ ok: true });
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "completed" || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).send("Archivo no disponible.");
  }

  res.download(job.filePath, job.filename, err => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [id, job] of jobs) {
    if (now - job.updatedAt < JOB_TTL_MS) continue;

    if (job.filePath && fs.existsSync(job.filePath)) {
      try { fs.unlinkSync(job.filePath); } catch {}
    }

    jobs.delete(id);
  }

  try {
    for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
      const file = path.join(DOWNLOAD_DIR, name);
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > JOB_TTL_MS) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  } catch {}
}, 60000);

app.listen(PORT, () => {
  console.log(`YouTube Music Downloader V2 escuchando en puerto ${PORT}`);
});
