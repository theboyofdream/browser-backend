import * as path from "path"
import * as fs from "fs"

export function formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

export function getUniqueFileName(bucketPath: string, originalName: string): string {
    const ext = path.extname(originalName)
    const baseName = path.basename(originalName, ext)

    let counter = 1
    let newName = originalName

    while (fs.existsSync(path.join(bucketPath, newName))) {
        newName = `${baseName} (${counter})${ext}`
        counter++
    }

    return newName
}
