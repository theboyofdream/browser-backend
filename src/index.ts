import { serve } from 'bun'
import * as fs from "fs"
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import mime from "mime"
import * as path from "path"
import { fileURLToPath } from "url"
import { DownloadProgress, FileInfo } from './types'
import { formatFileSize, getUniqueFileName } from './utils'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000']
const BUCKET_PATH = path.join(__dirname, "../bucket")
const PORT = process.env.PORT || 8000
const CORS_CONFIG = {
    origin: ALLOWED_ORIGINS,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'DELETE'],
    exposeHeaders: ['Content-Length'],
    //   maxAge: 600,
    credentials: true,
}

// async function cors(c: Context<{}, "/", BlankInput>) {
//     // const origin = c.req.header("origin")
//     // if (origin && ALLOWED_ORIGINS.includes(origin) || !origin) {
//     //     console.log("Unauthorized access from", origin)
//     //     // return c.json({ success: false, message: "Unauthorized origin" }, 403)
//     //     return c.text('404 Not Found 😭', 404)
//     // }
//     // await next()
// }

const downloadProgressStore = new Map<string, DownloadProgress>()
async function downloadFileInBackground(taskId: string, url: string) {
    downloadProgressStore.set(taskId, {
        status: 'downloading',
        totalBytes: 0,
        downloadedBytes: 0,
    })

    try {
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        // Extract filename
        let fileName = path.basename(new URL(url).pathname) || `file-${Date.now()}`
        const contentDisposition = response.headers.get('content-disposition')
        if (contentDisposition?.includes('filename=')) {
            const match = contentDisposition.match(/filename="?([^"]+)"?/)
            if (match?.[1]) fileName = match[1]
        }

        const finalFileName = getUniqueFileName(BUCKET_PATH, fileName)
        const finalFilePath = path.join(BUCKET_PATH, finalFileName)

        const totalBytes = parseInt(response.headers.get('content-length') || '0', 10)

        // Update with total
        let progress: DownloadProgress = {
            ...downloadProgressStore.get(taskId),
            status: 'downloading',
            totalBytes,
            downloadedBytes: 0,
            fileName: finalFileName
        }
        downloadProgressStore.set(taskId, progress)
        console.debug(progress)

        const file = Bun.file(finalFilePath)
        const writer = file.writer()

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        let downloadedBytes = 0
        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            await writer.write(value)
            downloadedBytes += value.length

            // Update progress
            progress = {
                ...downloadProgressStore.get(taskId),
                status: 'downloading',
                totalBytes,
                downloadedBytes,
            }
            downloadProgressStore.set(taskId, progress)
            console.debug(progress)
        }

        await writer.end()

        const stats = fs.statSync(finalFilePath)
        if (stats.size === 0) {
            fs.unlinkSync(finalFilePath)
            throw new Error('Downloaded file is empty')
        }

        // Success
        progress = {
            ...downloadProgressStore.get(taskId),
            status: 'success',
            totalBytes,
            downloadedBytes,
            fileName: finalFileName,
            size: stats.size,
            previewUrl: `/downloads/${encodeURIComponent(finalFileName)}?type=preview`,
            downloadUrl: `/downloads/${encodeURIComponent(finalFileName)}`,
            message: 'File downloaded successfully',
        }
        downloadProgressStore.set(taskId, progress)
        console.debug(progress)

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        const progress: DownloadProgress = {
            ...downloadProgressStore.get(taskId),
            status: 'error',
            totalBytes: 0,
            downloadedBytes: 0,
            message,
        }
        downloadProgressStore.set(taskId, progress)
        console.debug(progress)
    }
}

const app = new Hono()

console.debug({
    BUCKET_PATH,
    isBucketExists: fs.existsSync(BUCKET_PATH)
})

app.use("*", cors(CORS_CONFIG))
app.get('/', (c) => c.text('Server alive 🔥'))
app.notFound((c) => c.text('404 Not Found 😭', 404))

app.post("/save-on-server", async (c) => {
    try {
        const { url } = await c.req.json()
        if (!url) {
            return c.json({ success: false, message: 'Missing URL' }, 400)
        }

        const taskId = crypto.randomUUID()

        // Fire and forget (non-blocking)
        downloadFileInBackground(taskId, url).catch((err) =>
            console.error(`Background download failed for ${taskId}:`, err)
        )

        return c.json({
            success: true,
            message: 'Download started',
            taskId,
        })
    } catch (err) {
        console.error('Failed to start download:', err)
        return c.json({ success: false, message: 'Internal error' }, 500)
    }
})

app.get("/downloads", async (c) => {
    try {
        let files: FileInfo[] = []
        if (fs.existsSync(BUCKET_PATH)) {
            const items = fs.readdirSync(BUCKET_PATH)

            const filesInDownloadProgress = new Set<string>()
            downloadProgressStore.forEach(fileInProgress => {
                if (fileInProgress.status === "downloading" && fileInProgress.fileName) {
                    filesInDownloadProgress.add(fileInProgress.fileName)
                }
            })

            for (const item of items) {
                if (filesInDownloadProgress.has(item)) {
                    continue
                }
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
        return c.json({ success: true, files })
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

app.delete("/downloads/:filename", async (c) => {
    try {
        const filename = c.req.param("filename")
        if (!filename) return c.json({ success: false, message: "Missing filename" }, 400)

        const filePath = path.join(BUCKET_PATH, filename)
        if (!fs.existsSync(filePath))
            return c.json({ success: false, message: "File not found" }, 404)

        fs.unlinkSync(filePath)
        await new Promise((resolve) => setTimeout(resolve, 2000))
        return c.json({ success: true, message: `Deleted ${filename}` })
    } catch (err) {
        console.error("Error deleting file:", err)
        return c.json({ success: false, message: "Error deleting file" }, 500)
    }
})

app.get('/download-progress', (c) => {
    return streamSSE(c, async (stream) => {
        const sendAllProgress = async () => {
            const activeDownloads: Record<string, DownloadProgress> = {}

            downloadProgressStore.forEach((progress, taskId) => {
                if (progress.status === 'downloading' && progress.fileName) {
                    activeDownloads[taskId] = progress
                }
            })

            // Send the full snapshot
            await stream.writeSSE({
                event: 'progress',
                data: JSON.stringify(activeDownloads),
            })

            // Return true if there are active downloads (to keep streaming)
            return Object.keys(activeDownloads).length > 0
        }

        // Send initial state
        let hasActive = await sendAllProgress()

        // If no active downloads now, we could close — but let's keep stream open
        // in case new downloads start.

        const interval = setInterval(async () => {
            hasActive = await sendAllProgress()
            // Optionally: if (!hasActive) { clearInterval(interval); await stream.close(); }
        }, 3000)

        stream.onAbort(() => {
            clearInterval(interval)
        })
    })
})

serve({
    fetch: app.fetch,
    port: PORT,
    hostname: "0.0.0.0"
})
