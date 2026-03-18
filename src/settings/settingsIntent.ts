import type { SettingsInput } from "./settingsSchema.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { isRecord } from "../store/normalize/primitives.ts";
import { deepMerge } from "../utils.ts";

type JsonRecord = Record<string, unknown>;

function cloneIntentCandidate(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  return deepMerge({}, value) as JsonRecord;
}

function canonicalizeLegacyIntent(candidate: JsonRecord): JsonRecord {
  const next = cloneIntentCandidate(candidate);
  const agentStack = isRecord(next.agentStack) ? { ...next.agentStack } : null;
  if (!agentStack) return next;

  const overrides = isRecord(agentStack.overrides) ? { ...agentStack.overrides } : null;
  const runtimeConfig = isRecord(agentStack.runtimeConfig) ? { ...agentStack.runtimeConfig } : {};
  const voiceRuntime = overrides && typeof overrides.voiceRuntime === "string"
    ? String(overrides.voiceRuntime).trim()
    : "";
  const voice = isRecord(runtimeConfig.voice) ? { ...runtimeConfig.voice } : {};
  const hasExplicitRuntimeMode = Object.prototype.hasOwnProperty.call(voice, "runtimeMode");

  if (voiceRuntime && !hasExplicitRuntimeMode) {
    voice.runtimeMode = voiceRuntime;
    runtimeConfig.voice = voice;
    agentStack.runtimeConfig = runtimeConfig;
  }

  if (overrides && Object.prototype.hasOwnProperty.call(overrides, "voiceRuntime")) {
    delete overrides.voiceRuntime;
    if (Object.keys(overrides).length > 0) {
      agentStack.overrides = overrides;
    } else {
      delete agentStack.overrides;
    }
  }

  next.agentStack = agentStack;
  return next;
}

function getCandidateValue(root: JsonRecord, path: string[]) {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function deleteCandidatePath(root: JsonRecord, path: string[]): JsonRecord {
  if (path.length === 0) return {};
  const [head, ...rest] = path;
  const clone = { ...root };
  if (!Object.prototype.hasOwnProperty.call(clone, head)) {
    return clone;
  }
  if (rest.length === 0) {
    delete clone[head];
    return clone;
  }

  const currentChild = clone[head];
  if (!isRecord(currentChild)) {
    delete clone[head];
    return clone;
  }

  const nextChild = deleteCandidatePath(currentChild, rest);
  if (Object.keys(nextChild).length === 0) {
    delete clone[head];
  } else {
    clone[head] = nextChild;
  }
  return clone;
}

function normalizeIntentTargetJson(candidate: JsonRecord) {
  return JSON.stringify(normalizeSettings(candidate));
}

function effectiveMatches(candidate: JsonRecord, targetJson: string) {
  return normalizeIntentTargetJson(candidate) === targetJson;
}

function pruneIntentAtPath(root: JsonRecord, path: string[], targetJson: string): JsonRecord {
  const current = getCandidateValue(root, path);
  if (!isRecord(current)) return root;

  let workingRoot = root;
  for (const key of Object.keys(current)) {
    const childPath = [...path, key];
    const withoutChild = deleteCandidatePath(workingRoot, childPath);
    if (effectiveMatches(withoutChild, targetJson)) {
      workingRoot = withoutChild;
      continue;
    }

    const nextChild = getCandidateValue(workingRoot, childPath);
    if (!isRecord(nextChild)) {
      continue;
    }

    workingRoot = pruneIntentAtPath(workingRoot, childPath, targetJson);
    const prunedChild = getCandidateValue(workingRoot, childPath);
    if (!isRecord(prunedChild) || Object.keys(prunedChild).length > 0) {
      continue;
    }

    const withoutEmptyChild = deleteCandidatePath(workingRoot, childPath);
    if (effectiveMatches(withoutEmptyChild, targetJson)) {
      workingRoot = withoutEmptyChild;
    }
  }

  return workingRoot;
}

export function minimizeSettingsIntent(value: unknown): SettingsInput {
  const source =
    isRecord(value) && isRecord(value.intent)
      ? value.intent
      : value;
  const candidate = canonicalizeLegacyIntent(cloneIntentCandidate(source));
  const targetJson = normalizeIntentTargetJson(candidate);
  return pruneIntentAtPath(candidate, [], targetJson) as SettingsInput;
}
