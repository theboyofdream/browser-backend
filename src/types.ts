export interface FileInfo {
    name: string
    size: number
    sizeFormatted: string
    modified: Date
    downloadUrl: string
    previewUrl: string
}

export interface DownloadProgress {
  status: 'downloading' | 'success' | 'error'
  fileName?: string
  totalBytes: number
  downloadedBytes: number
  message?: string
  previewUrl?: string
  downloadUrl?: string
  size?: number
}
