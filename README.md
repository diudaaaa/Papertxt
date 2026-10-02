# PaperText

浏览器端纸质小说 OCR 工具：上传 PDF 或图片，识别成可编辑的 TXT，并尽量保留段落与缩进。

当前版本会对 PDF 逐页按需渲染，适合几十 MB、数百页的扫描 PDF；不会在上传时一次性把全部页面转成高分辨率图片。

## 本地运行

这是一个纯静态网站，不需要安装后端。直接用任意静态文件服务器打开项目根目录即可。

```bash
npx serve -l 4173
```

然后访问 `http://localhost:4173`。

## 发布到公网

### Vercel

1. 将此目录推送到 GitHub。
2. 在 Vercel 中导入该仓库。
3. `Build Command` 留空，`Output Directory` 填 `.`。
4. 点击 Deploy，生成的网址可在手机和其他电脑使用。

### Netlify

1. 打开 Netlify 的 Add new site。
2. 选择 Import an existing project，连接 GitHub 仓库。
3. 发布目录填写 `.`，不要填写构建命令。
4. 部署完成后使用 Netlify 提供的网址。

## 说明

- OCR 在用户浏览器中完成，上传的图片和 PDF 不会发送到本项目服务器。
- 首次识别需要从 CDN 加载 PDF.js、Tesseract.js 和中文识别模型，因此公网部署后需要联网。
- 生产环境应使用 HTTPS；Vercel 和 Netlify 默认提供 HTTPS。
- 上传同一个文件两次时会自动跳过重复文件。
- 识别过程中会逐页写入结果框；即使个别页面失败，也会保留已经识别成功的内容并显示失败页数。
