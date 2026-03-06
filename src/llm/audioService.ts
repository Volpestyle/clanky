import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type OpenAI from "openai";
import { clampNumber } from "./llmHelpers.ts";
import { normalizeInlineText } from "./llmHelpers.ts";
import type { LlmActionStore, LlmTrace } from "./serviceShared.ts";

export type AudioServiceDeps = {
  openai: OpenAI | null;
  store: LlmActionStore;
};

type TranscriptionTextResponse = {
  text: string;
};

function isTranscriptionTextResponse(value: unknown): value is TranscriptionTextResponse {
  return Boolean(value) && typeof value === "object" && "text" in value && typeof value.text === "string";
}

export function isAsrReady(deps: AudioServiceDeps) {
  return Boolean(deps.openai);
}

export function isSpeechSynthesisReady(deps: AudioServiceDeps) {
  return Boolean(deps.openai);
}

export async function transcribeAudio(
  deps: AudioServiceDeps,
  {
    filePath,
    audioBytes = null,
    fileName = "audio.wav",
    model = "gpt-4o-mini-transcribe",
    language = "",
    prompt = "",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    filePath?: string | null;
    audioBytes?: Buffer | Uint8Array | ArrayBuffer | null;
    fileName?: string;
    model?: string;
    language?: string;
    prompt?: string;
    trace?: LlmTrace;
  }
) {
  if (!deps.openai) {
    throw new Error("ASR fallback requires OPENAI_API_KEY.");
  }

  const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
  const resolvedLanguage = String(language || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .slice(0, 24);
  const resolvedPrompt = String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);

  try {
    const filePathText = String(filePath || "").trim();
    const resolvedFileName = String(fileName || "").trim() || "audio.wav";
    const resolvedAudioBytes = Buffer.isBuffer(audioBytes)
      ? audioBytes
      : audioBytes instanceof Uint8Array
        ? Buffer.from(audioBytes)
        : audioBytes instanceof ArrayBuffer
          ? Buffer.from(audioBytes)
          : filePathText
            ? await readFile(filePathText)
            : null;
    if (!resolvedAudioBytes?.length) {
      throw new Error("ASR transcription requires non-empty audio bytes or file path.");
    }

    const response = await deps.openai.audio.transcriptions.create({
      model: resolvedModel,
      file: new File([new Uint8Array(resolvedAudioBytes)], basename(filePathText) || resolvedFileName),
      response_format: "text",
      ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
      ...(resolvedPrompt ? { prompt: resolvedPrompt } : {})
    });
    const rawResponse: unknown = response;

    const text =
      typeof rawResponse === "string"
        ? rawResponse.trim()
        : isTranscriptionTextResponse(rawResponse)
          ? rawResponse.text.trim()
          : String(rawResponse || "").trim();
    if (!text) {
      throw new Error("ASR returned empty transcript.");
    }

    deps.store.logAction({
      kind: "asr_call",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: resolvedModel,
      metadata: {
        model: resolvedModel,
        language: resolvedLanguage || null,
        prompt: resolvedPrompt || null,
        source: trace.source || "unknown"
      }
    });

    return text;
  } catch (error) {
    deps.store.logAction({
      kind: "asr_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String(error?.message || error),
      metadata: {
        model: resolvedModel,
        language: resolvedLanguage || null,
        prompt: resolvedPrompt || null,
        source: trace.source || "unknown"
      }
    });
    throw error;
  }
}

export async function synthesizeSpeech(
  deps: AudioServiceDeps,
  {
    text,
    model = "gpt-4o-mini-tts",
    voice = "alloy",
    speed = 1,
    responseFormat = "pcm",
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }: {
    text: unknown;
    model?: string;
    voice?: string;
    speed?: number;
    responseFormat?: string;
    trace?: LlmTrace;
  }
) {
  if (!deps.openai) {
    throw new Error("Speech synthesis requires OPENAI_API_KEY.");
  }

  const resolvedText = normalizeInlineText(text, 4000);
  if (!resolvedText) {
    throw new Error("Speech synthesis requires non-empty text.");
  }

  const resolvedModel = String(model || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
  const resolvedVoice = String(voice || "alloy").trim() || "alloy";
  const normalizedFormat = String(responseFormat || "pcm").trim().toLowerCase();
  let resolvedFormat: "opus" | "pcm" | "mp3" | "aac" | "flac" | "wav" = "pcm";
  if (
    normalizedFormat === "opus" ||
    normalizedFormat === "pcm" ||
    normalizedFormat === "mp3" ||
    normalizedFormat === "aac" ||
    normalizedFormat === "flac" ||
    normalizedFormat === "wav"
  ) {
    resolvedFormat = normalizedFormat;
  }
  const resolvedSpeed = clampNumber(speed, 0.25, 2, 1);

  try {
    const response = await deps.openai.audio.speech.create({
      model: resolvedModel,
      voice: resolvedVoice,
      input: resolvedText,
      speed: resolvedSpeed,
      response_format: resolvedFormat
    });
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (!audioBuffer.length) {
      throw new Error("Speech synthesis returned empty audio.");
    }

    deps.store.logAction({
      kind: "tts_call",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: resolvedModel,
      metadata: {
        model: resolvedModel,
        voice: resolvedVoice,
        speed: resolvedSpeed,
        responseFormat: resolvedFormat,
        textChars: resolvedText.length,
        source: trace.source || "unknown"
      }
    });

    return {
      audioBuffer,
      model: resolvedModel,
      voice: resolvedVoice,
      speed: resolvedSpeed,
      responseFormat: resolvedFormat
    };
  } catch (error) {
    deps.store.logAction({
      kind: "tts_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String(error?.message || error),
      metadata: {
        model: resolvedModel,
        voice: resolvedVoice,
        speed: resolvedSpeed,
        responseFormat: resolvedFormat,
        source: trace.source || "unknown"
      }
    });
    throw error;
  }
}
