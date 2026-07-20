import { WORKFLOW_STAGE_ORDER } from "./workflow.mjs";

export const UI_CONTRACT_ID = "job-search-operations-ui";
export const UI_CONTRACT_SCHEMA_VERSION = 1;

const runtimeModes = new Set(["onboarding", "demo", "personal"]);

function capability(available, writable) {
  return { available: Boolean(available), writable: Boolean(writable) };
}

export function buildUiContract({ mode = "demo" } = {}) {
  if (!runtimeModes.has(mode)) throw new Error(`Unsupported UI contract mode: ${mode}`);

  const onboarding = mode === "onboarding";
  const personal = mode === "personal";
  const dashboardAvailable = !onboarding;

  return {
    contractId: UI_CONTRACT_ID,
    schemaVersion: UI_CONTRACT_SCHEMA_VERSION,
    frontendVersions: ["v2", "v3"],
    defaultFrontend: "v2",
    mode,
    apiBase: "/api",
    readModels: {
      bootstrap: "/api/bootstrap",
      jobs: "/api/jobs",
      jobDetail: "/api/jobs/:jobId",
      workflow: "/api/workflow",
      settings: "/api/settings",
      inbox: "/api/inbox",
    },
    navigationIntents: [
      "jobs",
      "job_detail",
      "resume_management",
      "package_review",
      "submission_review",
      "application_results",
      "settings",
    ],
    workflowStages: [...WORKFLOW_STAGE_ORDER],
    capabilities: {
      onboarding: capability(onboarding, onboarding),
      jobs: capability(dashboardAvailable, personal),
      jobState: capability(dashboardAvailable, personal),
      savedFilters: capability(personal, personal),
      settings: capability(dashboardAvailable, personal),
      documents: capability(dashboardAvailable, personal),
      resumeManagement: capability(dashboardAvailable, personal),
      packageWorkflow: capability(dashboardAvailable, personal),
      manualSubmission: capability(dashboardAvailable, personal),
      applicationResults: capability(personal, personal),
      localNotifications: capability(personal, personal),
      companionQueue: capability(personal, personal),
      jobCollectionRequest: capability(personal, personal),
      documentAnalysisRequest: capability(personal, personal),
      packageGenerationRequest: capability(personal, personal),
      batchJobImport: capability(personal, personal),
      privateDocumentPreview: capability(false, false),
      packagePdfPreview: capability(false, false),
      packagePdfDownload: capability(false, false),
      packageReviewTransitions: capability(false, false),
      cancelSubmissionPreparation: capability(false, false),
      markAllNotificationsRead: capability(false, false),
      outcomeEvidenceUpload: capability(false, false),
      automaticSubmission: capability(false, false),
    },
    constraints: {
      localFirst: true,
      singleUserInstance: true,
      builtInCrawler: false,
      builtInAiClient: false,
      storesAiCredentials: false,
      automaticSubmission: false,
      packagePdfRequiresApproval: true,
    },
  };
}
