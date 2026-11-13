import React, { useMemo } from 'react';
import { T } from '@/ui/grammar';
import { tokenizeCode, type HighlightToken } from '@/buzz/syntax-highlight';

type CodeHighlighterProps = {
  code: string;
  language: string | null;
};

// React Native pays native-view and layout cost for every nested Text span.
// Keep ordinary code highlighted, but render unusually large blocks as one
// selectable, full-fidelity text node instead of building thousands of spans.
const MAX_HIGHLIGHTED_CODE_CHARS = 20_000;

/** Two Inks on the grammar: structure recedes, names take brass, values read in ink. */
function Span({ token, children }: { token: HighlightToken; children: string }) {
  switch (token) {
    case 'structure':
      return <T v="code" color="secondary">{children}</T>;
    case 'name':
      return <T v="code" color="needsYou">{children}</T>;
    case 'value':
      return <T v="code" color="ink">{children}</T>;
    default:
      return <T v="code" color="secondary">{children}</T>;
  }
}

/**
 * Renders a code block with Two Inks spans. Long lines wrap: the parent must
 * bound width (no horizontal ScrollView). Very large blocks fall back to one
 * full-fidelity Text node so native layout stays bounded.
 */
export function CodeHighlighter({ code, language }: CodeHighlighterProps) {
  const lines = useMemo(
    () => (code.length <= MAX_HIGHLIGHTED_CODE_CHARS ? tokenizeCode(code, language) : null),
    [code, language],
  );

  if (!code) return null;

  if (!lines) {
    return (
      <T v="code" color="secondary" userSelect="text" width="100%" minWidth={0} testID="code-highlighter">
        {code}
      </T>
    );
  }

  return (
    <T v="code" color="secondary" userSelect="text" width="100%" minWidth={0} testID="code-highlighter">
      {lines.map((line, li) => (
        <React.Fragment key={li}>
          {li > 0 ? '\n' : null}
          {line.map((span, si) => (
            <Span key={si} token={span.token}>{span.text}</Span>
          ))}
        </React.Fragment>
      ))}
    </T>
  );
}
