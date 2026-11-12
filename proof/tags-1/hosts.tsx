// Browser native-host stand-ins; production TrayScreen, TagCard and section header own layout/copy.
import React from 'react';
import { beelineThemes } from '../../apps/mobile/sources/buzz/groknight';
const dark = new URLSearchParams(location.search).get('theme') !== 'bone';
const theme = dark ? beelineThemes.obsidian : beelineThemes.bone;
const colors: Record<string,string> = {canvas:theme.bgBase, raised:theme.bgRaised, ink:theme.textPrimary,
  secondary:theme.textSecondary, needsYou:theme.accent, stroke:theme.border, strongStroke:theme.borderStrong,
  highlight:theme.bgHighlight, transparent:'transparent'};
document.body.style.backgroundColor = theme.bgBase;
const steps: Record<string,number> = {'0':0,'0.5':2,'1':4,'2':8,'3':12,'4':16,'5':20,'6':24,'8':32};
const step = (x:any) => steps[x] ?? x;
export function Stack({children,testID,onPress,accessibilityRole,backgroundColor,borderColor,gap,...rest}:any) {
  const style:any = {display:'flex',flexDirection:'column',boxSizing:'border-box',minWidth:0,
    gap:step(gap),background:colors[backgroundColor],borderColor:colors[borderColor],borderStyle:'solid',borderWidth:0};
  for (const key of ['padding','paddingTop','paddingBottom','paddingLeft','paddingRight','marginTop','marginBottom']) if (rest[key] !== undefined) style[key]=step(rest[key]);
  if(rest.paddingHorizontal!==undefined) style.paddingLeft=style.paddingRight=step(rest.paddingHorizontal);
  for (const key of ['flex','height','minHeight','width','maxWidth','minWidth','alignItems','alignSelf','justifyContent','borderWidth','overflow']) if(rest[key]!==undefined) style[key]=rest[key];
  if(rest.row) style.flexDirection='row';
  return <div data-testid={testID} role={accessibilityRole} onClick={onPress} style={style}>{children}</div>;
}
export const YStack = Stack;
export const XStack = (props:any) => <Stack {...props} row />;
export const Card = Stack;
export const ListItem = Stack;
export const Image = () => null;
export const RadioGroup:any = Stack;
RadioGroup.Item=Stack; RadioGroup.Indicator=()=>null;
export const HEIGHT = {control:44};
export function T({children,v='body',color='ink',testID,accessibilityRole,flex,textAlign}:any) {
  const small=v==='meta'||v==='metaStrong';
  return <span data-testid={testID} role={accessibilityRole} style={{color:colors[color]??theme.textPrimary,
    fontFamily:v==='heading'||v==='metaStrong'?'SpaceGrotesk-SemiBold':'SpaceGrotesk-Regular',
    fontSize:small?13:16,lineHeight:small?'19px':'23px',flex,textAlign}}>{children}</span>;
}
export const Copy = ({small,quiet,strong,accent,...rest}:any) => <T {...rest} v={small?(strong?'metaStrong':'meta'):(strong?'heading':'body')} color={accent?'needsYou':quiet?'secondary':'ink'} />;
export const Glyph = () => null;
export const Inked = () => null;
export const Btn = ({children,onPress,testID}:any) => <button data-testid={testID} onClick={onPress}>{children}</button>;
export const SafeTop = () => null;
export const Path = () => null;
export default Stack;
export const AccessibilityInfo = {announceForAccessibility:()=>{}};
export const AppState = {currentState:'active'};
export function FlatList(props:any) {
  React.useEffect(()=>{props.onViewableItemsChanged?.({viewableItems:props.data.map((item:any)=>({item,isViewable:true}))});},[props.data]);
  return <Stack testID={props.testID}>{props.data.length?props.data.map((item:any,index:number)=><React.Fragment key={props.keyExtractor(item)}>{props.renderItem({item,index})}</React.Fragment>):props.ListEmptyComponent}{props.ListFooterComponent}</Stack>;
}
