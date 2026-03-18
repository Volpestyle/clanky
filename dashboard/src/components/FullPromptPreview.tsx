import { useState } from "react";
import { interpolatePromptTemplate } from "../promptTemplate";

function ScenarioSection({ title, prompt }) {
  if (!prompt) return null;
  return (
    <div className="full-prompt-scenario">
      <div className="full-prompt-scenario-title">{title}</div>
      <pre className="full-prompt-scenario-content">{prompt}</pre>
    </div>
  );
}

export function FullPromptPreview({ form }) {
  const [expanded, setExpanded] = useState(false);
  const botName = form.botName || "clanky";

  const textGuidance = interpolatePromptTemplate(form.promptTextGuidance, { botName });
  const voiceGuidance = interpolatePromptTemplate(form.promptVoiceGuidance, { botName });
  const voiceOperationalGuidance = interpolatePromptTemplate(form.promptVoiceOperationalGuidance, { botName });
  const capabilityHonesty = interpolatePromptTemplate(form.promptCapabilityHonestyLine, { botName });
  const impossibleAction = interpolatePromptTemplate(form.promptImpossibleActionLine, { botName });
  const memoryEnabled = interpolatePromptTemplate(form.promptMemoryEnabledLine, { botName });
  const memoryDisabled = interpolatePromptTemplate(form.promptMemoryDisabledLine, { botName });
  const skipLine = interpolatePromptTemplate(form.promptSkipLine, { botName });
  const mediaGuidance = interpolatePromptTemplate(form.promptMediaPromptCraftGuidance, { botName });

  const userPromptPreview = `=== LATEST MESSAGE (TURN ANCHOR) ===
Message from {{user}}: {{message content}}
{{#if has images}}
Attachments:
- {{filename}} ({{type}})
{{/if}}

=== RECENT MESSAGES ===
{{recent message 1}}
{{recent message 2}}
...

=== RELEVANT PAST MESSAGES ===
{{relevant message 1}}
...

=== USER FACTS ===
{{user fact 1}}
...

=== DURABLE MEMORY ===
{{memory fact 1}}
...

=== EMOJI OPTIONS ===
Server emoji: {{emoji1}}, {{emoji2}}

=== RESPONSE DECISION ===
Direct-address confidence: {{confidence}} (threshold {{threshold}}).
{{#if addressed}}This message directly addressed you.{{/if}}
A reply is required for this turn unless safety policy requires refusing.
Text ambient-reply eagerness: {{ambientReplyEagerness}}/100.
Response-window eagerness: {{responseWindowEagerness}}/100.
Reactivity: {{reactivity}}/100.`;

  const hasAnyPrompts =
    textGuidance ||
    voiceGuidance ||
    voiceOperationalGuidance ||
    capabilityHonesty ||
    impossibleAction ||
    memoryEnabled ||
    memoryDisabled ||
    skipLine ||
    mediaGuidance;

  if (!hasAnyPrompts) return null;

  return (
    <div className="full-prompt-preview-wrap">
      <button
        type="button"
        className="full-prompt-preview-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "▼" : "▶"} Full Prompt Preview
      </button>
      {expanded && (
        <div className="full-prompt-preview-content">
          <ScenarioSection title="Text Guidance" prompt={textGuidance} />
          <ScenarioSection title="Voice Guidance" prompt={voiceGuidance} />
          <ScenarioSection title="Voice Operational Guidance" prompt={voiceOperationalGuidance} />
          <ScenarioSection title="Capability Honesty" prompt={capabilityHonesty} />
          <ScenarioSection title="Impossible Action" prompt={impossibleAction} />
          <ScenarioSection title="Memory Enabled" prompt={memoryEnabled} />
          <ScenarioSection title="Memory Disabled" prompt={memoryDisabled} />
          <ScenarioSection title="Skip Directive" prompt={skipLine} />
          <ScenarioSection title="Media Guidance" prompt={mediaGuidance} />
          <ScenarioSection title="User Prompt Structure" prompt={userPromptPreview} />
        </div>
      )}
    </div>
  );
}
