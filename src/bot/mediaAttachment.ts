import { MAX_GIF_QUERY_LEN, normalizeDirectiveText } from "../botHelpers.ts";
import { getDiscoverySettings } from "../settings/agentStack.ts";
import type { Settings } from "../settings/settingsSchema.ts";
import {
  getGifBudgetState,
  getImageBudgetState,
  getVideoGenerationBudgetState,
  isImageGenerationReady,
  isVideoGenerationReady,
  type GifBudgetState,
  type ImageBudgetState,
  type VideoGenerationBudgetState
} from "./budgetTracking.ts";
import type { MediaAttachmentContext } from "./botContext.ts";

type MessagePayloadFile = {
  attachment: Buffer;
  name: string;
};

export type MessagePayload = {
  content: string;
  files?: MessagePayloadFile[];
};

export type MediaDirectiveType =
  | "gif"
  | "image_simple"
  | "image_complex"
  | "video";

type MediaAttachmentTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
};

type GenerateImageResult = {
  imageBuffer?: Buffer | null;
  imageUrl?: string | null;
  variant?: string | null;
};

type GenerateVideoResult = {
  videoUrl?: string | null;
};

type MaybeAttachGeneratedImageOptions = {
  settings: Settings;
  text: string;
  prompt?: string | null;
  variant?: string;
  trace?: MediaAttachmentTrace;
};

type MaybeAttachGeneratedVideoOptions = {
  settings: Settings;
  text: string;
  prompt?: string | null;
  trace?: MediaAttachmentTrace;
};

type MaybeAttachReplyGifOptions = {
  settings: Settings;
  text: string;
  query?: string | null;
  trace?: MediaAttachmentTrace;
};

export type MaybeAttachGeneratedImageResult = {
  payload: MessagePayload;
  imageUsed: boolean;
  variant: string | null;
  blockedByBudget: boolean;
  blockedByCapability: boolean;
  budget: ImageBudgetState;
};

export type MaybeAttachGeneratedVideoResult = {
  payload: MessagePayload;
  videoUsed: boolean;
  blockedByBudget: boolean;
  blockedByCapability: boolean;
  budget: VideoGenerationBudgetState;
};

export type MaybeAttachReplyGifResult = {
  payload: MessagePayload;
  gifUsed: boolean;
  blockedByBudget: boolean;
  blockedByConfiguration: boolean;
  budget: GifBudgetState;
};

export type ResolveMediaAttachmentOptions = {
  settings: Settings;
  text: string;
  directive?: {
    type?: MediaDirectiveType | null;
    gifQuery?: string | null;
    imagePrompt?: string | null;
    complexImagePrompt?: string | null;
    videoPrompt?: string | null;
  } | null;
  trace?: MediaAttachmentTrace;
};

export type ResolveMediaAttachmentResult = {
  payload: MessagePayload;
  media: { type: MediaDirectiveType } | null;
  imageUsed: boolean;
  imageBudgetBlocked: boolean;
  imageCapabilityBlocked: boolean;
  imageVariantUsed: string | null;
  videoUsed: boolean;
  videoBudgetBlocked: boolean;
  videoCapabilityBlocked: boolean;
  gifUsed: boolean;
  gifBudgetBlocked: boolean;
  gifConfigBlocked: boolean;
};

function buildBasePayload(text: string): MessagePayload {
  return {
    content: String(text || "")
  };
}

function normalizeTrace(trace: MediaAttachmentTrace | undefined) {
  return {
    guildId: trace?.guildId ?? null,
    channelId: trace?.channelId ?? null,
    userId: trace?.userId ?? null,
    source: trace?.source ?? null
  };
}

export function buildMessagePayloadWithImage(
  text: string,
  image: GenerateImageResult
) {
  if (image.imageBuffer) {
    return {
      payload: {
        content: String(text || ""),
        files: [{ attachment: image.imageBuffer, name: `clanker-${Date.now()}.png` }]
      },
      imageUsed: true
    };
  }

  if (image.imageUrl) {
    const normalizedUrl = String(image.imageUrl || "").trim();
    const trimmedText = String(text || "").trim();
    const content = trimmedText ? `${trimmedText}\n${normalizedUrl}` : normalizedUrl;
    return {
      payload: { content },
      imageUsed: true
    };
  }

  return {
    payload: buildBasePayload(text),
    imageUsed: false
  };
}

