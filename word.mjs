const MARKER_PATTERN = /([①-⑳⓵-⓾])/gu;

export function textRuns(text, TextRun, size, options = {}) {
  return text.split(MARKER_PATTERN).filter(Boolean).map((segment) =>
    new TextRun({
      text: segment,
      size: /^[①-⑳⓵-⓾]$/u.test(segment) ? Math.round(size * 0.75) : size,
      superScript: /^[①-⑳⓵-⓾]$/u.test(segment),
      font: "Microsoft YaHei",
      color: "20211F",
      ...options
    })
  );
}

export async function createWordBlob(results, docx) {
  const { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } = docx;
  const children = [];
  for (const result of results) {
    if (!result) continue;
    const elements = [...result.elements, ...(result.pictures || []).map((picture) => ({
      kind: "image",
      x: picture.x,
      y: picture.y,
      picture
    }))].sort((left, right) => {
      if (result.layout === "columns") {
        const leftColumn = (left.x || 0) >= result.pageWidth / 2 ? 1 : 0;
        const rightColumn = (right.x || 0) >= result.pageWidth / 2 ? 1 : 0;
        if (leftColumn !== rightColumn) return leftColumn - rightColumn;
      }
      return left.y - right.y;
    });
    for (const element of elements) {
      if (element.kind === "image") {
        const { picture } = element;
        const ratio = Math.min(1, 470 / picture.width, 640 / picture.height);
        const width = Math.round(picture.width * ratio);
        children.push(new Paragraph({
          alignment: "center",
          spacing: { before: 160, after: 160 },
          children: [new ImageRun({
            type: "jpg",
            data: picture.bytes,
            transformation: { width, height: Math.round(picture.height * ratio) },
            altText: { title: "书中配图", description: "从扫描页中截取的配图", name: "书中配图" }
          })]
        }));
        continue;
      }
      const heading = element.kind === "heading";
      const note = element.kind === "note";
      children.push(new Paragraph({
        heading: heading ? HeadingLevel.HEADING_1 : undefined,
        indent: !heading && !note ? { firstLine: 420 } : undefined,
        spacing: { before: heading ? 260 : note ? 100 : 0, after: heading ? 180 : note ? 80 : 90 },
        children: textRuns(element.text, TextRun, heading ? 32 : note ? 18 : 22,
          heading ? { bold: true } : {})
      }));
    }
  }
  if (!children.length) throw new Error("没有可导出的文字或图片");
  const document = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 }
        }
      },
      children
    }]
  });
  return Packer.toBlob(document);
}
