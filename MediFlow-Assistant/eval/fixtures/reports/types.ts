/**
 * A synthetic report standing in for an uploaded document.
 *
 * `summary` matters as much as `text`. Production never retrieves against the bare
 * question - the chat route prepends the extraction summary to it:
 *
 *   `Represent this for searching relevant passages: patient medical report says:
 *    ${reportData}. ${question}`
 *
 * so a harness that queried with the question alone would be measuring a retrieval path
 * the app does not have. Each fixture therefore carries a hand-written summary in the
 * shape the ingest route's extraction prompt asks for (~100 words, abnormal biomarkers
 * with values), and the suites build the query exactly as the route does.
 */
export interface FixtureReport {
  id: string;
  title: string;
  /**
   * Whether the report is longer than the retrieval topK of 10 chunks.
   *
   * `large` reports force retrieval to rank and discard. `medium` and `small` ones fit
   * inside topK, so every chunk comes back regardless of the question and recall@10 is
   * 100% by construction. Both regimes are real - most uploads are small - but they mean
   * different things, so the suites report them separately rather than averaging a
   * meaningful number together with a tautological one.
   */
  size: "large" | "medium" | "small";
  summary: string;
  text: string;
}
