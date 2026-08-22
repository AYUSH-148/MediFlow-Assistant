/**
 * Gold set for retrieval and corrective-RAG grading.
 *
 * `expectedFacts` are verbatim strings from the fixture, written in "label value" form
 * ("Ferritin 6 ng/mL") rather than as a bare value. Two reasons: a bare "6 ng/mL" is a
 * substring of "26 ng/mL" elsewhere in the same report and would score a false hit, and
 * requiring the label means a chunk only counts when it carries the line that actually
 * answers the question, not merely a number that happens to appear in it.
 *
 * A case is a hit at rank k when any one of its facts appears in a retrieved chunk. Facts
 * are alternatives, not a conjunction - several lines can each answer "is my cholesterol
 * high" - and the fraction of facts covered is reported separately as fact recall.
 *
 * `expectedVerdict` is the grader label. The distinction that matters is `none` versus
 * anything else: confusing `relevant` with `partial` is a judgement call about how
 * completely the excerpts answer, while calling a covered question `none` sends the user
 * "your report does not contain this" about something it does contain. The suite scores
 * those two disagreements separately for that reason.
 */
export interface RetrievalCase {
  id: string;
  reportId: string;
  question: string;
  expectedFacts: string[];
  expectedVerdict: "relevant" | "partial" | "none";
  /** Why this case is labelled the way it is, where that is not self-evident. */
  note?: string;
}

