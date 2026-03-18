type NumericConstraint = {
  min: number;
  max: number;
};

export const SETTINGS_NUMERIC_CONSTRAINTS = {
  permissions: {
    replies: {
      maxMessagesPerHour: { min: 0, max: 500 },
      maxReactionsPerHour: { min: 0, max: 500 }
    }
  },
  interaction: {
    startup: {
      catchupLookbackHours: { min: 1, max: 168 },
      catchupMaxMessagesPerChannel: { min: 1, max: 200 },
      maxCatchupRepliesPerChannel: { min: 0, max: 20 }
    },
    sessions: {
      sessionIdleTimeoutMs: { min: 10_000, max: 1_800_000 },
      maxConcurrentSessions: { min: 1, max: 100 }
    }
  },
  agentStack: {
    browser: {
      maxBrowseCallsPerHour: { min: 0, max: 60 },
      maxStepsPerTask: { min: 1, max: 30 },
      stepTimeoutMs: { min: 5_000, max: 120_000 },
      sessionTimeoutMs: { min: 10_000, max: 1_800_000 }
    },
    devTeam: {
      maxTurns: { min: 1, max: 200 },
      timeoutMs: { min: 10_000, max: 1_800_000 },
      maxBufferBytes: { min: 4_096, max: 10 * 1024 * 1024 },
      maxTasksPerHour: { min: 0, max: 200 },
      maxParallelTasks: { min: 1, max: 20 },
      asyncDispatchThresholdMs: { min: 0, max: 1_800_000 },
      asyncDispatchProgressIntervalMs: { min: 10_000, max: 1_800_000 },
      asyncDispatchMaxReportsPerTask: { min: 0, max: 20 }
    },
    voiceRuntime: {
      sampleRateHz: { min: 8_000, max: 96_000 }
    }
  },
  voice: {
    sessionLimits: {
      maxSessionMinutes: { min: 1, max: 240 },
      inactivityLeaveSeconds: { min: 15, max: 3_600 },
      maxSessionsPerDay: { min: 0, max: 240 },
      maxConcurrentSessions: { min: 1, max: 3 }
    },
    conversationPolicy: {
      ambientReplyEagerness: { min: 0, max: 100 },
      streaming: {
        minSentencesPerChunk: { min: 1, max: 6 },
        eagerFirstChunkChars: { min: 8, max: 220 },
        maxBufferChars: { min: 80, max: 800 }
      }
    },
    admission: {
      musicWakeLatchSeconds: { min: 0, max: 120 }
    },
    streamWatch: {
      commentaryEagerness: { min: 0, max: 100 }
    },
    soundboard: {
      eagerness: { min: 0, max: 100 }
    }
  }
} as const;
