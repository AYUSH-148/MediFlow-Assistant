import React, { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Label } from './ui/label'
import SocialMediaLinks from './social-links'
import { useToast } from "@/components/ui/use-toast"
import FilePreview from './FilePreview'
import StepIndicator from './StepIndicator'
import { AlertTriangle, Loader2, ShieldAlert, ShieldCheck, UploadCloud } from 'lucide-react'
import { Badge } from './ui/badge'

type Props = {
    onReportConfirmation: (data: { redactedSummary: string; vaultId: string }) => void
}

const STEPS = [{ label: 'Upload' }, { label: 'Review' }, { label: 'Ask' }]

// Vercel caps a serverless request body at ~4.5MB. Multipart sends the bytes as-is, so
// unlike the previous base64 body there is no 33% inflation to budget for; the margin is
// for the multipart envelope itself.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

// Photos are downscaled rather than quality-crushed. The previous JPEG quality of 0.1
// existed only to fit a base64 body, and it destroyed exactly the fine print - decimal
// points in lab values - that the OCR path has to read. Capping the long edge keeps
// characters legible at a far smaller size than aggressive requantisation does.
const MAX_IMAGE_EDGE = 2000
const JPEG_QUALITY = 0.85

function formatMb(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1)
}

const ReportComponent = ({ onReportConfirmation }: Props) => {
    const { toast } = useToast()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const dragCounter = useRef(0)

    // The bytes actually uploaded: the original file for PDFs, the downscaled JPEG for
    // images. Kept separate from `selectedFile` so the preview still shows the file the
    // user picked, at its real name and size.
    const [uploadFile, setUploadFile] = useState<File | null>(null)
    const [previewUrl, setPreviewUrl] = useState('')
    const [selectedFile, setSelectedFile] = useState<File | null>(null)
    const [isDragging, setIsDragging] = useState(false)
    const [isLoading, setIsLoading] = useState(false);
    const [reportData, setReportData] = useState("");
    const [vaultId, setVaultId] = useState("");
    const [piiCount, setPiiCount] = useState(0);
    // Set when the route reports it read the document but could not index it. The report is
    // still worth showing - the summary is real - but retrieval has nothing to search, so
    // the chat would answer every question with "this is not in your report".
    const [unsearchable, setUnsearchable] = useState(false);
    const [confirmed, setConfirmed] = useState(false);

    const currentStep = confirmed ? 3 : reportData ? 2 : 1;

    // An object URL holds its blob alive until revoked, so each new preview has to release
    // the previous one - otherwise picking several files in a row leaks every one of them.
    useEffect(() => {
        if (!selectedFile) {
            setPreviewUrl('');
            return;
        }
        const url = URL.createObjectURL(selectedFile);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [selectedFile]);

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
                description: "File type not supported!",
            });
            return;
        }

        // A PDF is sent untouched, so its size can be checked now. An image is checked
        // after downscaling instead - a 12MP phone photo routinely exceeds the limit as
        // shot and comes in well under it once resized, so rejecting it here would turn a
        // working upload into an error.
        if (isValidDoc && file.size > MAX_UPLOAD_BYTES) {
            toast({
                variant: 'destructive',
                description: `PDF is too large (${formatMb(file.size)}MB). The limit is ${formatMb(MAX_UPLOAD_BYTES)}MB.`,
            });
            return;
        }

        setSelectedFile(file);
        // Drop anything extracted from the previous file.
        setUploadFile(null);
        setReportData("");
        setVaultId("");
        setPiiCount(0);
        setUnsearchable(false);
        setConfirmed(false);

        if (isValidImage) {
            // An image that already fits, at a resolution the vision model can read, is sent
            // untouched. Re-encoding it would be a lossy round trip for nothing - and a PNG
            // screenshot of a report picks up JPEG ringing around exactly the small text the
            // OCR path depends on.
            if (file.size <= MAX_UPLOAD_BYTES) {
                measureImage(file, (withinEdgeCap) => {
                    if (withinEdgeCap) {
                        setUploadFile(file);
                    } else {
                        downscaleAndSet(file);
                    }
                });
            } else {
                downscaleAndSet(file);
            }
        }

        if (isValidDoc) {
            // PDFs go up as-is; the route handles the text-layer/OCR split.
            setUploadFile(file);
        }
    }

    function downscaleAndSet(file: File) {
        downscaleImage(file, (downscaled) => {
            if (downscaled.size > MAX_UPLOAD_BYTES) {
                toast({
                    variant: 'destructive',
                    description: `Image is still too large after resizing (${formatMb(downscaled.size)}MB). Try a smaller photo.`,
                });
                handleRemoveFile();
                return;
            }
            setUploadFile(downscaled);
        });
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
        setUploadFile(null);
        setReportData('');
        setVaultId('');
        setPiiCount(0);
        setUnsearchable(false);
        setConfirmed(false);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    }

    // Decode just far enough to read the dimensions, to decide whether a re-encode is
    // needed at all. An image that fails to decode is reported as within the cap so the
    // caller uploads it as-is and the server owns the rejection - the browser refusing to
    // render a file is not proof the vision model cannot read it.
    function measureImage(file: File, callback: (withinEdgeCap: boolean) => void) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            callback(Math.max(img.width, img.height) <= MAX_IMAGE_EDGE);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            callback(true);
        };
        img.src = url;
    }

    // Re-encode a photo as a JPEG that is bounded by its longest edge rather than by
    // quality. `canvas.toBlob` hands back the bytes directly - the old path went through a
    // base64 data URL and an atob loop only because the request body needed base64 anyway.
    function downscaleImage(file: File, callback: (resized: File) => void) {
        const url = URL.createObjectURL(file);
        const img = new Image();

        img.onload = () => {
            URL.revokeObjectURL(url);

            const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);

            canvas.toBlob(
                (blob) => {
                    if (!blob) {
                        toast({
                            variant: 'destructive',
                            description: "Couldn't read that image. Try a different file.",
                        });
                        return;
                    }
                    callback(new File([blob], file.name, { type: 'image/jpeg' }));
                },
                'image/jpeg',
                JPEG_QUALITY
            );
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            toast({
                variant: 'destructive',
                description: "Couldn't read that image. Try a different file.",
            });
        };

        img.src = url;
    }

    async function extractDetails(): Promise<void> {
        if (!uploadFile) {
            toast({
                variant: 'destructive',
                description: "Upload a valid report!",
            });
            return;
        }
        setIsLoading(true);

        try {
            const body = new FormData();
            body.append("file", uploadFile);

            // No Content-Type header: the browser has to set it, because multipart needs a
            // generated boundary token appended to the media type. Setting it by hand omits
            // the boundary and the server cannot parse the body.
            const response = await fetch("api/extractreportgemini", {
                method: "POST",
                body,
            });

            if (response.ok) {
                const data = await response.json();
                setReportData(data.redactedSummary);
                setVaultId(data.vaultId);
                setPiiCount(data.piiCount);
                // `searchable: false` means indexing failed, which the route used to swallow
                // into an unqualified 200. Note this is not `chunkCount === 0`: a re-upload
                // skips indexing because the vectors already exist, so the count is 0 on a
                // healthy path too. The route says which case it was.
                const searchable = data.searchable !== false;
                setUnsearchable(!searchable);

                toast(
                    searchable
                        ? { description: `Report processed! ${data.piiCount} PII entities redacted.` }
                        : {
                              variant: 'destructive',
                              description:
                                  "Report read, but it couldn't be indexed for search. Asking about it won't work yet - please upload it again.",
                          }
                );
            } else {
                // The route returns a human-readable `error` for a rejected upload (400) or
                // a document it couldn't read (422); surface that rather than a generic
                // failure.
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
            // A dropped connection or gateway timeout rejects the fetch outright.
            console.error("Report extraction request failed:", error);
            toast({
                variant: 'destructive',
                description: "Couldn't reach the server. Check your connection and try again.",
            });
        } finally {
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
                        <FilePreview file={selectedFile} previewUrl={previewUrl} onRemove={handleRemoveFile} />
                    )}
                </div>

                <Button onClick={extractDetails} disabled={!uploadFile || isLoading}>
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
                        {reportData && (
                            piiCount > 0 ? (
                                <Badge variant="outline" className="gap-1 text-[11px] font-normal">
                                    <ShieldCheck className="h-3 w-3 text-[#00B612]" /> {piiCount} PII redacted
                                </Badge>
                            ) : (
                                // Previously this rendered nothing, so "redaction matched
                                // nothing" looked the same as "no report yet". The rules are
                                // label-anchored, so a report whose identifiers are in prose
                                // rather than under a `Patient:` label produces this - and it
                                // is the one case where the summary below may still carry a
                                // name. Worth saying out loud rather than leaving as a 0.
                                <Badge variant="outline" className="gap-1 text-[11px] font-normal">
                                    <ShieldAlert className="h-3 w-3 text-amber-500" /> No PII detected — check the summary
                                </Badge>
                            )
                        )}
                    </div>
                    {unsearchable && (
                        // Persistent, not just a toast: the toast is gone in seconds and the
                        // consequence is not - confirming from here leads to a chat that
                        // denies every question about a report it cannot search.
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs"
                        >
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                            <p className="text-destructive">
                                This report was read but not indexed for search, so the chat
                                won&apos;t be able to look anything up in it. The summary below is
                                still accurate — upload the report again to enable questions.
                            </p>
                        </div>
                    )}
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
                        {/* Not disabled: the summary is real and worth reading, and blocking
                            would take that away over a failure the user did not cause. But the
                            label has to carry the consequence, so the choice is not made blind
                            by someone who scrolled past the warning above. */}
                        {unsearchable ? "Continue without search" : "Looks Good, Start Chatting"}
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
