import { Project, SyntaxKind } from "ts-morph";
import * as path from "path";

const projectPath = "/mnt/c/Users/volpe/clanker_conk-master";
const tsConfigFilePath = path.join(projectPath, "tsconfig.json");

const project = new Project({ tsConfigFilePath });
const sourceFilePath = path.join(projectPath, "src/voice/voiceSessionManager.ts");
const sourceFile = project.addSourceFileAtPath(sourceFilePath);

// Export unexported vars/funcs
for (const v of sourceFile.getVariableStatements()) {
  if (!v.isExported() && !v.hasModifier(SyntaxKind.DeclareKeyword)) v.setIsExported(true);
}
for (const f of sourceFile.getFunctions()) {
  if (!f.isExported()) f.setIsExported(true);
}

const classDec = sourceFile.getClassOrThrow("VoiceSessionManager");

const categories = {
  music: [
    "ensureSessionMusicState", "snapshotMusicRuntimeState", "isMusicPlaybackActive",
    "normalizeMusicPlatformToken", "isMusicDisambiguationActive", "clearMusicDisambiguationState",
    "findPendingMusicSelectionById", "isLikelyMusicStopPhrase", "isLikelyMusicPlayPhrase",
    "extractMusicPlayQuery", "haltSessionOutputForMusicPlayback", "playMusicViaDiscord",
    "executeVoiceMusicSearchTool", "executeVoiceMusicQueueAddTool", "playVoiceQueueTrackByIndex",
    "buildVoiceQueueStatePayload"
  ],
  streamWatch: [
    "requestWatchStream", "initializeStreamWatchState", "supportsStreamWatchCommentary",
    "supportsVisionFallbackStreamWatchCommentary", "supportsStreamWatchBrainContext",
    "resolveStreamWatchVisionProviderSettings", "getStreamWatchBrainContextForPrompt",
    "requestStopWatchingStream", "requestStreamWatchStatus"
  ],
  tools: [
    "ensureSessionToolRuntimeState", "ensureToolMusicQueueState", "getVoiceMcpServerStatuses",
    "updateVoiceMcpStatus", "extractOpenAiFunctionCallEnvelope", "handleOpenAiRealtimeFunctionCallEvent",
    "parseOpenAiRealtimeToolArguments", "resolveOpenAiRealtimeToolDescriptor", "summarizeVoiceToolOutput",
    "executeVoiceWebSearchTool"
  ],
  asr: [
    "getOpenAiSharedAsrState", "getOpenAiAsrSessionMap", "getOrCreateOpenAiAsrSessionState",
    "createOpenAiAsrRuntimeLogger", "orderOpenAiAsrFinalSegments", "closeAllOpenAiAsrSessions",
    "getOpenAiSharedAsrPendingCommitRequests", "pruneOpenAiSharedAsrPendingCommitRequests",
    "scheduleOpenAiSharedAsrSessionIdleClose", "releaseOpenAiSharedAsrActiveUser",
    "tryHandoffSharedAsrToWaitingCapture", "closeOpenAiSharedAsrSession", "flushPendingOpenAiAsrAudio",
    "ensureOpenAiAsrSessionConnected", "beginOpenAiAsrUtterance", "commitOpenAiAsrUtterance",
    "waitForOpenAiAsrTranscriptSettle", "scheduleOpenAiAsrSessionIdleClose",
    "shouldUseOpenAiPerUserTranscription", "shouldUseOpenAiSharedTranscription",
    "ensureOpenAiSharedAsrConnected", "flushPendingOpenAiSharedAsrAudio", "commitOpenAiSharedAsrUtterance"
  ],
  addressing: [
    "hasBotNameCueForTranscript", "resolveSpeakingEndFinalizeDelayMs", "evaluatePcmSilenceGate",
    "analyzeMonoPcmSignal", "isBargeInOutputSuppressed", "clearBargeInOutputSuppression",
    "isBargeInInterruptTargetActive", "normalizeReplyInterruptionPolicy", "setActiveReplyInterruptionPolicy",
    "maybeClearActiveReplyInterruptionPolicy", "isCaptureSignalAssertive", "isCaptureEligibleForActivityTouch",
    "findAssertiveInboundCaptureUserId", "hasAssertiveInboundCapture", "isAudioActivelyFlowing"
  ]
};

let mainImports = [];
let mainInjections = [];

for (const [cat, methods] of Object.entries(categories)) {
  const newFilePath = path.join(projectPath, `src/voice/voiceSessionManager.${cat}.ts`);
  const newFile = project.createSourceFile(newFilePath, "", { overwrite: true });

  const exportName = `inject${cat.charAt(0).toUpperCase() + cat.slice(1)}Methods`;
  let funcBody = "";

  for (const methodName of methods) {
    const method = classDec.getMethod(methodName);
    if (!method) continue;

    const isAsync = method.isAsync();
    const paramsForFunc = method.getParameters().map(p => p.getText()).join(", ");
    
    funcBody += "\n  target.prototype." + methodName + " = " + (isAsync ? "async " : "") + "function(" + paramsForFunc + ") {\n" + method.getBodyText() + "\n  };\n";
    method.remove();
  }

  newFile.addFunction({
    name: exportName,
    isExported: true,
    parameters: [{ name: "target", type: "any" }],
    statements: funcBody
  });

  newFile.fixMissingImports();

  mainImports.push(`import { ${exportName} } from "./voiceSessionManager.${cat}.ts";`);
  mainInjections.push(`${exportName}(VoiceSessionManager);`);
}

// Add interface merge
sourceFile.addStatements("\nexport interface VoiceSessionManager {\n  [key: string]: any;\n}\n");
sourceFile.addStatements(mainInjections.join("\n"));
sourceFile.insertStatements(0, mainImports.join("\n"));

project.saveSync();
console.log("Done.");