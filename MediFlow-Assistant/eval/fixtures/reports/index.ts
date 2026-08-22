import type { FixtureReport } from "./types";
import { metabolicWorkup } from "./metabolic-workup";
import { hematologyWorkup } from "./hematology-workup";
import { thyroidPanel } from "./thyroid-panel";
import { hepaticPanel } from "./hepatic-panel";
import { renalPanel } from "./renal-panel";

export type { FixtureReport } from "./types";

export const FIXTURE_REPORTS: readonly FixtureReport[] = [
  metabolicWorkup,
  hematologyWorkup,
  thyroidPanel,
  hepaticPanel,
  renalPanel,
];

export type FixtureReportId = (typeof FIXTURE_REPORTS)[number]["id"];

const byId = new Map(FIXTURE_REPORTS.map((report) => [report.id, report]));

export function getReport(id: string): FixtureReport {
  const report = byId.get(id);
  // A dataset case naming a report that does not exist would otherwise surface as an
  // undefined summary silently producing a nonsense retrieval query.
  if (!report) {
    throw new Error(
      `Unknown fixture report "${id}". Known ids: ${Array.from(byId.keys()).join(", ")}`
    );
  }
  return report;
}
