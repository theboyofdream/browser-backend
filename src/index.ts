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
    maxAge: 600,
    credentials: true,
}
const MIME_TO_EXT: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
}

const downloadProgressStore = new Map<string, DownloadProgress>()
// async function downloadFileInBackground(taskId: string, url: string) {
//     console.debug(url)
//     downloadProgressStore.set(taskId, {
//         status: 'downloading',
//         totalBytes: 0,
//         downloadedBytes: 0,
//     })

//     try {
//         const response = await fetch(url)
//         if (!response.ok) {
//             throw new Error(`HTTP ${response.status}: ${response.statusText}`)
//         }

//         // Extract filename
//         let fileName = path.basename(new URL(url).pathname) || `file-${Date.now()}`
//         const contentDisposition = response.headers.get('content-disposition')
//         if (contentDisposition?.includes('filename=')) {
//             const match = contentDisposition.match(/filename="?([^"]+)"?/)
//             if (match?.[1]) fileName = match[1]
//         }

//         const finalFileName = getUniqueFileName(BUCKET_PATH, fileName)
//         const finalFilePath = path.join(BUCKET_PATH, finalFileName)

//         const totalBytes = parseInt(response.headers.get('content-length') || '0', 10)

//         // Update with total
//         let progress: DownloadProgress = {
//             ...downloadProgressStore.get(taskId),
//             status: 'downloading',
//             totalBytes,
//             downloadedBytes: 0,
//             fileName: finalFileName
//         }
//         downloadProgressStore.set(taskId, progress)
//         console.debug(progress)

//         const file = Bun.file(finalFilePath)
//         const writer = file.writer()

//         const reader = response.body?.getReader()
//         if (!reader) throw new Error('No response body')

//         let downloadedBytes = 0
//         while (true) {
//             const { done, value } = await reader.read()
//             if (done) break

//             await writer.write(value)
//             downloadedBytes += value.length

//             // Update progress
//             progress = {
//                 ...downloadProgressStore.get(taskId),
//                 status: 'downloading',
//                 totalBytes,
//                 downloadedBytes,
//             }
//             downloadProgressStore.set(taskId, progress)
//             console.debug(progress)
//         }

//         await writer.end()

//         const stats = fs.statSync(finalFilePath)
//         if (stats.size === 0) {
//             fs.unlinkSync(finalFilePath)
//             throw new Error('Downloaded file is empty')
//         }

//         // Success
//         progress = {
//             ...downloadProgressStore.get(taskId),
//             status: 'success',
//             totalBytes,
//             downloadedBytes,
//             fileName: finalFileName,
//             size: stats.size,
//             previewUrl: `/downloads/${encodeURIComponent(finalFileName)}?type=preview`,
//             downloadUrl: `/downloads/${encodeURIComponent(finalFileName)}`,
//             message: 'File downloaded successfully',
//         }
//         downloadProgressStore.set(taskId, progress)
//         console.debug(progress)

//     } catch (err) {
//         const message = err instanceof Error ? err.message : 'Unknown error'
//         const progress: DownloadProgress = {
//             ...downloadProgressStore.get(taskId),
//             status: 'error',
//             totalBytes: 0,
//             downloadedBytes: 0,
//             message,
//         }
//         downloadProgressStore.set(taskId, progress)
//         console.debug(progress)
//     }
// }

