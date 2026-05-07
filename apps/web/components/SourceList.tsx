import type { CitedSource } from "../lib/types";

type SourceListProps = {
  sources: CitedSource[];
};

export function SourceList({ sources }: SourceListProps) {
  if (!sources.length) {
    return <p className="empty-text">No sources returned.</p>;
  }

  return (
    <ul className="source-list">
      {sources.map((source, index) => (
        <li className="source-item" key={`${source.url || source.title || "source"}-${index}`}>
          <div className="source-meta">
            <span className="tag">{source.provenance || "unknown"}</span>
            {source.source_name ? <span className="tag">{source.source_name}</span> : null}
            {source.source_type ? <span className="tag">{source.source_type}</span> : null}
            {typeof source.confidence_score === "number" ? (
              <span className="tag">{Math.round(source.confidence_score * 100)}% confidence</span>
            ) : null}
          </div>
          <p className="source-title">{source.title || source.url || "Untitled source"}</p>
          {source.url ? (
            <a className="source-url" href={source.url} target="_blank" rel="noreferrer">
              {source.url}
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
