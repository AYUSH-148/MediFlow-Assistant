import type { FixtureReport } from "./types";

/**
 * Second large fixture. Deliberately shares vocabulary with `metabolic-workup` - both
 * carry a CMP, ferritin, vitamin D and a medication list - so that a question scoped to
 * one document cannot be answered correctly by accident from the other. Chunks are
 * filtered by documentId in production, and this overlap is what makes that filter
 * observable if it ever regresses.
 */
export const hematologyWorkup: FixtureReport = {
  id: "hematology-workup",
  title: "Anaemia workup with full blood count and iron studies",
  size: "large",

  summary:
    "Haematology Workup for Symptomatic Anaemia. Haemoglobin is low at 9.2 g/dL with " +
    "MCV 71 fL and MCH 23.1 pg, a microcytic hypochromic picture. Iron studies confirm " +
    "iron deficiency: ferritin 6 ng/mL, serum iron 28 ug/dL, transferrin saturation 7 " +
    "percent, TIBC 412 ug/dL. Platelets are raised at 486 x10^9/L (reactive " +
    "thrombocytosis). Reticulocyte count 0.8 percent is inappropriately low. Faecal " +
    "occult blood is positive. B12 and folate are normal. Assessment: severe iron " +
    "deficiency anaemia with suspected chronic gastrointestinal blood loss.",

  text: `NORTHGATE HAEMATOLOGY SERVICES
Haematology Workup for Symptomatic Anaemia

Patient Name: Priya Venkatesan
Medical Record Number: NGH-7741820
DOB: 02/11/1988
Sex: Female          Age: 37
Phone: 628-555-0447
Referring Physician: Dr. Marcus Lindqvist
Specimen Collected: 04/02/2026 08:10
Report Released: 05/02/2026 11:45
Clinical Indication: Fatigue, exertional dyspnoea, pica

SECTION 1 - FULL BLOOD COUNT

Test                              Result           Reference Range     Flag
Haemoglobin                       9.2 g/dL         12.0 - 15.5         LOW
Haematocrit                       29.4 %           36.0 - 46.0         LOW
Red Blood Cell Count              4.08 x10^12/L    3.80 - 5.20         NORMAL
Mean Corpuscular Volume (MCV)     71 fL            80 - 100            LOW
Mean Corpuscular Haemoglobin      23.1 pg          27.0 - 33.0         LOW
MCHC                              31.3 g/dL        32.0 - 36.0         LOW
Red Cell Distribution Width       18.6 %           11.5 - 14.5         HIGH
White Blood Cell Count            7.4 x10^9/L      4.0 - 11.0          NORMAL
Platelet Count                    486 x10^9/L      150 - 400           HIGH
Mean Platelet Volume              9.1 fL           7.5 - 11.5          NORMAL

Comment: The haemoglobin of 9.2 g/dL with an MCV of 71 fL describes a microcytic
hypochromic anaemia. A red cell distribution width of 18.6 % indicates marked
anisocytosis and typically rises before the MCV falls, so it is the earliest index to
move in evolving iron deficiency. The platelet count of 486 x10^9/L is a reactive
thrombocytosis, a recognised accompaniment of iron deficiency and of chronic blood loss.

SECTION 2 - WHITE CELL DIFFERENTIAL

Test                              Result           Reference Range     Flag
Neutrophils                       58 %             40 - 75             NORMAL
Neutrophils, absolute             4.29 x10^9/L     2.00 - 7.50         NORMAL
Lymphocytes                       31 %             20 - 45             NORMAL
Lymphocytes, absolute             2.29 x10^9/L     1.00 - 4.00         NORMAL
Monocytes                         7 %              2 - 10              NORMAL
Eosinophils                       3 %              1 - 6               NORMAL
Basophils                         1 %              0 - 2               NORMAL

Comment: The differential is unremarkable. There is no eosinophilia to suggest parasitic
infestation as a cause of blood loss, and no immature forms are seen.

SECTION 3 - RED CELL MORPHOLOGY

Peripheral blood film examined by a consultant haematologist. Red cells show marked
hypochromia and microcytosis with prominent anisopoikilocytosis. Pencil cells and target
cells are present. No basophilic stippling is seen, which argues against lead exposure or
thalassaemia trait as the primary explanation. No schistocytes, no spherocytes, no
nucleated red cells. Platelets appear increased on the film, confirming the automated
count. White cells are morphologically normal with no blasts and no dysplastic features.

Impression: Film is consistent with iron deficiency rather than thalassaemia trait.

SECTION 4 - IRON STUDIES

Test                              Result           Reference Range     Flag
Ferritin                          6 ng/mL          15 - 200            LOW
Serum Iron                        28 ug/dL         50 - 170            LOW
Total Iron Binding Capacity       412 ug/dL        250 - 370           HIGH
Transferrin Saturation            7 %              20 - 50             LOW
Soluble Transferrin Receptor      4.8 mg/L         1.9 - 4.4           HIGH
Reticulocyte Count                0.8 %            0.5 - 2.5           NORMAL
Reticulocyte Haemoglobin          19.2 pg          > 28                LOW

Comment: A ferritin of 6 ng/mL is diagnostic of depleted iron stores and, unlike serum
iron, is not affected by recent dietary intake. Transferrin saturation of 7 % with a
raised TIBC of 412 ug/dL completes the picture. Ferritin is an acute phase reactant and
can be spuriously normal during inflammation; that is not a confounder here given how
low it is. The reticulocyte count of 0.8 % is within the reference range but
inappropriately low for this degree of anaemia, indicating that the marrow cannot mount
a response without iron. Reticulocyte haemoglobin of 19.2 pg confirms iron-restricted
erythropoiesis in the last 48 hours.

SECTION 5 - HAEMATINICS AND HAEMOLYSIS SCREEN

Test                              Result           Reference Range     Flag
Vitamin B12                       388 pg/mL        200 - 900           NORMAL
Folate, serum                     7.9 ng/mL        > 5.4               NORMAL
Folate, red cell                  312 ng/mL        > 280               NORMAL
Lactate Dehydrogenase             186 U/L          140 - 280           NORMAL
Haptoglobin                       112 mg/dL        30 - 200            NORMAL
Total Bilirubin                   0.6 mg/dL        0.2 - 1.2           NORMAL
Direct Coombs Test                Negative         Negative            NORMAL

Comment: B12 and folate are both normal, so this is not a mixed or megaloblastic picture.
The haemolysis screen is negative - a normal LDH with a preserved haptoglobin and a
negative direct Coombs test effectively excludes significant haemolysis.

SECTION 6 - HAEMOGLOBIN STUDIES

Test                              Result           Reference Range     Flag
Haemoglobin A                     97.1 %           96.0 - 98.5         NORMAL
Haemoglobin A2                    2.4 %            2.0 - 3.5           NORMAL
Haemoglobin F                     0.5 %            < 1.0               NORMAL
Haemoglobin Variants              None detected    None                NORMAL

Comment: Haemoglobin electrophoresis is normal. Note that HbA2 can be falsely lowered by
concurrent iron deficiency, so beta thalassaemia trait cannot be fully excluded on this
sample. Repeat electrophoresis after iron repletion is advised if the microcytosis
persists once ferritin has normalised.

SECTION 7 - GASTROINTESTINAL AND GYNAECOLOGICAL EVALUATION

Test                              Result           Reference Range     Flag
Faecal Occult Blood (FIT)         Positive         Negative            ABNORMAL
Faecal Calprotectin               142 ug/g         < 50                HIGH
Tissue Transglutaminase IgA       3 U/mL           < 15                NORMAL
Total IgA                         210 mg/dL        70 - 400            NORMAL
Helicobacter pylori antigen       Negative         Negative            NORMAL

Comment: A positive faecal immunochemical test with a calprotectin of 142 ug/g requires
lower gastrointestinal investigation and should not be attributed to menstrual loss
without it. Coeliac serology is negative with a normal total IgA, so the tTG result is
interpretable and not a false negative from IgA deficiency.

Gynaecological history: Menorrhagia reported for approximately two years, with cycles of
six to seven days and passage of clots. Last menstrual period 28/01/2026. No
intermenstrual bleeding. Pelvic ultrasound on 04/02/2026 shows a bulky uterus measuring
11.2 cm with two intramural fibroids, the largest 3.8 cm at the fundus. Endometrial
thickness is 6 mm. Both ovaries appear normal.

SECTION 8 - BASELINE BIOCHEMISTRY

Test                              Result           Reference Range     Flag
Sodium                            141 mmol/L       136 - 145           NORMAL
Potassium                         4.0 mmol/L       3.5 - 5.1           NORMAL
Creatinine                        0.72 mg/dL       0.50 - 1.10         NORMAL
eGFR                              > 90 mL/min/1.73m2   > 60            NORMAL
Albumin                           3.9 g/dL         3.5 - 5.0           NORMAL
C-Reactive Protein                6.1 mg/L         < 5.0               HIGH
Erythrocyte Sedimentation Rate    24 mm/hr         < 20                HIGH
TSH                               1.8 uIU/mL       0.45 - 4.50         NORMAL
Vitamin D, 25-hydroxy             26 ng/mL         30 - 100            LOW

Comment: The mildly raised CRP and ESR are consistent with the bowel inflammation
suggested by the calprotectin. Renal and thyroid function are normal.

SECTION 9 - CLINICAL HISTORY AND MEDICATIONS

History: Six months of progressive fatigue, breathlessness on climbing one flight of
stairs, and craving for ice, which the patient reports chewing daily. No fever, no night
sweats, no weight loss. Bowel habit is described as unchanged with no visible blood per
rectum. No prior transfusion. No known bleeding disorder. Vegetarian diet for
approximately fifteen years.

Current Medications:
  Tranexamic acid 500 mg three times daily during menstruation, started 11/2025
  Ferrous sulfate 325 mg once daily, self-initiated 01/2026, poor tolerance reported
  Combined oral contraceptive - discontinued 2023

Allergies: No known drug allergies.

SECTION 10 - ASSESSMENT AND PLAN

Assessment: Severe iron deficiency anaemia with a haemoglobin of 9.2 g/dL and a ferritin
of 6 ng/mL. Two plausible contributors are documented and both need addressing: chronic
gastrointestinal blood loss, indicated by a positive faecal occult blood test with a
raised calprotectin, and menorrhagia in the presence of uterine fibroids. Given the
positive FIT, gastrointestinal loss must be investigated regardless of the gynaecological
findings.

Plan:
  1. Urgent gastroenterology referral for bidirectional endoscopy. The positive FIT with
     a calprotectin of 142 ug/g takes precedence over the gynaecological pathway.
  2. Switch oral iron to ferrous fumarate 210 mg on alternate days. Alternate-day dosing
     improves fractional absorption and tolerance compared with the current daily
     regimen the patient reports being unable to tolerate.
  3. Consider intravenous ferric carboxymaltose if oral iron remains poorly tolerated or
     if endoscopy is delayed beyond six weeks.
  4. Gynaecology referral for management of menorrhagia and fibroids, non-urgent.
  5. Repeat full blood count and ferritin in 4 weeks. Expect a haemoglobin rise of at
     least 1 g/dL if the iron is being absorbed and the loss is controlled.
  6. Repeat haemoglobin electrophoresis after ferritin exceeds 100 ng/mL to exclude
     coexistent beta thalassaemia trait.

Next review: 05/03/2026, or sooner if symptoms worsen.

Reported by: Dr. Marcus Lindqvist
Verified by: Dr. Amelia Fontaine, Consultant Haematologist`,
};
