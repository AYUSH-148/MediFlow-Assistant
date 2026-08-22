/**
 * Gold set for the semantic response cache.
 *
 * A cache hit rate measured on live traffic is not a quality measure - it rises when
 * users repeat themselves and falls when they do not, and it says nothing about whether
 * the answers being replayed were the right ones. What matters is the pair of rates the
 * threshold trades off:
 *
 *   - `paraphrase` pairs SHOULD hit. A miss is a wasted generation, and nothing worse.
 *   - `distinct` pairs MUST NOT hit. A hit here replays one question's answer for a
 *     different question, and because the answer is served from the static-answer path
 *     the user sees no indication that anything was reused.
 *
 * The distinct pairs are deliberately near-misses - "my LDL" against "my HDL", "ALT"
 * against "AST" - because those are the ones a cosine threshold can actually get wrong.
 * Pairing unrelated questions would produce a reassuring 0% false-hit rate that tested
 * nothing.
 */
export interface CachePair {
  id: string;
  reportId: string;
  /** Asked and cached first. */
  seed: string;
  /** Asked second; the cache is expected to hit or miss depending on `relation`. */
  probe: string;
  relation: "paraphrase" | "distinct";
  note?: string;
}

export const CACHE_PAIRS: readonly CachePair[] = [
  // -------------------------------------------------------------- should hit (rephrase)
  {
    id: "para-ldl",
    reportId: "metabolic-workup",
    seed: "What is my LDL cholesterol?",
    probe: "What's my LDL cholesterol level?",
    relation: "paraphrase",
  },
  {
    id: "para-cholesterol-high",
    reportId: "metabolic-workup",
    seed: "Is my cholesterol high?",
    probe: "Is my cholesterol level too high?",
    relation: "paraphrase",
  },
  {
    id: "para-vitamin-d",
    reportId: "metabolic-workup",
    seed: "Am I deficient in vitamin D?",
    probe: "Do I have a vitamin D deficiency?",
    relation: "paraphrase",
  },
  {
    id: "para-medications",
    reportId: "metabolic-workup",
    seed: "What medications am I currently taking?",
    probe: "Which medications am I on at the moment?",
    relation: "paraphrase",
  },
  {
    id: "para-ferritin",
    reportId: "hematology-workup",
    seed: "What is my ferritin?",
    probe: "What is my ferritin level?",
    relation: "paraphrase",
  },
  {
    id: "para-haemoglobin-spelling",
    reportId: "hematology-workup",
    seed: "How low is my haemoglobin?",
    probe: "How low is my hemoglobin?",
    relation: "paraphrase",
    note: "British and American spellings of the same word. A near-identical string that still has to survive the embedding round trip.",
  },
  {
    id: "para-tsh",
    reportId: "thyroid-panel",
    seed: "What is my TSH?",
    probe: "What's my TSH value?",
    relation: "paraphrase",
  },
  {
    id: "para-underactive",
    reportId: "thyroid-panel",
    seed: "Does this mean my thyroid is underactive?",
    probe: "Is my thyroid underactive based on this?",
    relation: "paraphrase",
  },
  {
    id: "para-fibrosis",
    reportId: "hepatic-panel",
    seed: "How much scarring is there on my liver?",
    probe: "How much liver scarring do I have?",
    relation: "paraphrase",
  },
  {
    id: "para-ckd-stage",
    reportId: "renal-panel",
    seed: "What stage is my kidney disease?",
    probe: "Which stage of kidney disease am I at?",
    relation: "paraphrase",
  },

  // ------------------------------------------------------------ must not hit (distinct)
  {
    id: "dist-ldl-hdl",
    reportId: "metabolic-workup",
    seed: "What is my LDL cholesterol?",
    probe: "What is my HDL cholesterol?",
    relation: "distinct",
    note: "One character apart in the surface form, opposite clinical meaning, different number in the report.",
  },
  {
    id: "dist-ldl-triglycerides",
    reportId: "metabolic-workup",
    seed: "What is my LDL cholesterol?",
    probe: "What are my triglycerides?",
    relation: "distinct",
  },
  {
    id: "dist-vitamin-d-b12",
    reportId: "metabolic-workup",
    seed: "Am I deficient in vitamin D?",
    probe: "Am I deficient in vitamin B12?",
    relation: "distinct",
  },
  {
    id: "dist-alt-ast",
    reportId: "hepatic-panel",
    seed: "What is my ALT?",
    probe: "What is my AST?",
    relation: "distinct",
  },
  {
    id: "dist-hepb-hepc",
    reportId: "hepatic-panel",
    seed: "Do I have hepatitis B?",
    probe: "Do I have hepatitis C?",
    relation: "distinct",
    note: "The report answers these differently - immune to B, actively infected with C - so a replay here is a clinically wrong answer, not a stale one.",
  },
  {
    id: "dist-ferritin-b12",
    reportId: "hematology-workup",
    seed: "What is my ferritin?",
    probe: "What is my vitamin B12?",
    relation: "distinct",
  },
  {
    id: "dist-platelets-white-cells",
    reportId: "hematology-workup",
    seed: "Why are my platelets elevated?",
    probe: "Why are my white cells elevated?",
    relation: "distinct",
    note: "The white cell count is normal, so a cache hit would assert an abnormality that does not exist.",
  },
  {
    id: "dist-tsh-t4",
    reportId: "thyroid-panel",
    seed: "What is my TSH?",
    probe: "What is my free T4?",
    relation: "distinct",
  },
  {
    id: "dist-creatinine-ck",
    reportId: "renal-panel",
    seed: "What is my creatinine?",
    probe: "What is my creatine kinase?",
    relation: "distinct",
    note: "Nearly the same token sequence for two unrelated analytes.",
  },
  {
    id: "dist-potassium-calcium",
    reportId: "renal-panel",
    seed: "Is my potassium dangerous?",
    probe: "Is my calcium dangerous?",
    relation: "distinct",
  },
];
