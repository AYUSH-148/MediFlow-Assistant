import type { Metadata } from "next";
import { Inter, Source_Code_Pro } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
// import { Toaster } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster"

const inter = Inter({ subsets: ["latin"] });
const source_code_pro = Source_Code_Pro({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MediFlow Assistant",
  description: "Your smart AI companion for understanding medical reports. Extract key findings, ask questions, and get personalized health insights using state-of-the-art RAG technology powered by Gemini and Pinecone.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={source_code_pro.className}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
