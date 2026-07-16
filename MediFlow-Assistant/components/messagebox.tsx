import React, { useState } from 'react'
import Markdown from './markdown'
import { Bot, Check, Copy, User } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'

type Props = {
  role: string,
  content: string,
  createdAt?: Date
}

function formatTime(date?: Date): string {
  if (!date) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const MessageBox = ({ role, content, createdAt }: Props) => {
  const [copied, setCopied] = useState(false)
  const isUser = role === "user"
  const timeLabel = formatTime(createdAt)

  function handleCopy() {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={cn("flex items-start gap-3", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-[#D90013] text-white" : "bg-muted text-foreground border"
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={cn("flex max-w-[85%] flex-col gap-1", isUser && "items-end")}>
        <div
          className={cn(
            "group relative rounded-2xl px-4 py-3 text-sm overflow-hidden",
            isUser
              ? "bg-[#D90013] text-white rounded-tr-sm"
              : "bg-muted rounded-tl-sm"
          )}
        >
          <div className={cn(isUser && "[&_a]:text-white [&_a]:underline")}>
            <Markdown text={content} />
          </div>
          {!isUser && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleCopy}
              className="absolute right-1.5 top-1.5 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
              title="Copy response"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          )}
          {!isUser && (
            <div className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
              <span className="font-medium">Disclaimer:</span> Informational purposes only —
              not a substitute for professional medical diagnosis, treatment, or advice.
            </div>
          )}
        </div>
        {timeLabel && (
          <span className="px-1 text-[11px] text-muted-foreground">{timeLabel}</span>
        )}
      </div>
    </div>
  )
}

export default MessageBox
