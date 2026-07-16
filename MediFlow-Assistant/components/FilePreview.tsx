import React from 'react'
import { Button } from './ui/button'
import { FileText, Image as ImageIcon, X, Maximize2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog'

type Props = {
  file: File
  previewUrl: string
  onRemove: () => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

const FilePreview = ({ file, previewUrl, onRemove }: Props) => {
  const isImage = file.type.startsWith('image/')
  const isPdf = file.type === 'application/pdf'

  return (
    <Dialog>
      <div className="rounded-lg border bg-background overflow-hidden">
        <div className="flex items-center gap-3 p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            {isImage && previewUrl ? (
              <img src={previewUrl} alt="" className="h-full w-full object-cover" />
            ) : isImage ? (
              <ImageIcon className="h-5 w-5 text-muted-foreground" />
            ) : (
              <FileText className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)} &middot; {isImage ? 'Image' : 'PDF'}
            </p>
          </div>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              title="View full preview"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            title="Remove file"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{file.name}</DialogTitle>
        </DialogHeader>
        {isImage && (
          <img
            src={previewUrl}
            alt={file.name}
            className="mx-auto max-h-[70vh] rounded object-contain"
          />
        )}
        {isPdf && (
          <iframe
            src={previewUrl}
            title={file.name}
            className="h-[70vh] w-full rounded border"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export default FilePreview
