import { createContext, useContext } from "react";
import { mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";

import type { ReportEmbedKind } from "@/types/report";

import { ReportEmbed, type ReportEmbedRuntime } from "./ReportEmbed";
import { ReportProjectEmbedNode } from "./reportEditorCodec";

export const ReportEmbedRuntimeContext = createContext<ReportEmbedRuntime | undefined>(undefined);

function ProjectEmbedView({ node, selected }: NodeViewProps) {
  const kind = node.attrs.kind as ReportEmbedKind;
  const documentId = String(node.attrs.documentId);
  const runtime = useContext(ReportEmbedRuntimeContext);

  return (
    <NodeViewWrapper
      className={`sp-report-project-embed${selected ? " is-selected" : ""}`}
      data-report-project-embed=""
      data-kind={kind}
      data-document-id={documentId}
      contentEditable={false}
    >
      <ReportEmbed dependency={{ kind, documentId }} runtime={runtime} />
    </NodeViewWrapper>
  );
}

export const ReportProjectEmbed = ReportProjectEmbedNode.extend({
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-report-project-embed": "" }),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ProjectEmbedView);
  },
});