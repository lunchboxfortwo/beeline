import { registerRootComponent } from 'expo';
import React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { boneTheme, obsidianTheme } from '../sources/theme';
import { LedgerEntry } from '../sources/components/buzz/Ledger';
import result from './result.json';
import {useFonts} from 'expo-font';
StyleSheet.configure({themes:{bone:boneTheme,obsidian:obsidianTheme},settings:{initialTheme:'bone'}});
function App(){
 const [lang,setLang]=React.useState('en'); const {theme}=useUnistyles();
 const [fonts]=useFonts({'SpaceGrotesk-Regular':require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')});
 if(!fonts)return null;
 const text=result.results.find(r=>r.locale.startsWith(lang)).text;
 return <View style={{flex:1,backgroundColor:theme.buzz.bgBase,paddingTop:48}}>
 <View style={{flexDirection:'row',padding:20,gap:20}}>{['en','es'].map(l=><Pressable key={l} onPress={()=>setLang(l)}><Text style={{color:theme.colors.text}}>{l==='en'?'English':'Español'}</Text></Pressable>)}{['bone','obsidian'].map(t=><Pressable key={t} onPress={()=>UnistylesRuntime.setTheme(t)}><Text style={{color:theme.colors.text}}>{t}</Text></Pressable>)}</View>
 <Text style={{fontSize:24,color:theme.colors.text,padding:20}}>General</Text>
 <ScrollView contentContainerStyle={{padding:20,maxWidth:860}}><LedgerEntry itemId={lang} bodyText={text} bodyTestID="welcome" byline={{name:'Beebee',role:'agent',stamp:'10:00'}} luminous /></ScrollView>
 </View>;
}
registerRootComponent(App);
