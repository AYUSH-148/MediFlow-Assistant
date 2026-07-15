import React from 'react'
import { Textarea } from './ui/textarea'
import { useChat } from 'ai/react';
import { Button } from './ui/button';
import { CornerDownLeft, Loader2, MessageCircle, TextSearch } from 'lucide-react';
import { Badge } from './ui/badge';
import Messages from './messages';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import Markdown from './markdown';

type Props = {
  reportData?: {
    redactedSummary: string;
    vaultId: string;
  }
}

const ChatComponent = ({ reportData }: Props) => {
  const { messages, input, handleInputChange, handleSubmit, isLoading, data } =
    useChat({
      api: "api/medichatgemini",
    });
  return (
    <div className="h-full bg-muted/50 relative flex flex-col min-h-[50vh] rounded-xl p-4 gap-4">
      <Badge variant={'outline'}
        className={`absolute right-3 top-1.5 ${reportData && "bg-[#00B612] text-white border-transparent"}`}
      >
        {reportData ? "✓ Report Added" : "No Report Added"}

      </Badge>
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <MessageCircle className="h-8 w-8" />
            <p className="text-sm font-medium">Start the conversation</p>
            <p className="max-w-xs text-xs">
              {reportData
                ? "Ask a question about the uploaded report, or anything else on your mind."
                : "Upload a report on the left for tailored answers, or just ask a general question."}
            </p>
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
      <form
        className="relative overflow-hidden rounded-lg border bg-background"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit(event, {
            data: {
              reportData: reportData?.redactedSummary as string,
              vaultId: reportData?.vaultId as string,
            },
          });
        }}
      >
        <Textarea
          value={input}
          onChange={handleInputChange}
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