export function buildMessagePayloadWithVideo(
  text: string,
  video: GenerateVideoResult
) {
  const videoUrl = String(video?.videoUrl || "").trim();
  if (!videoUrl) {
    return {
      payload: buildBasePayload(text),
      videoUsed: false
    };
  }

  const trimmedText = String(text || "").trim();
  const content = trimmedText ? `${trimmedText}\n${videoUrl}` : videoUrl;
  return {
    payload: { content },
    videoUsed: true
  };
}

export function buildMessagePayloadWithGif(text: string, gifUrl: string) {
  const normalizedUrl = String(gifUrl || "").trim();
  if (!normalizedUrl) {
    return {
      payload: buildBasePayload(text),
      gifUsed: false
    };
  }

  const trimmedText = String(text || "").trim();
  const content = trimmedText ? `${trimmedText}\n${normalizedUrl}` : normalizedUrl;
  return {
    payload: { content },
    gifUsed: true
  };
}

export async function maybeAttachGeneratedImage(
  ctx: MediaAttachmentContext,
  {
    settings,
    text,
    prompt,
    variant = "simple",
    trace
  }: MaybeAttachGeneratedImageOptions
): Promise<MaybeAttachGeneratedImageResult> {
  const payload = buildBasePayload(text);
  const normalizedVariant = variant === "complex" ? "complex" : "simple";
  const ready = isImageGenerationReady(ctx, settings, normalizedVariant);
  if (!ready) {
    return {
      payload,
      imageUsed: false,
      variant: null,
      blockedByBudget: false,
      blockedByCapability: true,
      budget: getImageBudgetState(ctx, settings)
    };
  }

  const budget = getImageBudgetState(ctx, settings);
  if (!budget.canGenerate) {
    return {
      payload,
      imageUsed: false,
      variant: null,
      blockedByBudget: true,
      blockedByCapability: false,
      budget
    };
  }

  try {
    const image = await ctx.llm.generateImage({
      settings,
      prompt,
      variant: normalizedVariant,
      trace: normalizeTrace(trace)
    });
    const withImage = buildMessagePayloadWithImage(text, image);
    return {
      payload: withImage.payload,
      imageUsed: withImage.imageUsed,
      variant: image.variant || normalizedVariant,
      blockedByBudget: false,
      blockedByCapability: false,
      budget
    };
  } catch {
    return {
      payload,
      imageUsed: false,
      variant: null,
      blockedByBudget: false,
      blockedByCapability: false,
      budget
    };
  }
}

export async function maybeAttachGeneratedVideo(
  ctx: MediaAttachmentContext,
  {
    settings,
    text,
    prompt,
    trace
  }: MaybeAttachGeneratedVideoOptions
): Promise<MaybeAttachGeneratedVideoResult> {
  const payload = buildBasePayload(text);
  const ready = isVideoGenerationReady(ctx, settings);
  if (!ready) {
    return {
      payload,
      videoUsed: false,
      blockedByBudget: false,
      blockedByCapability: true,
      budget: getVideoGenerationBudgetState(ctx, settings)
    };
  }

  const budget = getVideoGenerationBudgetState(ctx, settings);
  if (!budget.canGenerate) {
    return {
      payload,
      videoUsed: false,
      blockedByBudget: true,
      blockedByCapability: false,
      budget
    };
  }

  try {
    const video = await ctx.llm.generateVideo({
      settings,
      prompt,
      trace: normalizeTrace(trace)
    });
    const withVideo = buildMessagePayloadWithVideo(text, video);
    return {
      payload: withVideo.payload,
      videoUsed: withVideo.videoUsed,
      blockedByBudget: false,
      blockedByCapability: false,
      budget
    };
  } catch {
    return {
      payload,
      videoUsed: false,
      blockedByBudget: false,
      blockedByCapability: false,
      budget
    };
  }
}

