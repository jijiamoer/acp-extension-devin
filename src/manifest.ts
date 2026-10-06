import { readFileSync } from "node:fs";

export interface PrivateWireContract {
  sidekickToolCallMeta: string;
  sidekickToolCallIdPrefix: string;
  subagentContextMeta: string;
  subagentStartedMeta: string;
  subagentCompletedMeta: string;
  subagentSupportClientCapability: string;
  rootAgentId: string;
  sidekickAgentId: string;
  toolNameMeta: string;
  inferenceToolNameMeta: string;
  compactionNotificationMethod: string;
  compactionSessionIdField: string;
  compactionStatusField: string;
  compactionSummaryField: string;
  compactionStartedStatus: string;
  compactionCompletedStatus: string;
  compactionFailedStatus: string;
  compactionManualCommand: string;
  elicitationAllowOtherMeta: string;
  usageInputTokensMeta: string;
  usageOutputTokensMeta: string;
  usageCachedReadTokensMeta: string;
  usageCachedWriteTokensMeta: string;
  usageTotalCreditCostMeta: string;
  usageTotalAcuCostMeta: string;
  usageResponseDimensionsMeta: string;
}

const FIELDS: readonly (keyof PrivateWireContract)[] = [
  "sidekickToolCallMeta",
  "sidekickToolCallIdPrefix",
  "subagentContextMeta",
  "subagentStartedMeta",
  "subagentCompletedMeta",
  "subagentSupportClientCapability",
  "rootAgentId",
  "sidekickAgentId",
  "toolNameMeta",
  "inferenceToolNameMeta",
  "compactionNotificationMethod",
  "compactionSessionIdField",
  "compactionStatusField",
  "compactionSummaryField",
  "compactionStartedStatus",
  "compactionCompletedStatus",
  "compactionFailedStatus",
  "compactionManualCommand",
  "elicitationAllowOtherMeta",
  "usageInputTokensMeta",
  "usageOutputTokensMeta",
  "usageCachedReadTokensMeta",
  "usageCachedWriteTokensMeta",
  "usageTotalCreditCostMeta",
  "usageTotalAcuCostMeta",
  "usageResponseDimensionsMeta",
];

function loadPrivateWireContract(): PrivateWireContract {
  const raw = JSON.parse(
    readFileSync(new URL("../runtime-manifest.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const section = raw["privateWireContract"];
  if (
    typeof section !== "object" ||
    section === null ||
    Array.isArray(section)
  ) {
    throw new Error(
      "runtime-manifest.json: privateWireContract must be an object",
    );
  }
  const contract: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = (section as Record<string, unknown>)[field];
    if (typeof value !== "string" || !value) {
      throw new Error(
        `runtime-manifest.json: privateWireContract.${field} must be a non-empty string`,
      );
    }
    contract[field] = value;
  }
  return contract as unknown as PrivateWireContract;
}

export const privateWireContract = loadPrivateWireContract();
