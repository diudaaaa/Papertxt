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
let pages = [];
let busy = false;
let workers = [];

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

function getOcrProfile() {
  const profiles = {
    fast: { renderScale: 1.5, maxPixels: 2800000 },
    balanced: { renderScale: 1.7, maxPixels: 3800000 },
    quality: { renderScale: 1.9, maxPixels: 5500000 }
  };
  return profiles[$("#speed").value] || profiles.fast;
}

async function renderPdfPage(pdf, pageNumber, scale) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const maxPixels = getOcrProfile().maxPixels;
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
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  removeLongLines(image, canvas.width, canvas.height);
  const enhancement = Number($("#scale").value);
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

function cleanLineText(text) {
  return text
    .replace(/[|¦‖]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([，。！？：；、）》】』」])/g, "$1")
    .replace(/([（《【“『「])\s+/g, "$1")
    .trim();
}

function collapseRepeatedChunks(text) {
  return text.replace(/(.{3,12})\1+/g, "$1");
}

function joinLineText(previous, current) {
  const left = previous.trimEnd();
  const right = current.trimStart();
  if (!left) return right;
  if (!right) return left;
  const leftChar = left[left.length - 1];
  const rightChar = right[0];
  if (/[A-Za-z0-9]$/.test(leftChar) && /^[A-Za-z0-9]/.test(rightChar)) {
    return `${left} ${right}`;
  }
  return `${left}${right}`;
}

function formatOcrResult(data) {
  const sourceLines = (data.lines || [])
    .filter((line) => line.text?.trim() && Number(line.confidence ?? 100) > 18)
    .map((line) => ({
      text: collapseRepeatedChunks(cleanLineText(line.text)),
      x: line.bbox?.x0 ?? 0,
      y: line.bbox?.y0 ?? 0,
      bottom: line.bbox?.y1 ?? line.bbox?.y0 ?? 0,
      height: Math.max(1, (line.bbox?.y1 ?? 0) - (line.bbox?.y0 ?? 0))
    }))
    .filter((line) => line.text);

  if (!sourceLines.length) {
    return {
      text: collapseRepeatedChunks(data.text?.trim() || ""),
      continues: false
    };
  }

  const pageHeight = Math.max(...sourceLines.map((line) => line.bottom));
  const pageWidth = Math.max(...sourceLines.map((line) => line.x + line.text.length * 20));
  const visibleLines = $("#trim").checked
    ? sourceLines.filter((line) => line.y > pageHeight * 0.045 && line.bottom < pageHeight * 0.955)
    : sourceLines;
  const layout = $("#layout").value;
  const rowTolerance = layout === "columns" ? 0.42 : 0.7;
  const rows = [];

  for (const line of visibleLines.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - line.y) <= line.height * rowTolerance);
    if (row) row.lines.push(line);
    else rows.push({ y: line.y, lines: [line] });
  }

  const orderedLines = rows.flatMap((row) => {
    if (layout === "columns") {
      const midpoint = pageWidth / 2;
      return row.lines.sort((a, b) => {
        const aColumn = a.x < midpoint ? 0 : 1;
        const bColumn = b.x < midpoint ? 0 : 1;
        return aColumn - bColumn || a.x - b.x;
      });
    }
    return row.lines.sort((a, b) => a.x - b.x);
  });

  const baseX = [...orderedLines]
    .map((line) => line.x)
    .sort((a, b) => a - b)[Math.floor(orderedLines.length * 0.2)] ?? 0;
  const indentThreshold = Math.max(12, pageWidth * 0.025);
  const lineGaps = orderedLines
    .slice(1)
    .map((line, index) => Math.max(0, line.y - orderedLines[index].bottom))
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b);
  const normalGap = lineGaps[Math.floor(lineGaps.length * 0.5)] || 0;
  const paragraphGap = Math.max(normalGap * 1.7, orderedLines[0]?.height * 0.9 || 0);
  const paragraphs = [];
  let current = null;

  for (const line of orderedLines) {
    const previousLine = current?.lastLine;
    const gap = previousLine ? Math.max(0, line.y - previousLine.bottom) : 0;
    const indented = line.x - baseX >= indentThreshold;
    const startsParagraph = Boolean(
      current &&
      (layout === "form" || indented || (gap > paragraphGap && current.text.length > 12))
    );

    if (!current || startsParagraph) {
      current = {
        text: line.text,
        firstX: line.x,
        lastLine: line,
        indented,
        breakBefore: startsParagraph
      };
      paragraphs.push(current);
    } else {
      current.text = joinLineText(current.text, line.text);
      current.lastLine = line;
    }
  }

  const formatted = paragraphs
    .filter((paragraph) => paragraph.text.trim())
    .map((paragraph) => {
      const text = paragraph.text.trim();
      const shouldIndent =
        $("#indent").checked &&
        (paragraph.indented || paragraph.breakBefore) &&
        layout !== "form";
      return `${shouldIndent ? "　　" : ""}${text}`;
    });

  return {
    text: formatted.join("\n"),
    continues: !paragraphs[0]?.indented
  };
}

function combinePageResults(results) {
  let combined = "";
  results.forEach((result) => {
    if (!result?.text) return;
    if (!combined) {
      combined = result.text;
      return;
    }
    combined += result.continues ? result.text : `\n${result.text}`;
  });
  return combined;
}

async function recognizePage(page, activeWorker) {
  const canvas = page.sourceType === "pdf"
    ? await renderPdfPage(page.pdf, page.pageNumber, getOcrProfile().renderScale)
    : prepareImage(page.source);
  const result = await activeWorker.recognize(canvas);
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
    const shouldParallelize =
      pages.length > 4 &&
      navigator.maxTouchPoints === 0 &&
      (navigator.hardwareConcurrency || 2) >= 6;
    const workerCount = shouldParallelize ? 2 : 1;
    const results = new Array(pages.length).fill(null);
    const failures = [];
let nextIndex = 0;
    let completed = 0;

    const createWorker = (workerNumber) => tesseract.createWorker($("#lang").value, 1, {
      logger: (message) => {
        if (message.status === "loading language traineddata" && workerNumber === 0) {
          setProgress(message.progress * 0.12, "正在加载中文识别模型…");
        }
        if (message.status === "recognizing text") {
          progressText.textContent = `正在识别页面… 已完成 ${completed} / ${pages.length}`;
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
        output.value = combinePageResults(results);
        updateChars();
        setProgress(completed / pages.length, `已完成 ${completed} / ${pages.length} 页`);
      }
    };

    await Promise.all(workers.map((activeWorker) => processWorker(activeWorker)));
    await Promise.all(workers.map((activeWorker) => activeWorker.terminate()));
    workers = [];
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
