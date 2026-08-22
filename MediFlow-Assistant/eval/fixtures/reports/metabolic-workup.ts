import type { FixtureReport } from "./types";

/**
 * Large fixture (~12k chars, splits to well over 10 chunks at the production chunk size),
 * so retrieval has to actually choose which 10 chunks to return. The medium and small
 * fixtures cover the opposite regime, where a report fits inside topK and retrieval
 * returns everything it has.
 *
 * Entirely synthetic. Names, identifiers and values are invented; the header carries a
 * name, MRN, DOB, phone and address specifically so the redaction rules fire during
 * corpus build, exactly as they would on a real upload.
 */
export const metabolicWorkup: FixtureReport = {
  id: "metabolic-workup",
  title: "Comprehensive metabolic and cardiovascular risk workup",
  size: "large",

  summary:
    "Comprehensive Annual Metabolic and Cardiovascular Risk Panel. Multiple abnormal " +
    "biomarkers: LDL cholesterol 172 mg/dL and total cholesterol 268 mg/dL (both high), " +
    "HDL low at 38 mg/dL, triglycerides 244 mg/dL. HbA1c 6.1% and fasting glucose 114 " +
    "mg/dL indicate prediabetes. Blood pressure 148/94 mmHg (stage 2 hypertension). ALT " +
    "58 U/L and AST 44 U/L mildly elevated with hepatic steatosis on ultrasound. Vitamin " +
    "D 18 ng/mL is deficient. eGFR 88 mL/min/1.73m2 and TSH 2.4 uIU/mL are normal. " +
    "Assessment: metabolic syndrome with prediabetes, dyslipidemia and NAFLD.",

  text: `RIVERBEND INTEGRATED DIAGNOSTICS
Comprehensive Annual Metabolic and Cardiovascular Risk Panel

Patient: Arjun Raghavan
MRN: RBD-4481203
DOB: 14/03/1979
Sex: Male            Age: 46
Phone: 415-555-0182
Address: 2214 Fillmore Street, Suite 300
Ordering Physician: Dr. Neha Kulkarni
Specimen Collected: 12/01/2026 07:40
Specimen Received: 12/01/2026 09:05
Report Released: 13/01/2026 16:20
Fasting Status: Fasting, 12 hours confirmed

SECTION 1 - LIPID PANEL

Test                              Result        Reference Range      Flag
Total Cholesterol                 268 mg/dL     < 200                HIGH
LDL Cholesterol (calculated)      172 mg/dL     < 100                HIGH
HDL Cholesterol                   38 mg/dL      > 40                 LOW
Triglycerides                     244 mg/dL     < 150                HIGH
Non-HDL Cholesterol               230 mg/dL     < 130                HIGH
Total Cholesterol / HDL Ratio     7.1           < 5.0                HIGH
Apolipoprotein B                  128 mg/dL     < 90                 HIGH
Lipoprotein(a)                    41 nmol/L     < 75                 NORMAL

Comment: The LDL cholesterol of 172 mg/dL is calculated by the Friedewald equation and
is reliable at this triglyceride level. The combination of elevated LDL, elevated
triglycerides and low HDL is the classic atherogenic dyslipidemia pattern seen in insulin
resistance. Apolipoprotein B of 128 mg/dL indicates a high circulating particle number
and is the better treatment target where it disagrees with LDL.

SECTION 2 - GLYCEMIC CONTROL

Test                              Result        Reference Range      Flag
Hemoglobin A1c                    6.1 %         < 5.7                HIGH
Fasting Plasma Glucose            114 mg/dL     70 - 99              HIGH
Fasting Insulin                   22 uIU/mL     2.6 - 24.9           NORMAL
HOMA-IR (calculated)              6.2           < 2.0                HIGH
C-peptide                         3.4 ng/mL     0.8 - 3.9            NORMAL

Comment: An HbA1c of 6.1 % falls in the prediabetes range of 5.7 to 6.4 %. Fasting
glucose of 114 mg/dL is concordant. HOMA-IR of 6.2 indicates substantial insulin
resistance despite an insulin level still inside the reference interval, which is why the
calculated index is reported alongside the raw value. No prior HbA1c is available for
comparison in this record.

SECTION 3 - COMPREHENSIVE METABOLIC PANEL

Test                              Result        Reference Range      Flag
Sodium                            139 mmol/L    136 - 145            NORMAL
Potassium                         4.2 mmol/L    3.5 - 5.1            NORMAL
Chloride                          102 mmol/L    98 - 107             NORMAL
Carbon Dioxide                    26 mmol/L     22 - 29              NORMAL
Blood Urea Nitrogen               16 mg/dL      7 - 20               NORMAL
Creatinine                        0.98 mg/dL    0.70 - 1.30          NORMAL
eGFR                              88 mL/min/1.73m2   > 60            NORMAL
Calcium                           9.4 mg/dL     8.6 - 10.2           NORMAL
Total Protein                     7.1 g/dL      6.0 - 8.3            NORMAL
Albumin                           4.2 g/dL      3.5 - 5.0            NORMAL
Total Bilirubin                   0.8 mg/dL     0.2 - 1.2            NORMAL
Alkaline Phosphatase              94 U/L        44 - 147             NORMAL
AST (SGOT)                        44 U/L        10 - 40              HIGH
ALT (SGPT)                        58 U/L        7 - 56               HIGH

Comment: Renal function is preserved, with an eGFR of 88 mL/min/1.73m2 and a normal
creatinine. The transaminase elevation is mild and hepatocellular in pattern, with an
AST/ALT ratio below 1, which in the presence of the metabolic findings above favours
hepatic steatosis over an alcoholic aetiology. Alkaline phosphatase and bilirubin are
normal, arguing against biliary obstruction.

SECTION 4 - VITAMINS, MINERALS AND ENDOCRINE

Test                              Result        Reference Range      Flag
Vitamin D, 25-hydroxy             18 ng/mL      30 - 100             LOW
Vitamin B12                       412 pg/mL     200 - 900            NORMAL
Folate, serum                     9.8 ng/mL     > 5.4                NORMAL
Ferritin                          186 ng/mL     30 - 400             NORMAL
Magnesium                         1.9 mg/dL     1.7 - 2.2            NORMAL
TSH                               2.4 uIU/mL    0.45 - 4.50          NORMAL
Free T4                           1.2 ng/dL     0.82 - 1.77          NORMAL
Testosterone, total               430 ng/dL     264 - 916            NORMAL
Uric Acid                         7.4 mg/dL     3.4 - 7.0            HIGH

Comment: Vitamin D at 18 ng/mL is in the deficient range (below 20 ng/mL) rather than
merely insufficient. Thyroid function is normal and does not explain the lipid profile.
Uric acid of 7.4 mg/dL is marginally elevated and is consistent with the metabolic
picture; there is no history of gout in this record.

SECTION 5 - INFLAMMATORY AND CARDIAC MARKERS

Test                              Result        Reference Range      Flag
hs-CRP                            4.8 mg/L      < 3.0                HIGH
Homocysteine                      11.2 umol/L   < 15.0               NORMAL
NT-proBNP                         62 pg/mL      < 125                NORMAL
Troponin T, high sensitivity      6 ng/L        < 14                 NORMAL

Comment: An hs-CRP of 4.8 mg/L places this patient in the high cardiovascular risk
category by that marker alone. Cardiac markers are normal and there is no evidence of
myocardial injury or strain at this time.

SECTION 6 - URINALYSIS

Test                              Result        Reference Range      Flag
Colour                            Yellow        Yellow               NORMAL
Clarity                           Clear         Clear                NORMAL
Specific Gravity                  1.018         1.005 - 1.030        NORMAL
pH                                6.0           4.5 - 8.0            NORMAL
Protein                           Negative      Negative             NORMAL
Glucose                           Trace         Negative             ABNORMAL
Ketones                           Negative      Negative             NORMAL
Blood                             Negative      Negative             NORMAL
Urine Albumin/Creatinine Ratio    18 mg/g       < 30                 NORMAL

Comment: Trace glycosuria is consistent with the fasting glucose above. The albumin to
creatinine ratio of 18 mg/g is normal, so there is no evidence of diabetic kidney disease
at this stage.

SECTION 7 - VITAL SIGNS AND ANTHROPOMETRICS

Blood Pressure (seated, average of three)     148/94 mmHg     Target < 130/80    HIGH
Heart Rate                                    78 bpm          60 - 100           NORMAL
Body Mass Index                               31.4 kg/m2      18.5 - 24.9        HIGH
Waist Circumference                           108 cm          < 102              HIGH
Body Weight                                   96.2 kg
Height                                        175 cm

Comment: The averaged blood pressure of 148/94 mmHg meets the criteria for stage 2
hypertension and was reproducible across three seated readings taken five minutes apart.
Waist circumference of 108 cm exceeds the threshold for central adiposity.

SECTION 8 - IMAGING

Abdominal Ultrasound, 12/01/2026:
Liver is enlarged at 17.2 cm in the craniocaudal axis with diffusely increased
echogenicity and poor visualisation of the intrahepatic vasculature, consistent with
moderate hepatic steatosis. No focal lesion. Gallbladder is unremarkable with no
calculi and a normal wall thickness. Common bile duct measures 4 mm. Both kidneys are
normal in size and cortical thickness with no hydronephrosis. Spleen is normal at
10.4 cm. Pancreas is partially obscured by bowel gas.

Impression: Moderate hepatic steatosis. No biliary obstruction.

Carotid Doppler, 12/01/2026:
Bilateral carotid intima-media thickness measures 0.82 mm on the right and 0.79 mm on
the left, above the 75th percentile for age. A small non-calcified plaque is noted at the
right carotid bulb causing less than 30 percent stenosis. Vertebral flow is antegrade
bilaterally.

Impression: Early subclinical atherosclerosis without haemodynamically significant
stenosis.

SECTION 9 - CLINICAL HISTORY AND MEDICATIONS

History: The patient reports increasing fatigue over the past eight months and
intermittent morning headaches. No chest pain, no dyspnoea on exertion, no claudication.
Family history is significant for myocardial infarction in the father at age 52 and type
2 diabetes in the mother. The patient is a lifelong non-smoker and reports alcohol intake
of approximately two units per week. Physical activity is described as sedentary, with
desk-based work and no structured exercise.

Current Medications:
  Amlodipine 5 mg once daily, started 06/2025 for hypertension
  Atorvastatin 10 mg once nightly, started 09/2025 for dyslipidemia
  Cholecalciferol 1000 IU once daily, over the counter

Allergies: Penicillin - documented urticarial rash in childhood. No other known drug
allergies.

SECTION 10 - ASSESSMENT AND PLAN

Assessment: This patient meets the criteria for metabolic syndrome, with central
adiposity, hypertension, elevated triglycerides, low HDL and impaired fasting glucose.
The picture is completed by prediabetes on HbA1c, non-alcoholic fatty liver disease on
ultrasound and biochemistry, vitamin D deficiency, and early subclinical atherosclerosis
on carotid imaging. Ten-year atherosclerotic cardiovascular disease risk is estimated at
14.2 percent, which is in the intermediate range.

Plan:
  1. Increase atorvastatin from 10 mg to 40 mg nightly. Repeat lipid panel in 8 weeks
     with a target LDL below 100 mg/dL and ideally below 70 mg/dL given the plaque.
  2. Add metformin 500 mg twice daily for prediabetes with an HOMA-IR of 6.2. Repeat
     HbA1c in 3 months.
  3. Escalate antihypertensive therapy - increase amlodipine to 10 mg daily and add
     an ACE inhibitor if the blood pressure remains above 130/80 mmHg at review.
  4. Cholecalciferol 60000 IU weekly for 8 weeks for the vitamin D of 18 ng/mL, then
     resume daily maintenance. Recheck at 3 months.
  5. Structured lifestyle intervention with a target of 7 percent body weight loss and
     150 minutes of moderate aerobic activity per week.
  6. Repeat liver enzymes in 3 months. If ALT remains above 50 U/L, refer to hepatology
     for fibrosis staging with transient elastography.

Next review: 14/04/2026 with repeat fasting bloods one week prior.

Reported by: Dr. Neha Kulkarni
Verified by: Dr. Samuel Okonjo, Consultant Chemical Pathologist`,
};