async function downloadFileInBackground(taskId: string, url: string) {
    console.debug('📥 Starting download for:', url);

    downloadProgressStore.set(taskId, {
        status: 'downloading',
        totalBytes: 0,
        downloadedBytes: 0,
    });

    try {
        let finalFileName: string;
        let finalFilePath: string;
        let totalBytes: number;

        if (url.startsWith('data:')) {
            // === Base64: small payloads only ===
            const mimeTypeMatch = url.match(/^data:([^;]+);base64,/);
            const base64DataMatch = url.match(/^data:[^,]*,([^]*)$/);

            if (!mimeTypeMatch || !base64DataMatch) {
                throw new Error('Invalid data URL format');
            }

            const mimeType = mimeTypeMatch[1];
            const base64Data = base64DataMatch[1];
            const ext = MIME_TO_EXT[mimeType] || '.bin';
            finalFileName = `file-${Date.now()}${ext}`;
            finalFilePath = path.join(BUCKET_PATH, finalFileName);

            const buffer = Buffer.from(base64Data, 'base64');
            totalBytes = buffer.length;

            // Write base64 result
            const file = Bun.file(finalFilePath);
            const writer = file.writer();
            await writer.write(buffer);
            await writer.end();

            downloadProgressStore.set(taskId, {
                ...downloadProgressStore.get(taskId),
                status: 'success',
                totalBytes,
                downloadedBytes: totalBytes,
                fileName: finalFileName,
                size: totalBytes,
                previewUrl: `/downloads/${encodeURIComponent(finalFileName)}?type=preview`,
                downloadUrl: `/downloads/${encodeURIComponent(finalFileName)}`,
                message: 'File saved successfully',
            });

            console.debug('✅ Base64 download complete:', finalFileName);
            return;
        }

        // === HTTP(S): stream to disk ===
        const response = await fetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Determine filename
        let fileName = path.basename(new URL(url).pathname) || `file-${Date.now()}`;
        const contentDisposition = response.headers.get('content-disposition');
        if (contentDisposition?.includes('filename=')) {
            const match = contentDisposition.match(/filename="?([^"]+)"?/);
            if (match?.[1]) fileName = match[1];
        }

        finalFileName = getUniqueFileName(BUCKET_PATH, fileName);
        finalFilePath = path.join(BUCKET_PATH, finalFileName);

        const totalBytesHeader = response.headers.get('content-length');
        totalBytes = totalBytesHeader ? parseInt(totalBytesHeader, 10) : 0;

        downloadProgressStore.set(taskId, {
            ...downloadProgressStore.get(taskId),
            status: 'downloading',
            totalBytes,
            downloadedBytes: 0,
            fileName: finalFileName,
        });

        // 🔑 Stream directly to file — no memory accumulation
        const file = Bun.file(finalFilePath);
        const writer = file.writer();

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        let downloadedBytes = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                await writer.write(value); // ✅ Write chunk immediately
                downloadedBytes += value.length;

                downloadProgressStore.set(taskId, {
                    ...downloadProgressStore.get(taskId),
                    status: 'downloading',
                    totalBytes,
                    downloadedBytes,
                    fileName: finalFileName,
                });
            }
        } finally {
            await writer.end(); // Ensure cleanup
        }

        const stats = fs.statSync(finalFilePath);
        if (stats.size === 0) {
            fs.unlinkSync(finalFilePath);
            throw new Error('Downloaded file is empty');
        }

        downloadProgressStore.set(taskId, {
            ...downloadProgressStore.get(taskId),
            status: 'success',
            totalBytes: stats.size,
            downloadedBytes: stats.size,
            fileName: finalFileName,
            size: stats.size,
            previewUrl: `/downloads/${encodeURIComponent(finalFileName)}?type=preview`,
            downloadUrl: `/downloads/${encodeURIComponent(finalFileName)}`,
            message: 'File saved successfully',
        });

        console.debug('✅ Download complete:', finalFileName);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('❌ Download failed:', message);

        downloadProgressStore.set(taskId, {
            ...downloadProgressStore.get(taskId),
            status: 'error',
            totalBytes: 0,
            downloadedBytes: 0,
            message,
        });
    }
}

// async function downloadFileInBackground(taskId: string, url: string) {
//     console.debug('📥 Starting download for:', url)

//     // Initialize progress
//     downloadProgressStore.set(taskId, {
//         status: 'downloading',
//         totalBytes: 0,
//         downloadedBytes: 0,
//     })

//     try {
//         let finalFileName: string
//         let finalFilePath: string
//         let buffer: Uint8Array | Buffer
//         let totalBytes: number

//         if (url.startsWith('data:')) {
//             // ======================
//             // Handle Base64 () URL
//             // ======================
//             const mimeTypeMatch = url.match(/^data:([^;]+);base64,/)
//             const base64DataMatch = url.match(/^data:[^,]*,([^]*)$/)

//             if (!mimeTypeMatch || !base64DataMatch) {
//                 throw new Error('Invalid data URL format')
//             }

//             const mimeType = mimeTypeMatch[1]
//             const base64Data = base64DataMatch[1]

//             // Infer extension
//             const ext = MIME_TO_EXT[mimeType] || '.bin'
//             finalFileName = `file-${Date.now()}${ext}`
//             finalFilePath = path.join(BUCKET_PATH, finalFileName)

//             // Decode base64
//             buffer = Buffer.from(base64Data, 'base64')
//             totalBytes = buffer.length

//             // Update progress (instant for base64)
//             downloadProgressStore.set(taskId, {
//                 status: 'downloading',
//                 totalBytes,
//                 downloadedBytes: totalBytes,
//                 fileName: finalFileName,
//             })

//         } else {
//             // ======================
//             // Handle HTTP(S) URL
//             // ======================
//             const response = await fetch(url,
//                 {
//                     headers: {
//                         // Mimic a real browser
//                         'User-Agent':
//                             'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
//                         'Accept': '*/*',
//                         'Accept-Language': 'en-US,en;q=0.9',
//                         'Accept-Encoding': 'gzip, deflate, br',
//                         'Connection': 'keep-alive',
//                         // Optional: add referer if you know the source page
//                         // 'Referer': 'https://example.com/page-with-the-link',
//                     },
//                     redirect: 'follow',
//                 }
//             )
//             if (!response.ok) {
//                 throw new Error(`HTTP ${response.status}: ${response.statusText}`)
//             }

//             // Extract filename
//             let fileName = path.basename(new URL(url).pathname) || `file-${Date.now()}`
//             const contentDisposition = response.headers.get('content-disposition')
//             if (contentDisposition?.includes('filename=')) {
//                 const match = contentDisposition.match(/filename="?([^"]+)"?/)
//                 if (match?.[1]) fileName = match[1]
//             }

