import type { FixtureReport } from "./types";

/**
 * Medium fixture: a single-panel report of the kind most users actually upload. It
 * splits into fewer chunks than the retrieval topK of 10, so every chunk is returned for
 * every question and the grader is the only stage doing any filtering.
 */
export const thyroidPanel: FixtureReport = {
  id: "thyroid-panel",
  title: "Thyroid function panel with autoantibodies",
  size: "medium",

  summary:
    "Thyroid Function Panel. TSH is markedly elevated at 11.6 uIU/mL against a reference " +
    "range of 0.45 to 4.50, with a low free T4 of 0.71 ng/dL, consistent with overt " +
    "primary hypothyroidism. Thyroid peroxidase antibodies are strongly positive at 486 " +
    "IU/mL, indicating Hashimoto thyroiditis as the underlying cause. Total cholesterol " +
    "is secondarily raised at 232 mg/dL. Ultrasound shows a heterogeneous, hypoechoic " +
    "gland without discrete nodules. Levothyroxine 50 mcg daily has been initiated.",

  text: `LAKESIDE ENDOCRINE LABORATORY
Thyroid Function Panel with Autoantibodies

Patient: Daniel Osei
MRN: LEL-3320914
DOB: 27/06/1991
Sex: Male           Age: 34
Phone: 503-555-0219
Ordering Physician: Dr. Ingrid Halvorsen
Specimen Collected: 19/03/2026 08:55
Report Released: 20/03/2026 14:10
Clinical Indication: Fatigue, cold intolerance, 6 kg weight gain over four months

THYROID FUNCTION

Test                              Result         Reference Range      Flag
TSH                               11.6 uIU/mL    0.45 - 4.50          HIGH
Free T4                           0.71 ng/dL     0.82 - 1.77          LOW
Free T3                           2.4 pg/mL      2.0 - 4.4            NORMAL
Total T4                          5.1 ug/dL      4.5 - 12.0           NORMAL
Reverse T3                        14 ng/dL       9 - 27               NORMAL

Comment: A TSH of 11.6 uIU/mL with a free T4 below the reference range defines overt
primary hypothyroidism, as distinct from subclinical hypothyroidism where the free T4
would still be normal. Free T3 is preserved, which is typical early in the disease as
peripheral conversion compensates, and it is not a reason to defer treatment.

THYROID AUTOANTIBODIES

Test                                    Result        Reference Range     Flag
Thyroid Peroxidase Antibody (anti-TPO)  486 IU/mL     < 35                HIGH
Thyroglobulin Antibody (anti-Tg)        112 IU/mL     < 40                HIGH
TSH Receptor Antibody (TRAb)            < 0.8 IU/L    < 1.75              NORMAL

Comment: A strongly positive anti-TPO at 486 IU/mL establishes an autoimmune aetiology,
which is Hashimoto thyroiditis in this clinical context. A negative TSH receptor antibody
excludes Graves disease. Antibody titres do not track disease severity and do not need
repeat measurement once positive.

ASSOCIATED BIOCHEMISTRY

Test                              Result         Reference Range      Flag
Total Cholesterol                 232 mg/dL      < 200                HIGH
LDL Cholesterol                   148 mg/dL      < 100                HIGH
Creatine Kinase                   268 U/L        30 - 200             HIGH
Sodium                            136 mmol/L     136 - 145            NORMAL
Haemoglobin                       13.1 g/dL      13.5 - 17.5          LOW
Vitamin B12                       302 pg/mL      200 - 900            NORMAL

Comment: The cholesterol elevation and the raised creatine kinase are both secondary to
hypothyroidism and are expected to correct with treatment. Repeating a lipid panel before
the thyroid is replaced risks committing the patient to a statin they will not need. The
mild anaemia is similarly common in hypothyroidism.

THYROID ULTRASOUND, 19/03/2026

The thyroid gland is diffusely enlarged with a total volume of 24 mL. Echotexture is
coarse and heterogeneous with diffuse hypoechogenicity and increased vascularity on
colour Doppler. No discrete nodule exceeding 5 mm is identified. No suspicious
microcalcification. Cervical lymph nodes are not enlarged, with preserved fatty hila.

Impression: Sonographic appearances of chronic autoimmune thyroiditis. No nodule
requiring fine needle aspiration.

CLINICAL HISTORY AND MEDICATIONS

History: Four months of progressive fatigue, cold intolerance, constipation and dry skin.
Weight gain of 6 kg over the same period despite an unchanged diet. No neck pain, no
hoarseness, no dysphagia. Family history of autoimmune thyroid disease in a sister and
vitiligo in the mother.

Current Medications:
  Levothyroxine 50 mcg once daily on an empty stomach, started 20/03/2026
  No other regular medications

Allergies: No known drug allergies.

ASSESSMENT AND PLAN

Assessment: Overt primary hypothyroidism due to Hashimoto thyroiditis, with a TSH of
11.6 uIU/mL, a free T4 of 0.71 ng/dL and an anti-TPO of 486 IU/mL. Secondary
dyslipidemia and a raised creatine kinase are attributable to the same cause.

Plan:
  1. Levothyroxine 50 mcg daily, taken fasting and at least 30 minutes before food or
     any calcium or iron supplement, which impair absorption.
  2. Repeat TSH and free T4 in 6 weeks. Do not recheck earlier - TSH takes that long to
     re-equilibrate and an early result invites an unnecessary dose change.
  3. Target TSH in the range 0.5 to 2.5 uIU/mL once stable.
  4. Repeat the lipid panel only after the thyroid is biochemically replaced.
  5. Screen for coeliac disease and type 1 diabetes given the autoimmune background and
     the family history.

Next review: 01/05/2026 with repeat thyroid function tests one week prior.

Reported by: Dr. Ingrid Halvorsen
Verified by: Dr. Rosa Cardenas, Consultant Endocrinologist`,
};
