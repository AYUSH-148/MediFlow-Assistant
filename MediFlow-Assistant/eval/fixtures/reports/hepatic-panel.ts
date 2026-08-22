import type { FixtureReport } from "./types";

/**
 * Medium fixture. Shares a liver theme with the metabolic workup's steatosis findings
 * but reaches a different aetiology and different numbers, so a question about "my liver
 * enzymes" scoped to one document has a verifiably wrong answer available in the other.
 */
export const hepaticPanel: FixtureReport = {
  id: "hepatic-panel",
  title: "Hepatic function panel with viral hepatitis serology",
  size: "medium",

  summary:
    "Hepatic Function Panel with Viral Serology. Transaminases are markedly elevated " +
    "with ALT 214 U/L and AST 178 U/L, alongside GGT 186 U/L and alkaline phosphatase " +
    "142 U/L. Bilirubin is mildly raised at 1.9 mg/dL. Synthetic function is preserved " +
    "with albumin 4.0 g/dL and INR 1.1. Hepatitis C antibody is reactive with an HCV RNA " +
    "viral load of 1.2 million IU/mL, genotype 1a. Hepatitis B and A serology are " +
    "negative. FibroScan shows 8.4 kPa, suggesting moderate fibrosis (F2).",

  text: `HARBOUR POINT LIVER UNIT
Hepatic Function Panel with Viral Hepatitis Serology

Patient: Elena Marchetti
MRN: HPL-6628401
DOB: 09/09/1975
Sex: Female         Age: 50
Phone: 917-555-0364
Ordering Physician: Dr. Tobias Wren
Specimen Collected: 07/04/2026 09:20
Report Released: 09/04/2026 10:05
Clinical Indication: Persistently abnormal liver enzymes on routine screening

LIVER ENZYMES AND FUNCTION

Test                              Result         Reference Range      Flag
ALT (SGPT)                        214 U/L        7 - 35               HIGH
AST (SGOT)                        178 U/L        10 - 35              HIGH
Gamma-Glutamyl Transferase        186 U/L        9 - 36               HIGH
Alkaline Phosphatase              142 U/L        44 - 121             HIGH
Total Bilirubin                   1.9 mg/dL      0.2 - 1.2            HIGH
Direct Bilirubin                  0.7 mg/dL      0.0 - 0.3            HIGH
Albumin                           4.0 g/dL       3.5 - 5.0            NORMAL
Total Protein                     7.4 g/dL       6.0 - 8.3            NORMAL
INR                               1.1            0.9 - 1.2            NORMAL
Platelet Count                    168 x10^9/L    150 - 400            NORMAL

Comment: The AST to ALT ratio of 0.83 describes a hepatocellular rather than
cholestatic pattern of injury. Albumin and INR are both normal, so synthetic function is
preserved and this is not acute liver failure despite the enzyme levels. A platelet count
of 168 x10^9/L is within range but at the lower end, which is worth tracking as an early
indirect marker of portal hypertension.

VIRAL HEPATITIS SEROLOGY

Test                                    Result             Reference      Flag
Hepatitis C Antibody                    Reactive           Non-reactive   ABNORMAL
Hepatitis C RNA, quantitative           1200000 IU/mL      Not detected   ABNORMAL
Hepatitis C Genotype                    1a                 -              -
Hepatitis B Surface Antigen             Non-reactive       Non-reactive   NORMAL
Hepatitis B Surface Antibody            Reactive           -              IMMUNE
Hepatitis B Core Antibody, total        Non-reactive       Non-reactive   NORMAL
Hepatitis A IgM                         Non-reactive       Non-reactive   NORMAL
HIV 1/2 Antigen-Antibody                Non-reactive       Non-reactive   NORMAL

Comment: A reactive hepatitis C antibody with a detectable RNA viral load of 1200000
IU/mL confirms active chronic infection rather than cleared past exposure. Genotype 1a is
identified. The hepatitis B pattern - surface antibody reactive with a non-reactive
surface antigen and core antibody - is that of vaccination, not past infection.

AUTOIMMUNE AND METABOLIC LIVER SCREEN

Test                              Result         Reference Range      Flag
Antinuclear Antibody              Negative       Negative             NORMAL
Anti-Smooth Muscle Antibody       Negative       Negative             NORMAL
Anti-Mitochondrial Antibody       Negative       Negative             NORMAL
Immunoglobulin G                  1180 mg/dL     700 - 1600           NORMAL
Ferritin                          284 ng/mL      15 - 200             HIGH
Transferrin Saturation            32 %           20 - 50              NORMAL
Ceruloplasmin                     28 mg/dL       20 - 35              NORMAL
Alpha-1 Antitrypsin               142 mg/dL      90 - 200             NORMAL

Comment: The autoimmune screen is negative. Ferritin of 284 ng/mL is raised but the
transferrin saturation is normal, so this is an acute phase response to hepatic
inflammation rather than iron overload; haemochromatosis genotyping is not indicated on
these numbers.

TRANSIENT ELASTOGRAPHY (FIBROSCAN), 08/04/2026

Liver stiffness measurement: 8.4 kPa (IQR 1.1 kPa, success rate 100 percent, 10 valid
measurements). Controlled attenuation parameter: 238 dB/m.

Impression: A liver stiffness of 8.4 kPa corresponds to moderate fibrosis, stage F2, in
chronic hepatitis C. Note that active necroinflammation with an ALT of 214 U/L can
inflate stiffness readings, so this may overestimate true fibrosis and should be repeated
after treatment.

CLINICAL HISTORY AND MEDICATIONS

History: No symptoms. The abnormality was found on routine occupational screening. No
jaundice, no pruritus, no abdominal pain, no ascites. The patient reports no alcohol
intake for the past ten years and no more than occasional social drinking before that.
Received a blood transfusion in 1994 following a road traffic accident, which predates
routine donor screening for hepatitis C in this jurisdiction. No intravenous drug use, no
tattoos.

Current Medications:
  Levothyroxine 75 mcg once daily for longstanding hypothyroidism
  Paracetamol as required, patient advised not to exceed 2 g daily

Allergies: Sulfonamides - rash.

ASSESSMENT AND PLAN

Assessment: Chronic hepatitis C, genotype 1a, with a viral load of 1200000 IU/mL and
moderate fibrosis at 8.4 kPa on elastography. Likely acquired from the 1994 transfusion.
Synthetic function is preserved and there is no evidence of cirrhosis or portal
hypertension.

Plan:
  1. Refer to hepatology for direct-acting antiviral therapy. Genotype 1a with F2
     fibrosis is treatable with a high expected cure rate.
  2. Baseline abdominal ultrasound before starting treatment.
  3. Hepatitis A vaccination - the patient is non-immune and hepatitis A superinfection
     on chronic liver disease carries a higher risk of decompensation.
  4. Avoid alcohol entirely. Cap paracetamol at 2 g per day.
  5. Repeat liver enzymes, HCV RNA and FibroScan at 12 weeks after treatment completion
     to confirm sustained virological response.

Next review: 12/05/2026, hepatology clinic.

Reported by: Dr. Tobias Wren
Verified by: Dr. Yusuf Karim, Consultant Hepatologist`,
};
