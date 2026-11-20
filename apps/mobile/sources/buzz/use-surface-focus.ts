import { useCallback, useContext, useState } from 'react';
import { NavigationContext } from '@react-navigation/core';
import { useFocusEffect } from '@react-navigation/native';

/** Retained navigation screens release network observers on actual blur.
 * Component mount alone does not make a surface focused. A screen pushed
 * focused starts focused, so its first commit needs no second render.
 */
export function useSurfaceFocus(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => { setFocused(false); };
  }, []));
  return focused;
}
