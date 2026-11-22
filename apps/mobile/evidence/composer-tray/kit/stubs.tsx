// Native services are idle in this offline rendering fixture.
import React from 'react';
export const useSpeechInput = () => ({ state:'idle', capability:'unavailable' });
export const VoiceAgentStrip = () => null;
export const VoiceBar = () => null;
export const HullDialog = () => null;
export const SurfaceGlyphLoader = () => null;
export const RuntimeErrorBoundary = ({children}: {children: React.ReactNode}) => <>{children}</>;
export const useReanimatedKeyboardAnimation = () => ({height:{value:0}});
export const useWindowDimensions = () => ({width:390,height:844});
export const lowerKeyboard = () => {};
export const useFinePointer = () => true;
export const resolveAgentDisplayIdentity = () => ({});
export const memberRosterModel = () => undefined;
export const memberRosterSubtitle = () => undefined;
export const IdentityMark = () => null;
export const impactAsync = async () => {};
export const selectionAsync = async () => {};
export const ImpactFeedbackStyle = {};