export async function maybeAttachReplyGif(
  ctx: MediaAttachmentContext,
  {
    settings,
    text,
    query,
    trace
  }: MaybeAttachReplyGifOptions
): Promise<MaybeAttachReplyGifResult> {
  const payload = buildBasePayload(text);
  const budget = getGifBudgetState(ctx, settings);
  const normalizedQuery = normalizeDirectiveText(query, MAX_GIF_QUERY_LEN);
  const discovery = getDiscoverySettings(settings);

  if (!discovery.allowReplyGifs) {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: false,
      blockedByConfiguration: true,
      budget
    };
  }

  if (!normalizedQuery) {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: false,
      blockedByConfiguration: false,
      budget
    };
  }

  if (!ctx.gifs?.isConfigured?.()) {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: false,
      blockedByConfiguration: true,
      budget
    };
  }

  if (!budget.canFetch) {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: true,
      blockedByConfiguration: false,
      budget
    };
  }

  try {
    const gif = await ctx.gifs.pickGif({
      query: normalizedQuery,
      trace
    });
    if (!gif?.url) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: false,
        budget
      };
    }

    const withGif = buildMessagePayloadWithGif(text, gif.url);
    return {
      payload: withGif.payload,
      gifUsed: withGif.gifUsed,
      blockedByBudget: false,
      blockedByConfiguration: false,
      budget
    };
  } catch {
    return {
      payload,
      gifUsed: false,
      blockedByBudget: false,
      blockedByConfiguration: false,
      budget
    };
  }
}

export async function resolveMediaAttachment(
  ctx: MediaAttachmentContext,
  {
    settings,
    text,
    directive = null,
    trace
  }: ResolveMediaAttachmentOptions
): Promise<ResolveMediaAttachmentResult> {
  const base: ResolveMediaAttachmentResult = {
    payload: buildBasePayload(text),
    media: null,
    imageUsed: false,
    imageBudgetBlocked: false,
    imageCapabilityBlocked: false,
    imageVariantUsed: null,
    videoUsed: false,
    videoBudgetBlocked: false,
    videoCapabilityBlocked: false,
    gifUsed: false,
    gifBudgetBlocked: false,
    gifConfigBlocked: false
  };

  if (directive?.type === "gif" && directive.gifQuery) {
    const gifResult = await maybeAttachReplyGif(ctx, {
      settings,
      text,
      query: directive.gifQuery,
      trace
    });
    return {
      ...base,
      payload: gifResult.payload,
      media: gifResult.gifUsed ? { type: "gif" } : null,
      gifUsed: gifResult.gifUsed,
      gifBudgetBlocked: gifResult.blockedByBudget,
      gifConfigBlocked: gifResult.blockedByConfiguration
    };
  }

  if (directive?.type === "image_simple" && directive.imagePrompt) {
    const imageResult = await maybeAttachGeneratedImage(ctx, {
      settings,
      text,
      prompt: directive.imagePrompt,
      variant: "simple",
      trace
    });
    return {
      ...base,
      payload: imageResult.payload,
      media: imageResult.imageUsed ? { type: "image_simple" } : null,
      imageUsed: imageResult.imageUsed,
      imageBudgetBlocked: imageResult.blockedByBudget,
      imageCapabilityBlocked: imageResult.blockedByCapability,
      imageVariantUsed: imageResult.variant || "simple"
    };
  }

  if (directive?.type === "image_complex" && directive.complexImagePrompt) {
    const imageResult = await maybeAttachGeneratedImage(ctx, {
      settings,
      text,
      prompt: directive.complexImagePrompt,
      variant: "complex",
      trace
    });
    return {
      ...base,
      payload: imageResult.payload,
      media: imageResult.imageUsed ? { type: "image_complex" } : null,
      imageUsed: imageResult.imageUsed,
      imageBudgetBlocked: imageResult.blockedByBudget,
      imageCapabilityBlocked: imageResult.blockedByCapability,
      imageVariantUsed: imageResult.variant || "complex"
    };
  }

  if (directive?.type === "video" && directive.videoPrompt) {
    const videoResult = await maybeAttachGeneratedVideo(ctx, {
      settings,
      text,
      prompt: directive.videoPrompt,
      trace
    });
    return {
      ...base,
      payload: videoResult.payload,
      media: videoResult.videoUsed ? { type: "video" } : null,
      videoUsed: videoResult.videoUsed,
      videoBudgetBlocked: videoResult.blockedByBudget,
      videoCapabilityBlocked: videoResult.blockedByCapability
    };
  }

  return base;
}
