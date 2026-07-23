import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Bot,
  FileText,
  MessagesSquare,
  Network,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About · MediFlow Assistant",
  description:
    "How MediFlow turns a medical report into private, tailored answers — extraction, PII redaction, and retrieval-augmented chat.",
};

const STEPS = [
  {
    icon: FileText,
    title: "1 · Upload & extract",
    body: "Upload a report as a PDF or image. Born-digital PDFs are read directly; scanned pages and photos are transcribed with Gemini vision. A short summary and key findings are pulled out.",
  },
  {
    icon: ShieldCheck,
    title: "2 · Redact PII",
    body: "Before anything is stored or sent to the model, personal details — names, IDs, contact info — are replaced with tokens. Your answers are re-personalised only at the very end, on your device's response.",
  },
  {
    icon: MessagesSquare,
    title: "3 · Ask questions",
    body: "Ask anything about the report. Relevant passages are retrieved with a hybrid semantic + keyword search and handed to the model as grounding context for a factual answer.",
  },
  {
    icon: Network,
    title: "4 · Knowledge graph",
    body: "Medical entities and their relationships are stored as a graph, so the assistant can follow connections — like what a drug treats or interacts with — while it answers.",
  },
];

const FEATURES = [
  "PII redaction before storage and inference",
  "Hybrid retrieval (vector + TF-IDF, fused with RRF)",
  "GraphRAG enrichment via a medical knowledge graph",
  "Semantic caching for fast, repeatable answers",
  "Works with PDFs, scans, and photos of reports",
];

const AboutPage = () => {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex h-[57px] items-center gap-2 border-b bg-background px-4">
        <Button asChild variant="ghost" size="icon" aria-label="Back to app">
          <Link href="/">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[#D90013] text-white">
          <Bot className="h-4 w-4" />
        </div>
        <h1 className="text-xl font-semibold text-[#D90013]">MediFlow</h1>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
        <div className="flex flex-col gap-3">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-[#D90013]" /> About
          </span>
          <h2 className="text-2xl font-semibold sm:text-3xl">
            Understand your medical reports, privately.
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
            MediFlow is an AI assistant that reads a clinical report, redacts personal
            information, and lets you ask questions about it in plain language. It combines
            retrieval-augmented generation with a medical knowledge graph so answers stay
            grounded in your report — not guesswork.
          </p>
        </div>

        <section className="mt-10">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            How it works
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {STEPS.map((step) => (
              <div
                key={step.title}
                className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4"
              >
                <step.icon className="h-5 w-5 text-[#D90013]" />
                <p className="text-sm font-medium">{step.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            What&apos;s inside
          </h3>
          <ul className="flex flex-col gap-2">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#00B612]" />
                <span className="text-muted-foreground">{feature}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10 rounded-lg border border-[#D90013]/20 bg-[#D90013]/5 p-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            <strong className="text-foreground">Not medical advice.</strong> MediFlow is an
            informational tool to help you understand a report. Always consult a qualified
            healthcare professional for diagnosis and treatment decisions.
          </p>
        </section>

        <div className="mt-10 flex justify-center">
          <Button asChild className="gap-1.5 bg-[#D90013] hover:bg-[#D90013]/90">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" /> Back to the assistant
            </Link>
          </Button>
        </div>
      </main>
    </div>
  );
};

export default AboutPage;
