import React,{useState} from 'react';
import {registerRootComponent} from 'expo';
import {View,Pressable,Text,ScrollView} from 'react-native';
import {useFonts} from 'expo-font';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {TamaguiProvider} from 'tamagui';
import {tamaguiConfig} from '../../../apps/mobile/sources/ui/tamagui.config';
import {GrantRequestCard} from '../../../apps/mobile/sources/components/buzz/GrantRequestCard';
import {GrantRequestCard as BeforeCard} from './BeforeCard';
const owner='a'.repeat(64), agent={pubkey:'b'.repeat(64),kind:'agent',name:'Proof',handle:'proof'};
const message={id:'proof',text:'',isUser:false,timestamp:1793700000,grantRequest:{agent,owner:{pubkey:owner,kind:'human',name:'Owner'},grants:[{grantId:'command-proof',kind:'command',target:JSON.stringify({argv:['bash'],stdin:'printf check'}),script:{path:'<stdin>',sha256:'a'.repeat(64),bytes:12,contents:'printf check'},reason:'Check the approval choices',status:'pending',requestedBy:agent,roomId:'proof',createdAt:1,auto:false}]}};
function App(){const [theme,setTheme]=useState('light'),[before,setBefore]=useState(true);const [loaded]=useFonts({'SpaceGrotesk-Regular':require('../../../apps/mobile/sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-SemiBold':require('../../../apps/mobile/sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../../../apps/mobile/sources/assets/fonts/IBMPlexMono-Regular.ttf')});if(!loaded)return null;const Card=before?BeforeCard:GrantRequestCard;return <SafeAreaProvider><TamaguiProvider config={tamaguiConfig} defaultTheme={`${theme}_brass`}><ScrollView style={{flex:1,backgroundColor:theme==='light'?'#f4efe5':'#101010'}} contentContainerStyle={{paddingTop:48,paddingHorizontal:12}}><View style={{flexDirection:'row',gap:16}}><Pressable onPress={()=>setTheme(theme==='light'?'dark':'light')}><Text style={{color:theme==='light'?'black':'white',padding:12}}>Theme</Text></Pressable><Pressable onPress={()=>setBefore(!before)}><Text style={{color:theme==='light'?'black':'white',padding:12}}>Before/After</Text></Pressable></View><Text style={{color:theme==='light'?'black':'white'}}>COMMAND-ONCE-1 · {theme==='light'?'Bone':'Obsidian'} · {before?'Before':'After'}</Text><Card key={`${theme}-${before}`} message={message} viewerIsAgent={false} viewerPubkey={owner} actionId={null} onDecision={()=>{}} /></ScrollView></TamaguiProvider></SafeAreaProvider>}
registerRootComponent(App);