export const RETRIEVAL_CASES: readonly RetrievalCase[] = [
  // ---------------------------------------------------------------- metabolic-workup
  {
    id: "met-ldl",
    reportId: "metabolic-workup",
    question: "What is my LDL cholesterol?",
    expectedFacts: ["LDL Cholesterol (calculated) 172 mg/dL"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-cholesterol-high",
    reportId: "metabolic-workup",
    question: "Is my cholesterol high?",
    expectedFacts: [
      "Total Cholesterol 268 mg/dL",
      "LDL Cholesterol (calculated) 172 mg/dL",
      "HDL Cholesterol 38 mg/dL",
    ],
    expectedVerdict: "relevant",
  },
  {
    id: "met-triglycerides",
    reportId: "metabolic-workup",
    question: "What were my triglycerides?",
    expectedFacts: ["Triglycerides 244 mg/dL"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-apob",
    reportId: "metabolic-workup",
    question: "What is my ApoB and what does it mean?",
    expectedFacts: ["Apolipoprotein B 128 mg/dL"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-a1c",
    reportId: "metabolic-workup",
    question: "Am I diabetic based on my HbA1c?",
    expectedFacts: ["Hemoglobin A1c 6.1 %", "Fasting Plasma Glucose 114 mg/dL"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-insulin-resistance",
    reportId: "metabolic-workup",
    question: "Do I have insulin resistance?",
    expectedFacts: ["HOMA-IR (calculated) 6.2"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-liver-enzymes",
    reportId: "metabolic-workup",
    question: "Are my liver enzymes abnormal?",
    expectedFacts: ["ALT (SGPT) 58 U/L", "AST (SGOT) 44 U/L"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-kidney",
    reportId: "metabolic-workup",
    question: "How are my kidneys doing?",
    expectedFacts: ["eGFR 88 mL/min/1.73m2"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-vitamin-d",
    reportId: "metabolic-workup",
    question: "Am I deficient in vitamin D?",
    expectedFacts: ["Vitamin D, 25-hydroxy 18 ng/mL"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-blood-pressure",
    reportId: "metabolic-workup",
    question: "What was my blood pressure reading?",
    expectedFacts: ["148/94 mmHg"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-inflammation",
    reportId: "metabolic-workup",
    question: "Is there any sign of inflammation in my results?",
    expectedFacts: ["hs-CRP 4.8 mg/L"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-ultrasound",
    reportId: "metabolic-workup",
    question: "What did my abdominal ultrasound show?",
    expectedFacts: ["moderate hepatic steatosis", "Liver is enlarged at 17.2 cm"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-carotid",
    reportId: "metabolic-workup",
    question: "Is there any plaque in my arteries?",
    expectedFacts: ["0.82 mm on the right", "non-calcified plaque"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-medications",
    reportId: "metabolic-workup",
    question: "What medications am I currently taking?",
    expectedFacts: ["Amlodipine 5 mg once daily", "Atorvastatin 10 mg once nightly"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-statin-change",
    reportId: "metabolic-workup",
    question: "Is my statin dose being changed?",
    expectedFacts: ["Increase atorvastatin from 10 mg to 40 mg nightly"],
    expectedVerdict: "relevant",
    note: "The answer is in the plan section, not the results tables - a chunk the lab-value questions never surface.",
  },
  {
    id: "met-allergies",
    reportId: "metabolic-workup",
    question: "What drug allergies are on file for me?",
    expectedFacts: ["Penicillin"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-uric-acid",
    reportId: "metabolic-workup",
    question: "Is my uric acid high enough to cause gout?",
    expectedFacts: ["Uric Acid 7.4 mg/dL"],
    expectedVerdict: "relevant",
  },
  {
    id: "met-ldl-and-psa",
    reportId: "metabolic-workup",
    question: "What are my LDL and my PSA results?",
    expectedFacts: ["LDL Cholesterol (calculated) 172 mg/dL"],
    expectedVerdict: "partial",
    note: "LDL is present, PSA was never ordered. The grader should answer the first half and flag the second as missing.",
  },
  {
    id: "met-psa",
    reportId: "metabolic-workup",
    question: "What is my PSA level?",
    expectedFacts: [],
    expectedVerdict: "none",
    note: "No prostate marker anywhere in this report. A confident answer here would be invented.",
  },
  {
    id: "met-bone-density",
    reportId: "metabolic-workup",
    question: "What did my bone density scan show?",
    expectedFacts: [],
    expectedVerdict: "none",
    note: "Imaging is present but it is ultrasound and carotid Doppler - a plausible near-miss for retrieval, which is the point.",
  },

  // --------------------------------------------------------------- hematology-workup
  {
    id: "hem-haemoglobin",
    reportId: "hematology-workup",
    question: "How low is my haemoglobin?",
    expectedFacts: ["Haemoglobin 9.2 g/dL"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-anaemia-type",
    reportId: "hematology-workup",
    question: "What type of anaemia do I have?",
    expectedFacts: [
      "Mean Corpuscular Volume (MCV) 71 fL",
      "microcytic hypochromic anaemia",
      "Ferritin 6 ng/mL",
    ],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-ferritin",
    reportId: "hematology-workup",
    question: "What is my ferritin?",
    expectedFacts: ["Ferritin 6 ng/mL"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-iron-saturation",
    reportId: "hematology-workup",
    question: "What is my transferrin saturation and is it low?",
    expectedFacts: ["Transferrin Saturation 7 %", "Total Iron Binding Capacity 412 ug/dL"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-platelets",
    reportId: "hematology-workup",
    question: "Why are my platelets elevated?",
    expectedFacts: ["Platelet Count 486 x10^9/L", "reactive thrombocytosis"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-blood-in-stool",
    reportId: "hematology-workup",
    question: "Was there any blood found in my stool sample?",
    expectedFacts: ["Faecal Occult Blood (FIT) Positive", "Faecal Calprotectin 142 ug/g"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-b12",
    reportId: "hematology-workup",
    question: "Is my B12 normal?",
    expectedFacts: ["Vitamin B12 388 pg/mL"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-fibroids",
    reportId: "hematology-workup",
    question: "How big are my fibroids?",
    expectedFacts: ["the largest 3.8 cm"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-thalassaemia",
    reportId: "hematology-workup",
    question: "Have I been checked for thalassaemia?",
    expectedFacts: ["Haemoglobin A2 2.4 %", "beta thalassaemia trait"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-iron-tablets",
    reportId: "hematology-workup",
    question: "Am I meant to change how I take my iron tablets?",
    expectedFacts: ["ferrous fumarate 210 mg on alternate days"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-blood-film",
    reportId: "hematology-workup",
    question: "What did the blood film show?",
    expectedFacts: ["Pencil cells and target cells are present"],
    expectedVerdict: "relevant",
  },
  {
    id: "hem-ferritin-and-a1c",
    reportId: "hematology-workup",
    question: "What are my ferritin and my HbA1c?",
    expectedFacts: ["Ferritin 6 ng/mL"],
    expectedVerdict: "partial",
    note: "No glycaemic testing in this workup.",
  },
  {
    id: "hem-a1c",
    reportId: "hematology-workup",
    question: "What is my HbA1c?",
    expectedFacts: [],
    expectedVerdict: "none",
  },
  {
    id: "hem-chest-xray",
    reportId: "hematology-workup",
    question: "What did my chest x-ray show?",
    expectedFacts: [],
    expectedVerdict: "none",
    note: "A pelvic ultrasound is present, so retrieval will surface imaging text that does not answer the question.",
  },

  // ------------------------------------------------------------------- thyroid-panel
  {
    id: "thy-tsh",
    reportId: "thyroid-panel",
    question: "What is my TSH?",
    expectedFacts: ["TSH 11.6 uIU/mL"],
    expectedVerdict: "relevant",
  },
  {
    id: "thy-underactive",
    reportId: "thyroid-panel",
    question: "Does this mean my thyroid is underactive?",
    expectedFacts: ["TSH 11.6 uIU/mL", "Free T4 0.71 ng/dL", "overt primary hypothyroidism"],
    expectedVerdict: "relevant",
  },
  {
    id: "thy-hashimoto",
    reportId: "thyroid-panel",
    question: "Is this Hashimoto's?",
    expectedFacts: ["Thyroid Peroxidase Antibody (anti-TPO) 486 IU/mL"],
    expectedVerdict: "relevant",
  },
  {
    id: "thy-cholesterol",
    reportId: "thyroid-panel",
    question: "Why is my cholesterol raised?",
    expectedFacts: ["Total Cholesterol 232 mg/dL", "secondary to hypothyroidism"],
    expectedVerdict: "relevant",
  },
  {
    id: "thy-nodules",
    reportId: "thyroid-panel",
    question: "Were any nodules found on my thyroid scan?",
    expectedFacts: ["No discrete nodule exceeding 5 mm is identified"],
    expectedVerdict: "relevant",
  },
  {
    id: "thy-dose",
    reportId: "thyroid-panel",
    question: "What dose of levothyroxine am I on?",
    expectedFacts: ["Levothyroxine 50 mcg once daily"],
    expectedVerdict: "relevant",
  },
  {
    id: "thy-recheck",
    reportId: "thyroid-panel",
    question: "When should I have my thyroid retested?",
    expectedFacts: ["Repeat TSH and free T4 in 6 weeks"],
    expectedVerdict: "relevant",
  },
  {
    id: "thy-tsh-and-kidneys",
    reportId: "thyroid-panel",
    question: "What is my TSH and how is my kidney function?",
    expectedFacts: ["TSH 11.6 uIU/mL"],
    expectedVerdict: "partial",
    note: "No creatinine or eGFR in this panel.",
  },
  {
    id: "thy-blood-pressure",
    reportId: "thyroid-panel",
    question: "What was my blood pressure?",
    expectedFacts: [],
    expectedVerdict: "none",
  },

  // ------------------------------------------------------------------- hepatic-panel
  {
    id: "hep-alt",
    reportId: "hepatic-panel",
    question: "How high are my liver enzymes?",
    expectedFacts: ["ALT (SGPT) 214 U/L", "AST (SGOT) 178 U/L"],
    expectedVerdict: "relevant",
  },
  {
    id: "hep-hepatitis",
    reportId: "hepatic-panel",
    question: "Do I have hepatitis C?",
    expectedFacts: [
      "Hepatitis C RNA, quantitative 1200000 IU/mL",
      "Hepatitis C Genotype 1a",
    ],
    expectedVerdict: "relevant",
  },
  {
    id: "hep-fibrosis",
    reportId: "hepatic-panel",
    question: "How much scarring is there on my liver?",
    expectedFacts: ["8.4 kPa"],
    expectedVerdict: "relevant",
  },
  {
    id: "hep-hep-b",
    reportId: "hepatic-panel",
    question: "Am I immune to hepatitis B?",
    expectedFacts: ["Hepatitis B Surface Antibody"],
    expectedVerdict: "relevant",
  },
  {
    id: "hep-ggt",
    reportId: "hepatic-panel",
    question: "What is my GGT?",
    expectedFacts: ["Gamma-Glutamyl Transferase 186 U/L"],
    expectedVerdict: "relevant",
  },
  {
    id: "hep-ferritin",
    reportId: "hepatic-panel",
    question: "Should I be worried about my high ferritin?",
    expectedFacts: ["Ferritin 284 ng/mL", "acute phase response"],
    expectedVerdict: "relevant",
  },
  {
    id: "hep-paracetamol",
    reportId: "hepatic-panel",
    question: "How much paracetamol can I safely take?",
    expectedFacts: ["not to exceed 2 g daily", "Cap paracetamol at 2 g per day"],
    expectedVerdict: "relevant",
  },
  {
    id: "hep-alt-and-a1c",
    reportId: "hepatic-panel",
    question: "What is my ALT and what is my HbA1c?",
    expectedFacts: ["ALT (SGPT) 214 U/L"],
    expectedVerdict: "partial",
  },
  {
    id: "hep-bone-density",
    reportId: "hepatic-panel",
    question: "What did my bone density scan show?",
    expectedFacts: [],
    expectedVerdict: "none",
  },

  // --------------------------------------------------------------------- renal-panel
  {
    id: "ren-egfr",
    reportId: "renal-panel",
    question: "What stage is my kidney disease?",
    expectedFacts: ["eGFR (CKD-EPI) 38 mL/min/1.73m2", "stage 3b chronic kidney disease"],
    expectedVerdict: "relevant",
  },
  {
    id: "ren-creatinine",
    reportId: "renal-panel",
    question: "What is my creatinine?",
    expectedFacts: ["Creatinine 1.84 mg/dL"],
    expectedVerdict: "relevant",
  },
  {
    id: "ren-potassium",
    reportId: "renal-panel",
    question: "Is my potassium dangerous?",
    expectedFacts: ["Potassium 5.4 mmol/L"],
    expectedVerdict: "relevant",
  },
  {
    id: "ren-protein-urine",
    reportId: "renal-panel",
    question: "Is there protein in my urine?",
    expectedFacts: ["Urine Albumin/Creatinine Ratio 340 mg/g"],
    expectedVerdict: "relevant",
  },
  {
    id: "ren-metformin",
    reportId: "renal-panel",
    question: "Do I need to change my metformin?",
    expectedFacts: ["the maximum is 1000 mg", "Review the metformin dose"],
    expectedVerdict: "relevant",
  },
  {
    id: "ren-anaemia",
    reportId: "renal-panel",
    question: "Why is my haemoglobin low?",
    expectedFacts: ["Haemoglobin 10.8 g/dL", "anaemia of chronic kidney disease"],
    expectedVerdict: "relevant",
  },
  {
    id: "ren-pth",
    reportId: "renal-panel",
    question: "What is my parathyroid hormone level?",
    expectedFacts: ["Parathyroid Hormone, intact 128 pg/mL"],
    expectedVerdict: "relevant",
  },
  {
    id: "ren-egfr-and-ldl",
    reportId: "renal-panel",
    question: "What is my eGFR and what is my LDL cholesterol?",
    expectedFacts: ["eGFR (CKD-EPI) 38 mL/min/1.73m2"],
    expectedVerdict: "partial",
    note: "Atorvastatin is on the medication list but no lipid result was measured, which is exactly the trap - a related mention that is not an answer.",
  },
  {
    id: "ren-thyroid",
    reportId: "renal-panel",
    question: "What are my thyroid function results?",
    expectedFacts: [],
    expectedVerdict: "none",
  },
];
