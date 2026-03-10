import { useMemo } from "react";
import Skeleton from "../Skeleton";
import { renderMarkdown } from "../../renderMarkdown";
import { PanelHead } from "../ui";

interface Props {
  markdown: string | null | undefined;
  onRefresh: () => void;
}

export default function MemorySnapshot({ markdown, onRefresh }: Props) {
  const rendered = useMemo(
    () => (markdown ? renderMarkdown(markdown) : ""),
    [markdown]
  );

  return (
    <div>
      <PanelHead title="Operator Summary">
        <button type="button" className="sm" onClick={onRefresh}>
          Refresh summary
        </button>
      </PanelHead>
      {markdown === undefined || markdown === null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton height="0.9em" width="80%" />
          <Skeleton height="0.9em" width="60%" />
          <Skeleton height="0.9em" width="90%" />
          <Skeleton height="0.9em" width="45%" />
        </div>
      ) : rendered ? (
        <div
          className="memory-box md-rendered"
          dangerouslySetInnerHTML={{ __html: rendered }}
        />
      ) : (
        <pre className="memory-box">No memory data</pre>
      )}
    </div>
  );
}
