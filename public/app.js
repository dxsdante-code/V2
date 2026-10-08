const $ = id => document.getElementById(id);

const urlInput = $("url");
const analyzeBtn = $("analyzeBtn");
const downloadBtn = $("downloadBtn");
const batchBtn = $("batchBtn");
const format = $("format");
const quality = $("quality");
const message = $("message");
const preview = $("preview");
const jobsBox = $("jobs");
const queueCount = $("queueCount");
const jobs = new Map();

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function setMessage(text, type="") {
  message.textContent = text;
  message.className = `message ${type}`;
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
}

async function analyze() {
  const url = urlInput.value.trim();
  if (!url) return setMessage("Pega primero una URL.", "error");

  analyzeBtn.disabled = true;
  setMessage("Analizando enlace...");

  try {
    const r = await fetch("/api/analyze", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({url})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "No se pudo analizar.");

    $("title").textContent = data.title || "Sin título";
    $("meta").textContent = [data.uploader, formatDuration(data.duration)].filter(Boolean).join(" • ");
    if (data.thumbnail) {
      $("thumb").src = data.thumbnail;
      $("thumb").alt = data.title || "";
    }
    preview.classList.remove("hidden");
    setMessage("Enlace válido. Ya puedes descargar.");
  } catch (e) {
    preview.classList.add("hidden");
    setMessage(e.message, "error");
  } finally {
    analyzeBtn.disabled = false;
  }
}

async function startDownload(url) {
  const r = await fetch("/api/download", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({url, format:format.value, quality:quality.value})
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "No se pudo iniciar.");
  addOrUpdateJob(data.job);
  poll(data.job.id);
}

async function downloadOne() {
  const url = urlInput.value.trim();
  if (!url) return setMessage("Pega primero una URL.", "error");

  downloadBtn.disabled = true;
  setMessage("Agregando a la cola...");

  try {
    await startDownload(url);
    setMessage("Descarga agregada a la cola.");
  } catch (e) {
    setMessage(e.message, "error");
  } finally {
    downloadBtn.disabled = false;
  }
}

async function downloadBatch() {
  const urls = $("batchUrls").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if (!urls.length) return setMessage("Agrega al menos una URL en el lote.", "error");

  batchBtn.disabled = true;
  try {
    const r = await fetch("/api/download-batch", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({urls, format:format.value, quality:quality.value})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "No se pudo procesar el lote.");

    data.jobs.forEach(job => {
      addOrUpdateJob(job);
      poll(job.id);
    });
    setMessage(`${data.jobs.length} trabajo(s) agregado(s) a la cola.`);
  } catch (e) {
    setMessage(e.message, "error");
  } finally {
    batchBtn.disabled = false;
  }
}

function statusText(job) {
  return ({
    queued:"En cola",
    downloading:"Descargando",
    completed:"Completado",
    error:"Error"
  })[job.status] || job.status;
}

function addOrUpdateJob(job) {
  jobs.set(job.id, job);
  renderJobs();
}

function renderJobs() {
  const list = [...jobs.values()].sort((a,b)=>b.createdAt-a.createdAt);
  queueCount.textContent = list.filter(j=>j.status==="queued" || j.status==="downloading").length;

  if (!list.length) {
    jobsBox.className = "jobs empty";
    jobsBox.textContent = "Todavía no hay trabajos.";
    return;
  }

  jobsBox.className = "jobs";
  jobsBox.innerHTML = list.map(job => {
    const title = job.title || job.filename || job.url;
    const stateClass = job.status === "error" ? "error" : job.status === "completed" ? "done" : "";
    return `<article class="job">
      <div class="job-top">
        <div class="job-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="status ${stateClass}">${escapeHtml(statusText(job))}</div>
      </div>
      <div class="bar"><i style="width:${Number(job.progress)||0}%"></i></div>
      <div class="job-meta">
        <span>${Math.round(Number(job.progress)||0)}%</span>
        <span>${escapeHtml(job.speed || job.eta || "")}</span>
      </div>
      ${job.status==="completed" ? `<a href="${job.downloadUrl}">⬇ Descargar archivo</a>` : ""}
      ${job.status==="error" ? `<div class="message error">${escapeHtml(job.error)}</div>` : ""}
    </article>`;
  }).join("");
}

async function poll(id) {
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
    if (!r.ok) return;
    const data = await r.json();
    addOrUpdateJob(data.job);

    if (data.job.status === "queued" || data.job.status === "downloading") {
      setTimeout(() => poll(id), 1500);
    }
  } catch {
    setTimeout(() => poll(id), 2500);
  }
}

analyzeBtn.addEventListener("click", analyze);
downloadBtn.addEventListener("click", downloadOne);
batchBtn.addEventListener("click", downloadBatch);

urlInput.addEventListener("keydown", e => {
  if (e.key === "Enter") analyze();
});

renderJobs();
