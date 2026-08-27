import { updateSessionSummary, readSessionId } from "@/lib/session";

export const maxDuration = 10;

/**
 * Bind the reviewed summary to the caller's session.
 *
 * The review step lets the user edit the extracted summary before chatting - the textarea
 * invites extra history and symptoms - so the summary cannot simply be read back from the
 * stored ingest result. It has to come from the client.
 *
 * What changes is where it lands. It used to travel in every chat request beside a
 * client-supplied vaultId, with nothing checking the two belonged together; one document's
 * id could be paired with another's summary and the answer would blend them. Now it is
 * written once, against a session that already names a document, so the pairing is decided
 * server-side and the chat request carries neither field.
 *
 * The summary is still user-controlled text that reaches a prompt. That is inherent to
 * letting people edit it, and is treated as untrusted input downstream.
 */
export async function POST(req: Request) {
  const sessionId = readSessionId(req);
  if (!sessionId) {
    return Response.json(
      { error: "No active report session. Upload a report first." },
      { status: 401 }
    );
  }

  let summary: unknown;
  try {
    ({ summary } = await req.json());
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (typeof summary !== "string" || summary.trim().length === 0) {
    return Response.json({ error: "A non-empty summary is required." }, { status: 400 });
  }

  // Fails when the session expired or never existed. A 401 rather than a 404: the client's
  // move is to upload again, not to retry this call.
  const updated = await updateSessionSummary(sessionId, summary);
  if (!updated) {
    return Response.json(
      { error: "Your report session expired. Please upload the report again." },
      { status: 401 }
    );
  }

  // Deliberately returns nothing about the document. The client has no use for its id and
  // giving it one would undo the point of holding it server-side.
  return Response.json({ ok: true });
}
