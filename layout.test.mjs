import test from "node:test";
import assert from "node:assert/strict";
import { combinePageResults, formatOcrResult } from "./layout.mjs";

const line = (text, x, y, width, height) => ({
  text, confidence: 90,
  bbox: { x0: x, y0: y, x1: x + width, y1: y + height }
});

test("filters the page side rail and separates heading, body, note", () => {
  const data = { blocks: [{ paragraphs: [{ lines: [
    line("第 1 章 蒙古人中的喇嘛教", 170, 200, 540, 47),
    line("19 世纪时，庙宇①", 90, 355, 650, 24),
    line("仍然存在于草原。", 90, 390, 650, 24),
    line("第 1 章 蒙古人中的喇嘛教", 865, 285, 26, 170),
    line("①《宝贝数据》注释", 90, 855, 450, 16)
  ] }] }] };
  const result = formatOcrResult(data, { width: 940, height: 1000 }, {
    trim: true, indent: true, layout: "novel"
  });
  assert.deepEqual(result.elements.map(({ kind }) => kind), ["heading", "body", "note"]);
  assert.match(result.text, /庙宇①仍然存在于草原/u);
  assert.equal(result.text.match(/第 1 章/gu)?.length, 1);
});

test("joins a continuing paragraph across pages", () => {
  assert.equal(combinePageResults([
    { text: "　　这是前一页的段落", continues: false },
    { text: "续写。", continues: true },
    { text: "　　新的段落。", continues: false }
  ]), "　　这是前一页的段落续写。\n　　新的段落。");
});

test("drops a right rail merged into a main OCR line", () => {
  const merged = line("章节标题侧栏", 130, 100, 770, 35);
  merged.words = [
    { text: "章节标题", bbox: { x0: 130, x1: 520 } },
    { text: "侧栏", bbox: { x0: 870, x1: 900 } }
  ];
  const result = formatOcrResult({
    blocks: [{ paragraphs: [{ lines: [merged] }] }]
  }, { width: 940, height: 1000 }, { layout: "novel" });
  assert.equal(result.text, "章节标题");
});

test("orders a two-column page by column instead of alternating rows", () => {
  const result = formatOcrResult({
    blocks: [{ paragraphs: [{ lines: [
      line("左栏第一行", 40, 100, 120, 20),
      line("右栏第一行", 300, 100, 120, 20),
      line("左栏第二行", 40, 135, 120, 20),
      line("右栏第二行", 300, 135, 120, 20)
    ] }] }]
  }, { width: 500, height: 400 }, { layout: "columns" });
  assert.equal(result.text, "左栏第一行左栏第二行\n右栏第一行右栏第二行");
});
