import React, { ChangeEvent, DragEvent, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Label } from './ui/label'
import SocialMediaLinks from './social-links'
import { useToast } from "@/components/ui/use-toast"
import FilePreview from './FilePreview'
import StepIndicator from './StepIndicator'
import { Loader2, ShieldCheck, UploadCloud } from 'lucide-react'
import { Badge } from './ui/badge'

type Props = {
    onReportConfirmation: (data: { redactedSummary: string; vaultId: string }) => void
}

const STEPS = [{ label: 'Upload' }, { label: 'Review' }, { label: 'Ask' }]

const ReportComponent = ({ onReportConfirmation }: Props) => {
    const { toast } = useToast()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const dragCounter = useRef(0)

    const [base64Data, setBase64Data] = useState('')
    const [selectedFile, setSelectedFile] = useState<File | null>(null)
    const [isDragging, setIsDragging] = useState(false)
    const [isLoading, setIsLoading] = useState(false);
    const [reportData, setReportData] = useState("");
    const [vaultId, setVaultId] = useState("");
    const [piiCount, setPiiCount] = useState(0);
    const [confirmed, setConfirmed] = useState(false);

    const currentStep = confirmed ? 3 : reportData ? 2 : 1;

    function processFile(file: File) {
        let isValidImage = false;
        let isValidDoc = false;
        const validImages = ['image/jpeg', 'image/png', 'image/webp'];
        const validDocs = ['application/pdf'];
        if (validImages.includes(file.type)) {
            isValidImage = true;
        }
        if (validDocs.includes(file.type)) {
            isValidDoc = true;
        }
        if (!(isValidImage || isValidDoc)) {
            toast({
                variant: 'destructive',
                description: "Filetype not supproted!",
            });
            return;
        }

        setSelectedFile(file);
        // Reset any previously extracted data when a new file is selected
        setReportData("");
        setVaultId("");
        setPiiCount(0);
        setConfirmed(false);

        if (isValidImage) {
            compressImage(file, (compressedFile) => {
                const reader = new FileReader();

                reader.onloadend = () => {
                    const base64String = reader.result as string;
                    setBase64Data(base64String);
                };

                reader.readAsDataURL(compressedFile);
            });
        }

        if (isValidDoc) {
            const reader = new FileReader();
            // Docs are not compressed. Might add note that upto 1MB supported. Or use server side compression libraries.
            reader.onloadend = () => {
                const base64String = reader.result as string;
                setBase64Data(base64String);
            };

            reader.readAsDataURL(file);
        }
    }

    function handleReportSelection(event: ChangeEvent<HTMLInputElement>): void {
        if (!event.target.files) return;
        const file = event.target.files[0];
        if (file) {
            processFile(file);
        }
    }

    function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
        event.preventDefault();
        dragCounter.current += 1;
        setIsDragging(true);
    }

    function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
        event.preventDefault();
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) {
            dragCounter.current = 0;
            setIsDragging(false);
        }
    }

    function handleDrop(event: DragEvent<HTMLDivElement>): void {
        event.preventDefault();
        dragCounter.current = 0;
        setIsDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) {
            processFile(file);
        }
    }

    function handleRemoveFile(): void {
        setSelectedFile(null);
        setBase64Data('');
        setReportData('');
        setVaultId('');
        setPiiCount(0);
        setConfirmed(false);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    }

    function compressImage(file: File, callback: (compressedFile: File) => void) {
        const reader = new FileReader();

        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                // Create a canvas element
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // Set  canvas dimensions to match the image
                canvas.width = img.width;
                canvas.height = img.height;

                // Draw the image onto the canvas
                ctx!.drawImage(img, 0, 0);


                // Apply basic compression (adjust quality as needed)
                const quality = 0.1; // Adjust quality as needed

                // Convert canvas to data URL
                const dataURL = canvas.toDataURL('image/jpeg', quality);

                // Convert data URL back to Blob
                const byteString = atob(dataURL.split(',')[1]);
                const ab = new ArrayBuffer(byteString.length);
                const ia = new Uint8Array(ab);
                for (let i = 0; i < byteString.length; i++) {
                    ia[i] = byteString.charCodeAt(i);

                }
                const compressedFile = new File([ab], file.name, { type: 'image/jpeg' });

                callback(compressedFile);
            };
            img.src = e.target!.result as string;
        };

        reader.readAsDataURL(file);
    }

    async function extractDetails(): Promise<void> {
        if (!base64Data) {
            toast({
                variant: 'destructive',
                description: "Upload a valid report!",
            });
            return;
        }
        setIsLoading(true);

        try {
            const response = await fetch("api/extractreportgemini", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    base64: base64Data,
                }),
            });

            if (response.ok) {
                const data = await response.json();
                setReportData(data.redactedSummary);
                setVaultId(data.vaultId);
                setPiiCount(data.piiCount);

                toast({
                    description: `Report processed! ${data.piiCount} PII entities redacted.`,
                });
            } else {
                // Without this the spinner just stops and nothing happens, so an unreadable
                // report looked identical to a report that produced no findings.
                const message = await response
                    .json()
                    .then((body) => body?.error)
                    .catch(() => null);

                toast({
                    variant: 'destructive',
                    description: message ?? "Couldn't process this report. Please try again.",
                });
            }
        } catch (error) {
            // A dropped connection or a gateway timeout on a slow report rejects the fetch
            // outright. Report it instead of leaving the spinner up with no explanation.
            console.error("Report extraction request failed:", error);
            toast({
                variant: 'destructive',
                description: "Couldn't reach the server. Check your connection and try again.",
            });
        } finally {
            // In a finally block so no path - success, error response, or thrown fetch -
            // can leave the upload stuck behind a permanent spinner.
            setIsLoading(false);
        }
    }

    return (
        <div className="grid w-full items-start gap-6 overflow-auto p-4 pt-0">
            <fieldset className='relative grid gap-5 rounded-lg border p-4'>
                <legend className="px-1 text-sm font-medium">Report</legend>

                <StepIndicator steps={STEPS} currentStep={currentStep} />

                {isLoading && (
                    <div
                        className={"absolute z-10 h-full w-full bg-card/90 rounded-lg flex flex-col items-center justify-center gap-2"
                        }
                    >
                        <Loader2 className="h-6 w-6 animate-spin text-[#D90013]" />
                        <span className="text-sm text-muted-foreground">Extracting &amp; redacting report...</span>
                    </div>
                )}

                <div className="grid gap-2">
                    <Label className="text-xs text-muted-foreground">Step 1 &middot; Upload report</Label>
                    {!selectedFile ? (
                        <div
                            onDragEnter={handleDragEnter}
                            onDragOver={(e) => e.preventDefault()}
                            onDragLeave={handleDragLeave}
                            onDrop={handleDrop}
                            onClick={() => fileInputRef.current?.click()}
                            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-all duration-150 ${
                                isDragging
                                    ? 'scale-[1.02] border-[#D90013] bg-[#D90013]/5 ring-4 ring-[#D90013]/10'
                                    : 'border-input hover:bg-accent/50'
                            }`}
                        >
                            <UploadCloud className={`h-8 w-8 transition-colors ${isDragging ? 'text-[#D90013]' : 'text-muted-foreground'}`} />
                            <p className="text-sm font-medium">
                                {isDragging ? 'Drop to upload' : 'Drag & drop your report here'}
                            </p>
                            <p className="text-xs text-muted-foreground">or click to browse &middot; PDF, JPG, PNG</p>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/png,image/jpeg,image/webp,application/pdf"
                                className="hidden"
                                onChange={handleReportSelection}
                            />
                        </div>
                    ) : (
                        <FilePreview file={selectedFile} previewUrl={base64Data} onRemove={handleRemoveFile} />
                    )}
                </div>

                <Button onClick={extractDetails} disabled={!selectedFile || isLoading}>
                    {isLoading ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Extracting...
                        </>
                    ) : (
                        "Upload & Extract"
                    )}
                </Button>

                <div className="grid gap-2">
                    <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground">Step 2 &middot; Review summary</Label>
                        {piiCount > 0 && (
                            <Badge variant="outline" className="gap-1 text-[11px] font-normal">
                                <ShieldCheck className="h-3 w-3 text-[#00B612]" /> {piiCount} PII redacted
                            </Badge>
                        )}
                    </div>
                    <Textarea
                        value={reportData}
                        onChange={(e) => {
                            setReportData(e.target.value);
                        }}
                        placeholder="Extracted data from the report will appear here. Get better recommendations by providing additional patient history and symptoms..."
                        className="min-h-72 resize-none border p-3 shadow-none focus-visible:ring-1" />
                </div>

                <div className="grid gap-1">
                    <Label className="text-xs text-muted-foreground">Step 3 &middot; Confirm</Label>
                    <Button
                        variant="destructive"
                        className="bg-[#D90013]"
                        onClick={() => {
                            if (!reportData || !vaultId) {
                                toast({
                                    variant: 'destructive',
                                    description: "Please upload and process a report first!",
                                });
                                return;
                            }
                            setConfirmed(true);
                            onReportConfirmation({ redactedSummary: reportData, vaultId });
                        }}
                    >
                        Looks Good, Start Chatting
                    </Button>
                </div>

                <div className='flex flex-row items-center justify-center gap-2 p-4'>
                    <Label>Share your thoughts </Label>
                    <SocialMediaLinks />
                </div>
            </fieldset>
        </div>
    )
}

export default ReportComponent
