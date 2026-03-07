const CANCEL_KEYWORDS =
  /^(?:ok\s+|oh\s+|actually\s+|just\s+|please\s+|yeah\s+|hey\s+)?(?:stop|cancel|never\s?mind|nevermind|nvm|forget\s?it|abort|quit)(?:\s+(?:it|that|this|please|now))?[.!]?$/i;

export function isCancelIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  return CANCEL_KEYWORDS.test(String(text).trim());
}
