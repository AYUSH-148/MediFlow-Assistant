"use client";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Bot, Info, UploadCloud } from "lucide-react";
import Link from "next/link";
import { ModeToggle } from "@/components/modetoggle";
import { useState } from "react";
import ReportComponent from "@/components/ReportComponent";
import { useToast } from "@/components/ui/use-toast"
import ChatComponent from "@/components/chatcomponent";

const Home = () => {
  const { toast } = useToast()

  const [reportData, setreportData] = useState<{ redactedSummary: string } | undefined>(undefined);
  const [reportDrawerOpen, setReportDrawerOpen] = useState(false);
  const onReportConfirmation = (data: { redactedSummary: string }) => {
    setreportData(data);
    setReportDrawerOpen(false);
    toast({
      description: "Report processed with PII protection!"
    });
  }

  return (
    <div className="grid h-screen w-full">
      <div className="flex flex-col">
        <header className="sticky top-0 z-10 flex h-[57px] bg-background items-center gap-2 border-b px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[#D90013] text-white">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <h1 className="flex flex-row text-2xl font-semibold text-[#D90013]">
            MediFlow
          </h1>
          <div className="w-full flex flex-row items-center justify-end gap-2">
            <Button asChild variant="ghost" size="icon" aria-label="About MediFlow">
              <Link href="/about">
                <Info className="h-5 w-5" />
              </Link>
            </Button>
            <ModeToggle />
            {/* Mobile-only: an explicit, labelled upload entry point. The report panel is
                hidden below md, so without this a phone user has no cue to add a report. */}
            <Drawer open={reportDrawerOpen} onOpenChange={setReportDrawerOpen}>
              <DrawerTrigger asChild>
                <Button
                  size="sm"
                  className="md:hidden gap-1.5 bg-[#D90013] hover:bg-[#D90013]/90"
                >
                  <UploadCloud className="h-4 w-4" />
                  {reportData ? "Report ✓" : "Upload"}
                </Button>
              </DrawerTrigger>
              <DrawerContent className="max-h-[85vh]">
                <DrawerHeader className="pb-0 text-left">
                  <DrawerTitle>Upload your report</DrawerTitle>
                  <DrawerDescription>
                    Add a medical report (PDF or image) for tailored answers. Personal
                    details are redacted before anything is processed.
                  </DrawerDescription>
                </DrawerHeader>
                <div className="min-h-0 overflow-y-auto">
                  <ReportComponent onReportConfirmation={onReportConfirmation} />
                </div>
              </DrawerContent>
            </Drawer>
          </div>
        </header>
        <main className="grid flex-1 min-h-0 gap-4 overflow-hidden p-4
        grid-rows-[minmax(0,1fr)]
        md:grid-cols-2
        lg:grid-cols-3"
        >
          <div
            className="hidden md:flex flex-col min-h-0 overflow-y-auto"
          >
            <ReportComponent onReportConfirmation={onReportConfirmation} />
          </div>
          <div
            className="lg:col-span-2 min-h-0"
          >
            <ChatComponent
              reportData={reportData}
              onOpenReport={() => setReportDrawerOpen(true)}
            />
          </div>
        </main>
      </div>
    </div>
  );
};

export default Home;
