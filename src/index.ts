import { Hono } from 'hono'
import { cors } from "hono/cors"
import * as path from "path"
import * as fs from "fs"
import mime from "mime"
import { formatFileSize, getUniqueFileName } from './utils'
import { FileInfo } from './types'
import { fileURLToPath } from "url";
import { serve } from 'bun'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000']
const BUCKET_PATH = path.join(__dirname, "../bucket")
const PORT = 8000

const app = new Hono()

console.debug({
    BUCKET_PATH,
    isBucketExists:fs.existsSync(BUCKET_PATH)
})

app.use('/*', cors({
    origin: ALLOWED_ORIGINS,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'DELETE'],
    exposeHeaders: ['Content-Length'],
    //   maxAge: 600,
    credentials: true,
}))

app.get('/', (c) => c.text('Server alive 🔥'))
app.notFound((c) => c.text('404 Not Found 😭', 404))

app.post("/save-on-server", async (c) => {
  try {
    const { url } = await c.req.json()
    if (!url) return c.json({ success: false, message: "Missing URL" }, 400)

    const response = await fetch(url)
    if (!response.ok) return c.json({ success: false, message: `Failed to download: ${response.statusText}` }, 400)

    let fileName = path.basename(new URL(url).pathname) || `file-${Date.now()}`
    const contentDisposition = response.headers.get('content-disposition')
    if (contentDisposition?.includes('filename=')) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/)
      if (match?.[1]) fileName = match[1]
    }

    const finalFileName = getUniqueFileName(BUCKET_PATH, fileName)
    const finalFilePath = path.join(BUCKET_PATH, finalFileName)

    // Create Node WriteStream and use Response.body.getReader()
    const fileStream = fs.createWriteStream(finalFilePath)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("No response body")

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      fileStream.write(Buffer.from(value))
    }
    fileStream.end()

    const stats = fs.statSync(finalFilePath)
    if (stats.size === 0) {
      fs.unlinkSync(finalFilePath)
      return c.json({ success: false, message: "Downloaded file is empty" }, 400)
    }

    return c.json({
      success: true,
      message: "File downloaded successfully",
    //   rawUrl: url,
      previewUrl: `/downloads/${encodeURIComponent(finalFileName)}?type=preview`,
      downloadUrl: `/downloads/${encodeURIComponent(finalFileName)}`,
      fileName: finalFileName,
      size: stats.size
    })

  } catch (err) {
    console.error("Download error:", err)
    return c.json({ success: false, message: err instanceof Error ? err.message : "Failed to save file" }, 500)
  }
})

app.get("/downloads", async (c) => {
    try {
        let files: FileInfo[] = []
        if (fs.existsSync(BUCKET_PATH)) {
            const items = fs.readdirSync(BUCKET_PATH)

            for (const item of items) {
                const itemPath = path.join(BUCKET_PATH, item)
                const stats = fs.statSync(itemPath)
                if (stats.isFile()) {
                    files.push({
                        name: item,
                        size: stats.size,
                        sizeFormatted: formatFileSize(stats.size),
                        modified: stats.mtime,
                        previewUrl: `/downloads/${encodeURIComponent(item)}?type=preview`,
                        downloadUrl: `/downloads/${encodeURIComponent(item)}`,
                    })
                }
            }
        }
        files.sort((a, b) => b.modified.getTime() - a.modified.getTime())
        return c.json(files)
    } catch (err) {
        console.error("Error listing bucket files:", err)
        return c.json({ success: false, message: "Error reading bucket" }, 500)
    }
})

app.get("/downloads/:filename", async (c) => {
  const filename = c.req.param("filename")
  const type = c.req.query("type")
  const filePath = path.join(BUCKET_PATH, filename)

  if (!fs.existsSync(filePath)) return c.notFound()

  const stream = fs.createReadStream(filePath)
  const contentType = mime.getType(filePath) || "application/octet-stream"

  const headers =
    type === "preview"
      ? { "Content-Type": contentType }
      : {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
        }

  return c.body(stream, 200, headers)
})


// export default app
serve({
    fetch: app.fetch,
    port: PORT
})
