import { requestWatchStream, initializeStreamWatchState, supportsStreamWatchCommentary, supportsVisionFallbackStreamWatchCommentary, supportsStreamWatchBrainContext, resolveStreamWatchVisionProviderSettings, getStreamWatchBrainContextForPrompt, requestStopWatchingStream, requestStreamWatchStatus } from "./voiceStreamWatch.ts";

export function injectStreamWatchMethods(target: any) {

      target.prototype.requestWatchStream = async function({ message, settings, targetUserId = null }) {
    return await requestWatchStream(this, { message, settings, targetUserId });
      };

      target.prototype.initializeStreamWatchState = function({ session, requesterUserId, targetUserId = null }) {
    return initializeStreamWatchState(this, { session, requesterUserId, targetUserId });
      };

      target.prototype.supportsStreamWatchCommentary = function(session, settings = null) {
    return supportsStreamWatchCommentary(this, session, settings);
      };

      target.prototype.supportsVisionFallbackStreamWatchCommentary = function({ session = null, settings = null } = {}) {
    return supportsVisionFallbackStreamWatchCommentary(this, { session, settings });
      };

      target.prototype.supportsStreamWatchBrainContext = function({ session = null, settings = null } = {}) {
    return supportsStreamWatchBrainContext(this, { session, settings });
      };

      target.prototype.resolveStreamWatchVisionProviderSettings = function(settings = null) {
    return resolveStreamWatchVisionProviderSettings(this, settings);
      };

      target.prototype.getStreamWatchBrainContextForPrompt = function(session, settings = null) {
    return getStreamWatchBrainContextForPrompt(session, settings);
      };

      target.prototype.requestStopWatchingStream = async function({ message, settings }) {
    return await requestStopWatchingStream(this, { message, settings });
      };

      target.prototype.requestStreamWatchStatus = async function({ message, settings }) {
    return await requestStreamWatchStatus(this, { message, settings });
      };
}
