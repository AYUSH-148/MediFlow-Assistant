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
  // The pairs above are close rewordings. The ones below are looser - abbreviations,
  // spelling variants and changed sentence shape - because a threshold tuned only on
  // near-identical strings would look safe and then miss real users' phrasing.
  {
    id: "para-hba1c",
    reportId: "metabolic-workup",
    seed: "What is my HbA1c?",
    probe: "What's my A1C result?",
    relation: "paraphrase",
  },
  {
    id: "para-triglycerides",
    reportId: "metabolic-workup",
    seed: "What are my triglycerides?",
    probe: "What is my triglyceride level?",
    relation: "paraphrase",
  },
  {
    id: "para-anaemia",
    reportId: "hematology-workup",
    seed: "Do I have anaemia?",
    probe: "Am I anemic?",
    relation: "paraphrase",
    note: "Spelling variant and a change of word form at once.",
  },
  {
    id: "para-platelets",
    reportId: "hematology-workup",
    seed: "What is my platelet count?",
    probe: "How many platelets do I have?",
    relation: "paraphrase",
  },
  {
    id: "para-b12-low",
    reportId: "hematology-workup",
    seed: "Is my vitamin B12 low?",
    probe: "Is my B12 level low?",
    relation: "paraphrase",
  },
  {
    id: "para-free-t4",
    reportId: "thyroid-panel",
    seed: "What is my free T4?",
    probe: "What's my FT4 level?",
    relation: "paraphrase",
  },
  {
    id: "para-liver-enzymes",
    reportId: "hepatic-panel",
    seed: "Are my liver enzymes raised?",
    probe: "Are my liver enzymes elevated?",
    relation: "paraphrase",
  },
  {
    id: "para-hepc-infected",
    reportId: "hepatic-panel",
    seed: "Do I have hepatitis C?",
    probe: "Am I infected with hep C?",
    relation: "paraphrase",
  },
  {
    id: "para-egfr-expanded",
    reportId: "renal-panel",
    seed: "What is my eGFR?",
    probe: "What is my estimated glomerular filtration rate?",
    relation: "paraphrase",
    note: "Abbreviation against its expansion: the hardest paraphrase here, likely to score lowest.",
  },
  {
    id: "para-kidney-function",
    reportId: "renal-panel",
    seed: "How well are my kidneys working?",
    probe: "Is my kidney function okay?",
    relation: "paraphrase",
  },
  {
    id: "para-potassium-worried",
    reportId: "renal-panel",
    seed: "Is my potassium dangerous?",
    probe: "Should I be worried about my potassium?",
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
  // Added after the move to gemini-embedding-001, whose first run put LDL/HDL at 0.973
  // against a lowest paraphrase of 0.980. A gap that narrow on ten distinct pairs is not
  // evidence of a safe threshold, so these probe it with more near-misses of the same
  // kind: one token changed, or the same analyte with the opposite direction or meaning.
  {
    id: "dist-t3-t4",
    reportId: "thyroid-panel",
    seed: "What is my free T3?",
    probe: "What is my free T4?",
    relation: "distinct",
    note: "One character apart, like LDL/HDL.",
  },
  {
    id: "dist-hyper-hypothyroid",
    reportId: "thyroid-panel",
    seed: "Do I have hyperthyroidism?",
    probe: "Do I have hypothyroidism?",
    relation: "distinct",
    note: "Opposite conditions, two letters apart.",
  },
  {
    id: "dist-hba1c-glucose",
    reportId: "metabolic-workup",
    seed: "What is my HbA1c?",
    probe: "What is my fasting glucose?",
    relation: "distinct",
  },
  {
    id: "dist-total-chol-ldl",
    reportId: "metabolic-workup",
    seed: "What is my total cholesterol?",
    probe: "What is my LDL cholesterol?",
    relation: "distinct",
  },
  {
    id: "dist-vitamin-d-dose",
    reportId: "metabolic-workup",
    seed: "What is my vitamin D level?",
    probe: "How much vitamin D should I take?",
    relation: "distinct",
    note: "Same analyte, different intent: a reported value against dosing advice.",
  },
  {
    id: "dist-haemoglobin-high-low",
    reportId: "hematology-workup",
    seed: "Is my haemoglobin too low?",
    probe: "Is my haemoglobin too high?",
    relation: "distinct",
    note: "One word flips the question; a replay answers the opposite one.",
  },
  {
    id: "dist-ferritin-iron",
    reportId: "hematology-workup",
    seed: "What is my ferritin?",
    probe: "What is my serum iron?",
    relation: "distinct",
  },
  {
    id: "dist-mcv-mch",
    reportId: "hematology-workup",
    seed: "What is my MCV?",
    probe: "What is my MCH?",
    relation: "distinct",
  },
  {
    id: "dist-alp-alt",
    reportId: "hepatic-panel",
    seed: "What is my ALP?",
    probe: "What is my ALT?",
    relation: "distinct",
  },
  {
    id: "dist-hbsag-antibody",
    reportId: "hepatic-panel",
    seed: "Am I positive for hepatitis B surface antigen?",
    probe: "Am I positive for hepatitis B surface antibody?",
    relation: "distinct",
    note: "Antigen positive means infected, antibody positive means immune - the most dangerous replay in the set.",
  },
  {
    id: "dist-egfr-creatinine",
    reportId: "renal-panel",
    seed: "What is my eGFR?",
    probe: "What is my creatinine?",
    relation: "distinct",
  },
  {
    id: "dist-sodium-potassium",
    reportId: "renal-panel",
    seed: "Is my sodium low?",
    probe: "Is my potassium low?",
    relation: "distinct",
  },
  {
    id: "dist-urea-uric-acid",
    reportId: "renal-panel",
    seed: "What is my urea?",
    probe: "What is my uric acid?",
    relation: "distinct",
  },
];
