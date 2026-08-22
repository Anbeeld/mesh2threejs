export interface CalibrationCase {
  id: string;
  human: "PASS" | "FAIL";
  machine: "PASS" | "FAIL";
}

export function summarizeCalibration(cases: CalibrationCase[]): {
  total: number;
  agreements: number;
  disagreements: string[];
  accuracy: number;
} {
  const disagreements = cases.filter((item) => item.human !== item.machine).map((item) => item.id);
  const agreements = cases.length - disagreements.length;
  return { total: cases.length, agreements, disagreements, accuracy: cases.length ? agreements / cases.length : 1 };
}
