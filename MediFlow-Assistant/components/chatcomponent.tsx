import React from 'react'
import { Textarea } from './ui/textarea'
import { useChat } from 'ai/react';
import { Button } from './ui/button';
import { AlertTriangle, CornerDownLeft, Loader2, MessageCircle, RotateCcw, TextSearch, UploadCloud } from 'lucide-react';
import { Badge } from './ui/badge';
import Messages from './messages';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import Markdown from './markdown';

type Props = {
  reportData?: {
    redactedSummary: string;
  }
  onOpenReport?: () => void
}

const ChatComponent = ({ reportData, onOpenReport }: Props) => {
  const { messages, input, handleInputChange, handleSubmit, isLoading, data, error, reload } =
    useChat({
      api: "api/medichatgemini",
      // Without this the SDK rolls the user's own message back out of the transcript when
      // a request fails, so a failed turn erased the question that caused it. The default
      // is false in this version and is documented as changing in the next major.
      keepLastMessageOnError: true,
    });
  return (
    <div className="h-full bg-muted/50 relative flex flex-col min-h-0 rounded-xl p-4 gap-4">
      {reportData ? (
        <Badge
          variant={'outline'}
          className="absolute right-3 top-1.5 bg-[#00B612] text-white border-transparent"
        >
          ✓ Report Added
        </Badge>
      ) : (
        // On mobile the status badge doubles as a tappable shortcut to the upload drawer,
        // since the report panel is hidden below md. On desktop it stays a plain indicator.
        <button
          type="button"
          onClick={onOpenReport}
          className="absolute right-3 top-1.5 md:pointer-events-none"
          aria-label="Add a report"
        >
          <Badge variant={'outline'} className="gap-1 cursor-pointer md:cursor-default">
            <UploadCloud className="h-3 w-3 md:hidden" />
            <span className="md:hidden">Add report</span>
            <span className="hidden md:inline">No Report Added</span>
          </Badge>
        </button>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-muted-foreground">
            <MessageCircle className="h-8 w-8" />
            <p className="text-sm font-medium">Start the conversation</p>
            <p className="max-w-xs text-xs">
              {/* Kept in step with the query guard, which turns away anything that is not
                  health-related. Promising "anything else on your mind" here would set up
                  a refusal the user was invited into. */}
              {reportData
                ? "Ask a question about the uploaded report — a medication, a biomarker, or what a result means."
                : "Upload a medical report for tailored, private answers — or ask a general medical question below."}
            </p>
            {!reportData && (
              // Prominent CTA so mobile users know a report can be added; hidden on md+
              // where the upload panel is already visible beside the chat.
              <Button
                type="button"
                onClick={onOpenReport}
                className="mt-1 gap-1.5 bg-[#D90013] hover:bg-[#D90013]/90 md:hidden"
              >
                <UploadCloud className="h-4 w-4" />
                Upload a report
              </Button>
            )}
          </div>
        ) : (
          <Messages messages={messages} isLoading={isLoading} />
        )}
      </div>
      {(data?.length !== undefined && data.length > 0) && (
        <Accordion type="single" className="text-sm" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger dir="">
              <span className="flex flex-row items-center gap-2"><TextSearch /> Relevant Info</span>
            </AccordionTrigger>
            <AccordionContent className="whitespace-pre-wrap">
                <Markdown text={(data[data.length - 1] as any).retrievals as string} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
      {error && (
        // The route sends a plain-text reason with a real status, and useChat surfaces it
        // as error.message - so this shows what actually failed rather than a generic
        // "something went wrong". `reload` re-sends the last user message, which is still
        // in the transcript thanks to keepLastMessageOnError.
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-destructive">{error.message || "Couldn't get an answer. Try again."}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 gap-1.5"
              onClick={() => reload()}
              disabled={isLoading}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </div>
      )}
      <form
        className="relative overflow-hidden rounded-lg border bg-background"
        onSubmit={(event) => {
          event.preventDefault();
          // No document id and no summary: the server resolves both from the session
          // cookie, so a chat request carries nothing that names a document.
          handleSubmit(event);
        }}
      >
        <Textarea
          value={input}
          onChange={handleInputChange}
          onKeyDown={(event) => {
            // Enter submits; Shift+Enter inserts a newline.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!isLoading && input.trim()) {
                event.currentTarget.form?.requestSubmit();
              }
            }
          }}
          placeholder="Type your query here..."
          className="min-h-12 resize-none border-0 p-3 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center p-3 pt-0">
          <Button
            disabled={isLoading || !input.trim()}
            type="submit"
            size="sm"
            className="ml-auto gap-1.5 bg-[#D90013] hover:bg-[#D90013]/90"
          >
            {isLoading ? "Analysing..." : "Ask"}
            {isLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CornerDownLeft className="size-3.5" />
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}

export default ChatComponent