//             finalFileName = getUniqueFileName(BUCKET_PATH, fileName)
//             finalFilePath = path.join(BUCKET_PATH, finalFileName)

//             const totalBytesHeader = response.headers.get('content-length')
//             totalBytes = totalBytesHeader ? parseInt(totalBytesHeader, 10) : 0

//             // Update progress with filename and size
//             downloadProgressStore.set(taskId, {
//                 status: 'downloading',
//                 totalBytes,
//                 downloadedBytes: 0,
//                 fileName: finalFileName,
//             })

//             // Stream download
//             const reader = response.body?.getReader()
//             if (!reader) throw new Error('No response body')

//             const chunks: Uint8Array[] = []
//             let downloadedBytes = 0

//             while (true) {
//                 const { done, value } = await reader.read()
//                 if (done) break

//                 chunks.push(value)
//                 downloadedBytes += value.length

//                 // Update progress
//                 downloadProgressStore.set(taskId, {
//                     status: 'downloading',
//                     totalBytes,
//                     downloadedBytes,
//                     fileName: finalFileName,
//                 })
//             }

//             buffer = Buffer.concat(chunks)
//         }

//         // ======================
//         // Write file (both cases)
//         // ======================
//         const file = Bun.file(finalFilePath)
//         const writer = file.writer()
//         await writer.write(buffer)
//         await writer.end()

//         const stats = fs.statSync(finalFilePath)
//         if (stats.size === 0) {
//             fs.unlinkSync(finalFilePath)
//             throw new Error('Downloaded file is empty')
//         }

//         // Success
//         downloadProgressStore.set(taskId, {
//             status: 'success',
//             totalBytes: stats.size,
//             downloadedBytes: stats.size,
//             fileName: finalFileName,
//             size: stats.size,
//             previewUrl: `/downloads/${encodeURIComponent(finalFileName)}?type=preview`,
//             downloadUrl: `/downloads/${encodeURIComponent(finalFileName)}`,
//             message: 'File saved successfully',
//         })

//         console.debug('✅ Download complete:', finalFileName)

//     } catch (err) {
//         const message = err instanceof Error ? err.message : 'Unknown error'
//         console.error('❌ Download failed:', message)

//         downloadProgressStore.set(taskId, {
//             status: 'error',
//             totalBytes: 0,
//             downloadedBytes: 0,
//             message,
//         })
//     }
// }

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
        await new Promise((resolve) => setTimeout(resolve, 1000))

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
        await new Promise((resolve) => setTimeout(resolve, 600))
        return c.json({ success: true, message: `Deleted ${filename}` })
    } catch (err) {
        console.error("Error deleting file:", err)
        return c.json({ success: false, message: "Error deleting file" }, 500)
    }
})

// app.get('/download-progress', (c) => {
//     return streamSSE(c, async (stream) => {
//         const sendAllProgress = async () => {
//             const activeDownloads: Record<string, DownloadProgress> = {}

//             downloadProgressStore.forEach((progress, taskId) => {
//                 if (progress.status === 'downloading' && progress.fileName) {
//                     activeDownloads[taskId] = progress
//                 }
//             })

//             // Send the full snapshot
//             await stream.writeSSE({
//                 event: 'progress',
//                 data: JSON.stringify(activeDownloads),
//             })

//             // Return true if there are active downloads (to keep streaming)
//             return Object.keys(activeDownloads).length > 0
//         }

//         // Send initial state
//         let hasActive = await sendAllProgress()

//         // If no active downloads now, we could close — but let's keep stream open
//         // in case new downloads start.

//         const interval = setInterval(async () => {
//             hasActive = await sendAllProgress()
//             // Optionally: if (!hasActive) { clearInterval(interval); await stream.close(); }
//         }, 3000)

//         stream.onAbort(() => {
//             clearInterval(interval)
//         })
//     })
// })
app.get('/download-progress', (c) => {
    //   // CORS (adjust origin as needed)
    c.header('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
    c.header('Access-Control-Allow-Credentials', 'true');

    return streamSSE(c, async (stream) => {
        let closed = false;

        const sendAllProgress = async () => {
            if (closed) return;

            const activeDownloads: Record<string, DownloadProgress> = {};
            downloadProgressStore.forEach((progress, taskId) => {
                if (progress.status === 'downloading' && progress.fileName) {
                    activeDownloads[taskId] = progress;
                }
            });

            if (Object.keys(activeDownloads).length > 0) {
                await stream.writeSSE({
                    event: 'progress',
                    data: JSON.stringify(activeDownloads),
                });
            } else {
                // Keep connection alive with a comment
                await stream.writeSSE({ event: 'progress', data: JSON.stringify({}) });
            }

            return Object.keys(activeDownloads).length > 0;
        };

        // Initial send
        await sendAllProgress();

        const interval = setInterval(() => {
            sendAllProgress().catch(console.error);
        }, 3000);

        stream.onAbort(() => {
            closed = true;
            clearInterval(interval);
            stream.close(); // Ensure cleanup
        });
    });
});

serve({
    fetch: app.fetch,
    port: PORT,
    hostname: "0.0.0.0"
})
