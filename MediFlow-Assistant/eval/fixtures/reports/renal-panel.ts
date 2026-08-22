import type { FixtureReport } from "./types";

/**
 * Small fixture - a two-page result slip, the shortest thing a user realistically
 * uploads. It splits into a handful of chunks, so this is the clearest case of retrieval
 * having nothing to select between.
 */
export const renalPanel: FixtureReport = {
  id: "renal-panel",
  title: "Renal function panel",
  size: "small",

  summary:
    "Renal Function Panel. Creatinine is elevated at 1.84 mg/dL with an eGFR of 38 " +
    "mL/min/1.73m2, indicating stage 3b chronic kidney disease. Urea is raised at 48 " +
    "mg/dL and potassium is high at 5.4 mmol/L. Urine albumin to creatinine ratio is " +
    "markedly abnormal at 340 mg/g. Haemoglobin is low at 10.8 g/dL and phosphate is " +
    "raised at 5.1 mg/dL, both consistent with CKD. Parathyroid hormone is elevated at " +
    "128 pg/mL. Nephrology referral has been made.",

  text: `WESTMOOR RENAL DIAGNOSTICS
Renal Function Panel

Patient: Kwame Boateng
MRN: WRD-9915672
DOB: 21/12/1962
Sex: Male           Age: 63
Phone: 312-555-0175
Ordering Physician: Dr. Fiona Ashworth
Specimen Collected: 22/05/2026 08:00
Report Released: 22/05/2026 17:30
Clinical Indication: Monitoring of chronic kidney disease in a diabetic patient

RENAL FUNCTION

Test                              Result              Reference Range     Flag
Creatinine                        1.84 mg/dL          0.70 - 1.30         HIGH
eGFR (CKD-EPI)                    38 mL/min/1.73m2    > 60                LOW
Blood Urea Nitrogen               48 mg/dL            7 - 20              HIGH
Cystatin C                        1.92 mg/L           0.62 - 1.15         HIGH
Urine Albumin/Creatinine Ratio    340 mg/g            < 30                HIGH

Comment: An eGFR of 38 mL/min/1.73m2 places this patient in stage 3b chronic kidney
disease. An albumin to creatinine ratio of 340 mg/g is in the severely increased range
(A3) and is an independent predictor of progression, which is why the staging must be
reported with both the eGFR and the albuminuria category rather than the eGFR alone.

ELECTROLYTES AND MINERAL METABOLISM

Test                              Result         Reference Range      Flag
Sodium                            138 mmol/L     136 - 145            NORMAL
Potassium                         5.4 mmol/L     3.5 - 5.1            HIGH
Bicarbonate                       19 mmol/L      22 - 29              LOW
Calcium, corrected                8.4 mg/dL      8.6 - 10.2           LOW
Phosphate                         5.1 mg/dL      2.5 - 4.5            HIGH
Parathyroid Hormone, intact       128 pg/mL      15 - 65              HIGH
Vitamin D, 25-hydroxy             21 ng/mL       30 - 100             LOW

Comment: The combination of a raised phosphate, a low corrected calcium and a
parathyroid hormone of 128 pg/mL describes secondary hyperparathyroidism of chronic
kidney disease. The bicarbonate of 19 mmol/L indicates a metabolic acidosis, which
independently accelerates CKD progression and bone disease.

HAEMATOLOGY

Test                              Result         Reference Range      Flag
Haemoglobin                       10.8 g/dL      13.5 - 17.5          LOW
MCV                               88 fL          80 - 100             NORMAL
Ferritin                          142 ng/mL      30 - 400             NORMAL
Transferrin Saturation            24 %           20 - 50              NORMAL

Comment: A normocytic anaemia with adequate iron stores is the expected pattern of
anaemia of chronic kidney disease, driven by reduced erythropoietin production.

CLINICAL HISTORY AND MEDICATIONS

History: Type 2 diabetes for eighteen years and hypertension for twelve. No haematuria,
no flank pain, no reduction in urine output. Mild ankle swelling reported in the
evenings. No prior dialysis. Blood pressure today 152/88 mmHg.

Current Medications:
  Ramipril 10 mg once daily
  Metformin 500 mg twice daily
  Empagliflozin 10 mg once daily
  Atorvastatin 20 mg once nightly
  Furosemide 40 mg once daily

Allergies: No known drug allergies.

ASSESSMENT AND PLAN

Assessment: Stage 3b chronic kidney disease with severely increased albuminuria,
secondary to long-standing diabetes and hypertension. Complicated by hyperkalaemia,
metabolic acidosis, secondary hyperparathyroidism and anaemia of chronic kidney disease.

Plan:
  1. Nephrology referral, routine.
  2. Review the metformin dose - at an eGFR of 38 mL/min/1.73m2 the maximum is 1000 mg
     daily, and it must be stopped below 30.
  3. Dietary potassium restriction and repeat potassium in one week. Continue ramipril
     for its albuminuria benefit unless the potassium exceeds 5.5 mmol/L.
  4. Sodium bicarbonate 500 mg twice daily for the metabolic acidosis.
  5. Cholecalciferol replacement, then reassess parathyroid hormone in 3 months.
  6. Repeat renal function and albumin to creatinine ratio in 3 months.

Next review: 22/08/2026.

Reported by: Dr. Fiona Ashworth
Verified by: Dr. Helena Barros, Consultant Nephrologist`,
};
