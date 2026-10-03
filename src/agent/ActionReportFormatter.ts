import type { DelegatedActionReport } from "./ActionTypes";

/** Keep observed inputs/results, not runner UUIDs and creation timestamps. */
export function actionReportForContext(report: DelegatedActionReport) {
  return {
    status: report.status,
    message: report.message,
    outcomes: report.outcomes.map(({ actionNumber, task, result }) => ({
      ...(actionNumber === undefined ? {} : { actionNumber }),
      capability: task.capability,
      input: structuredClone(task.input),
      result: structuredClone(result),
    })),
  };
}
