import { useState } from "react";
import type { PromptSnapshot, VoiceSession } from "../../hooks/useVoiceSSE";
import { CopyButton, Section } from "../ui";
import { normalizeFollowupPrompts, normalizePromptText } from "../../utils/voiceHelpers";
import {
  formatPromptBundleForCopy,
  hasPromptSnapshot,
  relativeTime,
  toPromptBundle
} from "./shared";

function PromptSnapshotCard({
  title,
  snapshot
}: {
  title: string;
  snapshot: PromptSnapshot;
}) {
  const bundle = toPromptBundle(snapshot);
  const systemPrompt = normalizePromptText(bundle?.systemPrompt);
  const initialUserPrompt = normalizePromptText(bundle?.initialUserPrompt);
  const followups = normalizeFollowupPrompts(bundle?.followupUserPrompts);
  const followupSteps = Math.max(0, Math.floor(Number(bundle?.followupSteps) || followups.length));
  const tools = Array.isArray(bundle?.tools) ? bundle.tools.filter((t) => t.name) : [];
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const activeTool = tools.find((t) => t.name === selectedTool) || null;
  const hasData = hasPromptSnapshot(snapshot);

  const meta = snapshot?.source
    ? `${snapshot.source}${snapshot.updatedAt ? ` · ${relativeTime(snapshot.updatedAt)}` : ""}`
    : undefined;

  return (
    <Section title={title} badge={meta} defaultOpen={hasData} disabled={!hasData}>
      <div className="vm-prompt-card">
        <div className="vm-prompt-card-header">
          <CopyButton text={formatPromptBundleForCopy(bundle)} label />
        </div>

        <div className="vm-prompt-body">
          <div className="vm-prompt-block">
            <div className="vm-prompt-block-header">
              <span className="vm-mini-label">System Prompt</span>
              <CopyButton text={systemPrompt || "(empty)"} />
            </div>
            <pre className="vm-prompt-pre">{systemPrompt || "(empty)"}</pre>
          </div>

          {(initialUserPrompt || followups.length > 0) && (
            <div className="vm-prompt-block">
              <div className="vm-prompt-block-header">
                <span className="vm-mini-label">Initial User Prompt</span>
                <CopyButton text={initialUserPrompt || "(empty)"} />
              </div>
              <pre className="vm-prompt-pre">{initialUserPrompt || "(empty)"}</pre>
            </div>
          )}

          {followups.length > 0 && (
            <div className="vm-prompt-block">
              <span className="vm-mini-label">
                Follow-up User Prompts ({Math.max(followupSteps, followups.length)})
              </span>
              <div className="vm-prompt-followups">
                {followups.map((prompt, index) => (
                  <div key={`${title}-followup-${index}`} className="vm-prompt-followup">
                    <div className="vm-prompt-block-header">
                      <span className="vm-prompt-step">Step {index + 1}</span>
                      <CopyButton text={prompt || "(empty)"} />
                    </div>
                    <pre className="vm-prompt-pre">{prompt || "(empty)"}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tools.length > 0 && (
            <div className="vm-prompt-block">
              <span className="vm-mini-label">Tools ({tools.length})</span>
              <div className="vm-tools-list">
                {tools.map((t) => (
                  <span
                    key={t.name}
                    className={`vm-tool-chip vm-tool-fn${selectedTool === t.name ? " vm-tool-chip-active" : ""}`}
                    onClick={() => setSelectedTool(selectedTool === t.name ? null : t.name)}
                    style={{ cursor: "pointer" }}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
              {activeTool && (
                <div className="vm-tool-detail">
                  <p className="vm-tool-detail-desc">{activeTool.description}</p>
                  {activeTool.parameters && (
                    <pre className="vm-prompt-pre">{JSON.stringify(activeTool.parameters, null, 2)}</pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

export function PromptStateViewer({ session }: { session: VoiceSession }) {
  const promptState = session.promptState || null;
  const cards = [
    {
      key: "instructions",
      title: "Current Realtime Instructions",
      snapshot: promptState?.instructions || null
    },
    {
      key: "generation",
      title: "Latest VC Brain Prompt",
      snapshot: promptState?.generation || null
    },
    {
      key: "classifier",
      title: "Latest Classifier Prompt",
      snapshot: promptState?.classifier || null
    },
    {
      key: "bridge",
      title: "Latest Bridge Forwarded Turn",
      snapshot: promptState?.bridge || null
    }
  ];
  const activeCount = cards.filter((card) => hasPromptSnapshot(card.snapshot)).length;

  return (
    <Section title="Live Prompt Snapshot" badge={activeCount > 0 ? activeCount : null}>
      {cards.map((card) => (
        <PromptSnapshotCard key={card.key} title={card.title} snapshot={card.snapshot} />
      ))}
    </Section>
  );
}
