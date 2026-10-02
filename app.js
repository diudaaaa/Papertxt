import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const $ = (selector) => document.querySelector(selector);
const input = $("#fileInput");
const zone = $("#dropZone");
const queue = $("#queue");
const empty = $("#empty");
const count = $("#pageCount");
const summary = $("#summary");
const recognizeButton = $("#recognize");
const output = $("#output");
const status = $("#status");
const chars = $("#chars");
const progress = $("#progress");
const bar = $("#bar");
const progressText = $("#progressText");
const copyButton = $("#copy");
const downloadButton = $("#download");

const MAX_PREVIEW_PAGES = 48;
const OCR_MAX_PIXELS = 5600000;
let pages = [];
let busy = false;
let worker = null;

function setStatus(message) {
  status.textContent = message;
}

function updateChars() {
  chars.textContent = `${output.value.length} 字`;
  copyButton.disabled = !output.value;
  downloadButton.disabled = !output.value;
}

function setProgress(value, message) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  bar.style.width = `${percent}%`;
  progressText.textContent = message;
}

function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function imageDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function renderPdfPage(pdf, pageNumber, scale) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const requestedPixels = baseViewport.width * baseViewport.height * scale * scale;
  const safeScale = requestedPixels > OCR_MAX_PIXELS
    ? scale * Math.sqrt(OCR_MAX_PIXELS / requestedPixels)
    : scale;
  const viewport = page.getViewport({ scale: safeScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  page.cleanup();
  return canvas;
}

async function createPdfPages(file) {
  const loadingTask = pdfjsLib.getDocument({
    data: await file.arrayBuffer(),
    disableAutoFetch: false,
    disableStream: false
  });
  const pdf = await loadingTask.promise;
  const previewCanvas = await renderPdfPage(pdf, 1, 0.42);
  const preview = previewCanvas.toDataURL("image/jpeg", 0.72);
  previewCanvas.width = 1;
  previewCanvas.height = 1;

  return Array.from({ length: pdf.numPages }, (_, index) => ({
    name: `${file.name} · 第 ${index + 1} 页`,
    type: "PDF",
    preview: index === 0 ? preview : "",
    sourceType: "pdf",
    pdf,
    pageNumber: index + 1,
    fileKey: fileKey(file)
  }));
}

async function createImagePage(file) {
  return {
    name: file.name,
    type: file.type.split("/")[1]?.toUpperCase() || "IMAGE",
    preview: await imageDataUrl(file),
    sourceType: "image",
    source: await createImageBitmap(file),
    fileKey: fileKey(file)
  };
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  for (const file of files) {
    if (pages.some((page) => page.fileKey === fileKey(file))) {
      setStatus(`已跳过重复文件：${file.name}`);
      continue;
    }

    try {
      setStatus(`正在读取：${file.name}`);
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        const newPages = await createPdfPages(file);
        pages.push(...newPages);
        setStatus(`已读取 ${newPages.length} 页：${file.name}`);
      } else if (file.type.startsWith("image/")) {
        pages.push(await createImagePage(file));
        setStatus(`已添加图片：${file.name}`);
      }
    } catch (error) {
      setStatus(`读取失败：${error.message || file.name}`);
    }
    renderQueue();
  }
  input.value = "";
}

function renderQueue() {
  count.textContent = `${pages.length} 页`;
  summary.textContent = pages.length
    ? `${pages.length} 个页面等待处理${pages.length > MAX_PREVIEW_PAGES ? "，列表仅显示前 48 页" : ""}`
    : "还没有添加文件";
  recognizeButton.disabled = !pages.length || busy;
  empty.hidden = Boolean(pages.length);
  queue.querySelectorAll(".queue-item").forEach((item) => item.remove());

  pages.slice(0, MAX_PREVIEW_PAGES).forEach((page, index) => {
    const item = document.createElement("div");
    item.className = "queue-item";
    const thumbnail = page.preview
      ? `<img src="${page.preview}" alt="第 ${index + 1} 页预览">`
      : `<div class="page-placeholder">${index + 1}</div>`;
    item.innerHTML = `
      ${thumbnail}
      <div>
        <strong>${page.name}</strong>
        <small>第 ${index + 1} 页 · ${page.type}</small>
      </div>
      <button class="remove" data-index="${index}" title="移除页面">×</button>
    `;
    queue.append(item);
  });

  queue.querySelectorAll(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      const removed = pages.splice(index, 1)[0];
      if (removed?.sourceType === "image") removed.source.close?.();
      renderQueue();
    });
  });
}

