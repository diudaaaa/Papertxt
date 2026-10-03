import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
import { combinePageResults, formatOcrResult } from "./layout.mjs";
import { findPictureRegions } from "./pictures.mjs";
import { createWordBlob } from "./word.mjs";

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
const wordButton = $("#downloadWord");

const MAX_PREVIEW_PAGES = 48;
let pages = [];
let busy = false;
let exportingWord = false;
let loadingFiles = false;
let workers = [];
let pageResults = [];

function setStatus(message) {
  status.textContent = message;
}

function updateChars() {
  chars.textContent = `${output.value.length} 字`;
  copyButton.disabled = !output.value;
  downloadButton.disabled = !output.value;
  wordButton.disabled = busy || exportingWord || !pageResults.some((result) => result?.elements?.length);
}

function invalidateWordResults() {
  pageResults = [];
  updateChars();
}

function setProgress(value, message) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  bar.style.width = `${percent}%`;
  progressText.textContent = message;
}

function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function getOcrProfile() {
  const profiles = {
    fast: { renderScale: 1.5, maxPixels: 2800000 },
    balanced: { renderScale: 1.7, maxPixels: 3800000 },
    quality: { renderScale: 1.9, maxPixels: 5500000 }
  };
  return profiles[$("#speed").value] || profiles.fast;
}

async function renderPdfPage(pdf, pageNumber, scale, options = {}) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const maxPixels = options.maxPixels || getOcrProfile().maxPixels;
  const requestedPixels = baseViewport.width * baseViewport.height * scale * scale;
  const safeScale = requestedPixels > maxPixels
    ? scale * Math.sqrt(maxPixels / requestedPixels)
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
  const sourceUrl = URL.createObjectURL(file);
  let loadingTask;
  try {
    loadingTask = pdfjsLib.getDocument({
      url: sourceUrl,
      disableAutoFetch: false,
      disableStream: false,
      rangeChunkSize: 1024 * 1024
    });
    const pdf = await loadingTask.promise;
    return Array.from({ length: pdf.numPages }, (_, index) => ({
      name: `${file.name} · 第 ${index + 1} 页`,
      type: "PDF",
      preview: "",
      sourceType: "pdf",
      pdf,
      pageNumber: index + 1,
      fileKey: fileKey(file),
      sourceUrl
    }));
  } catch (error) {
    loadingTask?.destroy?.();
    URL.revokeObjectURL(sourceUrl);
    if (file.size > 32 * 1024 * 1024) {
      throw new Error(`PDF 读取失败（${formatBytes(file.size)}）。请确认文件未加密，并尝试使用 Chrome 或 Edge。`);
    }
    try {
      const pdf = await pdfjsLib.getDocument({
        data: await file.arrayBuffer(),
        disableAutoFetch: false,
        disableStream: false
      }).promise;
      return Array.from({ length: pdf.numPages }, (_, index) => ({
        name: `${file.name} · 第 ${index + 1} 页`,
        type: "PDF",
        preview: "",
        sourceType: "pdf",
        pdf,
        pageNumber: index + 1,
        fileKey: fileKey(file),
        sourceUrl: ""
      }));
    } catch (fallbackError) {
      throw new Error(`PDF 读取失败：${fallbackError.message || error.message || "文件可能已损坏或加密"}`);
    }
  }
}

async function createImagePage(file) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    return {
      name: file.name,
      type: file.type.split("/")[1]?.toUpperCase() || "IMAGE",
      preview: sourceUrl,
      sourceType: "image",
      file,
      sourceUrl,
      fileKey: fileKey(file)
    };
  } catch (error) {
    URL.revokeObjectURL(sourceUrl);
    throw error;
  }
}

function schedulePdfPreview(page) {
  window.setTimeout(async () => {
    if (!pages.includes(page) || page.preview || loadingFiles || busy || exportingWord) return;
    try {
      const previewCanvas = await renderPdfPage(page.pdf, page.pageNumber, 0.34, {
        maxPixels: 520000
      });
      page.preview = previewCanvas.toDataURL("image/jpeg", 0.72);
      previewCanvas.width = 1;
      previewCanvas.height = 1;
      if (pages.includes(page)) renderQueue();
    } catch (error) {
      console.warn("缩略图生成失败", error);
    }
  }, 400);
}

function releasePageResource(page) {
  if (!page) return;
  if (page.sourceType === "image") {
    if (page.sourceUrl) URL.revokeObjectURL(page.sourceUrl);
  }
}

