import React, { useRef } from 'react';
import { usePathname } from 'expo-router';
import BuzzChannels from './beeline/channels';

/** The signed-in root is the Room deck; deep-linked screens own their landing. */
export default function Index() {
  const pathname = usePathname();
  const deck = useRef<React.ReactNode>(null);
  // A cold deep link owns its landing. Once the deck has drawn, native-stack
  // retains it beneath pushed screens, including its list position on Back.
  if (pathname === '/' && deck.current === null) deck.current = <BuzzChannels />;
  return deck.current;
}