function prepareImage(source) {
  const maxDimension = 2600;
  const ratio = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * ratio));
  canvas.height = Math.max(1, Math.round(source.height * ratio));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const enhancement = Number($("#scale").value);
  if (enhancement === 1) return canvas;

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const contrast = enhancement === 3 ? 1.28 : 1.12;
  for (let index = 0; index < image.data.length; index += 4) {
    const gray =
      image.data[index] * 0.299 +
      image.data[index + 1] * 0.587 +
      image.data[index + 2] * 0.114;
    const adjusted = Math.max(0, Math.min(255, (gray - 128) * contrast + 128));
    image.data[index] = adjusted;
    image.data[index + 1] = adjusted;
    image.data[index + 2] = adjusted;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function formatOcrResult(data) {
  const words = (data.words || []).filter(
    (word) => word.text?.trim() && Number(word.confidence) > 20
  );
  if (!words.length) return data.text?.trim() || "";

  const lineMap = new Map();
  words.forEach((word) => {
    const key = `${word.block_num}-${word.par_num}-${word.line_num}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push(word);
  });

  const allLines = [...lineMap.values()].sort(
    (a, b) => a[0].bbox.y0 - b[0].bbox.y0
  );
  const pageHeight = Math.max(...words.map((word) => word.bbox.y1));
  const pageWidth = Math.max(...words.map((word) => word.bbox.x1));
  const lines = $("#trim").checked
    ? allLines.filter((line) => {
        const top = Math.min(...line.map((word) => word.bbox.y0));
        const bottom = Math.max(...line.map((word) => word.bbox.y1));
        return top > pageHeight * 0.045 && bottom < pageHeight * 0.955;
      })
    : allLines;

  return lines
    .map((line) => {
      line.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      const indent = $("#indent").checked
        ? " ".repeat(Math.min(12, Math.round((line[0].bbox.x0 / pageWidth) * 12)))
        : "";
      return `${indent}${line.map((word) => word.text.trim()).join("")}`;
    })
    .join("\n");
}

async function recognizePage(page) {
  const canvas = page.sourceType === "pdf"
    ? await renderPdfPage(page.pdf, page.pageNumber, 1.8)
    : prepareImage(page.source);
  const result = await worker.recognize(canvas);
  canvas.width = 1;
  canvas.height = 1;
  return formatOcrResult(result.data);
}

async function runRecognition() {
  if (busy || !pages.length) return;
  busy = true;
  renderQueue();
  progress.hidden = false;
  bar.style.width = "0%";
  output.value = "";
  updateChars();

  const tesseract = globalThis.Tesseract;
  if (!tesseract?.createWorker) {
    setStatus("OCR 引擎加载失败，请刷新页面后重试");
    busy = false;
    progress.hidden = true;
    renderQueue();
    return;
  }

  try {
    setStatus("正在加载中文识别模型，首次使用可能需要一些时间…");
    worker = await tesseract.createWorker($("#lang").value, 1, {
      logger: (message) => {
        if (message.status === "loading language traineddata") {
          setProgress(message.progress * 0.15, "正在加载中文识别模型…");
        }
        if (message.status === "recognizing text") {
          progressText.textContent = "正在识别当前页面…";
        }
      }
    });
    await worker.setParameters({
      preserve_interword_spaces: "1",
      user_defined_dpi: "300"
    });

    const results = [];
    const failures = [];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      setProgress(index / pages.length, `正在识别第 ${index + 1} / ${pages.length} 页…`);
      try {
        const text = await recognizePage(page);
        results.push(text);
      } catch (error) {
        failures.push(index + 1);
        results.push("");
        console.error(`第 ${index + 1} 页识别失败`, error);
      }
      output.value = results.join("\n\n");
      updateChars();
      setProgress((index + 1) / pages.length, `已完成第 ${index + 1} / ${pages.length} 页`);
    }

    await worker.terminate();
    worker = null;
    const resultCount = results.filter(Boolean).length;
    if (failures.length) {
      setStatus(`识别完成：${resultCount} 页成功，${failures.length} 页失败`);
    } else if (resultCount) {
      setStatus("识别完成，可直接校对后下载 TXT");
    } else {
      setStatus("没有识别出文字，请检查图片清晰度或尝试关闭页眉页脚过滤");
    }
  } catch (error) {
    console.error("OCR 失败", error);
    setStatus(`识别失败：${error.message || "请刷新后重试"}`);
    if (worker) await worker.terminate();
    worker = null;
  } finally {
    busy = false;
    progress.hidden = true;
    renderQueue();
    updateChars();
  }
}

input.addEventListener("change", (event) => addFiles(event.target.files));
$("#addMore").addEventListener("click", () => input.click());
zone.addEventListener("dragover", (event) => {
  event.preventDefault();
  zone.classList.add("drag");
});
zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
zone.addEventListener("drop", (event) => {
  event.preventDefault();
  zone.classList.remove("drag");
  addFiles(event.dataTransfer.files);
});
recognizeButton.addEventListener("click", runRecognition);
output.addEventListener("input", updateChars);
$("#scale").addEventListener("input", (event) => {
  $("#scaleText").textContent = ["原图", "清晰", "高清"][Number(event.target.value) - 1];
});
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(output.value);
    setStatus("全文已复制");
  } catch {
    setStatus("复制失败，请手动选择文字复制");
  }
});
downloadButton.addEventListener("click", () => {
  const blob = new Blob([output.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "papertext-result.txt";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

renderQueue();
updateChars();