function releasePdfResource(page) {
  page?.pdf?.destroy?.();
  if (page?.sourceUrl) URL.revokeObjectURL(page.sourceUrl);
}

window.addEventListener("beforeunload", () => {
  const seenPdfs = new Set();
  for (const page of pages) {
    if (page.sourceType === "image") releasePageResource(page);
    if (page.sourceType === "pdf" && !seenPdfs.has(page.pdf)) {
      seenPdfs.add(page.pdf);
      releasePdfResource(page);
    }
  }
});

function isPdfFile(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function addFiles(fileList) {
  if (busy || exportingWord || loadingFiles) return;
  const files = [...fileList];
  if (!files.length) return;
  loadingFiles = true;
  input.disabled = true;
  $("#addMore").disabled = true;
  renderQueue();
  try {
    for (const file of files) {
      if (pages.some((page) => page.fileKey === fileKey(file))) {
        setStatus(`已跳过重复文件：${file.name}`);
        continue;
      }

      try {
        setStatus(`正在读取 ${formatBytes(file.size)} 文件：${file.name}`);
        if (isPdfFile(file)) {
          const newPages = await createPdfPages(file);
          pages.push(...newPages);
          invalidateWordResults();
          renderQueue();
          setStatus(`已读取 ${newPages.length} 页，可开始识别：${file.name}`);
        } else if (file.type.startsWith("image/")) {
          pages.push(await createImagePage(file));
          invalidateWordResults();
          setStatus(`已添加图片：${file.name}`);
        } else {
          setStatus(`不支持此文件：${file.name}`);
        }
      } catch (error) {
        setStatus(`读取失败：${error.message || file.name}`);
      }
      renderQueue();
    }
  } finally {
    loadingFiles = false;
    input.disabled = false;
    $("#addMore").disabled = false;
    input.value = "";
    renderQueue();
    const firstPdfPage = pages.find((page) => page.sourceType === "pdf" && !page.preview);
    if (firstPdfPage) schedulePdfPreview(firstPdfPage);
  }
}

function renderQueue() {
  count.textContent = `${pages.length} 页`;
  summary.textContent = pages.length
    ? `${pages.length} 个页面等待处理${pages.length > MAX_PREVIEW_PAGES ? "，列表仅显示前 48 页" : ""}`
    : "还没有添加文件";
  recognizeButton.disabled = !pages.length || busy || exportingWord || loadingFiles;
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
      <button class="remove" data-index="${index}" title="移除页面" ${busy || exportingWord || loadingFiles ? "disabled" : ""}>×</button>
    `;
    queue.append(item);
  });

  queue.querySelectorAll(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      if (busy || exportingWord || loadingFiles) return;
      const index = Number(button.dataset.index);
      const removed = pages.splice(index, 1)[0];
      releasePageResource(removed);
      if (removed?.sourceType === "pdf" &&
        !pages.some((page) => page.pdf === removed.pdf)) {
        releasePdfResource(removed);
      }
      invalidateWordResults();
      renderQueue();
    });
  });
}

function removeLongLines(image, width, height) {
  if (!$("#removeLines").checked) return;
  const darkLimit = 92;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 1200));
  const sampleWidth = Math.ceil(width / step);
  const sampleHeight = Math.ceil(height / step);
  const rowSpan = Math.max(18, Math.floor(sampleWidth * 0.34));
  const colSpan = Math.max(18, Math.floor(sampleHeight * 0.34));
  const eraseRows = [];
  const eraseColumns = [];

  for (let y = 0; y < height; y += step) {
    let run = 0;
    let longest = 0;
    let darkCount = 0;
    for (let x = 0; x < width; x += step) {
      const value = image.data[(y * width + x) * 4];
      if (value < darkLimit) {
        run += 1;
        darkCount += 1;
        longest = Math.max(longest, run);
      } else {
        run = 0;
      }
    }
    if (longest >= rowSpan && darkCount >= sampleWidth * 0.42) eraseRows.push(y);
  }

  for (let x = 0; x < width; x += step) {
    let run = 0;
    let longest = 0;
    let darkCount = 0;
    for (let y = 0; y < height; y += step) {
      const value = image.data[(y * width + x) * 4];
      if (value < darkLimit) {
        run += 1;
        darkCount += 1;
        longest = Math.max(longest, run);
      } else {
        run = 0;
      }
    }
    if (longest >= colSpan && darkCount >= sampleHeight * 0.42) eraseColumns.push(x);
  }

  for (const y of eraseRows) {
    for (let offset = -step; offset <= step; offset += 1) {
      const row = y + offset;
      if (row < 0 || row >= height) continue;
      for (let x = 0; x < width; x += 1) {
        const index = (row * width + x) * 4;
        image.data[index] = 255;
        image.data[index + 1] = 255;
        image.data[index + 2] = 255;
      }
    }
  }

  for (const x of eraseColumns) {
    for (let offset = -step; offset <= step; offset += 1) {
      const column = x + offset;
      if (column < 0 || column >= width) continue;
      for (let y = 0; y < height; y += 1) {
        const index = (y * width + column) * 4;
        image.data[index] = 255;
        image.data[index + 1] = 255;
        image.data[index + 2] = 255;
      }
    }
  }
}

function prepareImage(source) {
  const maxPixels = getOcrProfile().maxPixels;
  const ratio = Math.min(
    1,
    2600 / Math.max(source.width, source.height),
    Math.sqrt(maxPixels / (source.width * source.height))
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * ratio));
  canvas.height = Math.max(1, Math.round(source.height * ratio));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const enhancement = Number($("#scale").value);
  const needsPixelWork = $("#removeLines").checked || enhancement !== 1;
  if (!needsPixelWork) return canvas;

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  removeLongLines(image, canvas.width, canvas.height);
  if (enhancement === 1) {
    context.putImageData(image, 0, 0);
    return canvas;
  }
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

async function capturePictures(canvas, lines, pageWidth, pageHeight) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const regions = findPictureRegions(
    context.getImageData(0, 0, canvas.width, canvas.height),
    lines,
    pageWidth,
    pageHeight
  );
  const pictures = [];
  for (const region of regions) {
    const crop = document.createElement("canvas");
    crop.width = region.width;
    crop.height = region.height;
    crop.getContext("2d").drawImage(
      canvas, region.x, region.y, region.width, region.height,
      0, 0, region.width, region.height
    );
    const blob = await new Promise((resolve) => crop.toBlob(resolve, "image/jpeg", 0.82));
    if (blob) pictures.push({
      x: region.x * pageWidth / canvas.width,
      y: region.y * pageHeight / canvas.height,
      width: region.width,
      height: region.height,
      bytes: new Uint8Array(await blob.arrayBuffer())
    });
    crop.width = 1;
    crop.height = 1;
  }
  return pictures;
}

async function renderSourcePage(page) {
  if (page.sourceType === "pdf") {
    return renderPdfPage(page.pdf, page.pageNumber, getOcrProfile().renderScale);
  }
  const bitmap = await createImageBitmap(page.file);
  try {
    return prepareImage(bitmap);
  } finally {
    bitmap.close?.();
  }
}

async function recognizePage(page, activeWorker) {
  const canvas = await renderSourcePage(page);
  try {
    const { data } = await activeWorker.recognize(canvas, {}, {
      blocks: true
    });
    const result = formatOcrResult(data, { width: canvas.width, height: canvas.height }, {
      trim: $("#trim").checked,
      indent: $("#indent").checked,
      layout: $("#layout").value
    });
    result.pageHeight = canvas.height;
    return result;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function collectPicturesForWord() {
  if (!$("#includePictures").checked) return 0;
  const candidates = pageResults
    .map((result, index) => ({ result, page: pages[index] }))
    .filter(({ result, page }) => result?.lines?.length && page);
  let pictureCount = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const { result, page } = candidates[index];
    if (result.pictures) {
      pictureCount += result.pictures.length;
      setProgress((index + 1) / candidates.length, `正在扫描配图… ${index + 1} / ${candidates.length} 页`);
      continue;
    }
    const canvas = await renderSourcePage(page);
    try {
      result.pictures = await capturePictures(canvas, result.lines, result.pageWidth, result.pageHeight);
      pictureCount += result.pictures.length;
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
    setProgress((index + 1) / candidates.length, `正在扫描配图… ${index + 1} / ${candidates.length} 页`);
  }
  return pictureCount;
}

async function runRecognition() {
  if (busy || exportingWord || loadingFiles || !pages.length) return;
  busy = true;
  input.disabled = true;
  $("#addMore").disabled = true;
  renderQueue();
  progress.hidden = false;
  bar.style.width = "0%";
  output.value = "";
  pageResults = [];
  updateChars();

  const tesseract = globalThis.Tesseract;
  if (!tesseract?.createWorker) {
    setStatus("OCR 引擎加载失败，请刷新页面后重试");
    busy = false;
    input.disabled = false;
    $("#addMore").disabled = false;
    progress.hidden = true;
    renderQueue();
    return;
  }

  try {
    setStatus("正在加载中文识别模型，首次使用可能需要一些时间…");
    const shouldParallelize =
      pages.length > 4 &&
      navigator.maxTouchPoints === 0 &&
      (navigator.hardwareConcurrency || 2) >= 6;
    const workerCount = shouldParallelize ? 2 : 1;
    const results = new Array(pages.length).fill(null);
    pageResults = results;
    const failures = [];
    let nextIndex = 0;
    let completed = 0;
    let lastLoggerUpdate = 0;
    let lastOutputUpdate = 0;

    const createWorker = (workerNumber) => tesseract.createWorker($("#lang").value, 1, {
      logger: (message) => {
        if (message.status === "loading language traineddata" && workerNumber === 0) {
          setProgress(message.progress * 0.12, "正在加载中文识别模型…");
        }
        if (message.status === "recognizing text") {
          const now = Date.now();
          if (now - lastLoggerUpdate > 250) {
            progressText.textContent = `正在识别页面… 已完成 ${completed} / ${pages.length}`;
            lastLoggerUpdate = now;
          }
        }
      }
    }).then(async (createdWorker) => {
      const mode = $("#layout").value === "form" ? "11" : "6";
      await createdWorker.setParameters({
        preserve_interword_spaces: "1",
        user_defined_dpi: getOcrProfile().renderScale < 1.5 ? "240" : "300",
        tessedit_pageseg_mode: mode
      });
      return createdWorker;
    });

    workers = await Promise.all(Array.from({ length: workerCount }, (_, index) => createWorker(index)));

    const processWorker = async (activeWorker) => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= pages.length) return;
        try {
          results[index] = await recognizePage(pages[index], activeWorker);
        } catch (error) {
          failures.push(index + 1);
          console.error(`第 ${index + 1} 页识别失败`, error);
        }
        completed += 1;
        const now = Date.now();
        if (completed === pages.length || now - lastOutputUpdate > 1200) {
          output.value = combinePageResults(results);
          updateChars();
          lastOutputUpdate = now;
        }
        setProgress(completed / pages.length, `已完成 ${completed} / ${pages.length} 页`);
      }
    };

    await Promise.all(workers.map((activeWorker) => processWorker(activeWorker)));
    await Promise.all(workers.map((activeWorker) => activeWorker.terminate()));
    workers = [];
    output.value = combinePageResults(results);
    updateChars();
    const resultCount = results.filter((result) => result?.text).length;
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
    await Promise.all(workers.map((activeWorker) => activeWorker.terminate()));
    workers = [];
  } finally {
    busy = false;
    input.disabled = false;
    $("#addMore").disabled = false;
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
  if (busy || exportingWord || loadingFiles) return;
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
wordButton.addEventListener("click", async () => {
  if (exportingWord || busy) return;
  exportingWord = true;
  input.disabled = true;
  $("#addMore").disabled = true;
  wordButton.disabled = true;
  recognizeButton.disabled = true;
  progress.hidden = false;
  setProgress(0, "正在准备 Word 文档…");
  try {
    setStatus("正在准备 Word 文档…");
    const pictureCount = await collectPicturesForWord();
    if (!globalThis.docx) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/docx@9.6.1/dist/index.iife.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Word 组件下载失败，请检查网络"));
        document.head.append(script);
      });
    }
    const blob = await createWordBlob(pageResults, globalThis.docx);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(pages[0]?.name || "papertext").replace(/ · 第 \d+ 页$/, "").replace(/\.(pdf|png|jpe?g|webp)$/i, "")}.docx`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus(pictureCount
      ? `Word 文档已生成，包含 ${pictureCount} 张检测到的配图`
      : $("#includePictures").checked
        ? "Word 文档已生成；未检测到可分离的配图，请校对原页"
        : "Word 文档已生成");
  } catch (error) {
    console.error("Word 导出失败", error);
    setStatus(`Word 导出失败：${error.message}`);
  } finally {
    exportingWord = false;
    input.disabled = false;
    $("#addMore").disabled = false;
    progress.hidden = true;
    renderQueue();
    updateChars();
  }
});

renderQueue();
updateChars();
