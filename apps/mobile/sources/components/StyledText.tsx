import React from 'react';
import { T } from '@/ui/grammar';

type StyledTextProps = React.ComponentProps<typeof T> & {
  /**
   * Whether the text should be selectable. Defaults to false.
   */
  selectable?: boolean;
};

/** App text: one grammar type style (body by default). */
export const Text: React.FC<StyledTextProps> = ({
  selectable = false,
  ...props
}) => <T userSelect={selectable ? 'text' : undefined} {...props} />;
