const CIRCLED_MARKERS = /[①-⑳⓵-⓾]/u;

export function cleanLineText(text) {
  return text
    .replace(/[|¦‖]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([，。！？：；、）》】』」])/g, "$1")
    .replace(/([（《【“『「])\s+/g, "$1")
    .trim()
    .replace(/(.{3,12})\1+/g, "$1");
}

export function joinLineText(previous, current) {
  const left = previous.trimEnd();
  const right = current.trimStart();
  if (!left) return right;
  if (!right) return left;
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)
    ? `${left} ${right}`
    : `${left}${right}`;
}

export function extractLines(data) {
  const blocks = data.blocks || [];
  const nested = blocks.flatMap((block) =>
    (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || [])
  );
  return nested.length ? nested : data.lines || [];
}

export function formatOcrResult(data, pageSize, options = {}) {
  const { width, height } = pageSize;
  const layout = options.layout || "novel";
  const sourceLines = extractLines(data)
    .filter((line) => line.text?.trim() && Number(line.confidence ?? 100) > 18 && line.bbox)
    .map((line) => {
      const words = line.words || [];
      const mixedWithRail = words.some((word) => word.bbox?.x0 < width * 0.78) &&
        words.some((word) => word.bbox?.x0 > width * 0.86);
      const keptWords = mixedWithRail
        ? words.filter((word) => word.bbox?.x0 < width * 0.86)
        : words;
      return {
        text: cleanLineText(mixedWithRail
          ? keptWords.map((word) => word.text).join(" ")
          : line.text),
        x: line.bbox.x0,
        right: mixedWithRail ? Math.max(...keptWords.map((word) => word.bbox.x1)) : line.bbox.x1,
        y: line.bbox.y0,
        bottom: line.bbox.y1,
        height: Math.max(1, line.bbox.y1 - line.bbox.y0)
      };
    })
    .filter((line) => line.text)
    .filter((line) => {
      const narrow = line.right - line.x < width * 0.17;
      const sideRail = (line.x > width * 0.81 || line.right < width * 0.14) && narrow;
      if (sideRail && line.y < height * 0.9) return false;
      const edgeNumber = options.trim && (line.bottom < height * 0.035 || line.y > height * 0.965) &&
        /^[\d\s·\-—]+$/.test(line.text);
      return !edgeNumber;
    });

  if (!sourceLines.length) {
    const text = cleanLineText(data.text || "");
    return { text, continues: false, layout, pageWidth: width,
      elements: text ? [{ kind: "body", text, y: 0 }] : [], lines: [] };
  }

  const sorted = sourceLines.sort((a, b) => a.y - b.y || a.x - b.x);
  const heights = sorted.map((line) => line.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const mainLines = sorted.filter((line) => line.y < height * 0.78 && line.height < medianHeight * 1.3);
  const xPositions = (mainLines.length ? mainLines : sorted).map((line) => line.x).sort((a, b) => a - b);
  const baseX = xPositions[Math.floor(xPositions.length * 0.2)] ?? 0;
  const rightPositions = sorted.filter((line) => line.x >= width / 2).map((line) => line.x).sort((a, b) => a - b);
  const rightBaseX = rightPositions[Math.floor(rightPositions.length * 0.2)] ?? baseX;
  const indentThreshold = Math.max(12, width * 0.025);

  const classify = (line) => {
    if (layout === "form") return "body";
    const centered = Math.abs((line.x + line.right) / 2 - width / 2) < width * 0.16;
    const chapter = /^第\s*[一二三四五六七八九十百\d]+\s*[章回节]/u.test(line.text);
    if (chapter || (centered && line.height > medianHeight * 1.33 && line.y < height * 0.55)) {
      return "heading";
    }
    if (line.y > height * 0.78 && line.height < medianHeight * 0.87) return "note";
    return "body";
  };

  const rows = [];
  for (const line of sorted) {
    const row = rows.find((candidate) => Math.abs(candidate.y - line.y) <= line.height * 0.55);
    if (row) row.lines.push(line);
    else rows.push({ y: line.y, lines: [line] });
  }
  const ordered = layout === "columns"
    ? [
        ...sorted.filter((line) => line.x < width / 2),
        ...sorted.filter((line) => line.x >= width / 2)
      ]
    : rows.flatMap((row) => row.lines.sort((a, b) => a.x - b.x));
  const gaps = ordered.slice(1)
    .map((line, index) => Math.max(0, line.y - ordered[index].bottom))
    .filter((gap) => gap > 0).sort((a, b) => a - b);
  const normalGap = gaps[Math.floor(gaps.length / 2)] || 0;
  const paragraphGap = Math.max(normalGap * 1.7, medianHeight * 0.9);
  const elements = [];
  let current = null;

  for (const line of ordered) {
    const kind = classify(line);
    const column = layout === "columns" && line.x >= width / 2 ? 1 : 0;
    const gap = current ? Math.max(0, line.y - current.bottom) : 0;
    const indented = line.x - (column ? rightBaseX : baseX) >= indentThreshold;
    const newParagraph = !current || column !== current.column || kind !== current.kind || kind === "heading" ||
      (kind === "body" && (layout === "form" || indented || (gap > paragraphGap && current.text.length > 12))) ||
      (kind === "note" && (CIRCLED_MARKERS.test(line.text[0]) || gap > paragraphGap));

    if (newParagraph) {
      current = { kind, text: line.text, x: line.x, y: line.y, bottom: line.bottom, indented, column };
      elements.push(current);
    } else {
      current.text = joinLineText(current.text, line.text);
      current.bottom = line.bottom;
    }
  }

  const result = elements.map((element) => {
    const indent = options.indent !== false && element.kind === "body" && element.indented ? "　　" : "";
    return `${indent}${element.text}`;
  });
  return {
    text: result.join("\n"),
    continues: elements[0]?.kind === "body" && !elements[0].indented,
    elements,
    lines: ordered,
    layout,
    pageWidth: width
  };
}

export function combinePageResults(results) {
  let combined = "";
  for (const result of results) {
    if (!result?.text) continue;
    if (!combined) combined = result.text;
    else combined += result.continues ? result.text : `\n${result.text}`;
  }
  return combined;
}
