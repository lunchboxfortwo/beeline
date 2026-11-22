// Render the production composer and suggestion menu with local fixtures.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TamaguiProvider, Theme, YStack } from 'tamagui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { tamaguiConfig, themeName } from '@/ui/tamagui.config';
import { ConversationComposer, COMPOSER_MAX_INPUT_HEIGHT } from '@/components/buzz/ConversationComposer';
import { ChannelSuggestionMenu } from '@/components/buzz/MentionSuggestionMenu';
import { channelSuggestionCandidates, filterChannelSuggestions } from '@/buzz/channel-suggestions';
const params = new URLSearchParams(location.search);
const name = themeName(params.get('theme') === 'bone' ? 'light' : 'dark', 'brass');
const scene = params.get('scene') ?? 'six';
const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#b7a88b"/><path d="M0 42 18 13 30 28 40 17 48 37V48H0" fill="#77715d"/></svg>');
function Scene() {
 const [value, setValue] = useState(scene === 'menu' ? '#beeline' : 'Two screenshots of the pill. Can it open in place?');
 const [height, setHeight] = useState(69);
 const [reply, setReply] = useState(true);
 const [attachments, setAttachments] = useState(Array.from({length: scene === 'one' ? 1 : scene === 'menu' ? 0 : 6}, (_,i) => ({uri: photo, name:`file-${i}.jpg`, sizeLabel:'12 KB', mimeType: i === 3 ? 'application/pdf' : 'image/jpeg', uploadState: i === 1 ? 'uploading' as const : 'uploaded' as const })));
 const matches = filterChannelSuggestions(channelSuggestionCandidates([{id:'room',name:'beeline'}], {name:'beeline'}, Array.from({length:6},(_,i)=>({id:`thread-${i}`, name:['thread-handoff-gaps','agent-run-pills','composer-height','file-scroll','chat-links','reply-line'][i],activityAt:1000-i*60}))), 'beeline');
 return <YStack backgroundColor="canvas" height="100vh" padding="2">
  <YStack padding="4"><span style={{color: params.get('theme')==='bone' ? '#171310':'#f0f0f3'}}>#beeline</span></YStack>
  <YStack flex={1}/>
  <YStack width="100%" maxWidth={720} alignSelf="center">
   {scene==='menu' && <ChannelSuggestionMenu query="beeline" {...matches} highlightedIndex={0} keyboardOpen onSelect={(s)=>setValue('#'+s.token)} nowMs={1000000}/>}
   <ConversationComposer value={value} height={height} maxHeight={COMPOSER_MAX_INPUT_HEIGHT} focused disabled={false} hasAgentMembers
    onChangeText={setValue} onContentSizeChange={(e)=>setHeight(Math.min(COMPOSER_MAX_INPUT_HEIGHT, e.nativeEvent.contentSize.height))}
    onFocus={()=>{}} onBlur={()=>{}} onKeyPress={()=>{}} onSend={()=>{}} onAttach={()=>{}}
    reply={scene!=='menu' && reply ? {handle:'ruby',preview:'Mock attached (PNG plus HTML). It covers the open pill.'}:undefined}
    onCancelReply={()=>setReply(false)} attachments={attachments} onRemoveAttachment={(index)=>setAttachments(a=>a.filter((_,i)=>i!==index))}/>
  </YStack>
  {params.get('phone')==='1' && <YStack height={240} backgroundColor="raised" alignItems="center" justifyContent="center"><span>Keyboard area (fixture)</span></YStack>}
 </YStack>;
}
createRoot(document.getElementById('root')!).render(<SafeAreaProvider><TamaguiProvider config={tamaguiConfig} defaultTheme={name}><Theme name={name}><Scene/></Theme></TamaguiProvider></SafeAreaProvider>);
