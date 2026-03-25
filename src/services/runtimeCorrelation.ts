function firstNonEmptyEnvValue(...keys: string[]) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return null;
}

function resolveDeploymentIdentity() {
  return firstNonEmptyEnvValue(
    "CLANKER_DEPLOYMENT_ID",
    "RUNTIME_DEPLOYMENT_ID",
    "DEPLOYMENT_ID",
    "RAILWAY_DEPLOYMENT_ID",
    "RAILWAY_REPLICA_ID",
    "RENDER_DEPLOY_ID",
    "RENDER_INSTANCE_ID",
    "FLY_ALLOC_ID",
    "K_REVISION",
    "VERCEL_DEPLOYMENT_ID",
    "DYNO",
    "HOSTNAME"
  );
}

export function buildRuntimeDecisionCorrelation({
  botId = null,
  triggerMessageId = null,
  sessionId = null,
  turnId = null,
  source = null,
  stage,
  allow = null,
  reason = null
}: {
  botId?: string | null;
  triggerMessageId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  source?: string | null;
  stage: string;
  allow?: boolean | null;
  reason?: string | null;
}) {
  return {
    botId: String(botId || "").trim() || null,
    deployment: resolveDeploymentIdentity(),
    triggerMessageId: String(triggerMessageId || "").trim() || null,
    sessionId: String(sessionId || "").trim() || null,
    turnId: String(turnId || "").trim() || null,
    source: String(source || "").trim() || null,
    stage: String(stage || "").trim() || "unknown",
    allow: typeof allow === "boolean" ? allow : null,
    reason: String(reason || "").trim() || null
  };
}
